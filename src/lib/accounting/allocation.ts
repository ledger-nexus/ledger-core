// Allocation schedules — NetSuite dynamic-allocation parity, run
// through the recurring pipeline.
//
// An ALLOCATION template clears its source account's activity for the
// run window into target lines by fixed percentage. The classic close
// task: overhead accumulates in 6100 all month; on month-end the
// schedule moves it to department expense accounts 60/30/10.
//
// Deterministic by construction, which is what lets it stay AUTO under
// the automation constitution:
//   - window     = [first day of docDate's month, docDate] — anchor
//     allocation schedules to month-end and the window is the month.
//   - activity   = Σ (debit − credit) over ledger-effective lines on
//     the source account in the window, entity+book scoped. Zero →
//     nothing to allocate; the run date is marked done, no entry posts.
//   - amounts    = activity × percent/100, rounded to 2dp, with the
//     LAST target taking the remainder so the targets sum to the
//     activity exactly (penny invariant — no rounding leakage).
//   - the entry  = targets on the SAME side as the activity, source on
//     the opposite side for the total, so the source nets to zero for
//     the window and the targets carry it.
//   - percents must sum to exactly 100 — validated at template
//     creation AND re-checked here, because a drifted template must
//     refuse rather than silently allocate a fraction.

import { Decimal } from "decimal.js";
import type { PrismaClient, Prisma } from "@prisma/client";

import { LEDGER_EFFECTIVE_STATUSES } from "./types";
import { pickEntityScoped } from "./entity-scope";

type DbClient = PrismaClient | Prisma.TransactionClient;

export class AllocationTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AllocationTemplateError";
  }
}

export interface AllocationTarget {
  accountCode: string;
  /** 0–100. */
  percent: Decimal;
  description?: string | null;
}

export interface AllocationLine {
  accountCode: string;
  debit: Decimal;
  credit: Decimal;
  description?: string;
}

/** First day of the docDate's month — the run window opens here. */
export function allocationWindowStart(docDate: Date): Date {
  return new Date(Date.UTC(docDate.getUTCFullYear(), docDate.getUTCMonth(), 1));
}

/** True when `d` is the last day of its month (UTC). */
export function isMonthEnd(d: Date): boolean {
  const lastDay = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)
  ).getUTCDate();
  return d.getUTCDate() === lastDay;
}

/**
 * The window is [first of month, docDate], so a template anchored
 * anywhere but month-end allocates only part of each month and the
 * rest is never picked up by anything — silent under-allocation, the
 * worst failure a close task can have. v1 refuses instead: allocation
 * templates are month-end MONTHLY schedules (a quarterly cadence would
 * drop the quarter's first two months for the same reason). Enforced
 * at template creation AND here, because a template edited around the
 * action — a seed, a script, a restored row — must still refuse rather
 * than quietly allocate a fraction.
 *
 * Lifting this means deriving the window from the fiscal period rather
 * than the calendar month; the follow-up is noted in PROJECT_STATUS.
 */
export function assertMonthEndAnchor(docDate: Date): void {
  if (!isMonthEnd(docDate)) {
    throw new AllocationTemplateError(
      `Allocation runs must be anchored to month-end (got ${docDate.toISOString().slice(0, 10)}); ` +
        `a mid-month anchor would leave the rest of each month unallocated.`
    );
  }
}

/**
 * Pure: turn source activity + percent targets into balanced JE lines.
 * Returns [] when activity is zero (nothing to allocate — a no-op run,
 * not an error).
 */
export function computeAllocationLines(input: {
  sourceAccountCode: string;
  /** Signed, debit-positive, in the entry currency. */
  sourceActivity: Decimal;
  targets: AllocationTarget[];
}): AllocationLine[] {
  if (input.targets.length === 0) {
    throw new AllocationTemplateError("Allocation template has no target lines.");
  }
  const percentSum = input.targets.reduce(
    (a, t) => a.plus(t.percent),
    new Decimal(0)
  );
  if (!percentSum.equals(100)) {
    throw new AllocationTemplateError(
      `Allocation percents must sum to exactly 100 (got ${percentSum.toString()}).`
    );
  }
  if (input.targets.some((t) => t.percent.lessThanOrEqualTo(0))) {
    throw new AllocationTemplateError("Allocation percents must be positive.");
  }
  if (input.sourceActivity.isZero()) return [];

  const magnitude = input.sourceActivity.abs();
  // debit-side activity (net debits in the source) moves to target
  // DEBITS and a source CREDIT; credit-side activity flips both.
  const activityIsDebit = input.sourceActivity.greaterThan(0);

  const lines: AllocationLine[] = [];
  let allocated = new Decimal(0);
  input.targets.forEach((t, i) => {
    const isLast = i === input.targets.length - 1;
    // Last target takes the remainder: Σ portions === magnitude exactly.
    const portion = isLast
      ? magnitude.minus(allocated)
      : magnitude.times(t.percent).dividedBy(100).toDecimalPlaces(2);
    // Each non-last portion rounds independently, so on a pool small
    // relative to the target count they can round UP past the pool:
    // 0.05 across eight targets is 0.00625 each, which rounds to 0.01,
    // and the first seven already consume 0.07. The remainder would
    // then go negative and postJournalEntry would refuse it as a
    // negative amount — an error about the wrong thing. Refuse here,
    // in the vocabulary of what is actually wrong.
    if (portion.isNegative()) {
      throw new AllocationTemplateError(
        `Allocation of ${magnitude.toFixed(2)} across ${input.targets.length} targets rounds to more ` +
          `than the amount available — the pool is too small to split at these percents.`
      );
    }
    allocated = allocated.plus(portion);
    if (portion.isZero()) return;
    lines.push({
      accountCode: t.accountCode,
      debit: activityIsDebit ? portion : new Decimal(0),
      credit: activityIsDebit ? new Decimal(0) : portion,
      description: t.description ?? undefined,
    });
  });

  lines.push({
    accountCode: input.sourceAccountCode,
    debit: activityIsDebit ? new Decimal(0) : magnitude,
    credit: activityIsDebit ? magnitude : new Decimal(0),
    description: "Allocation clearing",
  });

  return lines;
}

/**
 * The source account's net activity (debit − credit) in
 * [windowStart, docDate] for the entity+book, ledger-effective entries
 * only. Tenant-pinned; entity-scoped account shadows a shared same-code
 * one (the standard chart dedup rule).
 */
export async function resolveSourceActivity(
  prisma: DbClient,
  input: {
    tenantId: string;
    entityId: string;
    bookId: string;
    sourceAccountCode: string;
    docDate: Date;
  }
): Promise<Decimal> {
  assertMonthEndAnchor(input.docDate);

  const candidates = await prisma.account.findMany({
    where: {
      tenantId: input.tenantId,
      code: input.sourceAccountCode,
      active: true,
      OR: [{ entityId: null }, { entityId: input.entityId }],
    },
    select: { id: true, entityId: true },
  });
  const account = pickEntityScoped(candidates, input.entityId);
  if (!account) {
    throw new AllocationTemplateError(
      `Allocation source account ${input.sourceAccountCode} not found.`
    );
  }

  const sums = await prisma.journalLine.aggregate({
    where: {
      tenantId: input.tenantId,
      accountId: account.id,
      entry: {
        entityId: input.entityId,
        bookId: input.bookId,
        documentDate: { gte: allocationWindowStart(input.docDate), lte: input.docDate },
        status: { in: [...LEDGER_EFFECTIVE_STATUSES] },
      },
    },
    _sum: { debit: true, credit: true },
  });
  const debit = new Decimal(sums._sum.debit?.toString() ?? "0");
  const credit = new Decimal(sums._sum.credit?.toString() ?? "0");
  return debit.minus(credit);
}
