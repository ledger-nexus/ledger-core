// Balance assertions — "this account held exactly this much on this date."
//
// postJournalEntry enforces correctness at the moment of WRITE (debits =
// credits, account validity, period close). This enforces correctness ACROSS
// TIME: drift that no single write would reject — a double-posted import, a
// missed reversal, a mapper regression — shows up here on the date it first
// appears, instead of surfacing at period close.
//
// Complementary to Reconciliation, not a replacement: reconciliation is the
// periodic, human, attested control (glBalance vs supportingBalance +
// sign-off); an assertion is the cheap machine tripwire you can run after
// every import.
//
// v1 is ADVISORY: this module only reports (and optionally caches) results. It
// deliberately does not block posting or period close — that gate is a later,
// separate decision.
//
// asOf is END of day: the observed balance includes every entry with
// documentDate <= asOf, which is exactly getTrialBalance's semantics, so this
// reuses that one query path rather than inventing a second notion of "the
// balance". (Beancount, where this idea comes from, asserts at the START of
// the date. The divergence is deliberate and load-bearing — mixing the two
// silently answers a different question than the reader expects.)

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { getTrialBalance } from "./reports";

const DEFAULT_BOOK = "US_GAAP";

export interface BalanceAssertionScope {
  /** Tenant the entity must belong to. Always pass it — see the lookup below. */
  tenantId: string;
  entityCode: string;
  bookCode?: string; // default "US_GAAP"
}

export interface AssertionCheckResult {
  assertionId: string;
  accountCode: string;
  currencyId: string;
  asOf: Date;
  /** As stated on the account's normal side. */
  expected: Decimal;
  observed: Decimal;
  tolerance: Decimal;
  /** observed − expected; sign tells you which way the drift runs. */
  delta: Decimal;
  status: "PASS" | "FAIL";
}

/**
 * Default tolerance = one unit of the currency's last decimal place
 * (USD/2 → 0.01, JPY/0 → 1). Rounding noise from FX or allocation should not
 * trip an assertion; a real posting error is always larger than this.
 */
export function defaultTolerance(decimals: number): Decimal {
  return new Decimal(10).pow(-decimals);
}

/**
 * Effective tolerance for an assertion: the explicit one when set, otherwise
 * derived from the currency's precision.
 */
export function resolveTolerance(
  explicit: Decimal | null | undefined,
  currencyDecimals: number
): Decimal {
  return explicit ?? defaultTolerance(currencyDecimals);
}

/**
 * The single definition of "is this assertion satisfied". Exported so the pad
 * flow decides whether there is anything to pad using exactly the same
 * comparison the checker uses — one notion of satisfied, not two.
 */
export function evaluateAssertion(
  expected: Decimal,
  observed: Decimal,
  tolerance: Decimal
): { delta: Decimal; status: "PASS" | "FAIL" } {
  const delta = observed.minus(expected);
  return {
    delta,
    status: delta.abs().lessThanOrEqualTo(tolerance) ? "PASS" : "FAIL",
  };
}

/**
 * Check every stored assertion for one (tenant, entity, book).
 *
 * Read-only unless `persist` is set, in which case the per-assertion result
 * cache is refreshed (the assertion rows themselves remain the durable fact).
 */
export async function checkBalanceAssertions(
  prisma: PrismaClient,
  scope: BalanceAssertionScope,
  opts: { asOf?: Date; persist?: boolean } = {}
): Promise<AssertionCheckResult[]> {
  const bookCode = scope.bookCode ?? DEFAULT_BOOK;

  // Tenant-pinned entity lookup. Entity codes are unique only per
  // (tenantId, code), so an unpinned findFirst can resolve a DIFFERENT
  // tenant's entity and silently check the wrong books.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: scope.entityCode, tenantId: scope.tenantId },
    select: { id: true },
  });
  if (!entity) return [];

  const book = await prisma.book.findUnique({
    where: { code: bookCode },
    select: { id: true },
  });
  if (!book) return [];

  const assertions = await prisma.balanceAssertion.findMany({
    where: {
      tenantId: scope.tenantId,
      entityId: entity.id,
      bookId: book.id,
      ...(opts.asOf ? { asOf: { lte: opts.asOf } } : {}),
    },
    include: { account: { select: { code: true } } },
    orderBy: [{ asOf: "asc" }],
  });
  if (assertions.length === 0) return [];

  // Currency precision drives the default tolerance.
  const currencyIds = Array.from(new Set(assertions.map((a) => a.currencyId)));
  const currencies = await prisma.currency.findMany({
    where: { code: { in: currencyIds } },
    select: { code: true, decimals: true },
  });
  const decimalsByCurrency = new Map(currencies.map((c) => [c.code, c.decimals]));

  // One trial balance per DISTINCT asOf date — assertions sharing a date share
  // the scan, so N assertions on one date cost one query, not N.
  const distinctDates = Array.from(
    new Set(assertions.map((a) => a.asOf.getTime()))
  ).map((t) => new Date(t));

  const balancesByDate = new Map<number, Map<string, Decimal>>();
  for (const d of distinctDates) {
    const tb = await getTrialBalance(
      prisma,
      { entityCode: scope.entityCode, bookCode, tenantId: scope.tenantId },
      d
    );
    balancesByDate.set(d.getTime(), new Map(tb.rows.map((r) => [r.accountCode, r.balance])));
  }

  const results: AssertionCheckResult[] = assertions.map((a) => {
    const byAccount = balancesByDate.get(a.asOf.getTime())!;
    // A missing row means the account carried no lines on/before asOf — a
    // genuine zero balance. v1 caveat: the trial-balance scan covers ACTIVE
    // accounts, so an assertion against a deactivated account reads as zero.
    const observed = byAccount.get(a.account.code) ?? new Decimal(0);
    const expected = new Decimal(a.expectedAmount.toString());
    const tolerance = resolveTolerance(
      a.tolerance != null ? new Decimal(a.tolerance.toString()) : null,
      decimalsByCurrency.get(a.currencyId) ?? 2
    );
    const { delta, status } = evaluateAssertion(expected, observed, tolerance);
    return {
      assertionId: a.id,
      accountCode: a.account.code,
      currencyId: a.currencyId,
      asOf: a.asOf,
      expected,
      observed,
      tolerance,
      delta,
      status,
    };
  });

  if (opts.persist) {
    const checkedAt = new Date();
    await prisma.$transaction(
      results.map((r) =>
        prisma.balanceAssertion.update({
          where: { id: r.assertionId },
          data: {
            lastCheckedAt: checkedAt,
            lastObservedAmount: r.observed.toFixed(4),
            lastStatus: r.status,
          },
        })
      )
    );
  }

  return results;
}
