// ASC 830 current-rate translation of one entity's trial balance —
// Phase B of the consolidation-translation arc.
//
// THE rule this module exists to honor (#151 postmortem): translation
// starts from the per-line FUNCTIONAL amounts Phase A (#334) stores,
// never from the stored debit/credit pair — those are the book's
// reporting view, already converted at transaction-date rates, and
// multiplying them by a period-end rate double-applies FX. The pinned
// example: 1000 GBP posted at 1.20 stores 1200; the translated balance
// at a 1.30 close is 1000 × 1.30 = 1300, not 1200 × 1.30 = 1560.
//
// A pleasant corollary: FX revaluation entries (which true the
// REPORTING view of monetary items and stamp functionalAmount 0 on
// foreign-functional entities) vanish from translation entirely — both
// legs are functionally zero — so the temporal-method true-up can never
// compound into the current-rate view (#151's 1690 case).
//
// Per-account rates come from the merged Phase 4a/4b groundwork:
// `Account.translationCategory` (null → CURRENT_RATE, the documented
// default) resolved through `getTranslationRate`:
//   CURRENT_RATE  → CLOSE rate at periodEnd
//   WEIGHTED_AVG  → mean of CLOSE at periodStart and periodEnd
//   HISTORICAL    → per-line: functionalAmount × CLOSE at that line's
//                   documentDate (equity frozen at contribution rates)
//   EXCLUDED      → 1
// Missing rates throw FxRateNotFoundError — a translated statement at
// a guessed rate is worse than an error.
//
// CTA sign convention, re-derived (do NOT copy #151's doc — its sign
// text was inverted relative to its own balancing code): after
// translating every account at its category rate, the entity's
// translated TB no longer balances; the plug that restores balance IS
// the cumulative translation adjustment. We report it CREDIT-POSITIVE
// (its natural equity presentation):
//
//   ctaCreditPositive = Σ translated signed balances (debit-positive)
//
// Worked example: net assets 1000 GBP translated at a 1.30 close =
// 1300 DR; the revenue that created them translated at a 1.25 average
// = 1250 CR; Σ signed = +50 → CTA +50 credit. Rising rate on positive
// net assets → positive CTA. Falling rate flips the sign symmetrically.

import { Decimal } from "@/lib/utils/decimal";
import type { AccountType } from "@prisma/client";

import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import { getTranslationRate, resolveFxRate } from "@/lib/accounting/fx";
import { indexEntityScopedByCode } from "@/lib/accounting/entity-scope";
import type { DbClient } from "@/lib/db";


export interface TranslatedRow {
  accountCode: string;
  accountName: string;
  type: AccountType;
  /** Translated into the book's reporting currency. */
  debit: Decimal;
  credit: Decimal;
}

export interface TranslatedEntityTb {
  rows: TranslatedRow[];
  /** The balancing plug, credit-positive (equity presentation). */
  ctaCreditPositive: Decimal;
  /** CLOSE rate at periodEnd (the CURRENT_RATE rate) — for display. */
  currentRate: Decimal;
}

export async function getTranslatedTrialBalance(
  prisma: DbClient,
  input: {
    tenantId: string;
    entityId: string;
    functionalCurrencyId: string;
    bookId: string;
    reportingCurrencyId: string;
    periodStart: Date;
    asOf: Date;
  }
): Promise<TranslatedEntityTb> {
  // Same scoping discipline as every other report: tenant-pinned
  // accounts, entity-scoped-or-shared, ledger-effective entries only.
  const accounts = await prisma.account.findMany({
    where: {
      tenantId: input.tenantId,
      active: true,
      OR: [{ entityId: null }, { entityId: input.entityId }],
    },
    select: {
      id: true,
      code: true,
      name: true,
      type: true,
      entityId: true,
      translationCategory: true,
    },
    orderBy: { code: "asc" },
  });

  // Entity-specific shadows shared (same dedup rule as getTrialBalance).
  const byCode = indexEntityScopedByCode(accounts, input.entityId);
  const winning = [...byCode.values()];

  // ONE predicate, written once and reused by both passes below. If the
  // aggregate pass and the HISTORICAL detail pass ever disagreed about
  // which lines are in scope, the two halves of the same trial balance
  // would be drawn from different ledgers.
  const lineScope = {
    tenantId: input.tenantId,
    accountId: { in: winning.map((a) => a.id) },
    entry: {
      entityId: input.entityId,
      bookId: input.bookId,
      documentDate: { lte: input.asOf },
      status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
    },
  };

  const ctx = {
    fromCurrencyId: input.functionalCurrencyId,
    toCurrencyId: input.reportingCurrencyId,
    periodStart: input.periodStart,
    periodEnd: input.asOf,
  };

  // One rate lookup per category per run; HISTORICAL adds a per-date
  // cache for the line walk.
  const categoryRateCache = new Map<string, Decimal | null>();
  const historicalRateCache = new Map<string, Decimal>();

  async function rateForCategory(category: string): Promise<Decimal | null> {
    if (!categoryRateCache.has(category)) {
      const r = await getTranslationRate(prisma, {
        category: category as "CURRENT_RATE" | "HISTORICAL" | "WEIGHTED_AVG" | "EXCLUDED",
        ctx,
      });
      categoryRateCache.set(category, r.rate);
    }
    return categoryRateCache.get(category)!;
  }

  async function historicalRate(date: Date): Promise<Decimal> {
    const key = date.toISOString().slice(0, 10);
    if (!historicalRateCache.has(key)) {
      const r = await resolveFxRate(prisma, {
        fromCurrency: input.functionalCurrencyId,
        toCurrency: input.reportingCurrencyId,
        asOf: date,
        rateType: "CLOSE",
      });
      historicalRateCache.set(key, r.rate);
    }
    return historicalRateCache.get(key)!;
  }

  // Pass 1 — the functional balance per account, summed in Postgres.
  // Every category except HISTORICAL needs nothing else: one rate times
  // one balance. Loading the underlying lines to add them up in JS was
  // the whole cost of this report on a real ledger.
  const sums =
    winning.length === 0
      ? []
      : await prisma.journalLine.groupBy({
          by: ["accountId"],
          where: lineScope,
          _sum: { functionalAmount: true },
        });
  const balanceByAccount = new Map<string, Decimal>();
  for (const s of sums) {
    balanceByAccount.set(
      s.accountId,
      new Decimal((s._sum.functionalAmount ?? 0).toString())
    );
  }

  // Pass 2 — resolve each account's rate, in code order and ONLY for
  // accounts that actually have activity. That restriction is load-
  // bearing, not an optimization: a chart may classify an account
  // WEIGHTED_AVG that nobody has posted to, and resolving its rate
  // would raise FxRateNotFoundError over a period-start rate the
  // statement does not depend on.
  const rateByAccount = new Map<string, Decimal | null>();
  for (const acct of winning) {
    if (!balanceByAccount.has(acct.id)) continue;
    // The documented Phase 4a default: null → CURRENT_RATE.
    rateByAccount.set(
      acct.id,
      await rateForCategory(acct.translationCategory ?? "CURRENT_RATE")
    );
  }

  // Pass 3 — lines, for the HISTORICAL accounts alone. A null rate is
  // the signal that no single per-account rate is meaningful, so each
  // contribution has to be frozen at its own date's rate. Note this is
  // empty for a same-currency entity: getTranslationRate short-circuits
  // every category to 1, HISTORICAL included.
  const historicalIds = [...rateByAccount]
    .filter(([, rate]) => rate === null)
    .map(([id]) => id);
  const historicalLines = new Map<string, { amount: Decimal; date: Date }[]>();
  if (historicalIds.length > 0) {
    const lines = await prisma.journalLine.findMany({
      // Zero-functional lines contribute nothing by construction — this
      // is where the FX revaluation true-ups drop out (#151).
      where: { ...lineScope, accountId: { in: historicalIds }, functionalAmount: { not: 0 } },
      select: {
        accountId: true,
        functionalAmount: true,
        entry: { select: { documentDate: true } },
      },
      orderBy: { id: "asc" },
    });
    for (const l of lines) {
      const bucket = historicalLines.get(l.accountId) ?? [];
      bucket.push({
        amount: new Decimal(l.functionalAmount.toString()),
        date: l.entry.documentDate,
      });
      historicalLines.set(l.accountId, bucket);
    }
  }

  const rows: TranslatedRow[] = [];
  let signedTotal = new Decimal(0);

  for (const acct of winning) {
    const functionalBalance = balanceByAccount.get(acct.id);
    if (functionalBalance === undefined) continue;
    const rate = rateByAccount.get(acct.id)!;

    let translatedSigned: Decimal;
    if (rate === null) {
      translatedSigned = new Decimal(0);
      for (const line of historicalLines.get(acct.id) ?? []) {
        translatedSigned = translatedSigned.plus(
          line.amount.times(await historicalRate(line.date))
        );
      }
    } else {
      translatedSigned = functionalBalance.times(rate);
    }

    if (translatedSigned.isZero()) continue;

    rows.push({
      accountCode: acct.code,
      accountName: acct.name,
      type: acct.type,
      debit: translatedSigned.greaterThan(0) ? translatedSigned : new Decimal(0),
      credit: translatedSigned.lessThan(0) ? translatedSigned.negated() : new Decimal(0),
    });
    signedTotal = signedTotal.plus(translatedSigned);
  }

  const currentRate = await getTranslationRate(prisma, {
    category: "CURRENT_RATE",
    ctx,
  });

  return {
    rows,
    ctaCreditPositive: signedTotal,
    currentRate: currentRate.rate ?? new Decimal(1),
  };
}
