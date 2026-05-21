// Accounts Payable sub-ledger — mirror of AR.
//
// Per the spec: "A bill creates an AP open item; it is not itself AP."
// The bill (vendor invoice) is a JournalEntry that debits expense + credits
// AP control. The AP open item is the line-item tracker with its own
// lifecycle.
//
// Invariant: sum of currentBalance for status IN (OPEN, PARTIAL, REOPENED)
// per (entity, book) === AP control account balance (Cr).

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";

function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export interface OpenApItemInput {
  entityCode: string;
  bookCode: string;
  partyCode: string;
  openedByEntryId: string;
  referenceNumber?: string;
  openedDate: Date;
  dueDate?: Date;
  amount: Decimal | string | number;
  currencyCode: string;
  controlAccountCode: string; // typically "2000"
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export async function openApItem(
  prisma: PrismaClient,
  input: OpenApItemInput
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
        OR: [{ entityId: null }, { entity: { code: input.entityCode } }],
      },
      select: { id: true },
    }),
  ]);

  const amount = toDecimal(input.amount).toFixed(4);

  const item = await prisma.apOpenItem.create({
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

export interface ApplyApPaymentInput {
  openItemId: string;
  appliedByEntryId: string;
  appliedAmount: Decimal | string | number;
  appliedDate: Date;
}

export async function applyApPayment(
  prisma: PrismaClient,
  input: ApplyApPaymentInput
): Promise<{ applicationId: string; remainingBalance: Decimal; status: string }> {
  return await prisma.$transaction(async (tx) => {
    const item = await tx.apOpenItem.findUniqueOrThrow({
      where: { id: input.openItemId },
      select: { currentBalance: true, status: true },
    });
    if (item.status === "APPLIED" || item.status === "WRITTEN_OFF" || item.status === "VOID") {
      throw new Error(`Cannot apply payment to AP item in ${item.status} state`);
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

    const application = await tx.apApplication.create({
      data: {
        openItemId: input.openItemId,
        appliedByEntryId: input.appliedByEntryId,
        appliedAmount: applied.toFixed(4),
        appliedDate: input.appliedDate,
      },
      select: { id: true },
    });

    await tx.apOpenItem.update({
      where: { id: input.openItemId },
      data: {
        currentBalance: newBalance.toFixed(4),
        status: nextStatus,
      },
    });

    return { applicationId: application.id, remainingBalance: newBalance, status: nextStatus };
  });
}

export async function openApBalance(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string
): Promise<Decimal> {
  const rows = await prisma.apOpenItem.findMany({
    where: {
      entity: { code: entityCode },
      book: { code: bookCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    select: { currentBalance: true },
  });
  return rows.reduce((acc, r) => acc.plus(toDecimal(r.currentBalance)), new Decimal(0));
}
