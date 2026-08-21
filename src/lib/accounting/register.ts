// The account register: a page of postings, each with the running balance.
//
// ⚠️ WHY THIS IS NOT JUST `skip`/`take`. A register row's balance depends on
// every row before it, so a page cannot be computed from the page alone. The
// previous implementation solved that by fetching EVERY line ever posted to
// the account — with its entry and party joins — accumulating from zero, and
// then rendering `.slice(-250)`. Correct, and a query whose cost grows with
// the account's entire history to display a fixed 250 rows.
//
// It also meant the register **had no way back**: line 251 and older were
// unreachable from the page, with an honest "newest 250 of N" note and no
// control to go further. On a cash account that is the most ordinary request
// an accountant has — "show me last March".
//
// The fix is one aggregate instead of one full fetch. The balance before a
// window is `SUM(signed movement)` over the lines older than it, which
// Postgres computes without returning the rows. The window itself is `take`
// rows. Both are bounded.
//
// ⚠️ THE ORDERING KEY IS A TRIPLE, and the comparison has to respect all
// three. A register orders by `(documentDate, entryNumber, lineNo)`; comparing
// on `documentDate` alone gets same-day postings wrong, which is the common
// case — a single invoice posts several lines on one date. `olderThan` below
// is the lexicographic comparison spelled out, and the test seeds same-date
// ties precisely because a date-only version passes without them.

import type { Prisma } from "@prisma/client";

import { Decimal } from "@/lib/utils/decimal";

/** A row's position in register order. */
export interface RegisterKey {
  documentDate: Date;
  entryNumber: string;
  lineNo: number;
}

/** Oldest first — the order a running balance has to accumulate in. */
export const REGISTER_ORDER_BY: Prisma.JournalLineOrderByWithRelationInput[] = [
  { entry: { documentDate: "asc" } },
  { entry: { entryNumber: "asc" } },
  { lineNo: "asc" },
];

/**
 * Movement on the account's NORMAL side, so a positive number always reads as
 * "more of what this account normally holds": for a bank account
 * (debit-normal) a deposit raises it; for a credit card (credit-normal) a
 * charge raises it.
 */
export function signedMovement(
  debit: Prisma.Decimal | Decimal | string,
  credit: Prisma.Decimal | Decimal | string,
  normalIsDebit: boolean
): Decimal {
  const d = new Decimal(debit.toString());
  const c = new Decimal(credit.toString());
  return normalIsDebit ? d.minus(c) : c.minus(d);
}

/**
 * A `where` fragment matching every line STRICTLY OLDER than `key` in register
 * order — the lexicographic `(documentDate, entryNumber, lineNo) < key`.
 *
 * ⚠️ Each branch pins the fields to its left to equality. Dropping that turns
 * the comparison into "earlier date OR smaller entry number", which matches
 * lines from *later* dates that happen to have a smaller number, and the
 * opening balance silently includes rows that belong after the window.
 */
export function olderThan(key: RegisterKey): Prisma.JournalLineWhereInput {
  return {
    OR: [
      { entry: { documentDate: { lt: key.documentDate } } },
      {
        entry: { documentDate: key.documentDate, entryNumber: { lt: key.entryNumber } },
      },
      {
        entry: { documentDate: key.documentDate, entryNumber: key.entryNumber },
        lineNo: { lt: key.lineNo },
      },
    ],
  };
}

export interface MovementRow {
  debit: Prisma.Decimal | Decimal | string;
  credit: Prisma.Decimal | Decimal | string;
}

/**
 * Attach a running balance to a window of lines given in OLDEST-FIRST order,
 * starting from the balance immediately before the window.
 *
 * Returns the same order it was given; the page decides whether to reverse for
 * display. Pure — the aggregate that produces `opening` is the caller's job,
 * which is what makes this testable against a naive full accumulation.
 */
export function withRunningBalance<T extends MovementRow>(
  lines: readonly T[],
  opening: Decimal,
  normalIsDebit: boolean
): { line: T; debit: Decimal; credit: Decimal; balance: Decimal }[] {
  let running = opening;
  return lines.map((line) => {
    const debit = new Decimal(line.debit.toString());
    const credit = new Decimal(line.credit.toString());
    running = running.plus(signedMovement(debit, credit, normalIsDebit));
    return { line, debit, credit, balance: running };
  });
}

/** `_sum` of a debit/credit aggregate, on the account's normal side. */
export function balanceFromSums(
  sums: { debit: Prisma.Decimal | null; credit: Prisma.Decimal | null },
  normalIsDebit: boolean
): Decimal {
  // ⚠️ `_sum` is null when NO rows matched — an empty aggregate, not a zero
  // balance in the data. Both mean zero here, but `new Decimal(null)` throws.
  return signedMovement(sums.debit ?? "0", sums.credit ?? "0", normalIsDebit);
}
