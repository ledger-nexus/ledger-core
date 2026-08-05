// The fixed-asset register — what the entity owns, per book.
//
// The asset model, the depreciation engine, and the internal posting
// routes have all existed for a while. What did not exist was any way
// to LOOK at the register: an accountant could depreciate assets they
// could not list. This is that view.
//
// Per book, deliberately. Useful life and method are book attributes
// (a laptop over 3 years for GAAP and 5 for tax is the whole point of
// multi-book), so cost is the only figure the books agree on — every
// other column here belongs to the book you are looking at.
//
// The totals tie to the fixed-asset reconciliation on purpose. The
// status set and the net-book-value math are shared with
// `resolveSupportingBalance`'s FIXED_ASSET_REGISTER branch rather than
// re-derived, because a register that disagreed with the reconciliation
// pulling from the same rows would be worse than no register at all.

import { Decimal } from "decimal.js";
import type { DbClient } from "@/lib/db";

/**
 * Assets that still sit on the balance sheet. Gross cost rolls off at
 * disposal; HELD_FOR_SALE stays until it actually sells.
 */
export const ON_BOOK_ASSET_STATUSES = [
  "IN_SERVICE",
  "IDLE",
  "HELD_FOR_SALE",
] as const;

export interface RegisterRow {
  id: string;
  code: string;
  description: string;
  category: string | null;
  status: string;
  acquisitionDate: Date;
  assetAccountCode: string;
  cost: Decimal;
  /** Per the selected book. */
  accumulatedDepreciation: Decimal;
  netBookValue: Decimal;
  /** Book attributes are absent until the asset is set up for this book. */
  inServiceDate: Date | null;
  usefulLifeMonths: number | null;
  depreciationMethod: string | null;
  lastDepreciatedThrough: Date | null;
}

export interface FixedAssetRegister {
  rows: RegisterRow[];
  totals: {
    cost: Decimal;
    accumulatedDepreciation: Decimal;
    netBookValue: Decimal;
  };
  /** Assets not set up for this book at all — they depreciate nowhere. */
  notConfiguredForBook: number;
  /** Excluded from the rows above; surfaced so the count isn't a mystery. */
  disposedCount: number;
}

export async function getFixedAssetRegister(
  prisma: DbClient,
  input: { tenantId: string; entityCode: string; bookCode: string }
): Promise<FixedAssetRegister> {
  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId: input.tenantId, code: input.entityCode },
    select: { id: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: input.bookCode },
    select: { id: true },
  });
  const empty: FixedAssetRegister = {
    rows: [],
    totals: {
      cost: new Decimal(0),
      accumulatedDepreciation: new Decimal(0),
      netBookValue: new Decimal(0),
    },
    notConfiguredForBook: 0,
    disposedCount: 0,
  };
  if (!entity || !book) return empty;

  const [assets, disposedCount] = await Promise.all([
    prisma.fixedAsset.findMany({
      where: {
        tenantId: input.tenantId,
        entityId: entity.id,
        status: { in: [...ON_BOOK_ASSET_STATUSES] },
      },
      select: {
        id: true,
        code: true,
        description: true,
        category: true,
        status: true,
        acquisitionDate: true,
        acquisitionCost: true,
        assetAccountCode: true,
        bookAttributes: {
          where: { bookId: book.id },
          select: {
            accumulatedDepreciation: true,
            inServiceDate: true,
            usefulLifeMonths: true,
            depreciationMethod: true,
            lastDepreciatedThrough: true,
          },
        },
      },
      orderBy: { code: "asc" },
    }),
    prisma.fixedAsset.count({
      where: {
        tenantId: input.tenantId,
        entityId: entity.id,
        status: "DISPOSED",
      },
    }),
  ]);

  let notConfiguredForBook = 0;
  const rows: RegisterRow[] = assets.map((a) => {
    const attrs = a.bookAttributes[0];
    if (!attrs) notConfiguredForBook += 1;
    const cost = new Decimal(a.acquisitionCost.toString());
    // No attributes for this book means no depreciation has been booked
    // here, so the asset sits at cost — which is what the GL shows for a
    // newly imported asset, and what the reconciliation expects.
    const accumulatedDepreciation = attrs
      ? new Decimal(attrs.accumulatedDepreciation.toString())
      : new Decimal(0);
    return {
      id: a.id,
      code: a.code,
      description: a.description,
      category: a.category,
      status: a.status,
      acquisitionDate: a.acquisitionDate,
      assetAccountCode: a.assetAccountCode,
      cost,
      accumulatedDepreciation,
      netBookValue: cost.minus(accumulatedDepreciation),
      inServiceDate: attrs?.inServiceDate ?? null,
      usefulLifeMonths: attrs?.usefulLifeMonths ?? null,
      depreciationMethod: attrs?.depreciationMethod ?? null,
      lastDepreciatedThrough: attrs?.lastDepreciatedThrough ?? null,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      cost: acc.cost.plus(r.cost),
      accumulatedDepreciation: acc.accumulatedDepreciation.plus(
        r.accumulatedDepreciation
      ),
      netBookValue: acc.netBookValue.plus(r.netBookValue),
    }),
    {
      cost: new Decimal(0),
      accumulatedDepreciation: new Decimal(0),
      netBookValue: new Decimal(0),
    }
  );

  return { rows, totals, notConfiguredForBook, disposedCount };
}
