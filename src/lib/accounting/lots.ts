// Lot persistence — the cost-basis parcels the inventory engine works over.
//
// This is the storage layer under src/lib/accounting/inventory.ts (the pure
// booking math). Three operations:
//   - augmentLot   : a purchase creates a new OPEN lot.
//   - getOpenLots  : read the OPEN lots for a holding, as the engine's Lot type,
//                    so bookReduction can consume them directly.
//   - consumeLots  : apply a booking result — draw down remainingUnits and CLOSE
//                    any parcel that reaches zero.
//
// Splitting persistence from the math keeps the math exhaustively testable on
// its own (done in part 1) and lets the GL posting integration (a later part of
// the arc) wrap augment / consume in the same transaction as postJournalEntry.
//
// Tenant-scoped throughout. Callers pass resolved ids (they already hold the
// entity/book/account/commodity context at posting time); code→id resolution
// stays with the caller, matching how the posting path already resolves codes.

import type { DbClient } from "../db";
import { Decimal } from "@/lib/utils/decimal";
import type { Lot as EngineLot, Consumption } from "./inventory";

export interface AugmentLotInput {
  tenantId: string;
  entityId: string;
  bookId: string;
  accountId: string;
  commodityId: string;
  units: Decimal | string | number;
  unitCost: Decimal | string | number;
  costCurrencyId: string;
  acquisitionDate: Date;
  label?: string;
  /** The purchase JE, once posting is wired. Optional for seed / import. */
  openedByEntryId?: string;
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
}

/** Create a new OPEN lot for a purchase. originalUnits == remainingUnits at open. */
export async function augmentLot(
  db: DbClient,
  input: AugmentLotInput
): Promise<{ id: string }> {
  const units = new Decimal(input.units);
  if (!units.isFinite() || units.lessThanOrEqualTo(0)) {
    throw new Error("Lot units must be positive.");
  }
  const unitCost = new Decimal(input.unitCost);
  if (!unitCost.isFinite() || unitCost.isNegative()) {
    throw new Error("Lot unit cost must be non-negative.");
  }
  const lot = await db.lot.create({
    data: {
      tenantId: input.tenantId,
      entityId: input.entityId,
      bookId: input.bookId,
      accountId: input.accountId,
      commodityId: input.commodityId,
      openedByEntryId: input.openedByEntryId,
      label: input.label,
      acquisitionDate: input.acquisitionDate,
      originalUnits: units.toString(),
      remainingUnits: units.toString(),
      unitCost: unitCost.toString(),
      costCurrencyId: input.costCurrencyId,
      status: "OPEN",
      sourceSystem: input.sourceSystem,
      sourceRecordType: input.sourceRecordType,
      sourceRecordId: input.sourceRecordId,
    },
    select: { id: true },
  });
  return lot;
}

/**
 * The OPEN lots for a holding, returned as the engine's Lot type (units =
 * remainingUnits) so bookReduction can consume them directly. Ordered oldest-
 * first for a stable result; the engine re-sorts per booking method regardless.
 */
export async function getOpenLots(
  db: DbClient,
  args: { tenantId: string; entityId: string; bookId: string; accountId: string; commodityId: string }
): Promise<EngineLot[]> {
  const rows = await db.lot.findMany({
    where: {
      tenantId: args.tenantId,
      entityId: args.entityId,
      bookId: args.bookId,
      accountId: args.accountId,
      commodityId: args.commodityId,
      status: "OPEN",
    },
    orderBy: [{ acquisitionDate: "asc" }, { id: "asc" }],
    select: { id: true, remainingUnits: true, unitCost: true, acquisitionDate: true, label: true },
  });
  return rows.map((r) => ({
    id: r.id,
    units: new Decimal(r.remainingUnits.toString()),
    unitCost: new Decimal(r.unitCost.toString()),
    acquisitionDate: r.acquisitionDate,
    label: r.label ?? undefined,
  }));
}

/**
 * Apply the engine's consumption plan to persistence: reduce each lot's
 * remainingUnits, and CLOSE any lot that reaches zero. Intended to run inside
 * the same transaction as the sale's JE — pass a TransactionClient as `db`.
 */
export async function consumeLots(db: DbClient, consumed: Consumption[]): Promise<void> {
  for (const c of consumed) {
    const lot = await db.lot.findUniqueOrThrow({
      where: { id: c.lotId },
      select: { remainingUnits: true },
    });
    const left = new Decimal(lot.remainingUnits.toString()).minus(new Decimal(c.units.toString()));
    await db.lot.update({
      where: { id: c.lotId },
      data: {
        remainingUnits: left.toString(),
        // A parcel drawn to zero (or below, which the engine never produces) is done.
        status: left.lessThanOrEqualTo(0) ? "CLOSED" : "OPEN",
      },
    });
  }
}
