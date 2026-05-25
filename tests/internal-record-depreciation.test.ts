// Integration test for POST /api/internal/fixed-asset/record-depreciation.
//
// Verifies the transactional contract that closes fa-amort v0.1's
// scoped exception:
//
//   - A single call posts N JEs AND advances FixedAssetBookAttributes
//     in one transaction. The book-attrs row's accumulatedDepreciation
//     + lastDepreciatedThrough are consistent with the JEs in the DB.
//
//   - Idempotent: re-running with the same periods returns the existing
//     entry numbers as duplicates, does NOT advance accumulated again,
//     and leaves the JE count unchanged.
//
//   - Mixed batch (some duplicates + some fresh) adds only the fresh
//     expense to accumulated.
//
// We invoke the route handler directly with a synthetic NextRequest;
// no HTTP server is started.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { POST } from "../src/app/api/internal/fixed-asset/record-depreciation/route";

const prisma = new PrismaClient();

const TOKEN = "test-internal-token-depr";
const ENTITY_CODE = "DEPRCO";
const BOOK_CODE = "US_GAAP";
const ASSET_CODE = "FA-9001";

beforeAll(async () => {
  process.env.INTERNAL_API_TOKEN = TOKEN;
  await seedMasterData();
});

beforeEach(async () => {
  await prisma.journalLine.deleteMany({
    where: { entry: { entity: { code: ENTITY_CODE } } },
  });
  await prisma.journalEntry.deleteMany({
    where: { entity: { code: ENTITY_CODE } },
  });
  await prisma.fixedAssetBookAttributes.updateMany({
    where: { asset: { entity: { code: ENTITY_CODE } } },
    data: { accumulatedDepreciation: "0", lastDepreciatedThrough: null },
  });
});

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY_CODE },
    create: { tenantId, code: ENTITY_CODE, name: "Depr Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  const book = await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: {
      code: BOOK_CODE,
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });
  // Expense + accumulated-depreciation accounts.
  for (const a of [
    { code: "8000", name: "Depreciation Expense", type: "EXPENSE", normalBalance: "DEBIT" },
    { code: "1510", name: "Accum Depreciation", type: "ASSET", normalBalance: "CREDIT" },
  ] as const) {
    const existing = await prisma.account.findFirst({
      where: { entityId: entity.id, code: a.code },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          entityId: entity.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
        },
      });
    }
  }
  // FixedAsset + bookAttrs.
  const existingAsset = await prisma.fixedAsset.findFirst({
    where: { entityId: entity.id, code: ASSET_CODE },
  });
  const asset =
    existingAsset ??
    (await prisma.fixedAsset.create({
      data: {
        entityId: entity.id,
        code: ASSET_CODE,
        description: "Test laptop fleet",
        category: "IT Equipment",
        acquisitionDate: new Date("2026-01-01"),
        acquisitionCost: "12000.0000",
        acquisitionCurrencyId: "USD",
        assetAccountCode: "1500",
      },
    }));
  await prisma.fixedAssetBookAttributes.upsert({
    where: { assetId_bookId: { assetId: asset.id, bookId: book.id } },
    create: {
      assetId: asset.id,
      bookId: book.id,
      usefulLifeMonths: 12,
      depreciationMethod: "STRAIGHT_LINE",
      inServiceDate: new Date("2026-01-01"),
      salvageValue: "0",
      accumulatedDepreciation: "0",
      lastDepreciatedThrough: null,
      depreciationExpenseAccountCode: "8000",
      accumDepreciationAccountCode: "1510",
    },
    update: {
      accumulatedDepreciation: "0",
      lastDepreciatedThrough: null,
    },
  });
}

function buildRequest(body: unknown): NextRequest {
  return new NextRequest(
    "http://localhost:3000/api/internal/fixed-asset/record-depreciation",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );
}

describe("POST /api/internal/fixed-asset/record-depreciation — transactional", () => {
  it("posts N JEs AND advances book-attrs in one call", async () => {
    const res = await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods: [
          { periodEnd: "2026-01-31", expenseAmount: "1000.00" },
          { periodEnd: "2026-02-28", expenseAmount: "1000.00" },
          { periodEnd: "2026-03-31", expenseAmount: "1000.00" },
        ],
      })
    );
    const json = (await res.json()) as {
      ok: boolean;
      entryNumbers: string[];
      duplicateCount: number;
      freshCount: number;
      newAccumulatedDepreciation: string;
      newLastDepreciatedThrough: string;
    };
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.entryNumbers).toHaveLength(3);
    expect(json.duplicateCount).toBe(0);
    expect(json.freshCount).toBe(3);
    expect(json.newAccumulatedDepreciation).toBe("3000.0000");
    expect(json.newLastDepreciatedThrough).toBe("2026-03-31");

    // The book-attrs row reflects the same state.
    const bookAttrs = await prisma.fixedAssetBookAttributes.findFirst({
      where: { asset: { code: ASSET_CODE, entity: { code: ENTITY_CODE } } },
      select: { accumulatedDepreciation: true, lastDepreciatedThrough: true },
    });
    expect(bookAttrs!.accumulatedDepreciation.toString()).toBe("3000");
    expect(bookAttrs!.lastDepreciatedThrough?.toISOString().slice(0, 10)).toBe(
      "2026-03-31"
    );

    // Exactly 3 JEs exist in the DB for this test entity.
    const count = await prisma.journalEntry.count({
      where: {
        sourceSystem: "fa-amort",
        sourceRecordType: "DepreciationRun",
        entity: { code: ENTITY_CODE },
      },
    });
    expect(count).toBe(3);
  });

  it("repeat call with same periods is idempotent — no double-counting", async () => {
    const periods = [
      { periodEnd: "2026-01-31", expenseAmount: "1000.00" },
      { periodEnd: "2026-02-28", expenseAmount: "1000.00" },
    ];
    // Call 1.
    const r1 = await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods,
      })
    );
    const j1 = (await r1.json()) as {
      newAccumulatedDepreciation: string;
      freshCount: number;
    };
    expect(j1.newAccumulatedDepreciation).toBe("2000.0000");
    expect(j1.freshCount).toBe(2);

    // Call 2 — identical input.
    const r2 = await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods,
      })
    );
    const j2 = (await r2.json()) as {
      newAccumulatedDepreciation: string;
      freshCount: number;
      duplicateCount: number;
      entryNumbers: string[];
    };
    // Accumulated did NOT double.
    expect(j2.newAccumulatedDepreciation).toBe("2000.0000");
    expect(j2.freshCount).toBe(0);
    expect(j2.duplicateCount).toBe(2);
    expect(j2.entryNumbers).toHaveLength(2);

    // Still only 2 JEs in DB for this test entity.
    const count = await prisma.journalEntry.count({
      where: {
        sourceSystem: "fa-amort",
        sourceRecordType: "DepreciationRun",
        entity: { code: ENTITY_CODE },
      },
    });
    expect(count).toBe(2);
  });

  it("mixed batch: 2 duplicates + 2 fresh advances only by the fresh expense", async () => {
    // First, post Jan + Feb.
    await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods: [
          { periodEnd: "2026-01-31", expenseAmount: "1000.00" },
          { periodEnd: "2026-02-28", expenseAmount: "1000.00" },
        ],
      })
    );

    // Now post Jan + Feb (dups) + Mar + Apr (fresh).
    const res = await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods: [
          { periodEnd: "2026-01-31", expenseAmount: "1000.00" },
          { periodEnd: "2026-02-28", expenseAmount: "1000.00" },
          { periodEnd: "2026-03-31", expenseAmount: "1000.00" },
          { periodEnd: "2026-04-30", expenseAmount: "1000.00" },
        ],
      })
    );
    const json = (await res.json()) as {
      duplicateCount: number;
      freshCount: number;
      newAccumulatedDepreciation: string;
      newLastDepreciatedThrough: string;
    };
    expect(json.duplicateCount).toBe(2);
    expect(json.freshCount).toBe(2);
    expect(json.newAccumulatedDepreciation).toBe("4000.0000");
    expect(json.newLastDepreciatedThrough).toBe("2026-04-30");

    // Exactly 4 JEs in DB for this test entity.
    const count = await prisma.journalEntry.count({
      where: {
        sourceSystem: "fa-amort",
        sourceRecordType: "DepreciationRun",
        entity: { code: ENTITY_CODE },
      },
    });
    expect(count).toBe(4);
  });

  it("rejects unknown asset", async () => {
    const res = await POST(
      buildRequest({
        assetCode: "FA-NONEXISTENT",
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods: [{ periodEnd: "2026-01-31", expenseAmount: "100.00" }],
      })
    );
    expect(res.status).toBe(422);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("UNKNOWN_ASSET");
  });

  it("rejects empty periods array", async () => {
    const res = await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods: [],
      })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("BAD_REQUEST");
  });

  it("rejects negative expense", async () => {
    const res = await POST(
      buildRequest({
        assetCode: ASSET_CODE,
        entityCode: ENTITY_CODE,
        bookCode: BOOK_CODE,
        periods: [{ periodEnd: "2026-01-31", expenseAmount: "-100.00" }],
      })
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("BAD_REQUEST");
  });
});
