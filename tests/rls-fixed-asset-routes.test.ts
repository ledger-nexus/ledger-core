// Integration test for RLS Phase 2b — fixed-asset HTTP routes + Class T
// refactor on createFixedAsset.
//
// Two angles:
//   1. createFixedAssetInTx runs cleanly inside withTenantContext, with
//      GUC = entity.tenantId.
//   2. The withTenantContext options forwarder (added in this PR) lets
//      a route pass timeout/maxWait/isolationLevel through to the
//      underlying $transaction — used by record-depreciation for the
//      30s extended-timeout batch path.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import {
  withTenantContext,
  getCurrentTenantGuc,
} from "../src/lib/db/tenant-context";
import {
  createFixedAsset,
  createFixedAssetInTx,
} from "../src/lib/accounting/sub-ledgers/fixed-assets";

const prisma = new PrismaClient();

let tenantId: string;
let entityCode: string;

beforeAll(async () => {
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: "NORTHWIND" },
    select: { code: true, tenantId: true },
  });
  tenantId = entity.tenantId;
  entityCode = entity.code;

  // Make sure the books we test against exist.
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("createFixedAsset Class T — RLS plumbing", () => {
  it("inner half (createFixedAssetInTx) runs inside withTenantContext with GUC set", async () => {
    const code = `RLS-FA-${Date.now().toString().slice(-8)}`;
    let observedGuc: string | null = null;

    const result = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      return createFixedAssetInTx(tx, {
        entityCode,
        code,
        description: "RLS test asset",
        category: "OFFICE_EQUIPMENT",
        acquisitionDate: new Date("2026-06-01"),
        acquisitionCost: new Decimal("1000.00"),
        acquisitionCurrencyCode: "USD",
        assetAccountCode: "1500",
        books: [
          {
            bookCode: "US_GAAP",
            usefulLifeMonths: 36,
            method: "STRAIGHT_LINE",
            inServiceDate: new Date("2026-06-01"),
            depreciationExpenseAccountCode: "8000",
            accumDepreciationAccountCode: "1510",
          },
        ],
      });
    });

    expect(observedGuc).toBe(tenantId);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Cleanup.
    await prisma.fixedAssetBookAttributes.deleteMany({
      where: { assetId: result.id },
    });
    await prisma.fixedAsset.delete({ where: { id: result.id } });
  });

  it("outer wrapper (createFixedAsset) still works on raw PrismaClient (legacy callers)", async () => {
    const code = `RLS-FA-LEGACY-${Date.now().toString().slice(-6)}`;

    const result = await createFixedAsset(prisma, {
      entityCode,
      code,
      description: "Legacy path test asset",
      category: "OFFICE_EQUIPMENT",
      acquisitionDate: new Date("2026-06-01"),
      acquisitionCost: new Decimal("500.00"),
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1500",
      books: [
        {
          bookCode: "US_GAAP",
          usefulLifeMonths: 36,
          method: "STRAIGHT_LINE",
          inServiceDate: new Date("2026-06-01"),
          depreciationExpenseAccountCode: "8000",
          accumDepreciationAccountCode: "1510",
        },
      ],
    });

    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Cleanup.
    await prisma.fixedAssetBookAttributes.deleteMany({
      where: { assetId: result.id },
    });
    await prisma.fixedAsset.delete({ where: { id: result.id } });
  });
});

describe("withTenantContext options forwarding", () => {
  it("accepts and forwards timeout option", async () => {
    // The option doesn't visibly change behavior in a fast test — we
    // just verify the call doesn't throw with the option present.
    // (If the option were dropped on the floor, this would still pass;
    // the real protection is the tsc check that the signature accepts it.)
    const result = await withTenantContext(
      tenantId,
      async (tx) => {
        return tx.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      },
      { timeout: 30_000 }
    );
    expect(result[0].ok).toBe(1);
  });
});
