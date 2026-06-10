// BlackLine arc — Phase 3 PR 2: flux analysis helper.
//
// `getFluxAnalysis(prisma, {tenantId, entityId, bookId, fromPeriodId,
//                          toPeriodId, absoluteThreshold,
//                          percentThreshold})`
// → array of computed flux lines, one per Account that appears in
//   either period's trial balance.
//
// The helper is PURE — it reads, never writes. The Server Action
// `generateFluxStatement` consumes the output to upsert FluxStatement
// + FluxLine rows. Splitting the math from the persistence layer
// keeps both tested independently and lets reports / dashboards
// preview a flux without committing it.
//
// Threshold model:
//   Material when |deltaAmount| >= absoluteThreshold
//          OR    |deltaPercent| >= percentThreshold
//   Otherwise IMMATERIAL.
//
// Division-by-zero: when |priorAmount| = 0, deltaPercent is null —
// rendered as "new account" downstream. Such lines fall back to the
// absoluteThreshold gate only; if the $ delta breaches, they're
// material (NEEDS_COMMENT); otherwise IMMATERIAL.

import { Decimal } from "decimal.js";
import type { Prisma, PrismaClient, FluxLineStatus, AccountType } from "@prisma/client";

import {
  getTrialBalance,
  type TrialBalanceRow,
} from "@/lib/accounting/reports";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface FluxAnalysisLine {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  priorAmount: Decimal;
  currentAmount: Decimal;
  deltaAmount: Decimal;
  /** Null when |priorAmount| = 0 (division-by-zero / new-account case). */
  deltaPercent: Decimal | null;
  /** Initial status the persistence layer will write. */
  status: FluxLineStatus;
}

export interface FluxAnalysisResult {
  lines: FluxAnalysisLine[];
  /** Counts so the page header can render "12 material / 47 total". */
  totalLines: number;
  materialLines: number;
}

interface Args {
  tenantId: string;
  entityCode: string;
  bookCode: string;
  /**
   * The `asOf` date for the FROM trial balance (typically prior
   * period.endsOn). The helper is period-agnostic — it just consumes
   * two TB snapshots. The Server Action resolves periods → endsOn.
   */
  asOfPrior: Date;
  asOfCurrent: Date;
  absoluteThreshold: Decimal;
  percentThreshold: Decimal;
}

export async function getFluxAnalysis(
  prisma: DbClient,
  args: Args
): Promise<FluxAnalysisResult> {
  const scope = {
    entityCode: args.entityCode,
    bookCode: args.bookCode,
    tenantId: args.tenantId,
  };

  // Two trial balances. Run in parallel — independent reads.
  const [priorTb, currentTb] = await Promise.all([
    getTrialBalance(prisma as PrismaClient, scope, args.asOfPrior),
    getTrialBalance(prisma as PrismaClient, scope, args.asOfCurrent),
  ]);

  // Index both by accountCode for the join. Each TB returns one row
  // per active account, so this is O(N). We need the accountId for
  // the FluxLine FK — pull it from the underlying account table for
  // the union of codes we see.
  const priorByCode = new Map<string, TrialBalanceRow>();
  for (const r of priorTb.rows) priorByCode.set(r.accountCode, r);
  const currentByCode = new Map<string, TrialBalanceRow>();
  for (const r of currentTb.rows) currentByCode.set(r.accountCode, r);

  const allCodes = new Set<string>([
    ...priorByCode.keys(),
    ...currentByCode.keys(),
  ]);

  // Pull accountIds in one query. Codes can be entity-specific or
  // shared (entityId=null); we accept any matching code in the
  // tenant — the trial-balance dedup already collapsed the
  // entity-override-wins logic before reaching us.
  const accounts = await prisma.account.findMany({
    where: {
      tenantId: args.tenantId,
      code: { in: Array.from(allCodes) },
    },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      entityId: true,
    },
  });
  // Dedup the same way getTrialBalance does: entity-override wins
  // over shared (entityId=null) at the same code.
  const accountByCode = new Map<
    string,
    { id: string; name: string; type: AccountType; entityId: string | null }
  >();
  for (const a of accounts) {
    const existing = accountByCode.get(a.code);
    if (!existing || (a.entityId !== null && existing.entityId === null)) {
      accountByCode.set(a.code, {
        id: a.id,
        name: a.name,
        type: a.type,
        entityId: a.entityId,
      });
    }
  }

  // Build the lines.
  const lines: FluxAnalysisLine[] = [];
  let materialLines = 0;

  for (const code of allCodes) {
    const acct = accountByCode.get(code);
    if (!acct) continue; // shouldn't happen — TB just returned this code

    const prior = priorByCode.get(code);
    const current = currentByCode.get(code);
    const priorAmount = prior ? prior.balance : new Decimal(0);
    const currentAmount = current ? current.balance : new Decimal(0);

    // Skip rows that are flat-zero on both sides — no flux to review.
    if (priorAmount.isZero() && currentAmount.isZero()) continue;

    const deltaAmount = currentAmount.minus(priorAmount);

    // deltaPercent = (current − prior) / |prior| × 100.
    // Null when |prior| = 0 (new-account case).
    let deltaPercent: Decimal | null = null;
    if (!priorAmount.isZero()) {
      deltaPercent = deltaAmount.div(priorAmount.abs()).times(100);
    }

    // Materiality classification.
    const overAbsolute = deltaAmount
      .abs()
      .greaterThanOrEqualTo(args.absoluteThreshold);
    const overPercent =
      deltaPercent !== null &&
      deltaPercent.abs().greaterThanOrEqualTo(args.percentThreshold);
    const material = overAbsolute || overPercent;
    const status: FluxLineStatus = material ? "NEEDS_COMMENT" : "IMMATERIAL";
    if (material) materialLines++;

    lines.push({
      accountId: acct.id,
      accountCode: code,
      accountName: acct.name,
      accountType: acct.type,
      priorAmount,
      currentAmount,
      deltaAmount,
      deltaPercent,
      status,
    });
  }

  // Sort by absolute delta DESC so the biggest swings surface first
  // — consistent with the recon list's UX.
  lines.sort((a, b) => b.deltaAmount.abs().comparedTo(a.deltaAmount.abs()));

  return {
    lines,
    totalLines: lines.length,
    materialLines,
  };
}
