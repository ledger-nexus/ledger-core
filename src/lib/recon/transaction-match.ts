// Transaction matching inside a reconciliation — BlackLine parity.
//
// Until now a reconciliation compared two NUMBERS: the GL balance and a
// supporting balance (typed, or pulled from a sub-ledger). When they
// disagreed, the operator was told the size of the difference and
// nothing about its composition. Every real reconciliation works the
// other way round: you match the transactions, and whatever fails to
// match IS the difference, itemized.
//
// This module does that for accounts whose supporting detail the system
// already holds — bank accounts, whose statement lines land in
// BankTransaction via the feeds arc. It reuses that arc's matching
// convention rather than inventing a second one:
//
//   - Amount equality is EXACT. Money matching is not fuzzy; a $0.02
//     difference is a real difference and gets reported as two
//     unmatched items, not silently absorbed.
//   - Both sides are signed on the account's normal side
//     (lineMovementOnNormalSide), so a statement deposit and the GL
//     debit that records it carry the same sign.
//   - A match must fall inside a date window, because the same amount
//     recurring monthly is a different transaction, not this one.
//
// The output is the classic bank-rec breakdown:
//
//   matched            — both sides agree; nothing to explain
//   unmatchedGl        — in the books, not on the statement:
//                        outstanding checks, deposits in transit
//   unmatchedSupport   — on the statement, not in the books:
//                        bank fees, interest, anything unrecorded
//
// and `netUnmatched` = unmatchedGl − unmatchedSupport, which is exactly
// the GL-minus-statement difference the reconciliation is trying to
// explain. When it equals the recon's own difference, the itemization
// is complete: every dollar of disagreement has a name.
//
// v1 is AUTOMATIC matching only — the pairing is derived on read and
// nothing is persisted. A manual "these two are the same transaction"
// override needs a join table and an audit trail of who decided it;
// that is the natural next slice, and until it exists this module
// never claims a pairing a human disagreed with, because it has no way
// to record that they did.

import { Decimal } from "decimal.js";

import { lineMovementOnNormalSide } from "@/lib/banking/match";
import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import type { DbClient } from "@/lib/db";

/** Days either side of a statement line a GL entry may be dated. */
export const RECON_MATCH_WINDOW_DAYS = 10;

export interface MatchableItem {
  id: string;
  date: Date;
  /** Signed on the account's normal side: + means the balance went up. */
  amount: Decimal;
  description: string;
  /** Entry number for GL items; the bank's own reference for support. */
  reference?: string | null;
}

export interface MatchedPair {
  gl: MatchableItem;
  support: MatchableItem;
  /** Whole days between the two dates — surfaced so a 9-day-old match
   *  can be eyeballed rather than trusted blindly. */
  dayGap: number;
}

export interface TransactionMatchResult {
  matched: MatchedPair[];
  unmatchedGl: MatchableItem[];
  unmatchedSupport: MatchableItem[];
  /** Σ unmatchedGl − Σ unmatchedSupport: the difference, itemized. */
  netUnmatched: Decimal;
}

function sum(items: MatchableItem[]): Decimal {
  return items.reduce((a, i) => a.plus(i.amount), new Decimal(0));
}

function dayGap(a: Date, b: Date): number {
  return Math.round(Math.abs(a.getTime() - b.getTime()) / 86_400_000);
}

/**
 * Pure matcher. Exact amounts, one-to-one, nearest date wins.
 *
 * Deterministic by construction: statement lines are walked oldest
 * first, and among equally-close candidates the earliest GL item wins.
 * Two runs over the same data produce the same pairing, which matters
 * because an operator who signs off on a reconciliation must be able to
 * reopen it and see what they signed.
 */
export function matchTransactions(input: {
  glItems: MatchableItem[];
  supportItems: MatchableItem[];
  windowDays?: number;
}): TransactionMatchResult {
  const window = input.windowDays ?? RECON_MATCH_WINDOW_DAYS;
  const byDateThenId = (a: MatchableItem, b: MatchableItem) =>
    a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id);

  const gl = [...input.glItems].sort(byDateThenId);
  const support = [...input.supportItems].sort(byDateThenId);

  const claimed = new Set<string>();
  const matched: MatchedPair[] = [];

  for (const s of support) {
    let best: MatchableItem | undefined;
    let bestGap = Number.POSITIVE_INFINITY;
    for (const g of gl) {
      if (claimed.has(g.id)) continue;
      if (!g.amount.equals(s.amount)) continue;
      const gap = dayGap(g.date, s.date);
      if (gap > window) continue;
      // Strictly-less keeps the earliest of equally-close candidates,
      // since `gl` is already in date order.
      if (gap < bestGap) {
        best = g;
        bestGap = gap;
      }
    }
    if (best) {
      claimed.add(best.id);
      matched.push({ gl: best, support: s, dayGap: bestGap });
    }
  }

  const matchedSupportIds = new Set(matched.map((m) => m.support.id));
  const unmatchedGl = gl.filter((g) => !claimed.has(g.id));
  const unmatchedSupport = support.filter((s) => !matchedSupportIds.has(s.id));

  return {
    matched,
    unmatchedGl,
    unmatchedSupport,
    netUnmatched: sum(unmatchedGl).minus(sum(unmatchedSupport)),
  };
}

export interface ReconMatchView extends TransactionMatchResult {
  /** False when the account has no supporting detail the system holds —
   *  the card stays hidden rather than showing an empty match table. */
  available: boolean;
  supportLabel: string;
}

/**
 * Load both sides for a reconciliation and match them.
 *
 * The GL side is the account's own lines for the period, on the same
 * ledger-effective statuses every other balance uses — a pending entry
 * is not yet in the books, so it cannot reconcile against a statement.
 * The supporting side is the bank feed's statement lines for the same
 * account and window.
 */
export async function getReconTransactionMatch(
  prisma: DbClient,
  input: {
    tenantId: string;
    entityId: string;
    bookId: string;
    accountId: string;
    periodStart: Date;
    periodEnd: Date;
  }
): Promise<ReconMatchView> {
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, tenantId: input.tenantId },
    select: { isBank: true, normalBalance: true, code: true, name: true },
  });
  if (!account?.isBank) {
    return {
      available: false,
      supportLabel: "",
      matched: [],
      unmatchedGl: [],
      unmatchedSupport: [],
      netUnmatched: new Decimal(0),
    };
  }
  const normalIsDebit = account.normalBalance === "DEBIT";

  const [lines, statement] = await Promise.all([
    prisma.journalLine.findMany({
      where: {
        tenantId: input.tenantId,
        accountId: input.accountId,
        entry: {
          entityId: input.entityId,
          bookId: input.bookId,
          documentDate: { gte: input.periodStart, lte: input.periodEnd },
          status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
        },
      },
      select: {
        id: true,
        debit: true,
        credit: true,
        description: true,
        entry: { select: { entryNumber: true, documentDate: true, memo: true } },
      },
    }),
    prisma.bankTransaction.findMany({
      where: {
        tenantId: input.tenantId,
        entityId: input.entityId,
        bookId: input.bookId,
        bankAccountId: input.accountId,
        postedDate: { gte: input.periodStart, lte: input.periodEnd },
        // EXCLUDED lines were triaged as "not ours" — they are not
        // supporting detail and must not become reconciling items.
        status: { not: "EXCLUDED" },
      },
      select: {
        id: true,
        postedDate: true,
        amount: true,
        description: true,
        externalRef: true,
      },
    }),
  ]);

  const glItems: MatchableItem[] = lines.map((l) => ({
    id: l.id,
    date: l.entry.documentDate,
    amount: lineMovementOnNormalSide(
      new Decimal(l.debit.toString()),
      new Decimal(l.credit.toString()),
      normalIsDebit
    ),
    description: l.description ?? l.entry.memo,
    reference: l.entry.entryNumber,
  }));

  const supportItems: MatchableItem[] = statement.map((s) => ({
    id: s.id,
    date: s.postedDate,
    amount: new Decimal(s.amount.toString()),
    description: s.description,
    reference: s.externalRef,
  }));

  return {
    available: true,
    supportLabel: `Bank statement lines (${statement.length})`,
    ...matchTransactions({ glItems, supportItems }),
  };
}
