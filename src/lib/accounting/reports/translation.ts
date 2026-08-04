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

import { Decimal } from "decimal.js";
import type { PrismaClient, Prisma, AccountType } from "@prisma/client";

import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import { getTranslationRate, resolveFxRate } from "@/lib/accounting/fx";
import { indexEntityScopedByCode } from "@/lib/accounting/entity-scope";

type DbClient = PrismaClient | Prisma.TransactionClient;

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
  // Per-account functional balances, with per-line dates kept for the
  // HISTORICAL walk. Same scoping discipline as every other report:
  // tenant-pinned accounts, entity-scoped-or-shared, ledger-effective
  // entries only.
  const accounts = await prisma.account.findMany({
    where: {
      tenantId: input.tenantId,
      active: true,
      OR: [{ entityId: null }, { entityId: input.entityId }],
    },
    select: {
      code: true,
      name: true,
      type: true,
      entityId: true,
      translationCategory: true,
      lines: {
        where: {
          entry: {
            entityId: input.entityId,
            bookId: input.bookId,
            documentDate: { lte: input.asOf },
            status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
          },
        },
        select: {
          functionalAmount: true,
          entry: { select: { documentDate: true } },
        },
      },
    },
    orderBy: { code: "asc" },
  });

  // Entity-specific shadows shared (same dedup rule as getTrialBalance).
  const byCode = indexEntityScopedByCode(accounts, input.entityId);

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

  const rows: TranslatedRow[] = [];
  let signedTotal = new Decimal(0);

  for (const acct of byCode.values()) {
    if (acct.lines.length === 0) continue;

    // The documented Phase 4a default: null → CURRENT_RATE.
    const category = acct.translationCategory ?? "CURRENT_RATE";
    const rate = await rateForCategory(category);

    let translatedSigned: Decimal;
    if (rate === null) {
      // HISTORICAL: each contribution frozen at its own date's rate.
      translatedSigned = new Decimal(0);
      for (const line of acct.lines) {
        const fn = new Decimal(line.functionalAmount.toString());
        if (fn.isZero()) continue;
        translatedSigned = translatedSigned.plus(
          fn.times(await historicalRate(line.entry.documentDate))
        );
      }
    } else {
      const functionalBalance = acct.lines.reduce(
        (a, l) => a.plus(new Decimal(l.functionalAmount.toString())),
        new Decimal(0)
      );
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
