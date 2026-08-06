// The fixed-asset register, and the property that makes it worth
// trusting: its total equals what the fixed-asset RECONCILIATION pulls
// from the same rows.
//
// A register that disagreed with the reconciliation would be worse than
// no register — the accountant would have two numbers and no way to
// tell which one to believe. They share a status set and the same
// cost-minus-accumulated-depreciation math for exactly that reason,
// and this suite fails if they ever drift.
//
// The other case worth having: an asset with no book attributes. It
// depreciates nowhere in that book and sits at full cost forever, which
// is a real data problem the page surfaces rather than hides.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";

import { getFixedAssetRegister } from "@/lib/accounting/sub-ledgers/fixed-asset-register";
import { resolveSupportingBalance } from "@/lib/recon/supporting-balance";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);
const E = `FAR${SUFFIX}`.toUpperCase().slice(0, 14);
const ASSET_ACCT = `FA15${SUFFIX}`.slice(0, 12);

let tenantId: string;
let entityId: string;
let gaapBookId: string;
let taxBookId: string;

async function scrubStale() {
  const stale = await prisma.tenant.findMany({
    where: { slug: { startsWith: "far-reg" } },
    select: { id: true },
  });
  const ids = stale.map((t) => t.id);
  if (ids.length > 0) {
    await prisma.fixedAssetBookAttributes.deleteMany({
      where: { asset: { tenantId: { in: ids } } },
    });
    await prisma.fixedAsset.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.account.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  const users = await prisma.user.findMany({
    where: { displayName: { startsWith: "FAR Fixture" } },
    select: { id: true },
  });
  if (users.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: users.map((u) => u.id) } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();
  const owner = await prisma.user.create({
    data: { email: `far-${SUFFIX}@example.test`, displayName: "FAR Fixture owner" },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `far-reg-${SUFFIX}`, name: "FAR Co", ownerUserId: owner.id },
    select: { id: true },
  });
  tenantId = tenant.id;
  const ent = await prisma.legalEntity.create({
    data: { tenantId, code: E, name: E, functionalCurrencyId: "USD" },
    select: { id: true },
  });
  entityId = ent.id;
  gaapBookId = (
    await prisma.book.findUniqueOrThrow({ where: { code: "US_GAAP" }, select: { id: true } })
  ).id;
  taxBookId = (
    await prisma.book.findUniqueOrThrow({ where: { code: "US_TAX" }, select: { id: true } })
  ).id;

  // The control account the reconciliation would be run against.
  await prisma.account.create({
    data: {
      tenantId,
      entityId,
      code: ASSET_ACCT,
      name: "Computer equipment",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
  });

  // Two assets set up for GAAP, one of them ALSO for tax with a longer
  // life; one disposed; one never set up for any book.
  const laptop = await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `LAPTOP-${SUFFIX}`.slice(0, 20),
      description: "Engineering laptop",
      category: "COMPUTER_EQUIPMENT",
      acquisitionDate: new Date("2026-01-15"),
      acquisitionCost: "3000",
      acquisitionCurrencyId: "USD",
      assetAccountCode: ASSET_ACCT,
      status: "IN_SERVICE",
    },
    select: { id: true },
  });
  const server = await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `SERVER-${SUFFIX}`.slice(0, 20),
      description: "Rack server",
      acquisitionDate: new Date("2026-02-01"),
      acquisitionCost: "9000",
      acquisitionCurrencyId: "USD",
      assetAccountCode: ASSET_ACCT,
      status: "IDLE",
    },
    select: { id: true },
  });
  await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `OLDPC-${SUFFIX}`.slice(0, 20),
      description: "Retired desktop",
      acquisitionDate: new Date("2025-01-01"),
      acquisitionCost: "1200",
      acquisitionCurrencyId: "USD",
      assetAccountCode: ASSET_ACCT,
      status: "DISPOSED",
      disposalDate: new Date("2026-03-01"),
    },
  });
  // Deliberately has NO book attributes at all.
  await prisma.fixedAsset.create({
    data: {
      tenantId,
      entityId,
      code: `UNSET-${SUFFIX}`.slice(0, 20),
      description: "Never configured",
      acquisitionDate: new Date("2026-04-01"),
      acquisitionCost: "500",
      acquisitionCurrencyId: "USD",
      assetAccountCode: ASSET_ACCT,
      status: "IN_SERVICE",
    },
  });

  for (const [assetId, bookId, life, accum] of [
    [laptop.id, gaapBookId, 36, "1000"],
    [laptop.id, taxBookId, 60, "600"],
    [server.id, gaapBookId, 60, "1500"],
  ] as const) {
    await prisma.fixedAssetBookAttributes.create({
      data: {
        assetId,
        bookId,
        usefulLifeMonths: life,
        depreciationMethod: "STRAIGHT_LINE",
        inServiceDate: new Date("2026-02-01"),
        accumulatedDepreciation: accum,
        depreciationExpenseAccountCode: "8000",
        accumDepreciationAccountCode: "1510",
      },
    });
  }
}, 60_000);

afterAll(async () => {
  await scrubStale();
  await prisma.$disconnect();
});

describe("fixed-asset register", () => {
  it("lists on-book assets with per-book depreciation and excludes disposals", async () => {
    const reg = await getFixedAssetRegister(prisma, {
      tenantId,
      entityCode: E,
      bookCode: "US_GAAP",
    });
    // laptop + server + the unconfigured one; the disposed PC is out.
    expect(reg.rows).toHaveLength(3);
    expect(reg.disposedCount).toBe(1);
    expect(reg.rows.map((r) => r.status)).not.toContain("DISPOSED");

    // 3000 + 9000 + 500 cost, 1000 + 1500 accumulated.
    expect(reg.totals.cost.toString()).toBe("12500");
    expect(reg.totals.accumulatedDepreciation.toString()).toBe("2500");
    expect(reg.totals.netBookValue.toString()).toBe("10000");
  });

  it("shows the SAME asset differently in another book", async () => {
    // The point of multi-book: a 3-year GAAP laptop is a 5-year tax one.
    const tax = await getFixedAssetRegister(prisma, {
      tenantId,
      entityCode: E,
      bookCode: "US_TAX",
    });
    const laptop = tax.rows.find((r) => r.code.startsWith("LAPTOP"))!;
    expect(laptop.usefulLifeMonths).toBe(60);
    expect(laptop.accumulatedDepreciation.toString()).toBe("600");
    expect(laptop.netBookValue.toString()).toBe("2400");

    // The server has no tax attributes, so in THIS book it sits at cost.
    const server = tax.rows.find((r) => r.code.startsWith("SERVER"))!;
    expect(server.accumulatedDepreciation.toString()).toBe("0");
    expect(server.netBookValue.toString()).toBe("9000");
    // Two of three carry no tax setup — surfaced, not hidden.
    expect(tax.notConfiguredForBook).toBe(2);
  });

  it("counts assets that will never depreciate in this book", async () => {
    const reg = await getFixedAssetRegister(prisma, {
      tenantId,
      entityCode: E,
      bookCode: "US_GAAP",
    });
    expect(reg.notConfiguredForBook).toBe(1);
    const unset = reg.rows.find((r) => r.code.startsWith("UNSET"))!;
    expect(unset.usefulLifeMonths).toBeNull();
    expect(unset.netBookValue.toString()).toBe("500");
  });

  it("ties EXACTLY to what the fixed-asset reconciliation pulls", async () => {
    // The load-bearing property. Both read the same rows; if they ever
    // disagree the accountant has two numbers and no tiebreak.
    const reg = await getFixedAssetRegister(prisma, {
      tenantId,
      entityCode: E,
      bookCode: "US_GAAP",
    });
    const account = await prisma.account.findFirstOrThrow({
      where: { tenantId, code: ASSET_ACCT },
      select: { id: true },
    });
    const suggestion = await resolveSupportingBalance(prisma, {
      tenantId,
      entityId,
      bookId: gaapBookId,
      accountId: account.id,
      asOf: new Date("2026-06-30"),
    });
    expect(suggestion.source).toBe("FIXED_ASSET_REGISTER");
    expect(new Decimal(suggestion.amount!.toString()).toString()).toBe(
      reg.totals.netBookValue.toString()
    );
  });

  it("returns an empty register rather than throwing on an unknown scope", async () => {
    const reg = await getFixedAssetRegister(prisma, {
      tenantId,
      entityCode: "NO_SUCH_ENTITY",
      bookCode: "US_GAAP",
    });
    expect(reg.rows).toEqual([]);
    expect(reg.totals.cost.toString()).toBe("0");
  });
});
