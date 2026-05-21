// Lease sub-ledger (ASC 842 / IFRS 16).
//
// Operational scope for v0.3: createLease + book-aware classification.
// Full amortization (ROU asset, lease liability roll-forward, interest
// expense) is stubbed via runLeaseStraightLineExpense — enough to seed a
// realistic operating lease for the portfolio demo. Full ASC 842 finance-
// lease mechanics arrive when the consumer repo (or a real customer
// engagement) needs them.
//
// The book divergence story this sub-ledger enables:
//   - US_GAAP operating lease → ROU asset + lease liability + straight-line lease expense
//   - IFRS 16 → essentially the same as GAAP operating lease finance treatment
//   - US_TAX → cash basis, expense as paid; no ROU, no liability
// → That's a substantial book-tax difference that the book-tax-diff report
//   can surface as ASC 740 temporary differences.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../post-journal";

function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export interface LeaseBookSpec {
  bookCode: string;
  classification: "OPERATING" | "FINANCE" | "SHORT_TERM" | "TAX_CASH_BASIS" | "NONE";
  discountRate?: Decimal | string | number;
  rouAccountCode?: string;
  liabilityAccountCode?: string;
  expenseAccountCode?: string;
  interestAccountCode?: string;
}

export interface CreateLeaseInput {
  entityCode: string;
  code: string;
  description: string;
  lessorPartyCode?: string;
  leaseStartDate: Date;
  leaseEndDate: Date;
  paymentFrequency?: "MONTHLY" | "QUARTERLY" | "ANNUAL";
  paymentAmount: Decimal | string | number;
  currencyCode: string;
  books: LeaseBookSpec[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export async function createLease(
  prisma: PrismaClient,
  input: CreateLeaseInput
): Promise<{ id: string }> {
  const entity = await prisma.legalEntity.findUniqueOrThrow({
    where: { code: input.entityCode },
    select: { id: true },
  });
  const lessor = input.lessorPartyCode
    ? await prisma.party.findFirstOrThrow({
        where: {
          code: input.lessorPartyCode,
          OR: [{ entityId: null }, { entity: { code: input.entityCode } }],
        },
        select: { id: true },
      })
    : null;
  const bookRows = await prisma.book.findMany({
    where: { code: { in: input.books.map((b) => b.bookCode) } },
    select: { id: true, code: true },
  });
  const bookIdByCode = new Map(bookRows.map((b) => [b.code, b.id]));

  // Compute totalUndiscountedPayments from frequency + amount + duration.
  const months = monthsBetween(input.leaseStartDate, input.leaseEndDate);
  const periodsPerYear = input.paymentFrequency === "ANNUAL" ? 1 : input.paymentFrequency === "QUARTERLY" ? 4 : 12;
  const totalPeriods = Math.ceil((months / 12) * periodsPerYear);
  const totalUndiscounted = toDecimal(input.paymentAmount).times(totalPeriods);

  return await prisma.lease.create({
    data: {
      entityId: entity.id,
      code: input.code,
      description: input.description,
      lessorPartyId: lessor?.id,
      leaseStartDate: input.leaseStartDate,
      leaseEndDate: input.leaseEndDate,
      paymentFrequency: input.paymentFrequency ?? "MONTHLY",
      paymentAmount: toDecimal(input.paymentAmount).toFixed(4),
      totalUndiscountedPayments: totalUndiscounted.toFixed(4),
      currencyId: input.currencyCode,
      status: "ACTIVE",
      sourceSystem: input.sourceSystem,
      sourceRecordType: input.sourceRecordType,
      sourceRecordId: input.sourceRecordId,
      sourcePayload: (input.sourcePayload as any) ?? undefined,
      bookAttributes: {
        create: input.books.map((b) => {
          const bookId = bookIdByCode.get(b.bookCode);
          if (!bookId) throw new Error(`Book ${b.bookCode} not found`);
          return {
            bookId,
            classification: b.classification,
            discountRate: toDecimal(b.discountRate ?? 0).toFixed(6),
            rouAccountCode: b.rouAccountCode,
            liabilityAccountCode: b.liabilityAccountCode,
            expenseAccountCode: b.expenseAccountCode,
            interestAccountCode: b.interestAccountCode,
          };
        }),
      },
    },
    select: { id: true },
  });
}

function monthsBetween(start: Date, end: Date): number {
  if (end < start) return 0;
  const sy = start.getUTCFullYear();
  const sm = start.getUTCMonth();
  const ey = end.getUTCFullYear();
  const em = end.getUTCMonth();
  return (ey - sy) * 12 + (em - sm) + 1;
}

// Post one straight-line lease expense entry for the period [from, through]
// to the given (entity, book). Cash basis books (TAX_CASH_BASIS) skip
// straight-line and post cash-payment-equivalent expense.
//
// This is intentionally simple: a real ASC 842 implementation would
// separately amortize the ROU asset and reduce the lease liability with
// imputed interest. For v0.3 we treat operating + finance similarly with
// straight-line expense; the consumer repo can replace this with the
// full machinery when needed.
export async function runLeaseStraightLineExpense(
  prisma: PrismaClient,
  input: {
    entityCode: string;
    bookCode: string;
    throughDate: Date;
    source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
    cashAccountCode?: string; // for TAX_CASH_BASIS, where the credit goes
  }
): Promise<{ entriesPosted: number; totalExpense: Decimal }> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: input.bookCode },
    select: { id: true, reportingCurrencyId: true },
  });
  const leases = await prisma.lease.findMany({
    where: {
      entity: { code: input.entityCode },
      status: "ACTIVE",
    },
    include: {
      bookAttributes: { where: { bookId: book.id } },
    },
  });

  let entriesPosted = 0;
  let totalExpense = new Decimal(0);

  for (const lease of leases) {
    const attrs = lease.bookAttributes[0];
    if (!attrs) continue;
    if (attrs.classification === "NONE") continue;

    const start = lease.leaseStartDate;
    if (input.throughDate < start) continue;

    let amortizeFrom: Date;
    if (attrs.lastAmortizedThrough) {
      amortizeFrom = new Date(
        Date.UTC(
          attrs.lastAmortizedThrough.getUTCFullYear(),
          attrs.lastAmortizedThrough.getUTCMonth() + 1,
          1
        )
      );
    } else {
      amortizeFrom = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    }
    if (input.throughDate < amortizeFrom) continue;

    const months = monthsBetween(amortizeFrom, input.throughDate);
    if (months <= 0) continue;

    const expense = toDecimal(lease.paymentAmount).times(months);

    if (!attrs.expenseAccountCode) {
      throw new Error(`Lease ${lease.code} on book ${input.bookCode} has no expenseAccountCode`);
    }
    const creditAccountCode =
      attrs.classification === "TAX_CASH_BASIS"
        ? input.cashAccountCode ?? "1000"
        : attrs.liabilityAccountCode ?? attrs.rouAccountCode ?? "2100";

    await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode: input.bookCode,
      currencyCode: book.reportingCurrencyId,
      documentDate: input.throughDate,
      memo: `Lease expense thru ${input.throughDate.toISOString().slice(0, 10)} — ${lease.code}`,
      source: input.source ?? "SYSTEM",
      sourceRecordType: "LeaseAmortization",
      sourceRecordId: lease.id,
      extensions: {
        leaseCode: lease.code,
        leaseId: lease.id,
        classification: attrs.classification,
        monthsAmortized: months,
      },
      lines: [
        {
          accountCode: attrs.expenseAccountCode,
          debit: expense.toFixed(4),
          description: `Lease expense — ${lease.code}`,
        },
        {
          accountCode: creditAccountCode,
          credit: expense.toFixed(4),
          description: `${attrs.classification === "TAX_CASH_BASIS" ? "Cash" : "Lease liability"} — ${lease.code}`,
        },
      ],
    });

    await prisma.leaseBookAttributes.update({
      where: { leaseId_bookId: { leaseId: lease.id, bookId: book.id } },
      data: { lastAmortizedThrough: input.throughDate },
    });

    entriesPosted += 1;
    totalExpense = totalExpense.plus(expense);
  }

  return { entriesPosted, totalExpense };
}
