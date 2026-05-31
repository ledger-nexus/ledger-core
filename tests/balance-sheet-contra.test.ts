// Regression test: contra-asset accounts must DEDUCT from total assets
// on the balance sheet (not add to them).
//
// The bug this guards against: getBalanceSheet was using signFor(type,
// isContra) which returns the account's EFFECTIVE normal side (with the
// contra flip applied). For Accumulated Depreciation (ASSET + isContra),
// that produced amount = credit - debit = the natural credit-side
// balance, which then got ADDED to totalAssets. A contra-asset's
// balance should reduce assets, not increase them — so the asset
// section needs to use the SECTION'S natural sign (debit-side) so
// contra-assets naturally compute as negative.
//
// Without the fix, the BS A = L + E identity fails by 2× the contra
// balance (once because the contra is wrongly added instead of
// subtracted).
//
// We post a minimal balanced set:
//   DR Cash 10,000 / CR Common Stock 10,000     (capital contribution)
//   DR Equipment 4,000 / CR Cash 4,000           (asset purchase)
//   DR Dep Exp 1,000 / CR Accum Dep 1,000        (depreciation)
//
// After this:
//   Cash             6,000
//   Equipment        4,000
//   Accum Dep      (1,000)     ← contra-asset, must DEDUCT
//   Total assets     9,000
//
//   Common Stock    10,000
//   Retained Eng.   (1,000)    ← from Dep Exp
//   Total equity     9,000
//
//   A = 9,000 = L (0) + E (9,000) ✓

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { getBalanceSheet } from "../src/lib/accounting/reports";

const prisma = new PrismaClient();

const ENTITY_CODE = "CONTRACO";
const BOOK_CODE = "US_GAAP";

beforeAll(async () => {
  await seedMasterData();
});

async function clearLedger() {
  await prisma.journalLine.deleteMany({
    where: { entry: { entity: { code: ENTITY_CODE } } },
  });
  await prisma.journalEntry.deleteMany({
    where: { entity: { code: ENTITY_CODE } },
  });
}

beforeEach(clearLedger);
afterAll(async () => {
  await clearLedger();
  await prisma.$disconnect();
});

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY_CODE } },
    create: { tenantId, code: ENTITY_CODE, name: "Contra Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  await prisma.book.upsert({
    where: { code: BOOK_CODE },
    create: {
      code: BOOK_CODE,
      name: "US GAAP",
      basis: "US_GAAP",
      reportingCurrencyId: "USD",
    },
    update: {},
  });

  const accounts = [
    { code: "1000", name: "Cash", type: "ASSET", normalBalance: "DEBIT", isContra: false },
    { code: "1500", name: "Equipment", type: "ASSET", normalBalance: "DEBIT", isContra: false },
    {
      code: "1510",
      name: "Accumulated Depreciation — Equipment",
      type: "ASSET",
      normalBalance: "CREDIT",
      isContra: true,
    },
    {
      code: "3000",
      name: "Common Stock",
      type: "EQUITY",
      normalBalance: "CREDIT",
      isContra: false,
    },
    {
      code: "8000",
      name: "Depreciation Expense",
      type: "EXPENSE",
      normalBalance: "DEBIT",
      isContra: false,
    },
  ] as const;
  for (const a of accounts) {
    const existing = await prisma.account.findFirst({
      where: { entityId: entity.id, code: a.code },
    });
    if (!existing) {
      await prisma.account.create({
        data: {
          tenantId: tenantId,
          entityId: entity.id,
          code: a.code,
          name: a.name,
          type: a.type,
          normalBalance: a.normalBalance,
          isContra: a.isContra,
        },
      });
    }
  }
}

async function postCapitalContribution() {
  return postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-01-01"),
    memo: "Founder capital",
    source: "MANUAL",
    lines: [
      { accountCode: "1000", debit: 10000 },
      { accountCode: "3000", credit: 10000 },
    ],
  });
}

async function postEquipmentPurchase() {
  return postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-01-15"),
    memo: "Buy laptops",
    source: "MANUAL",
    lines: [
      { accountCode: "1500", debit: 4000 },
      { accountCode: "1000", credit: 4000 },
    ],
  });
}

async function postDepreciation() {
  return postJournalEntry(prisma, {
    entityCode: ENTITY_CODE,
    bookCode: BOOK_CODE,
    currencyCode: "USD",
    documentDate: new Date("2026-12-31"),
    memo: "Annual depreciation",
    source: "MANUAL",
    lines: [
      { accountCode: "8000", debit: 1000 },
      { accountCode: "1510", credit: 1000 },
    ],
  });
}

describe("getBalanceSheet contra-asset handling", () => {
  it("contra-asset (Accum Dep) DEDUCTS from total assets — A = L + E holds", async () => {
    await postCapitalContribution();
    await postEquipmentPurchase();
    await postDepreciation();

    const bs = await getBalanceSheet(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: BOOK_CODE },
      new Date("2026-12-31")
    );

    // Per-line amounts.
    const cash = bs.assets.find((a) => a.code === "1000")!;
    const equip = bs.assets.find((a) => a.code === "1500")!;
    const accumDep = bs.assets.find((a) => a.code === "1510")!;
    expect(cash.amount.toFixed(2)).toBe("6000.00");
    expect(equip.amount.toFixed(2)).toBe("4000.00");
    // The contra balance MUST be negative in the asset section.
    expect(accumDep.amount.toFixed(2)).toBe("-1000.00");

    // Total assets = 6000 + 4000 + (-1000) = 9000.
    expect(bs.totalAssets.toFixed(2)).toBe("9000.00");

    // Equity = 10000 common stock + (-1000) retained earnings = 9000.
    expect(bs.totalEquity.toFixed(2)).toBe("9000.00");
    expect(bs.totalLiabilities.toFixed(2)).toBe("0.00");

    // The headline check: A = L + E.
    expect(bs.balances).toBe(true);
    expect(bs.totalAssets.equals(bs.totalLiabilitiesAndEquity)).toBe(true);
  });

  it("without a contra-asset, A = L + E still holds (no regression for non-contra accounts)", async () => {
    await postCapitalContribution();
    await postEquipmentPurchase();
    // skip depreciation — no contra balance

    const bs = await getBalanceSheet(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: BOOK_CODE },
      new Date("2026-12-31")
    );

    expect(bs.totalAssets.toFixed(2)).toBe("10000.00");
    expect(bs.totalEquity.toFixed(2)).toBe("10000.00");
    expect(bs.balances).toBe(true);
  });

  it("contra-asset balance is presented as negative in the assets section (display convention)", async () => {
    await postCapitalContribution();
    await postEquipmentPurchase();
    await postDepreciation();

    const bs = await getBalanceSheet(
      prisma,
      { entityCode: ENTITY_CODE, bookCode: BOOK_CODE },
      new Date("2026-12-31")
    );

    const accumDep = bs.assets.find((a) => a.code === "1510")!;
    expect(accumDep.amount.isNegative()).toBe(true);
  });
});
