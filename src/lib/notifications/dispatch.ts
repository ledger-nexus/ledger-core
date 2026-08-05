import type { NotificationChannelType } from "@prisma/client";
// Close-alerts dispatcher.
//
// The body of `POST /api/cron/close-alerts-dispatch`, extracted so
// it's testable end-to-end against a real DB without going through
// the Next.js route layer. The route handler is a thin wrapper that
// adds auth + audit + 200 JSON serialization.
//
// Flow (per cron tick):
//   1. Pull all enabled SLACK channels grouped by tenant.
//   2. For each (channel, tenant) tuple, find the active (entity, book,
//      period) scopes for this tenant. Active = period has no
//      PeriodClose row for (entity, book) — i.e. open.
//   3. For each active scope, call getCloseAlerts.
//   4. Filter alerts by the channel's severityFilter (empty filter =
//      all severities).
//   5. For each surviving alert: upsert NotificationDispatch on
//      @@unique(channelId, alertFingerprint).
//      - INSERT path: decrypt webhook URL, sendSlackMessage, write
//        sendStatus/sendError to the row.
//      - DUPLICATE path: skip — we already pinged this channel for
//        this alert.
//   6. Return per-tenant aggregate counters.
//
// Idempotency: the @@unique index is the dedupe. Re-firing the cron
// is safe; only NEW alerts ping.
//
// Failure modes:
//   - Decrypt error (key rotated, ciphertext corrupted): row written
//     with sendStatus=null + sendError set. The dedupe key locks it
//     in so we don't retry forever; ops fix the key + delete the
//     dispatch row to retry.
//   - Slack 4xx: row written with sendStatus + sendError. Dedupe
//     locks it in (same reasoning).
//   - Slack 5xx / network error: we still WRITE the row so the dedupe
//     prevents an infinite-retry stampede. The error column carries
//     the diagnostic.
//
// SOC 2:
//   CC6.1  every read/write tenant-scoped via tenantId on join
//   CC6.7  webhook URLs decrypted only at send time; never logged
//   CC7.2  every dispatch (success or fail) writes a row; the row IS
//          the audit trail for the outbound action

import { decryptWebhookUrl } from "@/lib/notifications/crypto";
import { formatSlackBlocks, sendSlackMessage } from "@/lib/notifications/slack";
import {
  formatGenericPayload,
  sendGenericWebhook,
} from "@/lib/notifications/generic-webhook";
import type { CloseAlert } from "@/lib/close/alerts";
import {
  collectOpenPeriodAlerts,
  matchesSeverityFilter,
  scrubSlackUrls,
  type DbClient,
  type ScopeKey,
} from "@/lib/notifications/shared";

export interface DispatchOptions {
  /** Override the default base URL used to render deep-link "Open" buttons. */
  appBaseUrl?: string;
  /** Cap on how many open periods to scan per tenant (defense-in-depth). */
  maxPeriodsPerTenant?: number;
}

export interface TenantDispatchResult {
  tenantId: string;
  channelsConsidered: number;
  alertsConsidered: number;
  dispatched: number;
  skippedDedupe: number;
  skippedSeverity: number;
  errors: number;
}

export interface DispatchResult {
  tenants: TenantDispatchResult[];
  summary: {
    tenantsScanned: number;
    channelsConsidered: number;
    alertsConsidered: number;
    dispatched: number;
    skippedDedupe: number;
    skippedSeverity: number;
    errors: number;
  };
}

const DEFAULT_MAX_PERIODS_PER_TENANT = 3;

/**
 * Main entry. Iterates all tenants with at least one enabled SLACK
 * channel and dispatches alerts.
 */
export async function dispatchCloseAlerts(
  prisma: DbClient,
  opts: DispatchOptions = {}
): Promise<DispatchResult> {
  const appBaseUrl =
    opts.appBaseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const maxPeriodsPerTenant =
    opts.maxPeriodsPerTenant ?? DEFAULT_MAX_PERIODS_PER_TENANT;

  // Every enabled IMMEDIATE channel, whatever its type — the send
  // branches per channel below. This used to filter `type: "SLACK"`,
  // which is the kind of clause that silently strips a new channel
  // type of any effect. DIGEST_DAILY channels are handled by a
  // separate cron route (close-alerts-digest) so the two cadences
  // don't fight over the same dedupe rows mid-tick.
  const channels = await prisma.notificationChannel.findMany({
    where: { enabled: true, mode: "IMMEDIATE" },
    select: {
      id: true,
      tenantId: true,
      name: true,
      type: true,
      webhookUrl: true,
      signingSecret: true,
      severityFilter: true,
    },
  });

  const byTenant = new Map<string, typeof channels>();
  for (const ch of channels) {
    const list = byTenant.get(ch.tenantId) ?? [];
    list.push(ch);
    byTenant.set(ch.tenantId, list);
  }

  const tenantResults: TenantDispatchResult[] = [];
  for (const [tenantId, tenantChannels] of byTenant) {
    const result = await dispatchForTenant(prisma, {
      tenantId,
      tenantChannels,
      appBaseUrl,
      maxPeriodsPerTenant,
    });
    tenantResults.push(result);
  }

  return {
    tenants: tenantResults,
    summary: {
      tenantsScanned: tenantResults.length,
      channelsConsidered: tenantResults.reduce(
        (s, t) => s + t.channelsConsidered,
        0
      ),
      alertsConsidered: tenantResults.reduce(
        (s, t) => s + t.alertsConsidered,
        0
      ),
      dispatched: tenantResults.reduce((s, t) => s + t.dispatched, 0),
      skippedDedupe: tenantResults.reduce((s, t) => s + t.skippedDedupe, 0),
      skippedSeverity: tenantResults.reduce((s, t) => s + t.skippedSeverity, 0),
      errors: tenantResults.reduce((s, t) => s + t.errors, 0),
    },
  };
}

interface TenantDispatchArgs {
  tenantId: string;
  tenantChannels: {
    id: string;
    tenantId: string;
    name: string;
    type: NotificationChannelType;
    webhookUrl: string;
    signingSecret: string | null;
    severityFilter: string[];
  }[];
  appBaseUrl: string;
  maxPeriodsPerTenant: number;
}

async function dispatchForTenant(
  prisma: DbClient,
  args: TenantDispatchArgs
): Promise<TenantDispatchResult> {
  const result: TenantDispatchResult = {
    tenantId: args.tenantId,
    channelsConsidered: args.tenantChannels.length,
    alertsConsidered: 0,
    dispatched: 0,
    skippedDedupe: 0,
    skippedSeverity: 0,
    errors: 0,
  };

  // Every (entity, book, latest-open-period) alert for this tenant —
  // collected by the module shared with the digest cadence so the two
  // dispatchers can't silently diverge on scope resolution.
  const allAlerts = await collectOpenPeriodAlerts(
    prisma,
    args.tenantId,
    args.maxPeriodsPerTenant
  );
  result.alertsConsidered = allAlerts.length;

  // For each (alert, channel) pair: severity filter + dedupe check +
  // (if surviving) send + write dispatch row.
  for (const { scope, alert } of allAlerts) {
    for (const channel of args.tenantChannels) {
      if (!matchesSeverityFilter(alert.severity, channel.severityFilter)) {
        result.skippedSeverity += 1;
        continue;
      }
      // Dedupe check via upsert pattern. We try-create; a duplicate
      // surfaces as P2002 which we silently skip.
      const sendOutcome = await sendOne(prisma, {
        tenantId: args.tenantId,
        channelId: channel.id,
        channelType: channel.type,
        webhookUrl: channel.webhookUrl,
        signingSecret: channel.signingSecret,
        alert,
        scope,
        appBaseUrl: args.appBaseUrl,
      });
      if (sendOutcome === "DEDUPED") {
        result.skippedDedupe += 1;
      } else if (sendOutcome === "SENT") {
        result.dispatched += 1;
      } else {
        result.errors += 1;
      }
    }
  }

  return result;
}

type SendOutcome = "SENT" | "DEDUPED" | "ERROR";

interface SendOneArgs {
  tenantId: string;
  channelId: string;
  channelType: NotificationChannelType;
  webhookUrl: string;
  signingSecret: string | null;
  alert: CloseAlert;
  scope: ScopeKey;
  appBaseUrl: string;
}

async function sendOne(
  prisma: DbClient,
  args: SendOneArgs
): Promise<SendOutcome> {
  // Probe the dedupe key first — cheaper than the upsert+catch
  // round-trip and produces a clean "skipped" signal.
  const existing = await prisma.notificationDispatch.findUnique({
    where: {
      channelId_alertFingerprint: {
        channelId: args.channelId,
        alertFingerprint: args.alert.id,
      },
    },
    select: { id: true },
  });
  if (existing) return "DEDUPED";

  let plaintextUrl: string;
  try {
    plaintextUrl = decryptWebhookUrl(args.webhookUrl);
  } catch (err) {
    // Decrypt failed — record the failure with the dedupe lock so we
    // don't infinite-retry. The masked URL helps ops debug; the
    // sendError carries the diagnostic.
    await prisma.notificationDispatch.create({
      data: {
        tenantId: args.tenantId,
        channelId: args.channelId,
        alertFingerprint: args.alert.id,
        pillar: args.alert.pillar,
        severity: args.alert.severity,
        sendStatus: null,
        sendError: `decrypt failed: ${err instanceof Error ? err.message : "unknown"}`,
      },
    });
    return "ERROR";
  }

  // Slack gets Block Kit; a generic receiver gets our own envelope,
  // signed so it can prove the request came from us.
  let result: { ok: boolean; status: number | null; error?: string };
  if (args.channelType === "WEBHOOK_GENERIC") {
    const payload = formatGenericPayload([args.alert], {
      event: "close.alert",
      sentAt: new Date(),
      appBaseUrl: args.appBaseUrl,
      entity: args.scope.entity,
      book: args.scope.book,
      period: args.scope.period,
    });
    result = await sendGenericWebhook(plaintextUrl, payload, {
      signingSecret: args.signingSecret
        ? decryptWebhookUrl(args.signingSecret)
        : null,
    });
  } else {
    const payload = formatSlackBlocks(args.alert, {
      appBaseUrl: args.appBaseUrl,
      entity: args.scope.entity,
      book: args.scope.book,
      period: args.scope.period,
    });
    result = await sendSlackMessage(plaintextUrl, payload);
  }

  await prisma.notificationDispatch.create({
    data: {
      tenantId: args.tenantId,
      channelId: args.channelId,
      alertFingerprint: args.alert.id,
      pillar: args.alert.pillar,
      severity: args.alert.severity,
      sendStatus: result.ok ? result.status : (result.status ?? null),
      // Never persist webhook URLs, even on failure — shared scrub.
      sendError: result.ok
        ? null
        : scrubSlackUrls(result.error ?? "send failed", plaintextUrl),
    },
  });

  return result.ok ? "SENT" : "ERROR";
}

// ScopeKey / findLatestOpenPeriod / matchesSeverityFilter live in
// ./shared — one source of truth for both cadences.
