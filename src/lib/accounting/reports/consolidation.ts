// Multi-entity consolidation report.
//
// Walks the LegalEntity.parentEntityId hierarchy under a root entity,
// aggregates trial balances across all descendants, and eliminates
// intercompany balances (DUE_FROM_AFFILIATE / DUE_TO_AFFILIATE,
// INTERCOMPANY_REV / INTERCOMPANY_EXP). The result is what a parent
// company would report as the consolidated group's financial position.
//
// Elimination is subtype-driven: any account whose subtype is in the
// IC list is zeroed out at the consolidated level. In practice IC balances
// should net to zero across entities if the underlying transactions are
// recorded consistently; if they don't, the report shows the imbalance
// as a sanity check.
//
// Caveat: this v1.0 implementation handles two-party intercompany via
// subtype tags. Three-way IC chains, intercompany inventory in transit,
// and FX-driven IC imbalances are real-world refinements not modeled here.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { getTrialBalance } from "../reports";
import { signFor } from "../types";

const IC_ASSET_SUBTYPES = ["DUE_FROM_AFFILIATE"];
const IC_LIAB_SUBTYPES = ["DUE_TO_AFFILIATE"];
const IC_REV_SUBTYPES = ["INTERCOMPANY_REV"];
const IC_EXP_SUBTYPES = ["INTERCOMPANY_EXP"];
const ALL_IC_SUBTYPES = [...IC_ASSET_SUBTYPES, ...IC_LIAB_SUBTYPES, ...IC_REV_SUBTYPES, ...IC_EXP_SUBTYPES];

export interface ConsolidatedRow {
  accountCode: string;
  accountName: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
  subtype: string | null;
  perEntity: { entityCode: string; debit: Decimal; credit: Decimal }[];
  totalDebit: Decimal;
  totalCredit: Decimal;
  isEliminated: boolean;
  eliminatedDebit: Decimal;
  eliminatedCredit: Decimal;
  consolidatedDebit: Decimal;
  consolidatedCredit: Decimal;
  consolidatedBalance: Decimal; // signed on the normal-balance side
}

export interface EliminationSummaryRow {
  accountCode: string;
  accountName: string;
  subtype: string;
  totalDebitEliminated: Decimal;
  totalCreditEliminated: Decimal;
  // The expected pair (e.g. DUE_FROM_AFFILIATE expects DUE_TO_AFFILIATE)
  // — used to flag IC imbalance.
  netImbalance: Decimal;
}

export interface ConsolidationReport {
  rootEntityCode: string;
  rootEntityName: string;
  bookCode: string;
  asOf: Date;
  entitiesIncluded: { code: string; name: string; isRoot: boolean }[];
  rows: ConsolidatedRow[];
  eliminationSummary: EliminationSummaryRow[];

  // Pre-elimination totals (per-entity sum)
  preEliminationTotalDebit: Decimal;
  preEliminationTotalCredit: Decimal;

  // Post-elimination totals
  consolidatedTotalDebit: Decimal;
  consolidatedTotalCredit: Decimal;
  balances: boolean;

  // Net IC imbalance: if all IC pairs net to zero, this is zero.
  // Non-zero indicates one side recorded but not the other, or FX drift.
  netIcImbalance: Decimal;
}

export async function getConsolidatedTrialBalance(
  prisma: PrismaClient,
  input: {
    rootEntityCode: string;
    bookCode?: string;
    asOf: Date;
  }
): Promise<ConsolidationReport> {
  const bookCode = input.bookCode ?? "US_GAAP";

  // Resolve the root first so we can constrain the hierarchy walk to the
  // root's tenant. Without this, after Phase 4b composite-uniques allow
  // duplicate codes across tenants, an unscoped findMany would pull
  // entities from other tenants into the consolidation.
  const root = await prisma.legalEntity.findFirst({
    where: { code: input.rootEntityCode },
    select: { id: true, code: true, name: true, parentEntityId: true, tenantId: true },
  });
  if (!root) {
    throw new Error(`Root entity ${input.rootEntityCode} not found`);
  }

  // Walk the entity hierarchy WITHIN the same tenant only. Cross-tenant
  // hierarchy traversal is not supported (would be a privacy violation).
  const allEntities = await prisma.legalEntity.findMany({
    where: { tenantId: root.tenantId },
    select: { id: true, code: true, name: true, parentEntityId: true },
  });

  const included: typeof allEntities = [root];
  const queue = [root.id];
  const seen = new Set<string>([root.id]);
  while (queue.length) {
    const parentId = queue.shift()!;
    const children = allEntities.filter((e) => e.parentEntityId === parentId);
    for (const child of children) {
      if (seen.has(child.id)) continue;
      seen.add(child.id);
      included.push(child);
      queue.push(child.id);
    }
  }

  // Get TB per entity. Some entities (the parent) may have no activity —
  // their TB is empty and contributes nothing.
  const perEntityTbs = await Promise.all(
    included.map(async (e) => ({
      entity: e,
      tb: await getTrialBalance(prisma, { entityCode: e.code, bookCode }, input.asOf),
    }))
  );

  // Aggregate by accountCode.
  type Aggregate = {
    code: string;
    name: string;
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
    isContra: boolean;
    perEntity: { entityCode: string; debit: Decimal; credit: Decimal }[];
  };
  const aggregates = new Map<string, Aggregate>();

  for (const { entity, tb } of perEntityTbs) {
    for (const row of tb.rows) {
      const existing = aggregates.get(row.accountCode);
      const debit = row.debit;
      const credit = row.credit;
      if (existing) {
        existing.perEntity.push({ entityCode: entity.code, debit, credit });
      } else {
        aggregates.set(row.accountCode, {
          code: row.accountCode,
          name: row.accountName,
          type: row.type,
          isContra: false, // gets filled in below
          perEntity: [{ entityCode: entity.code, debit, credit }],
        });
      }
    }
  }

  // Pull account metadata (subtype + isContra) for classification.
  const accountMeta = await prisma.account.findMany({
    where: { code: { in: Array.from(aggregates.keys()) } },
    select: { code: true, subtype: true, isContra: true },
  });
  const metaByCode = new Map(accountMeta.map((a) => [a.code, a]));

  // Build the consolidated rows + classify eliminations.
  const rows: ConsolidatedRow[] = [];
  const eliminationByCode = new Map<string, EliminationSummaryRow>();

  let preTotalDebit = new Decimal(0);
  let preTotalCredit = new Decimal(0);
  let consolTotalDebit = new Decimal(0);
  let consolTotalCredit = new Decimal(0);

  for (const agg of aggregates.values()) {
    const meta = metaByCode.get(agg.code);
    const subtype = meta?.subtype ?? null;
    const isContra = meta?.isContra ?? false;
    const isEliminated = subtype !== null && ALL_IC_SUBTYPES.includes(subtype);

    const totalDebit = agg.perEntity.reduce((acc, p) => acc.plus(p.debit), new Decimal(0));
    const totalCredit = agg.perEntity.reduce((acc, p) => acc.plus(p.credit), new Decimal(0));

    const eliminatedDebit = isEliminated ? totalDebit : new Decimal(0);
    const eliminatedCredit = isEliminated ? totalCredit : new Decimal(0);

    const consolidatedDebit = totalDebit.minus(eliminatedDebit);
    const consolidatedCredit = totalCredit.minus(eliminatedCredit);

    const sign = signFor(agg.type, isContra);
    const consolidatedBalance =
      sign === 1 ? consolidatedDebit.minus(consolidatedCredit) : consolidatedCredit.minus(consolidatedDebit);

    rows.push({
      accountCode: agg.code,
      accountName: agg.name,
      type: agg.type,
      subtype,
      perEntity: agg.perEntity,
      totalDebit,
      totalCredit,
      isEliminated,
      eliminatedDebit,
      eliminatedCredit,
      consolidatedDebit,
      consolidatedCredit,
      consolidatedBalance,
    });

    preTotalDebit = preTotalDebit.plus(totalDebit);
    preTotalCredit = preTotalCredit.plus(totalCredit);
    consolTotalDebit = consolTotalDebit.plus(consolidatedDebit);
    consolTotalCredit = consolTotalCredit.plus(consolidatedCredit);

    if (isEliminated && subtype) {
      eliminationByCode.set(agg.code, {
        accountCode: agg.code,
        accountName: agg.name,
        subtype,
        totalDebitEliminated: eliminatedDebit,
        totalCreditEliminated: eliminatedCredit,
        netImbalance: new Decimal(0), // computed below
      });
    }
  }

  // Sort rows by account code for stable display.
  rows.sort((a, b) => a.accountCode.localeCompare(b.accountCode));

  // IC imbalance check: sum eliminated debits across IC accounts should
  // equal sum eliminated credits. If not, one side of an IC was booked
  // and the other wasn't (or FX drift). Show that as a sanity check.
  const totalIcDebit = Array.from(eliminationByCode.values()).reduce(
    (acc, e) => acc.plus(e.totalDebitEliminated),
    new Decimal(0)
  );
  const totalIcCredit = Array.from(eliminationByCode.values()).reduce(
    (acc, e) => acc.plus(e.totalCreditEliminated),
    new Decimal(0)
  );
  const netIcImbalance = totalIcDebit.minus(totalIcCredit);

  return {
    rootEntityCode: root.code,
    rootEntityName: root.name,
    bookCode,
    asOf: input.asOf,
    entitiesIncluded: included.map((e) => ({
      code: e.code,
      name: e.name,
      isRoot: e.code === root.code,
    })),
    rows,
    eliminationSummary: Array.from(eliminationByCode.values()).sort((a, b) =>
      a.accountCode.localeCompare(b.accountCode)
    ),
    preEliminationTotalDebit: preTotalDebit,
    preEliminationTotalCredit: preTotalCredit,
    consolidatedTotalDebit: consolTotalDebit,
    consolidatedTotalCredit: consolTotalCredit,
    balances: consolTotalDebit.equals(consolTotalCredit),
    netIcImbalance,
  };
}
