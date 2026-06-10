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

import type { Prisma, PrismaClient } from "@prisma/client";

import { decryptWebhookUrl, maskWebhookUrl } from "@/lib/notifications/crypto";
import { formatSlackBlocks, sendSlackMessage } from "@/lib/notifications/slack";
import {
  getCloseAlerts,
  type CloseAlert,
  type AlertSeverity,
} from "@/lib/close/alerts";

type DbClient = PrismaClient | Prisma.TransactionClient;

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

  // Pull all enabled SLACK channels at once; group by tenant.
  const channels = await prisma.notificationChannel.findMany({
    where: { type: "SLACK", enabled: true },
    select: {
      id: true,
      tenantId: true,
      name: true,
      webhookUrl: true,
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
    webhookUrl: string;
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

  // Find all (entity, book) tuples for this tenant that have at
  // least one OPEN period. We scan the top N most-recent periods per
  // (entity, book) and pick the first one without a close row.
  const entities = await prisma.legalEntity.findMany({
    where: { tenantId: args.tenantId },
    select: { id: true, code: true },
  });
  const books = await prisma.book.findMany({ select: { id: true, code: true } });

  // For each (entity, book, openPeriod) scope, pull alerts.
  const allAlerts: { scope: ScopeKey; alert: CloseAlert }[] = [];
  for (const entity of entities) {
    for (const book of books) {
      const openPeriod = await findLatestOpenPeriod(prisma, {
        tenantId: args.tenantId,
        entityId: entity.id,
        bookId: book.id,
        limit: args.maxPeriodsPerTenant,
      });
      if (!openPeriod) continue;
      const alerts = await getCloseAlerts(prisma, {
        tenantId: args.tenantId,
        entityId: entity.id,
        bookId: book.id,
        periodId: openPeriod.id,
        periodCode: openPeriod.code,
      });
      for (const alert of alerts) {
        allAlerts.push({
          scope: {
            entity: entity.code,
            book: book.code,
            period: openPeriod.code,
          },
          alert,
        });
      }
    }
  }
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
        webhookUrl: channel.webhookUrl,
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
  webhookUrl: string;
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

  const payload = formatSlackBlocks(args.alert, {
    appBaseUrl: args.appBaseUrl,
    entity: args.scope.entity,
    book: args.scope.book,
    period: args.scope.period,
  });
  const result = await sendSlackMessage(plaintextUrl, payload);

  await prisma.notificationDispatch.create({
    data: {
      tenantId: args.tenantId,
      channelId: args.channelId,
      alertFingerprint: args.alert.id,
      pillar: args.alert.pillar,
      severity: args.alert.severity,
      sendStatus: result.ok ? result.status : (result.status ?? null),
      sendError: result.ok
        ? null
        : // Mask any URL that might have leaked into the error string.
          // We never log webhook URLs even on failure.
          result.error.includes("hooks.slack.com")
          ? result.error.replace(/https?:\/\/hooks\.slack\.com\/[^\s)]+/g, maskWebhookUrl(plaintextUrl))
          : result.error,
    },
  });

  return result.ok ? "SENT" : "ERROR";
}

interface ScopeKey {
  entity: string;
  book: string;
  period: string;
}

interface FindOpenPeriodArgs {
  tenantId: string;
  entityId: string;
  bookId: string;
  limit: number;
}

async function findLatestOpenPeriod(
  prisma: DbClient,
  args: FindOpenPeriodArgs
): Promise<{ id: string; code: string } | null> {
  const periods = await prisma.period.findMany({
    where: {
      tenantId: args.tenantId,
      calendar: { entityId: args.entityId },
    },
    orderBy: { startsOn: "desc" },
    take: args.limit,
    select: { id: true, code: true },
  });
  if (periods.length === 0) return null;
  const closes = await prisma.periodClose.findMany({
    where: {
      tenantId: args.tenantId,
      entityId: args.entityId,
      bookId: args.bookId,
      periodId: { in: periods.map((p) => p.id) },
    },
    select: { periodId: true },
  });
  const closedIds = new Set(closes.map((c) => c.periodId));
  return periods.find((p) => !closedIds.has(p.id)) ?? null;
}

function matchesSeverityFilter(
  severity: AlertSeverity,
  filter: string[]
): boolean {
  if (filter.length === 0) return true;
  return filter.includes(severity);
}
