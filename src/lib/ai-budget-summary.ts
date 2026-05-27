// AI budget summary helper.
//
// Aggregates Anthropic spend + recent alerts across all three AI-using
// companion repos (recon, revenue-rec, fa-amort) for the /admin/ai-budget
// admin page. Each companion repo independently enforces its own cap +
// fires its own alerts; this helper is read-only and just rolls them up
// for operator visibility.
//
// Architecture notes:
//
//   - We read from companion-owned tables via raw SQL. ledger-core does
//     NOT mirror those models into its Prisma schema — that would create
//     a reverse dependency from substrate to consumer. Raw SQL on stable
//     table names is the right escape hatch for read-only aggregation.
//
//   - Per-model pricing lives in TS so it stays in lockstep with the
//     companion-repo helpers (same table in each repo). If pricing
//     changes, update PRICING in this file AND in
//     {recon,revenue-rec,fa-amort}/src/lib/auth/ai-budget.ts.
//
//   - "Source" labels follow the companion repos' REPO_NAME constants
//     so the table column and the webhook payload share vocabulary.

import { Decimal } from "decimal.js";
import { prisma } from "./db";

const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-7":   { input: 5,   output: 25 },
  "claude-opus-4-6":   { input: 5,   output: 25 },
  "claude-sonnet-4-6": { input: 3,   output: 15 },
  "claude-haiku-4-5":  { input: 1,   output: 5  },
};

const DEFAULT_MONTHLY_CAP_USD = numFromEnv("AI_TENANT_MONTHLY_CAP_USD", 50);

function numFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export interface TenantSpendRow {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  /// Effective cap — either tenant.monthlyAiSpendCapUsd or env default.
  capUsd: Decimal;
  /// true if the cap is a per-tenant override (not the env fallback).
  capIsExplicit: boolean;
  /// Sum spend this calendar month across all three companion repos.
  spentUsd: Decimal;
  /// Per-repo breakdown for the same window.
  byRepo: {
    recon: Decimal;
    revenueRec: Decimal;
    faAmort: Decimal;
  };
  /// (spent / cap) * 100, capped at 999.99 so a runaway month doesn't
  /// blow up the UI formatting.
  pctOfCap: Decimal;
}

export interface RecentAlert {
  source: "recon" | "revenue-rec" | "fa-amort" | "unknown";
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  monthKey: string;
  threshold: number;
  capUsd: Decimal;
  spentUsd: Decimal;
  sentAt: Date;
}

interface RawSpendRow {
  tenantId: string;
  modelName: string;
  promptTokens: bigint | null;
  completionTokens: bigint | null;
}

interface RawAlertRow {
  tenantId: string;
  source: string;
  monthKey: string;
  threshold: number;
  capUsd: string;
  spentUsd: string;
  sentAt: Date;
}

/**
 * Sum AI spend per tenant for the current calendar month, broken down by
 * source repo. Joins with the Tenant table for slug + name + per-tenant
 * cap. Tenants with zero AI activity this month are excluded — only rows
 * with at least one suggestion across the three repos appear.
 */
export async function getCurrentMonthSpendByTenant(): Promise<TenantSpendRow[]> {
  const monthStart = startOfCurrentMonthUtc();

  // Three independent SUMs from the three AI suggestion tables. We let
  // each query aggregate at the DB to avoid pulling N×rows of token
  // counts back into Node; the per-tenant join with pricing happens in
  // app code (pricing lives in TS).
  const [reconRows, revRecRows, faAmortRows] = await Promise.all([
    prisma.$queryRaw<RawSpendRow[]>`
      SELECT
        tenant_id        AS "tenantId",
        model_name       AS "modelName",
        SUM(prompt_tokens)::bigint     AS "promptTokens",
        SUM(completion_tokens)::bigint AS "completionTokens"
      FROM ai_suggestion
      WHERE tenant_id IS NOT NULL
        AND created_at >= ${monthStart}
      GROUP BY tenant_id, model_name
    `,
    prisma.$queryRaw<RawSpendRow[]>`
      SELECT
        tenant_id        AS "tenantId",
        model_name       AS "modelName",
        SUM(prompt_tokens)::bigint     AS "promptTokens",
        SUM(completion_tokens)::bigint AS "completionTokens"
      FROM ai_extraction_suggestion
      WHERE tenant_id IS NOT NULL
        AND created_at >= ${monthStart}
      GROUP BY tenant_id, model_name
    `,
    prisma.$queryRaw<RawSpendRow[]>`
      SELECT
        tenant_id        AS "tenantId",
        model_name       AS "modelName",
        SUM(prompt_tokens)::bigint     AS "promptTokens",
        SUM(completion_tokens)::bigint AS "completionTokens"
      FROM ai_asset_suggestion
      WHERE tenant_id IS NOT NULL
        AND created_at >= ${monthStart}
      GROUP BY tenant_id, model_name
    `,
  ]);

  // Fold per-repo rows into per-tenant subtotals.
  const reconByTenant = sumRowsToTenantUsd(reconRows);
  const revRecByTenant = sumRowsToTenantUsd(revRecRows);
  const faAmortByTenant = sumRowsToTenantUsd(faAmortRows);

  const tenantIds = new Set<string>([
    ...reconByTenant.keys(),
    ...revRecByTenant.keys(),
    ...faAmortByTenant.keys(),
  ]);

  if (tenantIds.size === 0) return [];

  // Pull the Tenant rows in one shot to get slug / name / cap.
  const tenants = await prisma.tenant.findMany({
    where: { id: { in: [...tenantIds] } },
    select: { id: true, slug: true, name: true, monthlyAiSpendCapUsd: true },
  });

  const rows: TenantSpendRow[] = tenants.map((t) => {
    const recon = reconByTenant.get(t.id) ?? new Decimal(0);
    const revenueRec = revRecByTenant.get(t.id) ?? new Decimal(0);
    const faAmort = faAmortByTenant.get(t.id) ?? new Decimal(0);
    const spent = recon.plus(revenueRec).plus(faAmort);
    const capIsExplicit = t.monthlyAiSpendCapUsd != null;
    const cap = capIsExplicit
      ? new Decimal(t.monthlyAiSpendCapUsd!.toString())
      : new Decimal(DEFAULT_MONTHLY_CAP_USD);
    const pct = cap.greaterThan(0)
      ? Decimal.min(spent.div(cap).mul(100), new Decimal("999.99"))
      : new Decimal(0);
    return {
      tenantId: t.id,
      tenantSlug: t.slug,
      tenantName: t.name,
      capUsd: cap,
      capIsExplicit,
      spentUsd: spent,
      byRepo: { recon, revenueRec, faAmort },
      pctOfCap: pct,
    };
  });

  // Sort by % used desc so the most at-risk tenants surface first.
  rows.sort((a, b) => b.pctOfCap.cmp(a.pctOfCap));
  return rows;
}

function sumRowsToTenantUsd(rows: RawSpendRow[]): Map<string, Decimal> {
  const out = new Map<string, Decimal>();
  for (const r of rows) {
    const price = PRICING[r.modelName];
    if (!price) continue; // Unknown model — silently exclude.
    const promptN = new Decimal((r.promptTokens ?? 0n).toString());
    const completionN = new Decimal((r.completionTokens ?? 0n).toString());
    const input = promptN.mul(price.input).div(1_000_000);
    const output = completionN.mul(price.output).div(1_000_000);
    const rowUsd = input.plus(output);
    const prev = out.get(r.tenantId) ?? new Decimal(0);
    out.set(r.tenantId, prev.plus(rowUsd));
  }
  return out;
}

/**
 * Pull the last N spend-threshold alerts across all three companion
 * repos. ALL three repos write to the same physical ai_spend_alert
 * table (they share Postgres) — the `source` column distinguishes
 * which repo fired each alert. Sorted by sentAt desc.
 */
export async function getRecentAlerts(limit: number = 50): Promise<RecentAlert[]> {
  const rows = await prisma.$queryRaw<RawAlertRow[]>`
    SELECT
      tenant_id    AS "tenantId",
      source,
      month_key    AS "monthKey",
      threshold,
      cap_usd::text   AS "capUsd",
      spent_usd::text AS "spentUsd",
      sent_at      AS "sentAt"
    FROM ai_spend_alert
    ORDER BY sent_at DESC
    LIMIT ${limit}
  `;

  const tenantIds = new Set(rows.map((r) => r.tenantId));
  if (tenantIds.size === 0) return [];

  const tenants = await prisma.tenant.findMany({
    where: { id: { in: [...tenantIds] } },
    select: { id: true, slug: true, name: true },
  });
  const tenantById = new Map(tenants.map((t) => [t.id, t]));

  return rows.flatMap<RecentAlert>((r) => {
    const t = tenantById.get(r.tenantId);
    if (!t) return [];
    // The source column is free-form String, so validate against the
    // known set before narrowing the type. Unknown sources still
    // surface — just labeled as "unknown" — so a future fourth repo
    // doesn't disappear silently.
    const source: RecentAlert["source"] =
      r.source === "recon" || r.source === "revenue-rec" || r.source === "fa-amort"
        ? r.source
        : ("unknown" as RecentAlert["source"]);
    return [{
      source,
      tenantId: r.tenantId,
      tenantSlug: t.slug,
      tenantName: t.name,
      monthKey: r.monthKey,
      threshold: r.threshold,
      capUsd: new Decimal(r.capUsd),
      spentUsd: new Decimal(r.spentUsd),
      sentAt: r.sentAt,
    }];
  });
}

function startOfCurrentMonthUtc(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export function currentMonthKey(): string {
  const now = new Date();
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}
