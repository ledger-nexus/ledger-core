// Daily AI-token usage reporting to Stripe's billing-meter API.
//
// One row per (tenant, calendar-day, UTC) in AiUsageReport. The
// daily cron (POST /api/cron/report-ai-usage) iterates every tenant
// with an active Stripe subscription, computes yesterday's Anthropic
// spend across all 3 AI suggestion tables, reports it to Stripe as
// a meter event, and persists the result.
//
// Why CENTS (not tokens or dollars):
//   - Tokens conflate input vs output cost — Opus output is 5× input,
//     so a flat "per-token" price would over- or under-charge.
//   - Cents-of-cost gives the operator a clean "report what we spent"
//     unit; the Stripe Price decides the markup (e.g. "$1 per 100
//     units" for pass-through, "$1 per 50 units" for 2x).
//   - Integer cents avoids the per-event-value float-rounding gotcha
//     Stripe meters have.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { createMeterEvent } from "./stripe-client";
import type { AiUsageReportStatus } from "@prisma/client";

// Per-model Anthropic pricing in dollars per million tokens.
// MUST stay in sync with the same table in
// src/lib/ai-budget-summary.ts and the companion-repo ai-budget.ts
// modules. When Anthropic changes pricing, update all four files.
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":   { input: 5,   output: 25 },
  "claude-opus-4-6":   { input: 5,   output: 25 },
  "claude-sonnet-4-6": { input: 3,   output: 15 },
  "claude-haiku-4-5":  { input: 1,   output: 5  },
};

interface RawUsageRow {
  modelName: string;
  promptTokens: bigint | null;
  completionTokens: bigint | null;
}

/**
 * Compute the integer cents of Anthropic spend for one tenant on one
 * UTC calendar day. Reads the three AI suggestion tables via raw SQL
 * (no Prisma mirrors needed — same pattern as
 * /admin/ai-budget's getCurrentMonthSpendByTenant).
 *
 * Returns 0 when there's no usage. Rounds to integer cents
 * (HALF_EVEN) so the daily total summed across the billing period
 * matches what Anthropic actually charged us within a cent or two.
 */
export async function computeDailyUsageCents(
  tenantId: string,
  usageDay: string  // "YYYY-MM-DD" UTC
): Promise<number> {
  const dayStart = `${usageDay}T00:00:00Z`;
  const dayEnd = `${usageDay}T23:59:59.999Z`;

  // Three independent queries — one per AI suggestion table. Each
  // SUMs per model so we can apply the right price.
  const [reconRows, revRecRows, faAmortRows] = await Promise.all([
    prisma.$queryRaw<RawUsageRow[]>`
      SELECT
        model_name                          AS "modelName",
        SUM(prompt_tokens)::bigint          AS "promptTokens",
        SUM(completion_tokens)::bigint      AS "completionTokens"
      FROM ai_suggestion
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${dayStart}::timestamptz
        AND created_at <= ${dayEnd}::timestamptz
      GROUP BY model_name
    `,
    prisma.$queryRaw<RawUsageRow[]>`
      SELECT
        model_name                          AS "modelName",
        SUM(prompt_tokens)::bigint          AS "promptTokens",
        SUM(completion_tokens)::bigint      AS "completionTokens"
      FROM ai_extraction_suggestion
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${dayStart}::timestamptz
        AND created_at <= ${dayEnd}::timestamptz
      GROUP BY model_name
    `,
    prisma.$queryRaw<RawUsageRow[]>`
      SELECT
        model_name                          AS "modelName",
        SUM(prompt_tokens)::bigint          AS "promptTokens",
        SUM(completion_tokens)::bigint      AS "completionTokens"
      FROM ai_asset_suggestion
      WHERE tenant_id = ${tenantId}::uuid
        AND created_at >= ${dayStart}::timestamptz
        AND created_at <= ${dayEnd}::timestamptz
      GROUP BY model_name
    `,
  ]);

  let totalUsd = new Decimal(0);
  for (const rows of [reconRows, revRecRows, faAmortRows]) {
    for (const r of rows) {
      const price = PRICING[r.modelName];
      if (!price) continue; // unknown model — silently exclude
      const promptN = new Decimal((r.promptTokens ?? 0n).toString());
      const completionN = new Decimal((r.completionTokens ?? 0n).toString());
      const input = promptN.mul(price.input).div(1_000_000);
      const output = completionN.mul(price.output).div(1_000_000);
      totalUsd = totalUsd.plus(input).plus(output);
    }
  }

  // Convert dollars → integer cents, banker's-rounded.
  return totalUsd.mul(100).toDecimalPlaces(0, Decimal.ROUND_HALF_EVEN).toNumber();
}

// ─── Report-one-tenant ──────────────────────────────────────────────────

export interface ReportDailyUsageOutcome {
  tenantId: string;
  usageDay: string;
  reportedCents: number;
  status: AiUsageReportStatus;
  stripeEventId?: string | null;
  errorMessage?: string | null;
}

/**
 * Idempotent per (tenantId, usageDay). If a row already exists for
 * the same key, returns that row unchanged. The unique constraint
 * on AiUsageReport guarantees we never double-bill — even under a
 * cron race the second writer hits P2002 and we fall through to
 * "already reported, skip".
 */
export async function reportDailyUsage(args: {
  tenantId: string;
  usageDay: string;
}): Promise<ReportDailyUsageOutcome> {
  const { tenantId, usageDay } = args;

  // 1. Already-reported short-circuit.
  const existing = await prisma.aiUsageReport.findUnique({
    where: { tenantId_usageDay: { tenantId, usageDay } },
  });
  if (existing) {
    return {
      tenantId,
      usageDay,
      reportedCents: existing.reportedCents,
      status: existing.status,
      stripeEventId: existing.stripeEventId,
      errorMessage: existing.errorMessage,
    };
  }

  // 2. Tenant lookup + subscription check.
  const tenant = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: {
      stripeCustomerId: true,
      stripeSubscriptionId: true,
      subscriptionStatus: true,
    },
  });
  if (!tenant) {
    return {
      tenantId,
      usageDay,
      reportedCents: 0,
      status: "FAILED",
      errorMessage: "Tenant not found",
    };
  }

  // Free-tier / past_due / canceled: persist NO_SUBSCRIPTION + skip
  // the Stripe call. The row makes the cron progress visible without
  // double-counting.
  const hasActiveSub =
    !!tenant.stripeCustomerId &&
    !!tenant.stripeSubscriptionId &&
    (tenant.subscriptionStatus === "active" ||
      tenant.subscriptionStatus === "trialing");

  // 3. Compute cents.
  const reportedCents = await computeDailyUsageCents(tenantId, usageDay);

  if (!hasActiveSub) {
    await safeCreateReport({
      tenantId,
      usageDay,
      reportedCents,
      status: "NO_SUBSCRIPTION",
      errorMessage: tenant.subscriptionStatus
        ? `Subscription status: ${tenant.subscriptionStatus}`
        : "No Stripe subscription on this tenant",
    });
    return {
      tenantId,
      usageDay,
      reportedCents,
      status: "NO_SUBSCRIPTION",
    };
  }

  if (reportedCents === 0) {
    await safeCreateReport({
      tenantId,
      usageDay,
      reportedCents: 0,
      status: "NO_USAGE",
    });
    return { tenantId, usageDay, reportedCents: 0, status: "NO_USAGE" };
  }

  // 4. Stripe meter event POST.
  const apiKey = process.env.STRIPE_SECRET_KEY;
  const eventName = process.env.STRIPE_AI_METER_EVENT_NAME;

  if (!apiKey || !eventName) {
    // LOGGED_ONLY: persist the row so the operator can see what
    // would have been reported. Mirrors the email module's same
    // posture when Resend isn't configured.
    const errorMessage = !apiKey
      ? "STRIPE_SECRET_KEY unset"
      : "STRIPE_AI_METER_EVENT_NAME unset";
    await safeCreateReport({
      tenantId,
      usageDay,
      reportedCents,
      status: "LOGGED_ONLY",
      errorMessage,
    });
    return {
      tenantId,
      usageDay,
      reportedCents,
      status: "LOGGED_ONLY",
      errorMessage,
    };
  }

  // Idempotency: pass a deterministic identifier so a duplicate
  // POST (e.g. cron retry) is no-op'd by Stripe.
  const identifier = `${tenantId}-${usageDay}`;
  // End-of-day timestamp so the meter event lands in the right
  // billing period even when the cron runs at 1am the next day.
  const timestamp = Math.floor(Date.parse(`${usageDay}T23:59:59Z`) / 1000);

  try {
    const ev = await createMeterEvent({
      eventName,
      customerId: tenant.stripeCustomerId!,
      value: reportedCents,
      timestamp,
      identifier,
    });
    await safeCreateReport({
      tenantId,
      usageDay,
      reportedCents,
      status: "REPORTED",
      stripeEventId: ev.identifier,
    });
    return {
      tenantId,
      usageDay,
      reportedCents,
      status: "REPORTED",
      stripeEventId: ev.identifier,
    };
  } catch (e) {
    const errorMessage = e instanceof Error ? e.message : "Unknown Stripe error";
    await safeCreateReport({
      tenantId,
      usageDay,
      reportedCents,
      status: "FAILED",
      errorMessage,
    });
    return { tenantId, usageDay, reportedCents, status: "FAILED", errorMessage };
  }
}

// safeCreateReport swallows P2002 (unique constraint) — happens when
// two cron invocations race on the same (tenant, day). The "lost"
// writer is the one that lost the race; the winner's row is fine.
async function safeCreateReport(data: {
  tenantId: string;
  usageDay: string;
  reportedCents: number;
  status: AiUsageReportStatus;
  stripeEventId?: string;
  errorMessage?: string;
}): Promise<void> {
  try {
    await prisma.aiUsageReport.create({ data });
  } catch (e) {
    if (isUniqueViolation(e)) return; // peer cron won the race
    throw e;
  }
}

function isUniqueViolation(e: unknown): boolean {
  if (!e || typeof e !== "object") return false;
  const code = (e as { code?: string }).code;
  return code === "P2002";
}

// ─── Report-all-tenants (the cron entry point) ──────────────────────────

export interface ReportAllOutcome {
  /** ISO date string for the day reported. */
  usageDay: string;
  /** Per-status counts. */
  reported: number;
  noUsage: number;
  noSubscription: number;
  loggedOnly: number;
  failed: number;
  /** Detail rows for each tenant — useful in the cron response for ops. */
  tenants: ReportDailyUsageOutcome[];
}

/**
 * Iterate every tenant (paginated) and report their previous-day
 * usage. Idempotent — each tenant either gets a fresh report or
 * the existing row is returned unchanged.
 *
 * Failures on individual tenants don't abort the batch. The cron's
 * response surfaces the per-tenant outcomes so the operator can
 * grep for FAILED.
 */
export async function reportYesterdayForAllTenants(options?: {
  /** Override the day reported (default: yesterday UTC). */
  usageDay?: string;
}): Promise<ReportAllOutcome> {
  const usageDay = options?.usageDay ?? yesterdayUtcIsoDate();

  // Iterate ALL tenants — even ones without subscriptions. The
  // per-tenant function handles the "no sub" case by persisting a
  // status=NO_SUBSCRIPTION row, giving the operator a complete view
  // of what got considered.
  //
  // Soft-deleted tenants (deletedAt != null) skipped — they've been
  // offboarded and shouldn't generate billing events.
  const tenants = await prisma.tenant.findMany({
    where: { deletedAt: null },
    select: { id: true },
  });

  const outcomes: ReportDailyUsageOutcome[] = [];
  let reported = 0;
  let noUsage = 0;
  let noSubscription = 0;
  let loggedOnly = 0;
  let failed = 0;

  // Sequential. Stripe rate limits ~100 req/sec; 1 req per tenant
  // even with 10k tenants is 100s — fine for a daily cron. If volume
  // grows, batch with a concurrency limit.
  for (const t of tenants) {
    const o = await reportDailyUsage({ tenantId: t.id, usageDay });
    outcomes.push(o);
    switch (o.status) {
      case "REPORTED":        reported += 1; break;
      case "NO_USAGE":        noUsage += 1; break;
      case "NO_SUBSCRIPTION": noSubscription += 1; break;
      case "LOGGED_ONLY":     loggedOnly += 1; break;
      case "FAILED":          failed += 1; break;
    }
  }

  return {
    usageDay,
    reported,
    noUsage,
    noSubscription,
    loggedOnly,
    failed,
    tenants: outcomes,
  };
}

export function yesterdayUtcIsoDate(): string {
  const now = new Date();
  // Yesterday at midnight UTC, expressed as YYYY-MM-DD.
  const y = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
  );
  return y.toISOString().slice(0, 10);
}
