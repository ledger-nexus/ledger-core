// Lease sub-ledger (ASC 842 / IFRS 16).
//
// v0.4 ships the real mechanics — replacing the v0.3 straight-line stub.
//
//   OPERATING (ASC 842 / IFRS 16):
//     Lease commencement → Dr ROU asset, Cr Lease Liability (PV of payments)
//     Each period → ONE combined expense JE:
//       Dr Lease Expense (straight-line amount)
//       Cr ROU Asset (period amortization = SL − imputed interest)
//       Cr Lease Liability (imputed interest accretion)
//     Then cash payment → Dr Lease Liability, Cr Cash
//     The lease expense line stays constant; ROU and liability both
//     decrease in lockstep over the lease term.
//
//   FINANCE (ASC 842):
//     Same commencement entry. Period expense splits into Interest Expense
//     and Amortization Expense (separate P&L lines):
//       Dr Interest Expense (imputed)
//       Dr Lease Amortization Expense (SL on ROU)
//       Cr ROU Asset (= amortization)
//       Cr Lease Liability (= interest)
//
//   TAX_CASH_BASIS / SHORT_TERM:
//     No commencement. Each period is Dr Lease Expense, Cr Cash.
//
// The classification lives per-book in LeaseBookAttributes. The same
// underlying lease produces three different ledger streams: GAAP ROU+liability,
// IFRS ROU+liability (identical to GAAP in this simplified model), TAX cash.

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
  discountRate?: Decimal | string | number; // annual rate, e.g. 0.06 for 6%
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
    select: { id: true, tenantId: true },
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

  const periodsPerYear =
    input.paymentFrequency === "ANNUAL" ? 1 : input.paymentFrequency === "QUARTERLY" ? 4 : 12;
  const totalMonths = monthsBetween(input.leaseStartDate, input.leaseEndDate);
  const totalPeriods = Math.ceil((totalMonths / 12) * periodsPerYear);
  const totalUndiscounted = toDecimal(input.paymentAmount).times(totalPeriods);

  return await prisma.lease.create({
    data: {
      tenantId: entity.tenantId,
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
  return (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth()) + 1;
}

// PV of an ordinary annuity: P × (1 - (1+r)^-n) / r
// monthlyRate is decimal (e.g. 0.005 for 6% annual / 12). If rate is zero,
// PV degenerates to P × n (undiscounted sum).
function presentValueAnnuity(payment: Decimal, n: number, monthlyRate: Decimal): Decimal {
  if (monthlyRate.isZero()) return payment.times(n);
  const onePlusR = monthlyRate.plus(1);
  // decimal.js supports negative exponents on Decimal bases.
  const power = onePlusR.pow(-n);
  const factor = new Decimal(1).minus(power).div(monthlyRate);
  return payment.times(factor);
}

// Iterate month-ends from (year, month) for `count` months. Each value is
// the UTC last-day-of-month Date.
function monthEndsFrom(startYear: number, startMonth: number, count: number): Date[] {
  const ends: Date[] = [];
  for (let i = 0; i < count; i++) {
    const y = startYear + Math.floor((startMonth + i) / 12);
    const m = (startMonth + i) % 12;
    // Day 0 of month m+1 = last day of month m
    ends.push(new Date(Date.UTC(y, m + 1, 0)));
  }
  return ends;
}

export interface RunLeaseAccountingInput {
  entityCode: string;
  bookCode: string;
  throughDate: Date;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
  cashAccountCode?: string; // default "1000"
}

export interface RunLeaseAccountingResult {
  entriesPosted: number;
  totalExpense: Decimal;
}

export async function runLeaseAccounting(
  prisma: PrismaClient,
  input: RunLeaseAccountingInput
): Promise<RunLeaseAccountingResult> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: input.bookCode },
    select: { id: true, reportingCurrencyId: true },
  });
  const cashAccountCode = input.cashAccountCode ?? "1000";

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
    if (input.throughDate < lease.leaseStartDate) continue;

    const payment = toDecimal(lease.paymentAmount);
    const totalMonths = monthsBetween(lease.leaseStartDate, lease.leaseEndDate);
    const monthlyRate = toDecimal(attrs.discountRate).div(12);

    let currentRou = toDecimal(attrs.rouAssetBalance);
    let currentLiab = toDecimal(attrs.leaseLiabilityBalance);

    // ---- Step 1: lease commencement (first run only, OPERATING / FINANCE) ----
    const needsCommencement =
      !attrs.lastAmortizedThrough &&
      currentRou.isZero() &&
      currentLiab.isZero() &&
      (attrs.classification === "OPERATING" || attrs.classification === "FINANCE");

    if (needsCommencement) {
      if (!attrs.rouAccountCode || !attrs.liabilityAccountCode) {
        throw new Error(
          `Lease ${lease.code} on book ${input.bookCode} is ${attrs.classification} but missing ROU / liability account codes`
        );
      }
      const pv = presentValueAnnuity(payment, totalMonths, monthlyRate);
      await postJournalEntry(prisma, {
        entityCode: input.entityCode,
        bookCode: input.bookCode,
        currencyCode: book.reportingCurrencyId,
        documentDate: lease.leaseStartDate,
        memo: `Lease commencement — ${lease.code} (${attrs.classification})`,
        source: input.source ?? "SYSTEM",
        sourceRecordType: "LeaseCommencement",
        sourceRecordId: lease.id,
        extensions: {
          leaseCode: lease.code,
          classification: attrs.classification,
          presentValue: pv.toFixed(2),
        },
        lines: [
          {
            accountCode: attrs.rouAccountCode,
            debit: pv.toFixed(4),
            description: `ROU asset — ${lease.code}`,
          },
          {
            accountCode: attrs.liabilityAccountCode,
            credit: pv.toFixed(4),
            description: `Lease liability — ${lease.code}`,
          },
        ],
      });
      currentRou = pv;
      currentLiab = pv;
      entriesPosted += 1;
    }

    // ---- Step 2: figure out which month-ends still need amortization ----
    const startNextMonth = attrs.lastAmortizedThrough
      ? {
          y: attrs.lastAmortizedThrough.getUTCFullYear(),
          m: attrs.lastAmortizedThrough.getUTCMonth() + 1,
        }
      : {
          y: lease.leaseStartDate.getUTCFullYear(),
          m: lease.leaseStartDate.getUTCMonth(),
        };
    // Normalize y / m when m === 12
    const normalY = startNextMonth.y + Math.floor(startNextMonth.m / 12);
    const normalM = startNextMonth.m % 12;

    const monthsToProcess = Math.max(
      0,
      Math.min(
        // through-date month-end relative to start month
        (input.throughDate.getUTCFullYear() - normalY) * 12 +
          (input.throughDate.getUTCMonth() - normalM) +
          1,
        // cap at remaining lease months
        totalMonths -
          (attrs.lastAmortizedThrough
            ? monthsBetween(lease.leaseStartDate, attrs.lastAmortizedThrough)
            : 0)
      )
    );
    if (monthsToProcess <= 0) {
      // Persist any commencement state and move on.
      if (needsCommencement) {
        await prisma.leaseBookAttributes.update({
          where: { leaseId_bookId: { leaseId: lease.id, bookId: book.id } },
          data: {
            rouAssetBalance: currentRou.toFixed(4),
            leaseLiabilityBalance: currentLiab.toFixed(4),
          },
        });
      }
      continue;
    }

    const monthEnds = monthEndsFrom(normalY, normalM, monthsToProcess);

    // ---- Step 3: amortize month by month ----
    let lastDone = attrs.lastAmortizedThrough ?? lease.leaseStartDate;
    for (const monthEnd of monthEnds) {
      // Skip months past lease end (shouldn't happen given the cap, but defensive).
      if (monthEnd > lease.leaseEndDate) break;

      if (attrs.classification === "OPERATING") {
        const interest = currentLiab.times(monthlyRate);
        const expense = payment; // SL since payments are constant
        const rouAmort = expense.minus(interest);

        await postJournalEntry(prisma, {
          entityCode: input.entityCode,
          bookCode: input.bookCode,
          currencyCode: book.reportingCurrencyId,
          documentDate: monthEnd,
          memo: `Lease expense — ${lease.code} (operating)`,
          source: input.source ?? "SYSTEM",
          sourceRecordType: "LeaseExpense",
          sourceRecordId: lease.id,
          extensions: {
            leaseCode: lease.code,
            classification: "OPERATING",
            interest: interest.toFixed(2),
            rouAmortization: rouAmort.toFixed(2),
          },
          lines: [
            { accountCode: attrs.expenseAccountCode!, debit: expense.toFixed(4), description: `Lease expense — ${lease.code}` },
            { accountCode: attrs.rouAccountCode!, credit: rouAmort.toFixed(4), description: `ROU amortization — ${lease.code}` },
            { accountCode: attrs.liabilityAccountCode!, credit: interest.toFixed(4), description: `Interest accretion — ${lease.code}` },
          ],
        });
        // Cash payment.
        await postJournalEntry(prisma, {
          entityCode: input.entityCode,
          bookCode: input.bookCode,
          currencyCode: book.reportingCurrencyId,
          documentDate: monthEnd,
          memo: `Lease payment — ${lease.code}`,
          source: input.source ?? "SYSTEM",
          sourceRecordType: "LeasePayment",
          sourceRecordId: lease.id,
          extensions: { leaseCode: lease.code },
          lines: [
            { accountCode: attrs.liabilityAccountCode!, debit: payment.toFixed(4), description: `Pay liability — ${lease.code}` },
            { accountCode: cashAccountCode, credit: payment.toFixed(4) },
          ],
        });
        currentLiab = currentLiab.plus(interest).minus(payment);
        currentRou = currentRou.minus(rouAmort);
        entriesPosted += 2;
        totalExpense = totalExpense.plus(expense);
      } else if (attrs.classification === "FINANCE") {
        const interest = currentLiab.times(monthlyRate);
        const rouAmort = currentRou.greaterThan(0) ? currentRou.div(totalMonths - monthsBetween(lease.leaseStartDate, lastDone)) : new Decimal(0);

        await postJournalEntry(prisma, {
          entityCode: input.entityCode,
          bookCode: input.bookCode,
          currencyCode: book.reportingCurrencyId,
          documentDate: monthEnd,
          memo: `Lease expense — ${lease.code} (finance)`,
          source: input.source ?? "SYSTEM",
          sourceRecordType: "LeaseExpense",
          sourceRecordId: lease.id,
          extensions: { leaseCode: lease.code, classification: "FINANCE" },
          lines: [
            { accountCode: attrs.interestAccountCode ?? "8200", debit: interest.toFixed(4), description: `Lease interest — ${lease.code}` },
            { accountCode: attrs.expenseAccountCode!, debit: rouAmort.toFixed(4), description: `Lease amortization — ${lease.code}` },
            { accountCode: attrs.rouAccountCode!, credit: rouAmort.toFixed(4), description: `ROU amortization` },
            { accountCode: attrs.liabilityAccountCode!, credit: interest.toFixed(4), description: `Interest accretion` },
          ],
        });
        await postJournalEntry(prisma, {
          entityCode: input.entityCode,
          bookCode: input.bookCode,
          currencyCode: book.reportingCurrencyId,
          documentDate: monthEnd,
          memo: `Lease payment — ${lease.code}`,
          source: input.source ?? "SYSTEM",
          sourceRecordType: "LeasePayment",
          sourceRecordId: lease.id,
          lines: [
            { accountCode: attrs.liabilityAccountCode!, debit: payment.toFixed(4) },
            { accountCode: cashAccountCode, credit: payment.toFixed(4) },
          ],
        });
        currentLiab = currentLiab.plus(interest).minus(payment);
        currentRou = currentRou.minus(rouAmort);
        entriesPosted += 2;
        totalExpense = totalExpense.plus(interest).plus(rouAmort);
      } else if (attrs.classification === "TAX_CASH_BASIS" || attrs.classification === "SHORT_TERM") {
        await postJournalEntry(prisma, {
          entityCode: input.entityCode,
          bookCode: input.bookCode,
          currencyCode: book.reportingCurrencyId,
          documentDate: monthEnd,
          memo: `Lease expense (cash basis) — ${lease.code}`,
          source: input.source ?? "SYSTEM",
          sourceRecordType: "LeaseExpense",
          sourceRecordId: lease.id,
          extensions: { leaseCode: lease.code, classification: attrs.classification },
          lines: [
            { accountCode: attrs.expenseAccountCode!, debit: payment.toFixed(4) },
            { accountCode: cashAccountCode, credit: payment.toFixed(4) },
          ],
        });
        entriesPosted += 1;
        totalExpense = totalExpense.plus(payment);
      }
      lastDone = monthEnd;
    }

    // Persist updated balances + lastAmortizedThrough.
    await prisma.leaseBookAttributes.update({
      where: { leaseId_bookId: { leaseId: lease.id, bookId: book.id } },
      data: {
        rouAssetBalance: currentRou.toFixed(4),
        leaseLiabilityBalance: currentLiab.toFixed(4),
        lastAmortizedThrough: lastDone,
      },
    });
  }

  return { entriesPosted, totalExpense };
}

// Back-compat alias for v0.3 callers. New code should use runLeaseAccounting.
export const runLeaseStraightLineExpense = runLeaseAccounting;
