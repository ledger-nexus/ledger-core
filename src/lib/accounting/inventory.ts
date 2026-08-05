// Inventory booking engine — lots, cost basis, and realized gain.
//
// This is the algorithmic heart of "lots" (Beancount adoption item 4). It is
// PURE: given the lots currently held and a reduction, it decides which lots
// are consumed and computes the cost relieved and the realized gain. No DB, no
// posting — persistence and the postJournalEntry integration are separate
// layers that call this. Keeping the math pure is deliberate: this is where
// subtle errors live, so it must be exhaustively unit-testable in isolation.
//
// Model (following Beancount's inventory semantics):
//   - A LOT is a parcel of units acquired at a specific per-unit cost on a
//     specific date. Two acquisitions never merge unless every cost attribute
//     matches — so cost basis is preserved parcel by parcel.
//   - An AUGMENTATION (a purchase) just adds a lot; it is trivial and lives at
//     the caller. This module handles the hard direction: a REDUCTION (a sale),
//     which must decide WHICH lots it draws down.
//   - A BOOKING METHOD resolves that choice:
//       STRICT — refuse an ambiguous reduction; the caller must name the lot,
//                unless there is only one lot or the whole position is sold.
//       FIFO   — oldest lots first.
//       LIFO   — newest lots first.
//     (Beancount also defines NONE — no booking, append-only — which never
//     reaches a reduction, and AVERAGE, which upstream itself has not
//     implemented. Both are out of scope here.)
//   - Capital gain is driven by COST BASIS, not sale price: proceeds minus the
//     cost relieved. The sale price supplies proceeds; the lots supply basis.

import { Decimal } from "@/lib/utils/decimal";

export type BookingMethod = "STRICT" | "FIFO" | "LIFO";

export interface Lot {
  /** Stable identifier for this lot (a lot id, or a user label). Unique within a holding. */
  id: string;
  /** Units currently held in this lot. Positive. */
  units: Decimal;
  /** Cost basis per unit, in the cost currency. */
  unitCost: Decimal;
  /** When the lot was acquired — the ordering key for FIFO / LIFO. */
  acquisitionDate: Date;
  /** Optional human label (informational; not used for matching in v1). */
  label?: string;
}

export interface Consumption {
  lotId: string;
  /** Units drawn from this lot by the reduction. */
  units: Decimal;
  /** The lot's cost basis per unit (carried through for gain + JE lines). */
  unitCost: Decimal;
}

export interface BookingResult {
  /** Which lots were drawn down, in consumption order. */
  consumed: Consumption[];
  /** Lots after the reduction — consumed lots reduced or dropped, input order preserved. */
  remaining: Lot[];
  /** Total cost basis removed: Σ consumed.units × consumed.unitCost. */
  costRelieved: Decimal;
  /** Sale proceeds (reduceUnits × reductionPrice) when a price was given, else null. */
  proceeds: Decimal | null;
  /** Realized gain/loss: proceeds − costRelieved, when a price was given, else null. */
  realizedGain: Decimal | null;
}

export class InvalidReductionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidReductionError";
  }
}

export class InsufficientUnitsError extends Error {
  constructor(public requested: Decimal, public held: Decimal) {
    super(`Cannot reduce ${requested} units — only ${held} held`);
    this.name = "InsufficientUnitsError";
  }
}

export class AmbiguousLotError extends Error {
  constructor(public lotCount: number) {
    super(
      `STRICT booking: reduction spans a choice of ${lotCount} lots — name the lot, ` +
        `sell the whole position, or use FIFO/LIFO`
    );
    this.name = "AmbiguousLotError";
  }
}

export class UnknownLotError extends Error {
  constructor(public lotId: string) {
    super(`No held lot with id "${lotId}"`);
    this.name = "UnknownLotError";
  }
}

export function totalUnits(lots: Lot[]): Decimal {
  return lots.reduce((acc, l) => acc.plus(l.units), new Decimal(0));
}

export function totalCost(lots: Lot[]): Decimal {
  return lots.reduce((acc, l) => acc.plus(l.units.times(l.unitCost)), new Decimal(0));
}

/** Weighted-average cost per unit across a holding, or null when it holds nothing. */
export function averageCost(lots: Lot[]): Decimal | null {
  const units = totalUnits(lots);
  if (units.isZero()) return null;
  return totalCost(lots).dividedBy(units);
}

/**
 * Decide the consumption ORDER of the held lots for a reduction.
 *
 * FIFO/LIFO sort on (acquisitionDate, id) so the result is deterministic even
 * when two lots share a date. STRICT does not order the whole holding — it
 * either targets one lot or (for a full-position sale) consumes everything in
 * FIFO order for a stable `consumed` list.
 */
function consumptionOrder(held: Lot[], reduce: Decimal, method: BookingMethod, lotId?: string): Lot[] {
  const byDateThenId = [...held].sort((a, b) => {
    const d = a.acquisitionDate.getTime() - b.acquisitionDate.getTime();
    return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  if (method === "FIFO") return byDateThenId;
  if (method === "LIFO") return byDateThenId.reverse();

  // STRICT.
  if (lotId) {
    const lot = held.find((l) => l.id === lotId);
    if (!lot) throw new UnknownLotError(lotId);
    return [lot];
  }
  // No lot named: a reduction is unambiguous only when there is a single lot,
  // or when the entire position is being sold (Beancount's carve-out — selling
  // everything needs no choice). Otherwise STRICT refuses.
  if (held.length === 1) return held;
  if (reduce.equals(totalUnits(held))) return byDateThenId;
  throw new AmbiguousLotError(held.length);
}

/**
 * Book a reduction against held lots.
 *
 * @param opts.reductionPrice per-unit sale price; when given, proceeds and
 *        realized gain are computed. Omit for a non-sale reduction (e.g. a
 *        transfer) where only cost relief matters.
 * @param opts.lotId under STRICT, the specific lot to draw from.
 */
export function bookReduction(
  held: Lot[],
  reduceUnits: Decimal | string | number,
  method: BookingMethod,
  opts: { reductionPrice?: Decimal | string | number; lotId?: string } = {}
): BookingResult {
  const reduce = new Decimal(reduceUnits);
  if (!reduce.isFinite() || reduce.lessThanOrEqualTo(0)) {
    throw new InvalidReductionError("Reduction units must be positive.");
  }

  const held0 = totalUnits(held);
  if (reduce.greaterThan(held0)) {
    throw new InsufficientUnitsError(reduce, held0);
  }

  // A STRICT reduction targeting one lot cannot spill into others — that would
  // require a booking choice STRICT is meant to force the caller to make.
  const order = consumptionOrder(held, reduce, method, opts.lotId);
  if (method === "STRICT" && opts.lotId && reduce.greaterThan(order[0].units)) {
    throw new InsufficientUnitsError(reduce, order[0].units);
  }

  // Greedy draw-down in the chosen order.
  const consumedByLot = new Map<string, Decimal>();
  const consumed: Consumption[] = [];
  let need = reduce;
  for (const lot of order) {
    if (need.isZero()) break;
    const take = Decimal.min(need, lot.units);
    if (take.isZero()) continue;
    consumedByLot.set(lot.id, take);
    consumed.push({ lotId: lot.id, units: take, unitCost: lot.unitCost });
    need = need.minus(take);
  }

  // Remaining preserves the caller's original lot order; fully-consumed lots drop.
  const remaining: Lot[] = [];
  for (const lot of held) {
    const taken = consumedByLot.get(lot.id) ?? new Decimal(0);
    const left = lot.units.minus(taken);
    if (left.greaterThan(0)) remaining.push({ ...lot, units: left });
  }

  const costRelieved = consumed.reduce(
    (acc, c) => acc.plus(c.units.times(c.unitCost)),
    new Decimal(0)
  );

  let proceeds: Decimal | null = null;
  let realizedGain: Decimal | null = null;
  if (opts.reductionPrice != null) {
    proceeds = reduce.times(new Decimal(opts.reductionPrice));
    realizedGain = proceeds.minus(costRelieved);
  }

  return { consumed, remaining, costRelieved, proceeds, realizedGain };
}
