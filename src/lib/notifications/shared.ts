// Shared plumbing for the two close-alert dispatchers.
//
// dispatch.ts (IMMEDIATE cadence) and digest.ts (DIGEST_DAILY cadence)
// walk the same universe — every (entity, book) scope with an open
// period — and apply the same severity + URL-scrub rules. Those pieces
// live here so the two cadences can't silently diverge: a change to
// "which period is open" or "what counts as matching the filter" lands
// in exactly one place.
//
// The webhook-URL scrub is also used by the admin testChannel action.
// Policy (SOC 2 CC6.7): the regex is the authoritative scrub — no
// .includes() pre-gate (CodeQL flags incomplete-URL-substring-
// sanitization on the gate, and the regex is a no-op when nothing
// matches). The stop-class excludes quotes so a URL embedded in JSON
// error output masks tidily instead of swallowing trailing text.

import type { Prisma, PrismaClient } from "@prisma/client";

import { maskWebhookUrl } from "@/lib/notifications/crypto";
import {
  getCloseAlerts,
  type CloseAlert,
  type AlertSeverity,
} from "@/lib/close/alerts";

export type DbClient = PrismaClient | Prisma.TransactionClient;

/** The (entity, book, period) coordinates an alert was collected under. */
export interface ScopeKey {
  entity: string;
  book: string;
  period: string;
}

const SLACK_WEBHOOK_URL_RE = /https?:\/\/hooks\.slack\.com\/services\/[^\s"')]+/g;

/**
 * Mask any Slack webhook URL that leaked into an error string before it
 * is persisted (dispatch rows, audit metadata) — we never store webhook
 * URLs in plaintext, even on failure paths.
 */
export function scrubSlackUrls(text: string, plaintextUrl: string): string {
  return text.replace(SLACK_WEBHOOK_URL_RE, maskWebhookUrl(plaintextUrl));
}

/** Empty filter = all severities push to the channel. */
export function matchesSeverityFilter(
  severity: AlertSeverity,
  filter: string[]
): boolean {
  if (filter.length === 0) return true;
  return filter.includes(severity);
}

interface FindOpenPeriodArgs {
  tenantId: string;
  entityId: string;
  bookId: string;
  /** How many most-recent periods to scan for an open one. */
  limit: number;
}

/**
 * The most recent period for (entity's calendar) with no PeriodClose row
 * for this (entity, book) — i.e. the period the close team is working.
 * Scans the latest `limit` periods so an unclosed ancient period doesn't
 * resurface stale alerts.
 */
export async function findLatestOpenPeriod(
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

/**
 * Collect every close alert across a tenant's (entity × book × latest
 * open period) scopes. Both cadences start from this exact set; they
 * differ only in how they batch + send.
 */
export async function collectOpenPeriodAlerts(
  prisma: DbClient,
  tenantId: string,
  maxPeriodsPerTenant: number
): Promise<Array<{ scope: ScopeKey; alert: CloseAlert }>> {
  const entities = await prisma.legalEntity.findMany({
    where: { tenantId },
    select: { id: true, code: true },
  });
  const books = await prisma.book.findMany({ select: { id: true, code: true } });

  const out: Array<{ scope: ScopeKey; alert: CloseAlert }> = [];
  for (const entity of entities) {
    for (const book of books) {
      const openPeriod = await findLatestOpenPeriod(prisma, {
        tenantId,
        entityId: entity.id,
        bookId: book.id,
        limit: maxPeriodsPerTenant,
      });
      if (!openPeriod) continue;
      const alerts = await getCloseAlerts(prisma, {
        tenantId,
        entityId: entity.id,
        bookId: book.id,
        periodId: openPeriod.id,
        periodCode: openPeriod.code,
      });
      for (const alert of alerts) {
        out.push({
          scope: { entity: entity.code, book: book.code, period: openPeriod.code },
          alert,
        });
      }
    }
  }
  return out;
}
