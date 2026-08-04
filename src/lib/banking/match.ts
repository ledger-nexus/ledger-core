// Match a bank-feed line to an EXISTING journal entry.
//
// If the books already recorded this money — a manual JE, a recurring
// posting — then categorizing the feed line would post it twice. Matching
// instead links the line to the entry that already carries it: the line
// leaves the inbox, and nothing new posts. This is the "Match" half of
// QBO's Add/Match/Exclude triage.
//
// A candidate is a journal entry in the same (entity, book) with a line on
// the SAME bank account whose signed movement equals the feed line's
// amount, dated within a window of the feed date, and not already claimed
// by another feed line. Equality is exact — money matching is not fuzzy —
// and the signed comparison uses the account's normal side, the same
// convention as the feed amount and the register.

import { Decimal } from "decimal.js";
import { LEDGER_EFFECTIVE_STATUSES } from "@/lib/accounting/types";
import type { PrismaClient } from "@prisma/client";

export const MATCH_WINDOW_DAYS = 10;

export interface MatchCandidate {
  entryId: string;
  entryNumber: string;
  documentDate: Date;
  memo: string;
}

/**
 * Signed movement of a JE line on the account's normal side — positive
 * means the account's balance went up. Mirrors the register's running-
 * balance math and ParsedBankRow.amount, so feed amounts and line
 * movements are directly comparable.
 */
export function lineMovementOnNormalSide(
  debit: Decimal,
  credit: Decimal,
  normalIsDebit: boolean
): Decimal {
  return normalIsDebit ? debit.minus(credit) : credit.minus(debit);
}

export async function findMatchCandidates(
  prisma: PrismaClient,
  input: {
    tenantId: string;
    entityId: string;
    bookId: string;
    bankAccountId: string;
    bankNormalIsDebit: boolean;
    postedDate: Date;
    amount: Decimal; // feed sign convention: + = balance up
    limit?: number;
  }
): Promise<MatchCandidate[]> {
  const from = new Date(input.postedDate);
  from.setUTCDate(from.getUTCDate() - MATCH_WINDOW_DAYS);
  const to = new Date(input.postedDate);
  to.setUTCDate(to.getUTCDate() + MATCH_WINDOW_DAYS);

  const lines = await prisma.journalLine.findMany({
    where: {
      accountId: input.bankAccountId,
      entry: {
        tenantId: input.tenantId,
        entityId: input.entityId,
        bookId: input.bookId,
        documentDate: { gte: from, lte: to },
        status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
      },
    },
    select: {
      debit: true,
      credit: true,
      entry: {
        select: { id: true, entryNumber: true, documentDate: true, memo: true },
      },
    },
  });

  // Amount equality in JS (Decimal-exact), then drop entries another feed
  // line already claimed — one bank line per entry.
  const byAmount = lines.filter((l) =>
    lineMovementOnNormalSide(
      new Decimal(l.debit.toString()),
      new Decimal(l.credit.toString()),
      input.bankNormalIsDebit
    ).equals(input.amount)
  );
  if (byAmount.length === 0) return [];

  const entryIds = [...new Set(byAmount.map((l) => l.entry.id))];
  const claimed = await prisma.bankTransaction.findMany({
    where: { tenantId: input.tenantId, postedEntryId: { in: entryIds } },
    select: { postedEntryId: true },
  });
  const claimedIds = new Set(claimed.map((c) => c.postedEntryId));

  const seen = new Set<string>();
  const out: MatchCandidate[] = [];
  for (const l of byAmount) {
    if (claimedIds.has(l.entry.id) || seen.has(l.entry.id)) continue;
    seen.add(l.entry.id);
    out.push({
      entryId: l.entry.id,
      entryNumber: l.entry.entryNumber,
      documentDate: l.entry.documentDate,
      memo: l.entry.memo,
    });
  }
  // Nearest date first — the most plausible match leads.
  out.sort(
    (a, b) =>
      Math.abs(a.documentDate.getTime() - input.postedDate.getTime()) -
      Math.abs(b.documentDate.getTime() - input.postedDate.getTime())
  );
  return out.slice(0, input.limit ?? 3);
}
