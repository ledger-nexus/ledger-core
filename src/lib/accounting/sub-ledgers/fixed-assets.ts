// Fixed Asset sub-ledger.
//
// Spec rule: "the same physical asset can carry divergent useful life /
// depreciation method / accumulated depreciation across books." This is
// the canonical book-tax-difference engine: GAAP says 36-month straight
// line, Tax says 5-year MACRS, IFRS says 36-month SL — same laptop,
// three different depreciation streams.
//
// createFixedAsset creates the asset record and one book-attributes row
// per book the asset depreciates in. It does NOT post the acquisition
// journal entry — the caller posts that (because the spec says posting
// happens via the GL substrate, not the sub-ledger).
//
// runDepreciation walks every in-service asset in a (entity, book), works
// out how much depreciation has accrued since lastDepreciatedThrough, and
// posts ONE consolidated JE per book for the period. The JE references
// each asset via line.extensions so the sub-ledger detail roll up
// cleanly to GL.

import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../post-journal";

function toDecimal(v: Decimal | string | number | null | undefined): Decimal {
  if (v === undefined || v === null) return new Decimal(0);
  if (v instanceof Decimal) return v;
  return new Decimal(v);
}

export interface FixedAssetBookSpec {
  bookCode: string;
  usefulLifeMonths: number;
  method: "STRAIGHT_LINE" | "MACRS_5_HY" | "MACRS_7_HY" | "NONE";
  inServiceDate: Date;
  salvageValue?: Decimal | string | number;
  depreciationExpenseAccountCode: string; // typically "8000"
  accumDepreciationAccountCode: string; // typically "1510"
}

export interface CreateFixedAssetInput {
  entityCode: string;
  code: string;
  description: string;
  category?: string;
  vendorPartyCode?: string;
  acquisitionDate: Date;
  acquisitionCost: Decimal | string | number;
  acquisitionCurrencyCode: string;
  assetAccountCode: string;
  books: FixedAssetBookSpec[];
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export async function createFixedAsset(
  prisma: PrismaClient,
  input: CreateFixedAssetInput
): Promise<{ id: string }> {
  const entity = await prisma.legalEntity.findUniqueOrThrow({
    where: { code: input.entityCode },
    select: { id: true },
  });
  const vendor = input.vendorPartyCode
    ? await prisma.party.findFirstOrThrow({
        where: {
          code: input.vendorPartyCode,
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

  return await prisma.$transaction(async (tx) => {
    const asset = await tx.fixedAsset.create({
      data: {
        entityId: entity.id,
        code: input.code,
        description: input.description,
        category: input.category,
        vendorPartyId: vendor?.id,
        acquisitionDate: input.acquisitionDate,
        acquisitionCost: toDecimal(input.acquisitionCost).toFixed(4),
        acquisitionCurrencyId: input.acquisitionCurrencyCode,
        assetAccountCode: input.assetAccountCode,
        status: "IN_SERVICE",
        sourceSystem: input.sourceSystem,
        sourceRecordType: input.sourceRecordType,
        sourceRecordId: input.sourceRecordId,
        sourcePayload: (input.sourcePayload as any) ?? undefined,
        bookAttributes: {
          create: input.books.map((b) => {
            const bookId = bookIdByCode.get(b.bookCode);
            if (!bookId) {
              throw new Error(`Book ${b.bookCode} not found`);
            }
            return {
              bookId,
              usefulLifeMonths: b.usefulLifeMonths,
              depreciationMethod: b.method,
              inServiceDate: b.inServiceDate,
              salvageValue: toDecimal(b.salvageValue ?? 0).toFixed(4),
              depreciationExpenseAccountCode: b.depreciationExpenseAccountCode,
              accumDepreciationAccountCode: b.accumDepreciationAccountCode,
            };
          }),
        },
      },
      select: { id: true },
    });
    return asset;
  });
}

// Count full calendar months between two dates, inclusive of the start
// month. (2026-01-15 → 2026-06-30) = 6 months (Jan, Feb, Mar, Apr, May, Jun).
// Assets in service mid-month get the full month's depreciation — the
// "full-month convention", which is the most common GAAP practice.
function monthsBetween(start: Date, end: Date): number {
  if (end < start) return 0;
  const sy = start.getUTCFullYear();
  const sm = start.getUTCMonth();
  const ey = end.getUTCFullYear();
  const em = end.getUTCMonth();
  return (ey - sy) * 12 + (em - sm) + 1;
}

function monthlyStraightLine(
  cost: Decimal,
  salvage: Decimal,
  usefulLifeMonths: number
): Decimal {
  return cost.minus(salvage).div(usefulLifeMonths);
}

// MACRS 5-year half-year convention. Year-1 = 20% of basis, spread evenly
// across 12 months → 1.667% per month. (Half-year is a year-1 reduction
// already baked into the 20% factor; we just spread it monthly so it
// composes with the runner's full-month convention.)
const MACRS_5_HY_MONTHLY_PCT = [
  0.20 / 12, // year 1
  0.32 / 12, // year 2
  0.192 / 12, // year 3
  0.1152 / 12, // year 4
  0.1152 / 12, // year 5
  0.0576 / 12, // year 6 (half-year)
];

function macrs5HyMonthly(cost: Decimal, monthsInService: number): Decimal {
  // monthsInService is the number of months from inServiceDate to the
  // period being computed (1-indexed). Year = ceil(monthsInService / 12).
  const yearIdx = Math.min(Math.floor((monthsInService - 1) / 12), MACRS_5_HY_MONTHLY_PCT.length - 1);
  return cost.times(MACRS_5_HY_MONTHLY_PCT[yearIdx]);
}

export interface RunDepreciationInput {
  entityCode: string;
  bookCode: string;
  throughDate: Date;
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
}

export interface RunDepreciationResult {
  entriesPosted: number;
  totalDepreciation: Decimal;
  perAsset: { assetCode: string; months: number; amount: Decimal; entryNumber: string }[];
}

export async function runDepreciation(
  prisma: PrismaClient,
  input: RunDepreciationInput
): Promise<RunDepreciationResult> {
  const book = await prisma.book.findUniqueOrThrow({
    where: { code: input.bookCode },
    select: { id: true, reportingCurrencyId: true },
  });

  const assets = await prisma.fixedAsset.findMany({
    where: {
      entity: { code: input.entityCode },
      status: "IN_SERVICE",
    },
    include: {
      bookAttributes: {
        where: { bookId: book.id },
      },
    },
  });

  let entriesPosted = 0;
  let totalDepreciation = new Decimal(0);
  const perAsset: RunDepreciationResult["perAsset"] = [];

  for (const asset of assets) {
    const attrs = asset.bookAttributes[0];
    if (!attrs) continue;
    if (attrs.depreciationMethod === "NONE") continue;

    const inService = attrs.inServiceDate;
    if (input.throughDate < inService) continue;

    // First month not yet depreciated = lastDepreciatedThrough + 1 month
    // (or inServiceDate if never depreciated).
    let depreciateFrom: Date;
    if (attrs.lastDepreciatedThrough) {
      depreciateFrom = new Date(
        Date.UTC(
          attrs.lastDepreciatedThrough.getUTCFullYear(),
          attrs.lastDepreciatedThrough.getUTCMonth() + 1,
          1
        )
      );
    } else {
      depreciateFrom = new Date(
        Date.UTC(inService.getUTCFullYear(), inService.getUTCMonth(), 1)
      );
    }
    if (input.throughDate < depreciateFrom) continue;

    const monthsToDepreciate = monthsBetween(depreciateFrom, input.throughDate);
    if (monthsToDepreciate <= 0) continue;

    // Don't depreciate past useful life.
    const monthsAlreadyDepreciated = attrs.lastDepreciatedThrough
      ? monthsBetween(
          new Date(Date.UTC(inService.getUTCFullYear(), inService.getUTCMonth(), 1)),
          attrs.lastDepreciatedThrough
        )
      : 0;
    const monthsRemainingInLife = Math.max(0, attrs.usefulLifeMonths - monthsAlreadyDepreciated);
    const actualMonths = Math.min(monthsToDepreciate, monthsRemainingInLife);
    if (actualMonths <= 0) continue;

    const cost = toDecimal(asset.acquisitionCost);
    const salvage = toDecimal(attrs.salvageValue);

    // Compute depreciation per month and sum. For SL this is constant.
    // For MACRS it varies by year — sum month-by-month.
    let amount = new Decimal(0);
    if (attrs.depreciationMethod === "STRAIGHT_LINE") {
      const monthly = monthlyStraightLine(cost, salvage, attrs.usefulLifeMonths);
      amount = monthly.times(actualMonths);
    } else if (attrs.depreciationMethod === "MACRS_5_HY") {
      for (let i = 1; i <= actualMonths; i++) {
        amount = amount.plus(macrs5HyMonthly(cost, monthsAlreadyDepreciated + i));
      }
    } else {
      // Other methods not implemented in v1; skip.
      continue;
    }

    if (amount.lessThanOrEqualTo(0)) continue;

    const result = await postJournalEntry(prisma, {
      entityCode: input.entityCode,
      bookCode: input.bookCode,
      currencyCode: book.reportingCurrencyId,
      documentDate: input.throughDate,
      memo: `Depreciation thru ${input.throughDate.toISOString().slice(0, 10)} — ${asset.code}`,
      source: input.source ?? "SYSTEM",
      sourceRecordType: "Depreciation",
      sourceRecordId: asset.id,
      extensions: {
        assetCode: asset.code,
        assetId: asset.id,
        method: attrs.depreciationMethod,
        monthsDepreciated: actualMonths,
      },
      lines: [
        {
          accountCode: attrs.depreciationExpenseAccountCode,
          debit: amount.toFixed(4),
          description: `Depreciation expense — ${asset.code}`,
        },
        {
          accountCode: attrs.accumDepreciationAccountCode,
          credit: amount.toFixed(4),
          description: `Accumulated depreciation — ${asset.code}`,
        },
      ],
    });

    await prisma.fixedAssetBookAttributes.update({
      where: { assetId_bookId: { assetId: asset.id, bookId: book.id } },
      data: {
        accumulatedDepreciation: toDecimal(attrs.accumulatedDepreciation).plus(amount).toFixed(4),
        lastDepreciatedThrough: input.throughDate,
      },
    });

    entriesPosted += 1;
    totalDepreciation = totalDepreciation.plus(amount);
    perAsset.push({
      assetCode: asset.code,
      months: actualMonths,
      amount,
      entryNumber: result.entryNumber,
    });
  }

  return { entriesPosted, totalDepreciation, perAsset };
}

// Net book value per (entity, book) = sum of acquisitionCost - accumDep across in-service assets.
export async function netBookValue(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string
): Promise<{ totalGross: Decimal; totalAccumDep: Decimal; nbv: Decimal }> {
  const assets = await prisma.fixedAsset.findMany({
    where: {
      entity: { code: entityCode },
      status: { in: ["IN_SERVICE", "IDLE"] },
    },
    include: {
      bookAttributes: {
        where: { book: { code: bookCode } },
        select: { accumulatedDepreciation: true },
      },
    },
  });
  let gross = new Decimal(0);
  let accum = new Decimal(0);
  for (const a of assets) {
    gross = gross.plus(toDecimal(a.acquisitionCost));
    if (a.bookAttributes[0]) {
      accum = accum.plus(toDecimal(a.bookAttributes[0].accumulatedDepreciation));
    }
  }
  return { totalGross: gross, totalAccumDep: accum, nbv: gross.minus(accum) };
}
