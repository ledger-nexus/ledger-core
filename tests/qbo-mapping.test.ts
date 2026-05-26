// QBO mapping invariants + roundtrip proof.
//
// The headline assertions for the "validate by mapping" milestone from
// docs/universal-schema.md: a real-shaped QBO export can be imported,
// produces a balanced trial balance, every imported row carries lineage,
// AR/AP sub-ledger invariants hold, AND a subsequent export reconstructs
// the original JSON.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { Decimal } from "decimal.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  importFromQbo,
  exportToQbo,
  diffQboExports,
  type QboExport,
} from "../src/lib/mappers/qbo";
import { getTrialBalance, getBalanceSheet } from "../src/lib/accounting/reports";
import { openArBalance } from "../src/lib/accounting/sub-ledgers/ar";
import { openApBalance } from "../src/lib/accounting/sub-ledgers/ap";

const prisma = new PrismaClient();
const ENTITY = "QBO_DEMO";
const SCOPE = { entityCode: ENTITY, bookCode: "US_GAAP" };

function loadFixture(): QboExport {
  const path = join(__dirname, "..", "prisma", "fixtures", "qbo-sample.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function clearAll() {
  // Scope to the QBO test entity — never wipe Northwind / other tests' data.
  const ent = await prisma.legalEntity.findUnique({
    where: { code: ENTITY },
    select: { id: true },
  });
  const entityId = ent?.id;
  if (entityId) {
    await prisma.arApplication.deleteMany({
      where: { openItem: { entityId } },
    });
    await prisma.apApplication.deleteMany({
      where: { openItem: { entityId } },
    });
    await prisma.arOpenItem.deleteMany({ where: { entityId } });
    await prisma.apOpenItem.deleteMany({ where: { entityId } });
    await prisma.journalLine.deleteMany({
      where: { entry: { entityId } },
    });
    await prisma.journalEntry.deleteMany({ where: { entityId } });
  }
  // QBO-sourced parties + accounts may be shared (entityId=null), so
  // scope by sourceSystem rather than entity. These belong to the QBO
  // mapper's own data; deleting them across runs is correct.
  await prisma.partyRole.deleteMany({
    where: { party: { sourceSystem: "QBO" } },
  });
  await prisma.party.deleteMany({ where: { sourceSystem: "QBO" } });
  await prisma.account.deleteMany({ where: { sourceSystem: "QBO" } });
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { code: ENTITY },
    create: { tenantId, code: ENTITY, name: "QBO Demo Co.", functionalCurrencyId: "USD" },
    update: { tenantId },
  });
  for (const b of [
    { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP" as const },
    { code: "US_TAX", name: "US Federal Tax", basis: "US_TAX" as const },
    { code: "IFRS", name: "IFRS", basis: "IFRS" as const },
  ]) {
    await prisma.book.upsert({
      where: { code: b.code },
      create: { code: b.code, name: b.name, basis: b.basis, reportingCurrencyId: "USD" },
      update: {},
    });
  }
  const calendar = await prisma.fiscalCalendar.upsert({
    where: { entityId_code: { entityId: entity.id, code: "STANDARD_2026" } },
    create: {
      tenantId: tenantId,
      entityId: entity.id,
      code: "STANDARD_2026",
      name: "2026",
      periodFrequency: "MONTHLY",
    },
    update: {},
  });
  for (let m = 1; m <= 12; m++) {
    const code = `2026-${String(m).padStart(2, "0")}`;
    await prisma.period.upsert({
      where: { calendarId_code: { calendarId: calendar.id, code } },
      create: {
        tenantId: tenantId,
        calendarId: calendar.id,
        code,
        ordinal: m,
        startsOn: new Date(Date.UTC(2026, m - 1, 1)),
        endsOn: new Date(Date.UTC(2026, m, 0)),
      },
      update: {},
    });
  }
}

beforeAll(async () => {
  await seedMasterData();
});

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await clearAll();
});

// =========================================================================
// Import invariants
// =========================================================================

describe("QBO import: structural invariants", () => {
  it("imports accounts, parties, and transactions; TB balances after import", async () => {
    const fixture = loadFixture();
    const result = await importFromQbo(prisma, {
      entityCode: ENTITY,
      export: fixture,
    });

    expect(result.accountsImported).toBe(6);
    expect(result.partiesImported).toBe(3); // 2 customers + 1 vendor
    // 2 invoices + 1 bill + 1 payment + 1 billpayment + 1 JE = 6 journal entries
    expect(result.journalEntriesImported).toBe(6);
    expect(result.arOpenItemsOpened).toBe(2); // 2 invoices opened AR items
    expect(result.apOpenItemsOpened).toBe(1); // 1 bill opened AP item
    expect(result.paymentsApplied).toBe(2);   // 1 customer payment + 1 vendor payment
    expect(result.errors).toEqual([]);

    const tb = await getTrialBalance(prisma, SCOPE, new Date("2026-12-31"));
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("sub-ledger invariant holds: AR control = sum of open AR items", async () => {
    const fixture = loadFixture();
    await importFromQbo(prisma, { entityCode: ENTITY, export: fixture });

    const openBal = await openArBalance(prisma, ENTITY, "US_GAAP");
    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-12-31"));
    // QBO-imported AR account has code "Q2" (Accounts Receivable, Id=2).
    const arRow = bs.assets.find((a) => a.code === "Q2");
    expect(arRow).toBeDefined();
    expect(openBal.equals(arRow!.amount)).toBe(true);

    // Sample data: invoice 5001 ($5k) unpaid; invoice 5002 ($5k) paid by Payment 7001.
    // → open AR = $5,000 (invoice 5001).
    expect(openBal.equals(new Decimal(5_000))).toBe(true);
  });

  it("AP invariant: vendor bill paid by BillPayment leaves zero AP", async () => {
    const fixture = loadFixture();
    await importFromQbo(prisma, { entityCode: ENTITY, export: fixture });

    const openBal = await openApBalance(prisma, ENTITY, "US_GAAP");
    expect(openBal.equals(new Decimal(0))).toBe(true);
  });

  it("every imported row carries QBO lineage", async () => {
    const fixture = loadFixture();
    await importFromQbo(prisma, { entityCode: ENTITY, export: fixture });

    const accountsWithLineage = await prisma.account.count({
      where: { entity: { code: ENTITY }, sourceSystem: "QBO" },
    });
    expect(accountsWithLineage).toBe(6);

    const partiesWithLineage = await prisma.party.count({
      where: { entity: { code: ENTITY }, sourceSystem: "QBO" },
    });
    expect(partiesWithLineage).toBe(3);

    const entriesWithLineage = await prisma.journalEntry.count({
      where: { entity: { code: ENTITY }, sourceSystem: "QBO" },
    });
    expect(entriesWithLineage).toBe(6);

    // Pick one and verify sourcePayload is populated.
    const sample = await prisma.journalEntry.findFirst({
      where: { entity: { code: ENTITY }, sourceSystem: "QBO", sourceRecordType: "Invoice" },
      select: { sourceRecordId: true, sourcePayload: true, mappingVersion: true },
    });
    expect(sample).toBeDefined();
    expect(sample!.sourceRecordId).toBe("5001");
    expect(sample!.sourcePayload).toBeDefined();
    expect(sample!.mappingVersion).toBe("qbo-v1");
  });

  it("idempotency: re-importing the same fixture does not duplicate rows", async () => {
    const fixture = loadFixture();
    const first = await importFromQbo(prisma, { entityCode: ENTITY, export: fixture });
    const second = await importFromQbo(prisma, { entityCode: ENTITY, export: fixture });

    // Second run reports everything skipped.
    expect(second.accountsImported).toBe(0);
    expect(second.accountsSkipped).toBe(first.accountsImported);
    expect(second.partiesImported).toBe(0);
    expect(second.partiesSkipped).toBe(first.partiesImported);
    expect(second.journalEntriesImported).toBe(0);
    expect(second.journalEntriesSkipped).toBe(first.journalEntriesImported);

    // Row counts didn't double.
    const totalEntries = await prisma.journalEntry.count({
      where: { entity: { code: ENTITY }, sourceSystem: "QBO" },
    });
    expect(totalEntries).toBe(first.journalEntriesImported);
  });
});

// =========================================================================
// Roundtrip proof
// =========================================================================

describe("QBO roundtrip: export reconstructs the original", () => {
  it("export → import → export produces JSON equivalent to the original", async () => {
    const original = loadFixture();
    await importFromQbo(prisma, { entityCode: ENTITY, export: original });

    const roundTripped = await exportToQbo(prisma, { entityCode: ENTITY });

    // Strip _meta from both sides — that's regenerated each export and
    // doesn't need to match.
    const stripped: QboExport = { ...roundTripped, _meta: undefined };
    const originalStripped: QboExport = { ...original, _meta: undefined };

    const diff = diffQboExports(originalStripped, stripped);
    if (diff !== null) {
      // surface the diff in the assertion message
      expect(diff).toBe(null);
    }
  });
});
