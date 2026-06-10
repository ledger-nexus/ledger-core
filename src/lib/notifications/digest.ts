// Daily close-alerts digest dispatcher.
//
// Counterpart to dispatch.ts. Where dispatch.ts handles channels in
// IMMEDIATE mode (one Slack message per new alert, runs every 15m
// business hours), this module handles DIGEST_DAILY mode: ONE Slack
// message per channel per day, batching every NEW alert across the
// tenant's open periods.
//
// Flow (per cron tick, runs 09:00 UTC):
//   1. Pull all enabled SLACK channels in DIGEST_DAILY mode; group by
//      tenant.
//   2. For each (channel, tenant) tuple, walk every (entity, book,
//      open period) scope and collect alerts.
//   3. Filter by the channel's severityFilter.
//   4. Per alert: probe NotificationDispatch on @@unique(channelId,
//      alertFingerprint). If a row exists, skip — already sent. If
//      not, collect for this run.
//   5. If 0 fresh alerts → no Slack send. Return tenants={empty} for
//      this channel (silent on idle days; operators don't want a
//      "no alerts today" message).
//   6. If 1+ fresh alerts → render ONE Slack message with N attachments
//      (formatSlackDigest), POST it, then write N NotificationDispatch
//      rows (one per alert) — every batched alert gets a dedupe lock
//      regardless of whether the send succeeded, so a partial-failure
//      day doesn't double-ping tomorrow.
//
// Idempotency: the @@unique(channelId, alertFingerprint) index is the
// dedupe (same as IMMEDIATE). Re-firing the digest cron on the same
// day finds every fresh alert already dispatched and sends nothing.
//
// Failure modes (same shape as IMMEDIATE):
//   - Decrypt error: every batched alert gets a dispatch row with
//     sendStatus=null + sendError="decrypt failed: ..." — Slack is
//     never called.
//   - Slack 4xx / 5xx / network / timeout: every batched alert gets a
//     dispatch row with sendStatus=<code|null> + sendError set. The
//     dedupe lock prevents a re-ping until the alert source changes.
//
// SOC 2:
//   CC6.1  every read/write tenant-scoped via tenantId on join
//   CC6.7  webhook URLs decrypted only at send time; never logged
//   CC7.2  every batched alert writes a dispatch row whether the
//          Slack call succeeded or failed — the row IS the audit
//          trail for the outbound action

import type { Prisma, PrismaClient } from "@prisma/client";

import { decryptWebhookUrl, maskWebhookUrl } from "@/lib/notifications/crypto";
import {
  formatSlackDigest,
  sendSlackMessage,
  type SlackSendResult,
} from "@/lib/notifications/slack";
import {
  getCloseAlerts,
  type CloseAlert,
  type AlertSeverity,
} from "@/lib/close/alerts";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface DigestOptions {
  /** Override the default base URL used to render deep-link "Open" buttons. */
  appBaseUrl?: string;
  /** Cap on how many open periods to scan per (entity, book). */
  maxPeriodsPerTenant?: number;
  /**
   * Wall-clock date label rendered in the digest header. Defaults to
   * today's UTC YYYY-MM-DD. Exposed for tests so a deterministic date
   * shows up in the Slack payload assertion.
   */
  digestDate?: string;
  /**
   * Safety belt: cap the number of alerts rendered in a single digest
   * message. Slack's 40KB payload limit gives plenty of headroom but a
   * pathological tenant could blow past it. We still write dispatch
   * rows for every fresh alert (truncated or not), so the operator
   * doesn't lose any.
   */
  maxAlertsPerMessage?: number;
}

export interface TenantDigestResult {
  tenantId: string;
  channelsConsidered: number;
  channelsSent: number;
  alertsBatched: number;
  alertsSkippedDedupe: number;
  alertsSkippedSeverity: number;
  errors: number;
}

export interface DigestResult {
  tenants: TenantDigestResult[];
  summary: {
    tenantsScanned: number;
    channelsConsidered: number;
    channelsSent: number;
    alertsBatched: number;
    alertsSkippedDedupe: number;
    alertsSkippedSeverity: number;
    errors: number;
  };
}

const DEFAULT_MAX_PERIODS_PER_TENANT = 3;
const DEFAULT_MAX_ALERTS_PER_MESSAGE = 50;

function todayUtcLabel(): string {
  // Stable wall-clock label for the digest header. Cron fires at 09:00
  // UTC, so "today" is unambiguous across operator timezones.
  return new Date().toISOString().slice(0, 10);
}

/**
 * Main entry. Iterates every tenant with at least one enabled SLACK
 * channel in DIGEST_DAILY mode and sends one batched message per
 * channel (or nothing, if there's nothing fresh).
 */
export async function dispatchCloseDigests(
  prisma: DbClient,
  opts: DigestOptions = {}
): Promise<DigestResult> {
  const appBaseUrl =
    opts.appBaseUrl ?? process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  const maxPeriodsPerTenant =
    opts.maxPeriodsPerTenant ?? DEFAULT_MAX_PERIODS_PER_TENANT;
  const maxAlertsPerMessage =
    opts.maxAlertsPerMessage ?? DEFAULT_MAX_ALERTS_PER_MESSAGE;
  const digestDate = opts.digestDate ?? todayUtcLabel();

  const channels = await prisma.notificationChannel.findMany({
    where: { type: "SLACK", enabled: true, mode: "DIGEST_DAILY" },
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

  const tenantResults: TenantDigestResult[] = [];
  for (const [tenantId, tenantChannels] of byTenant) {
    const result = await digestForTenant(prisma, {
      tenantId,
      tenantChannels,
      appBaseUrl,
      maxPeriodsPerTenant,
      maxAlertsPerMessage,
      digestDate,
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
      channelsSent: tenantResults.reduce((s, t) => s + t.channelsSent, 0),
      alertsBatched: tenantResults.reduce((s, t) => s + t.alertsBatched, 0),
      alertsSkippedDedupe: tenantResults.reduce(
        (s, t) => s + t.alertsSkippedDedupe,
        0
      ),
      alertsSkippedSeverity: tenantResults.reduce(
        (s, t) => s + t.alertsSkippedSeverity,
        0
      ),
      errors: tenantResults.reduce((s, t) => s + t.errors, 0),
    },
  };
}

interface TenantDigestArgs {
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
  maxAlertsPerMessage: number;
  digestDate: string;
}

interface ScopeKey {
  entity: string;
  book: string;
  period: string;
}

async function digestForTenant(
  prisma: DbClient,
  args: TenantDigestArgs
): Promise<TenantDigestResult> {
  const result: TenantDigestResult = {
    tenantId: args.tenantId,
    channelsConsidered: args.tenantChannels.length,
    channelsSent: 0,
    alertsBatched: 0,
    alertsSkippedDedupe: 0,
    alertsSkippedSeverity: 0,
    errors: 0,
  };

  // Collect every alert across this tenant's (entity, book, open
  // period) scopes once — every digest channel for this tenant looks
  // at the same alert set; we just filter per-channel below.
  const entities = await prisma.legalEntity.findMany({
    where: { tenantId: args.tenantId },
    select: { id: true, code: true },
  });
  const books = await prisma.book.findMany({ select: { id: true, code: true } });

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

  for (const channel of args.tenantChannels) {
    const outcome = await digestForChannel(prisma, {
      tenantId: args.tenantId,
      channel,
      allAlerts,
      appBaseUrl: args.appBaseUrl,
      maxAlertsPerMessage: args.maxAlertsPerMessage,
      digestDate: args.digestDate,
    });
    result.alertsBatched += outcome.alertsBatched;
    result.alertsSkippedDedupe += outcome.alertsSkippedDedupe;
    result.alertsSkippedSeverity += outcome.alertsSkippedSeverity;
    if (outcome.channelSent) result.channelsSent += 1;
    if (outcome.error) result.errors += 1;
  }

  return result;
}

interface DigestForChannelArgs {
  tenantId: string;
  channel: {
    id: string;
    name: string;
    webhookUrl: string;
    severityFilter: string[];
  };
  allAlerts: { scope: ScopeKey; alert: CloseAlert }[];
  appBaseUrl: string;
  maxAlertsPerMessage: number;
  digestDate: string;
}

interface DigestForChannelResult {
  channelSent: boolean;
  alertsBatched: number;
  alertsSkippedDedupe: number;
  alertsSkippedSeverity: number;
  error: boolean;
}

async function digestForChannel(
  prisma: DbClient,
  args: DigestForChannelArgs
): Promise<DigestForChannelResult> {
  const result: DigestForChannelResult = {
    channelSent: false,
    alertsBatched: 0,
    alertsSkippedDedupe: 0,
    alertsSkippedSeverity: 0,
    error: false,
  };

  // Severity filter first — cheap pre-screen.
  const severityScreened = args.allAlerts.filter(({ alert }) => {
    if (matchesSeverityFilter(alert.severity, args.channel.severityFilter)) {
      return true;
    }
    result.alertsSkippedSeverity += 1;
    return false;
  });

  if (severityScreened.length === 0) return result;

  // Bulk dedupe lookup — one query for every (channel, alert) tuple
  // instead of probing one-by-one. Cheaper than the per-alert probe
  // the IMMEDIATE dispatcher uses; we know we're scanning many at once.
  const existingDispatches = await prisma.notificationDispatch.findMany({
    where: {
      channelId: args.channel.id,
      alertFingerprint: { in: severityScreened.map(({ alert }) => alert.id) },
    },
    select: { alertFingerprint: true },
  });
  const alreadySent = new Set(existingDispatches.map((d) => d.alertFingerprint));

  const freshAlerts = severityScreened.filter(({ alert }) => {
    if (alreadySent.has(alert.id)) {
      result.alertsSkippedDedupe += 1;
      return false;
    }
    return true;
  });

  if (freshAlerts.length === 0) return result;

  // Decrypt webhook URL up front. Decrypt failure → every fresh alert
  // gets a dispatch row with the diagnostic + the dedupe lock so we
  // don't retry until ops resets WEBHOOK_ENCRYPTION_KEY.
  let plaintextUrl: string;
  try {
    plaintextUrl = decryptWebhookUrl(args.channel.webhookUrl);
  } catch (err) {
    const errMsg = `decrypt failed: ${err instanceof Error ? err.message : "unknown"}`;
    await prisma.notificationDispatch.createMany({
      data: freshAlerts.map(({ alert }) => ({
        tenantId: args.tenantId,
        channelId: args.channel.id,
        alertFingerprint: alert.id,
        pillar: alert.pillar,
        severity: alert.severity,
        sendStatus: null,
        sendError: errMsg,
      })),
    });
    result.alertsBatched = freshAlerts.length;
    result.error = true;
    return result;
  }

  // Cap the render at maxAlertsPerMessage so the Slack payload stays
  // under the 40KB ceiling. We still write a dispatch row for every
  // fresh alert (including the truncated ones) — operators care that
  // the alert was accounted for, not that the digest message showed it.
  const rendered = freshAlerts.slice(0, args.maxAlertsPerMessage);
  const payload = formatSlackDigest(rendered, {
    appBaseUrl: args.appBaseUrl,
    digestDate: args.digestDate,
    channelName: args.channel.name,
  });

  const sendResult = await sendSlackMessage(plaintextUrl, payload);

  await prisma.notificationDispatch.createMany({
    data: freshAlerts.map(({ alert }) =>
      buildDispatchRow({
        tenantId: args.tenantId,
        channelId: args.channel.id,
        alert,
        plaintextUrl,
        sendResult,
      })
    ),
  });
  result.alertsBatched = freshAlerts.length;

  if (sendResult.ok) {
    result.channelSent = true;
  } else {
    result.error = true;
  }

  return result;
}

interface BuildDispatchArgs {
  tenantId: string;
  channelId: string;
  alert: CloseAlert;
  plaintextUrl: string;
  sendResult: SlackSendResult;
}

function buildDispatchRow(args: BuildDispatchArgs) {
  return {
    tenantId: args.tenantId,
    channelId: args.channelId,
    alertFingerprint: args.alert.id,
    pillar: args.alert.pillar,
    severity: args.alert.severity,
    sendStatus: args.sendResult.ok
      ? args.sendResult.status
      : (args.sendResult.status ?? null),
    // Same URL-scrub policy as dispatch.ts: regex is authoritative,
    // no .includes() pre-gate (CodeQL flags incomplete-URL-substring-
    // sanitization on the gate; the regex is a no-op when there's no
    // match).
    sendError: args.sendResult.ok
      ? null
      : args.sendResult.error.replace(
          /https?:\/\/hooks\.slack\.com\/services\/[^\s)]+/g,
          maskWebhookUrl(args.plaintextUrl)
        ),
  };
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
