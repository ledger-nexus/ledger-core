// Accounts Receivable sub-ledger.
//
// Per the spec: "A bill creates an AP open item; it is not itself AP."
// The mirror rule for AR: an invoice creates an AR open item. The invoice
// itself is a JournalEntry that debits AR control + credits revenue. The
// open-item is a separate record with its own lifecycle (open → partial
// → applied / written off / reopened).
//
// Invariant: sum of currentBalance for status IN (OPEN, PARTIAL) per
// (entity, book) === AR control account balance (Dr). See tests.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export interface OpenArItemInput {
  entityCode: string;
  bookCode: string;
  partyCode: string;
  openedByEntryId: string;
  referenceNumber?: string;
  openedDate: Date;
  dueDate?: Date;
  amount: Decimal | string | number;
  currencyCode: string;
  controlAccountCode: string; // typically "1200"
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export async function openArItem(
  prisma: PrismaClient,
  input: OpenArItemInput
): Promise<{ id: string }> {
  const [entity, book, party] = await Promise.all([
    prisma.legalEntity.findUniqueOrThrow({
      where: { code: input.entityCode },
      select: { id: true },
    }),
    prisma.book.findUniqueOrThrow({
      where: { code: input.bookCode },
      select: { id: true },
    }),
    prisma.party.findFirstOrThrow({
      where: {
        code: input.partyCode,
        OR: [{ entityId: null }, { entityId: undefined }, { entity: { code: input.entityCode } }],
      },
      select: { id: true },
    }),
  ]);

  const amount = toDecimal(input.amount).toFixed(4);

  const item = await prisma.arOpenItem.create({
    data: {
      entityId: entity.id,
      bookId: book.id,
      partyId: party.id,
      openedByEntryId: input.openedByEntryId,
      referenceNumber: input.referenceNumber,
      openedDate: input.openedDate,
      dueDate: input.dueDate,
      originalAmount: amount,
      currentBalance: amount,
      currencyId: input.currencyCode,
      controlAccountCode: input.controlAccountCode,
      status: "OPEN",
      sourceSystem: input.sourceSystem,
      sourceRecordType: input.sourceRecordType,
      sourceRecordId: input.sourceRecordId,
      sourcePayload: (input.sourcePayload as any) ?? undefined,
    },
    select: { id: true },
  });
  return item;
}

export interface ApplyArPaymentInput {
  openItemId: string;
  appliedByEntryId: string;
  appliedAmount: Decimal | string | number;
  appliedDate: Date;
}

export async function applyArPayment(
  prisma: PrismaClient,
  input: ApplyArPaymentInput
): Promise<{ applicationId: string; remainingBalance: Decimal; status: string }> {
  return await prisma.$transaction(async (tx) => {
    const item = await tx.arOpenItem.findUniqueOrThrow({
      where: { id: input.openItemId },
      select: { currentBalance: true, originalAmount: true, status: true },
    });
    if (item.status === "APPLIED" || item.status === "WRITTEN_OFF" || item.status === "VOID") {
      throw new Error(`Cannot apply payment to AR item in ${item.status} state`);
    }

    const applied = toDecimal(input.appliedAmount);
    const current = toDecimal(item.currentBalance);
    if (applied.greaterThan(current)) {
      throw new Error(
        `Application amount ${applied} exceeds open balance ${current.toFixed(4)}`
      );
    }

    const newBalance = current.minus(applied);
    const nextStatus = newBalance.isZero() ? "APPLIED" : "PARTIAL";

    const application = await tx.arApplication.create({
      data: {
        openItemId: input.openItemId,
        appliedByEntryId: input.appliedByEntryId,
        appliedAmount: applied.toFixed(4),
        appliedDate: input.appliedDate,
      },
      select: { id: true },
    });

    await tx.arOpenItem.update({
      where: { id: input.openItemId },
      data: {
        currentBalance: newBalance.toFixed(4),
        status: nextStatus,
      },
    });

    return { applicationId: application.id, remainingBalance: newBalance, status: nextStatus };
  });
}

export async function writeOffArItem(
  prisma: PrismaClient,
  openItemId: string,
  appliedByEntryId: string,
  asOfDate: Date
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const item = await tx.arOpenItem.findUniqueOrThrow({
      where: { id: openItemId },
      select: { currentBalance: true, status: true },
    });
    if (item.status === "APPLIED" || item.status === "WRITTEN_OFF" || item.status === "VOID") {
      throw new Error(`Cannot write off AR item in ${item.status} state`);
    }
    await tx.arApplication.create({
      data: {
        openItemId,
        appliedByEntryId,
        appliedAmount: item.currentBalance,
        appliedDate: asOfDate,
      },
    });
    await tx.arOpenItem.update({
      where: { id: openItemId },
      data: { currentBalance: "0.0000", status: "WRITTEN_OFF" },
    });
  });
}

// Sum of open + partial item balances for a (entity, book). Should equal
// the AR control account balance — the headline AR invariant.
export async function openArBalance(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string
): Promise<Decimal> {
  const rows = await prisma.arOpenItem.findMany({
    where: {
      entity: { code: entityCode },
      book: { code: bookCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    select: { currentBalance: true },
  });
  return rows.reduce((acc, r) => acc.plus(toDecimal(r.currentBalance)), new Decimal(0));
}

// Aging buckets — useful for the recon project + portfolio demo.
export interface ArAgingBucket {
  bucket: "CURRENT" | "1_30" | "31_60" | "61_90" | "OVER_90";
  totalBalance: Decimal;
  itemCount: number;
}

export async function arAging(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string,
  asOf: Date
): Promise<ArAgingBucket[]> {
  const items = await prisma.arOpenItem.findMany({
    where: {
      entity: { code: entityCode },
      book: { code: bookCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    select: { currentBalance: true, dueDate: true, openedDate: true },
  });

  const buckets = {
    CURRENT: { total: new Decimal(0), count: 0 },
    "1_30": { total: new Decimal(0), count: 0 },
    "31_60": { total: new Decimal(0), count: 0 },
    "61_90": { total: new Decimal(0), count: 0 },
    OVER_90: { total: new Decimal(0), count: 0 },
  };
  for (const item of items) {
    const refDate = item.dueDate ?? item.openedDate;
    const daysOverdue = Math.floor(
      (asOf.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const bal = toDecimal(item.currentBalance);
    let key: keyof typeof buckets;
    if (daysOverdue <= 0) key = "CURRENT";
    else if (daysOverdue <= 30) key = "1_30";
    else if (daysOverdue <= 60) key = "31_60";
    else if (daysOverdue <= 90) key = "61_90";
    else key = "OVER_90";
    buckets[key].total = buckets[key].total.plus(bal);
    buckets[key].count += 1;
  }
  return (Object.keys(buckets) as (keyof typeof buckets)[]).map((k) => ({
    bucket: k,
    totalBalance: buckets[k].total,
    itemCount: buckets[k].count,
  }));
}
