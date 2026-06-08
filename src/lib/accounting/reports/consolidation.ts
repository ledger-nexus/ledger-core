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
import { getTranslationRate, type TranslationRateSource } from "../fx";
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
  /**
   * Each entity in the consolidation hierarchy + its functional currency.
   * The page surfaces a multi-currency-disclosure banner when the set of
   * currencies has more than one distinct value (see `hasMultiCurrency`).
   */
  entitiesIncluded: {
    code: string;
    name: string;
    isRoot: boolean;
    functionalCurrencyId: string;
  }[];
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

  /**
   * True iff the included entities have more than one distinct
   * functional currency. When true, AND Phase 4c translation didn't
   * run (translationActive=false), the consolidated totals are naïve
   * sums of debit/credit in each entity's own currency — the
   * disclosure banner appears.
   *
   * When translation IS active (translationActive=true), the totals
   * are accurate post-translation USD figures and the banner is
   * replaced with a "FX translation active" note.
   */
  hasMultiCurrency: boolean;
  /** The distinct currencies present in the included entities. */
  distinctCurrencies: string[];

  /**
   * v0.8 FX Phase 4c — set true when this report applied ASC 830
   * translation. False when same-currency (no translation needed) OR
   * when translation was skipped because the caller didn't pass
   * `periodStart` (needed for weighted-avg). When true, the page
   * replaces the disclosure banner with "FX translation active".
   */
  translationActive: boolean;
  /** Map of entity code → the current-rate (CR) rate used. Null for same-currency entities. */
  translationRateByEntity: Record<string, string | null>;
  /**
   * v0.8 FX Phase 4c — Cumulative Translation Adjustment. Computed as
   * the equity-side plug after translating each account at its ASC 830
   * category rate. Always Decimal(0) when translationActive=false.
   * Positive = net debit (FX loss / equity decrease), negative = net
   * credit (FX gain / equity increase). The page surfaces this as a
   * dedicated CTA line on the equity section.
   */
  cumulativeTranslationAdjustment: Decimal;
}

// ─── HISTORICAL account translator ────────────────────────────────────
//
// ASC 830 requires equity items (and any other HISTORICAL-classified
// account) to translate at the rate IN EFFECT WHEN THE CONTRIBUTION
// WAS ORIGINALLY POSTED — not the period-end rate. The balance in
// reporting currency is the accumulation of (lineAmount × lineFxRate)
// across every line that posted to the account.
//
// Implementation: query every JournalLine for (entity, book, account,
// documentDate ≤ asOf) including its parent JE's fxRate. Sum
// debit × fxRate and credit × fxRate. Returns the translated balance.
//
// Performance: one query per HISTORICAL row per entity per report run.
// Equity is sparse in real data (a handful of accounts at most) so
// this is acceptable. The Phase 4c rate cache (per-entity, per-
// category) handles the CR + WA hot paths; HISTORICAL is its own
// per-account query.
async function translateHistoricalAccount(
  prisma: PrismaClient,
  input: {
    entityId: string;
    bookCode: string;
    accountCode: string;
    asOf: Date;
  }
): Promise<{ debit: Decimal; credit: Decimal }> {
  const lines = await prisma.journalLine.findMany({
    where: {
      account: { code: input.accountCode },
      entry: {
        entityId: input.entityId,
        book: { code: input.bookCode },
        documentDate: { lte: input.asOf },
      },
    },
    select: {
      debit: true,
      credit: true,
      entry: { select: { fxRate: true } },
    },
  });
  let debit = new Decimal(0);
  let credit = new Decimal(0);
  for (const l of lines) {
    const rate = new Decimal(l.entry.fxRate.toString());
    // Prisma Decimals → decimal.js for arithmetic per CLAUDE.md.
    debit = debit.plus(new Decimal(l.debit.toString()).times(rate));
    credit = credit.plus(new Decimal(l.credit.toString()).times(rate));
  }
  return { debit, credit };
}

export async function getConsolidatedTrialBalance(
  prisma: PrismaClient,
  input: {
    rootEntityCode: string;
    bookCode?: string;
    asOf: Date;
    /**
     * v0.8 FX Phase 4c — period start. When provided, the consolidation
     * runs ASC 830 translation (CURRENT_RATE / WEIGHTED_AVG / HISTORICAL /
     * EXCLUDED per Account.translationCategory) and computes the CTA
     * plug. When omitted, the report falls back to the v1.0 naïve-sum
     * behavior + the multi-currency disclosure banner (PR #144).
     *
     * Required to apply WEIGHTED_AVG (income statement) translation,
     * which averages periodStart and periodEnd rates.
     */
    periodStart?: Date;
  }
): Promise<ConsolidationReport> {
  const bookCode = input.bookCode ?? "US_GAAP";

  // Resolve the root first so we can constrain the hierarchy walk to the
  // root's tenant. Without this, after Phase 4b composite-uniques allow
  // duplicate codes across tenants, an unscoped findMany would pull
  // entities from other tenants into the consolidation.
  const root = await prisma.legalEntity.findFirst({
    where: { code: input.rootEntityCode },
    select: {
      id: true,
      code: true,
      name: true,
      parentEntityId: true,
      tenantId: true,
      functionalCurrencyId: true,
    },
  });
  if (!root) {
    throw new Error(`Root entity ${input.rootEntityCode} not found`);
  }

  // Walk the entity hierarchy WITHIN the same tenant only. Cross-tenant
  // hierarchy traversal is not supported (would be a privacy violation).
  // functionalCurrencyId is pulled so we can compute hasMultiCurrency
  // for the disclosure banner — see ConsolidationReport.hasMultiCurrency.
  const allEntities = await prisma.legalEntity.findMany({
    where: { tenantId: root.tenantId },
    select: {
      id: true,
      code: true,
      name: true,
      parentEntityId: true,
      functionalCurrencyId: true,
    },
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

  // v0.8 FX Phase 4c — set up the translation layer. We look up the
  // book's reporting currency once, then translate per entity.
  // Translation only runs when:
  //   1. The caller passed `periodStart` (required for WEIGHTED_AVG)
  //   2. AT LEAST ONE entity has a functional currency != book reporting
  //      currency (i.e., translation has work to do)
  // Otherwise we fall back to the v1.0 naïve-sum path and the page
  // surfaces the disclosure banner (Phase 4c → Phase 5 removes the
  // banner once translation is verified end-to-end).
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: bookCode },
    select: { reportingCurrencyId: true },
  });
  const bookReportingCurrencyId = book.reportingCurrencyId;
  const translationCanRun = !!input.periodStart;
  const needsTranslation = included.some(
    (e) => e.functionalCurrencyId !== bookReportingCurrencyId
  );
  const translationActive = translationCanRun && needsTranslation;

  // Account category lookup. Per Phase 4a, every account row has a
  // category. We fetch the categories for every account that appeared
  // in any entity's TB so the per-row translation logic can dispatch.
  const allAccountCodes = Array.from(
    new Set(
      perEntityTbs.flatMap((entry) => entry.tb.rows.map((r) => r.accountCode))
    )
  );
  const accountCategoryRows = translationActive
    ? await prisma.account.findMany({
        where: { code: { in: allAccountCodes } },
        select: { code: true, translationCategory: true },
      })
    : [];
  const categoryByCode = new Map(
    accountCategoryRows.map((a) => [a.code, a.translationCategory])
  );

  // Track the entity-level translation rate (CURRENT_RATE) we'd use
  // for the banner / page display. Null for same-currency entities.
  const translationRateByEntity: Record<string, string | null> = {};

  // Cache rates per (entity, category) within a single report run.
  // Same entity's CURRENT_RATE is re-used across every CR-classified
  // account on that entity — no point re-querying the FxRate table
  // for each row.
  const rateCache = new Map<string, { rate: Decimal | null; source: TranslationRateSource }>();
  async function rateFor(
    entityFunctionalCurrencyId: string,
    category: "CURRENT_RATE" | "HISTORICAL" | "WEIGHTED_AVG" | "EXCLUDED"
  ): Promise<{ rate: Decimal | null; source: TranslationRateSource }> {
    const cacheKey = `${entityFunctionalCurrencyId}|${category}`;
    const cached = rateCache.get(cacheKey);
    if (cached) return cached;
    const result = await getTranslationRate(prisma, {
      category,
      ctx: {
        fromCurrencyId: entityFunctionalCurrencyId,
        toCurrencyId: bookReportingCurrencyId,
        // periodStart defaults to asOf when omitted — non-translation
        // path returns rate=1 anyway via same-currency branch.
        periodStart: input.periodStart ?? input.asOf,
        periodEnd: input.asOf,
      },
    });
    rateCache.set(cacheKey, result);
    return result;
  }

  // Aggregate by accountCode. Each perEntity entry now carries the
  // POST-translation debit/credit (untranslated when translation
  // didn't run).
  type Aggregate = {
    code: string;
    name: string;
    type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
    isContra: boolean;
    perEntity: { entityCode: string; debit: Decimal; credit: Decimal }[];
  };
  const aggregates = new Map<string, Aggregate>();

  for (const { entity, tb } of perEntityTbs) {
    // Capture entity's CURRENT_RATE for the page display + result fields.
    // Done once per entity even when the entity has no rows.
    if (translationActive) {
      if (entity.functionalCurrencyId === bookReportingCurrencyId) {
        translationRateByEntity[entity.code] = null;
      } else {
        const cr = await rateFor(entity.functionalCurrencyId, "CURRENT_RATE");
        translationRateByEntity[entity.code] = cr.rate ? cr.rate.toString() : null;
      }
    } else {
      translationRateByEntity[entity.code] = null;
    }

    for (const row of tb.rows) {
      // Apply translation per Account.translationCategory. When
      // translation isn't active OR the entity is same-currency, the
      // rate is 1 (same_currency branch in getTranslationRate) and
      // multiplication is a no-op.
      let debit = row.debit;
      let credit = row.credit;
      if (translationActive) {
        const category = categoryByCode.get(row.accountCode) ?? "CURRENT_RATE";
        const { rate } = await rateFor(entity.functionalCurrencyId, category);
        if (rate !== null) {
          // CURRENT_RATE / WEIGHTED_AVG / EXCLUDED / same_currency path.
          debit = row.debit.times(rate);
          credit = row.credit.times(rate);
        } else if (
          entity.functionalCurrencyId !== bookReportingCurrencyId
        ) {
          // HISTORICAL path — walk each JE line for this (entity,
          // book, account) and translate at the line's source-JE
          // fxRate (the rate AT THE TIME the contribution was posted).
          // Equity items don't re-translate at period-end under
          // ASC 830; they stay frozen at the contribution rate. The
          // accumulation of those frozen rates IS the equity-side
          // balance in reporting currency.
          //
          // Same-currency case never enters this branch (rate=1 above);
          // we explicit-check to short-circuit anyway.
          const translated = await translateHistoricalAccount(prisma, {
            entityId: entity.id,
            bookCode,
            accountCode: row.accountCode,
            asOf: input.asOf,
          });
          debit = translated.debit;
          credit = translated.credit;
        }
        // Same-currency HISTORICAL: pass through untranslated. The
        // entity already records in reporting currency.
      }
      const existing = aggregates.get(row.accountCode);
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

  // Multi-currency disclosure data. After Phase 4c, the report can
  // ALSO translate accurately when translationActive=true — the page
  // chooses between disclosure banner (legacy path) and "FX
  // translation active" note based on translationActive.
  const distinctCurrencies = Array.from(
    new Set(included.map((e) => e.functionalCurrencyId))
  ).sort();

  // v0.8 FX Phase 4c — CTA (Cumulative Translation Adjustment).
  //
  // Mechanic: when ASC 830 translation runs, different rates apply to
  // different account categories (CR for BS, WA for IS, HR for equity).
  // The translated trial balance no longer balances even though the
  // source trial balances do (each in its own currency). The plug —
  // the amount needed to re-balance the consolidated TB — is the CTA,
  // a real economic effect of holding foreign-currency assets through
  // a rate change. It posts to equity in ASC 830 (specifically, OCI
  // → AOCI cumulative translation adjustment).
  //
  // Computation: CTA = consolTotalDebit - consolTotalCredit (post-
  // elimination). The CTA is added to the report as a synthetic
  // equity-side balancing entry; this doesn't post a JE (no fictional
  // line in the GL), it's a report-time aggregation only.
  let cumulativeTranslationAdjustment = new Decimal(0);
  if (translationActive) {
    cumulativeTranslationAdjustment = consolTotalDebit.minus(consolTotalCredit);
    if (!cumulativeTranslationAdjustment.isZero()) {
      // Adjust the report totals so the BS appears balanced. The CTA
      // line itself is what represents the adjustment — when displayed,
      // it appears in the equity section.
      if (cumulativeTranslationAdjustment.gt(0)) {
        // Debits exceed credits → CTA is a credit (equity increase
        // / FX gain). Post the credit to balance.
        consolTotalCredit = consolTotalCredit.plus(cumulativeTranslationAdjustment);
      } else {
        // Credits exceed debits → CTA is a debit (equity decrease
        // / FX loss). Post the debit.
        consolTotalDebit = consolTotalDebit.plus(
          cumulativeTranslationAdjustment.abs()
        );
      }
    }
  }

  return {
    rootEntityCode: root.code,
    rootEntityName: root.name,
    bookCode,
    asOf: input.asOf,
    entitiesIncluded: included.map((e) => ({
      code: e.code,
      name: e.name,
      isRoot: e.code === root.code,
      functionalCurrencyId: e.functionalCurrencyId,
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
    hasMultiCurrency: distinctCurrencies.length > 1,
    distinctCurrencies,
    translationActive,
    translationRateByEntity,
    cumulativeTranslationAdjustment,
  };
}
