// postJournalEntry: the single entry point for writing to the ledger.
//
// This function is the most important code in the project. Everything else
// (rev rec engine, bank recon, manual entries) MUST go through here. The
// guarantees this function provides are the guarantees the whole system has.
//
// Guarantees:
//   1. Debits equal credits, summed across all lines (UnbalancedEntryError if not).
//   2. Each line has exactly one of debit/credit (InvalidLineError if not).
//   3. All amounts are non-negative.
//   4. All referenced accounts exist and are active (UnknownAccountError if not).
//   5. The write is atomic — partial entries are impossible.
//   6. entryNumber is auto-assigned and monotonically increasing.
//
// If you find yourself writing a feature that needs to bypass this function,
// stop. The feature is wrong.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import {
  JournalEntryInput,
  UnbalancedEntryError,
  InvalidLineError,
  UnknownAccountError,
} from "./types";

// Configure Decimal.js for accounting:
//   - 28 digits of precision (way more than we'll ever need)
//   - ROUND_HALF_EVEN (banker's rounding — the GAAP-friendly default)
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_EVEN });

function toDecimal(v: Decimal | string | number | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export async function postJournalEntry(
  prisma: PrismaClient,
  input: JournalEntryInput
): Promise<{ id: string; entryNumber: string }> {
  if (input.lines.length < 2) {
    throw new InvalidLineError(
      `Journal entry must have at least 2 lines (got ${input.lines.length})`
    );
  }

  // Validate each line and compute totals.
  let debitTotal = new Decimal(0);
  let creditTotal = new Decimal(0);

  const normalizedLines = input.lines.map((line, idx) => {
    const debit = toDecimal(line.debit);
    const credit = toDecimal(line.credit);

    if (debit.isNegative() || credit.isNegative()) {
      throw new InvalidLineError(
        `Line ${idx}: amounts must be non-negative (got debit=${debit}, credit=${credit})`
      );
    }

    const debitPositive = debit.greaterThan(0);
    const creditPositive = credit.greaterThan(0);

    if (debitPositive && creditPositive) {
      throw new InvalidLineError(
        `Line ${idx}: cannot have both debit and credit non-zero`
      );
    }
    if (!debitPositive && !creditPositive) {
      throw new InvalidLineError(`Line ${idx}: must have either debit or credit`);
    }

    debitTotal = debitTotal.plus(debit);
    creditTotal = creditTotal.plus(credit);

    return {
      accountCode: line.accountCode,
      debit,
      credit,
      description: line.description,
    };
  });

  // The headline invariant: debits = credits.
  // We compare with .equals() rather than === because Decimal instances are objects.
  if (!debitTotal.equals(creditTotal)) {
    throw new UnbalancedEntryError(debitTotal, creditTotal);
  }

  // Resolve account codes to IDs. One query per entry, not per line.
  const codes = normalizedLines.map((l) => l.accountCode);
  const accounts = await prisma.account.findMany({
    where: { code: { in: codes }, active: true },
    select: { id: true, code: true },
  });

  const codeToId = new Map(accounts.map((a) => [a.code, a.id]));
  for (const line of normalizedLines) {
    if (!codeToId.has(line.accountCode)) {
      throw new UnknownAccountError(line.accountCode);
    }
  }

  // Atomic write. If anything in here fails, nothing is persisted.
  return await prisma.$transaction(async (tx) => {
    // Get next entry number. Using a count is fine at portfolio scale;
    // in production you'd use a sequence or a dedicated counter table.
    const count = await tx.journalEntry.count();
    const entryNumber = `JE-${String(count + 1).padStart(5, "0")}`;

    const entry = await tx.journalEntry.create({
      data: {
        entryNumber,
        date: input.date,
        memo: input.memo,
        source: input.source ?? "MANUAL",
        lines: {
          create: normalizedLines.map((l) => ({
            accountId: codeToId.get(l.accountCode)!,
            debit: l.debit.toFixed(4),
            credit: l.credit.toFixed(4),
            description: l.description,
          })),
        },
      },
    });

    return { id: entry.id, entryNumber: entry.entryNumber };
  });
}
