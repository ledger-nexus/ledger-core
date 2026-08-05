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
// MANUAL pairs win. Auto-matching handles the exact-amount,
// close-in-time cases; everything it cannot pair — a cheque split
// across two deposits, a fee posted net, a transposition — needs a
// person to say so. Those decisions live in `reconciliation_manual_match`
// with the deciding user against them, are applied here BEFORE the
// automatic pass, and remove both sides from consideration so the
// automatic pass can never contradict a human.

import { Decimal } from "@/lib/utils/decimal";

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
  /** A person decided this pairing; the card shows who and why. */
  manual?: { decidedBy: string; decidedAt: Date; note: string | null };
}

/** A persisted decision, keyed by the two ids it pairs. */
export interface ManualPair {
  journalLineId: string;
  bankTransactionId: string;
  decidedBy: string;
  decidedAt: Date;
  note: string | null;
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
  /** Applied first; both sides then sit out the automatic pass. */
  manualPairs?: ManualPair[];
}): TransactionMatchResult {
  const window = input.windowDays ?? RECON_MATCH_WINDOW_DAYS;
  const byDateThenId = (a: MatchableItem, b: MatchableItem) =>
    a.date.getTime() - b.date.getTime() || a.id.localeCompare(b.id);

  const gl = [...input.glItems].sort(byDateThenId);
  const support = [...input.supportItems].sort(byDateThenId);

  const claimed = new Set<string>();
  const matched: MatchedPair[] = [];

  // Human decisions first. Amounts are NOT required to agree — that is
  // the entire point of a manual match, and it is why the difference
  // the reconciliation reports still comes out right: an unequal pair
  // simply nets whatever it nets, and netUnmatched excludes both sides.
  const glById = new Map(gl.map((g) => [g.id, g]));
  const supportById = new Map(support.map((s) => [s.id, s]));
  const manuallyPairedSupport = new Set<string>();
  for (const m of input.manualPairs ?? []) {
    const g = glById.get(m.journalLineId);
    const sup = supportById.get(m.bankTransactionId);
    // A decision whose rows have left the window is not applied — but
    // it is not deleted either; it applies again if they return.
    if (!g || !sup) continue;
    claimed.add(g.id);
    manuallyPairedSupport.add(sup.id);
    matched.push({
      gl: g,
      support: sup,
      dayGap: dayGap(g.date, sup.date),
      manual: { decidedBy: m.decidedBy, decidedAt: m.decidedAt, note: m.note },
    });
  }

  for (const s of support) {
    if (manuallyPairedSupport.has(s.id)) continue;
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
    /** Supplied to load this recon's manual decisions. */
    reconciliationId?: string;
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

  const manualRows = input.reconciliationId
    ? await prisma.reconciliationManualMatch.findMany({
        where: {
          tenantId: input.tenantId,
          reconciliationId: input.reconciliationId,
        },
        select: {
          journalLineId: true,
          bankTransactionId: true,
          decidedAt: true,
          note: true,
          decidedBy: { select: { displayName: true, email: true } },
        },
      })
    : [];

  const manualPairs: ManualPair[] = manualRows.map((m) => ({
    journalLineId: m.journalLineId,
    bankTransactionId: m.bankTransactionId,
    decidedBy: m.decidedBy.displayName ?? m.decidedBy.email,
    decidedAt: m.decidedAt,
    note: m.note,
  }));

  return {
    available: true,
    supportLabel: `Bank statement lines (${statement.length})`,
    ...matchTransactions({ glItems, supportItems, manualPairs }),
  };
}
