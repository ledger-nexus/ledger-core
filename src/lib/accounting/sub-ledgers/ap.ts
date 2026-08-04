// Accounts Payable sub-ledger — mirror of AR.
//
// Per the spec: "A bill creates an AP open item; it is not itself AP."
// The bill (vendor invoice) is a JournalEntry that debits expense + credits
// AP control. The AP open item is the line-item tracker with its own
// lifecycle.
//
// Invariant: sum of currentBalance for status IN (OPEN, PARTIAL, REOPENED)
// per (entity, book) === AP control account balance (Cr).

import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { CrossBookApplicationError } from "../types";
import { fireInsertRules, type FireRulesResult } from "../../rules/integration";
import { toDecimal } from "../../utils/decimal";
import { isUuid } from "../../utils/uuid";



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
  /**
   * Acting user. Threaded into createdBy + the default ownerId. "system"
   * for engine-generated AP items (ERP imports). Real Server Action
   * callers pass currentUser.id.
   */
  actorUserId?: string;
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export interface OpenApItemResult {
  id: string;
  /**
   * Result of the ON_INSERT rules fire. The AP item exists regardless of
   * whether rules fired or reassigned — rule failures are non-fatal and
   * surface here for the caller to log + handle.
   */
  rulesResult?: FireRulesResult;
}

export async function openApItem(
  prisma: PrismaClient,
  input: OpenApItemInput
): Promise<OpenApItemResult> {
  // Entity first → tenant-scoped party lookup. Same rationale as
  // ar.ts; cross-tenant party leakage on shared (entityId=null) parties.
  // Phase 4b: code is unique per [tenantId, code], so findFirst.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: input.entityCode },
    select: { id: true, tenantId: true },
  });
  const [book, party] = await Promise.all([
    prisma.book.findUniqueOrThrow({
      where: { code: input.bookCode },
      select: { id: true },
    }),
    prisma.party.findFirstOrThrow({
      where: {
        tenantId: entity.tenantId,
        code: input.partyCode,
        OR: [{ entityId: null }, { entityId: entity.id }],
      },
      select: { id: true },
    }),
  ]);

  const amount = toDecimal(input.amount).toFixed(4);
  const actor = input.actorUserId ?? "system";
  const isHumanActor = actor !== "system" && isUuid(actor);

  const item = await prisma.apOpenItem.create({
    data: {
      tenantId: entity.tenantId,
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
      ownerId: isHumanActor ? actor : null,
      ownerType: "USER",
      createdBy: actor,
      updatedBy: actor,
      sourceSystem: input.sourceSystem,
      sourceRecordType: input.sourceRecordType,
      sourceRecordId: input.sourceRecordId,
      sourcePayload: (input.sourcePayload as any) ?? undefined,
    },
    select: {
      id: true,
      status: true,
      originalAmount: true,
      currentBalance: true,
      dueDate: true,
      openedDate: true,
      controlAccountCode: true,
      entityId: true,
      bookId: true,
      partyId: true,
      party: { select: { code: true, displayName: true } },
    },
  });

  // Fire ON_INSERT rules. Mirror of openArItem — rules see the just-created
  // record with party data and may route to a queue (e.g., utility-vendor
  // invoices to a utilities approval queue, large-amount AP to controller).
  const rulesResult = await fireInsertRules(
    prisma,
    "ApOpenItem",
    item.id,
    item as unknown as Record<string, unknown>,
    actor
  );

  return { id: item.id, rulesResult };
}

export interface ApplyApPaymentInput {
  openItemId: string;
  appliedByEntryId: string;
  appliedAmount: Decimal | string | number;
  appliedDate: Date;
}

// Class T (RLS Phase 2b): transactional body exported separately so
// Server Actions can run it inside withTenantContext's transaction.
export async function applyApPaymentInTx(
  tx: Prisma.TransactionClient,
  input: ApplyApPaymentInput
): Promise<{ applicationId: string; remainingBalance: Decimal; status: string }> {
  {
    const item = await tx.apOpenItem.findUniqueOrThrow({
      where: { id: input.openItemId },
      // bookId pulled for the Phase 3.5.D cross-book guard below.
      select: {
        currentBalance: true,
        status: true,
        tenantId: true,
        bookId: true,
        book: { select: { code: true } },
      },
    });
    if (item.status === "APPLIED" || item.status === "WRITTEN_OFF" || item.status === "VOID") {
      throw new Error(`Cannot apply payment to AP item in ${item.status} state`);
    }

    // v0.9 NS Books Phase 3.5.D — cross-book application guard (mirror
    // of applyArPayment). The payment JE must be on the same book as
    // the OpenItem; cross-book apply leaves the per-book TB imbalanced.
    const appliedByEntry = await tx.journalEntry.findUniqueOrThrow({
      where: { id: input.appliedByEntryId },
      select: { bookId: true, book: { select: { code: true } } },
    });
    if (appliedByEntry.bookId !== item.bookId) {
      throw new CrossBookApplicationError(
        input.openItemId,
        item.book.code,
        input.appliedByEntryId,
        appliedByEntry.book.code
      );
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

    // SECURITY (TOCTOU race fix): optimistic-concurrency guard on the
    // currentBalance — see applyArPayment for full rationale.
    const application = await tx.apApplication.create({
      data: {
        tenantId: item.tenantId,
        openItemId: input.openItemId,
        appliedByEntryId: input.appliedByEntryId,
        appliedAmount: applied.toFixed(4),
        appliedDate: input.appliedDate,
      },
      select: { id: true },
    });

    const updated = await tx.apOpenItem.updateMany({
      where: {
        id: input.openItemId,
        currentBalance: current.toFixed(4),
      },
      data: {
        currentBalance: newBalance.toFixed(4),
        status: nextStatus,
      },
    });
    if (updated.count === 0) {
      throw new Error(
        `Concurrent update on AP item ${input.openItemId} — payment was applied to a stale balance. Retry the request.`
      );
    }

    return { applicationId: application.id, remainingBalance: newBalance, status: nextStatus };
  }
}

export async function applyApPayment(
  prisma: PrismaClient,
  input: ApplyApPaymentInput
): Promise<{ applicationId: string; remainingBalance: Decimal; status: string }> {
  return prisma.$transaction((tx) => applyApPaymentInTx(tx, input));
}

export async function openApBalance(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string,
  // Tenant pin — entity codes are only unique per tenant; UI/API callers
  // MUST pass this (deficiency #16 pattern, closed for reports, was still
  // open here). Optional for legacy substrate scripts.
  tenantId?: string
): Promise<Decimal> {
  const rows = await prisma.apOpenItem.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      entity: { code: entityCode },
      book: { code: bookCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    select: { currentBalance: true },
  });
  return rows.reduce((acc, r) => acc.plus(toDecimal(r.currentBalance)), new Decimal(0));
}

// Aging buckets — mirror of arAging. Useful for the AP aging report.
export interface ApAgingBucket {
  bucket: "CURRENT" | "1_30" | "31_60" | "61_90" | "OVER_90";
  totalBalance: Decimal;
  itemCount: number;
}

export async function apAging(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string,
  asOf: Date,
  // Tenant pin — see openApBalance. Same cross-tenant same-code hole.
  tenantId?: string
): Promise<ApAgingBucket[]> {
  const items = await prisma.apOpenItem.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
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
