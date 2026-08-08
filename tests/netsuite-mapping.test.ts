// NetSuite mapping invariants + dimension engine exercise + roundtrip.
//
// This is the "ceiling test" companion to qbo-mapping.test.ts. The
// dimension engine (which has been an empty table seam since v0.2) gets
// its first real workout — every transaction line carries class /
// department / location / region dimensions, dedup'd via DimensionSet's
// stable hash.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { Decimal } from "@/lib/utils/decimal";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  importFromNs,
  exportToNs,
  diffNsExports,
  dimensionSetHash,
  type NsExport,
} from "../src/lib/mappers/netsuite";
import { getTrialBalance, getBalanceSheet } from "../src/lib/accounting/reports";
import { openArBalance } from "../src/lib/accounting/sub-ledgers/ar";
import { openApBalance } from "../src/lib/accounting/sub-ledgers/ap";

const prisma = new PrismaClient();
const ENTITY = "NS_DEMO";
const SCOPE = { entityCode: ENTITY, bookCode: "US_GAAP" };

function loadFixture(): NsExport {
  const path = join(__dirname, "..", "prisma", "fixtures", "netsuite-sample.json");
  return JSON.parse(readFileSync(path, "utf-8"));
}

async function clearAll() {
  // Scope JE/sub-ledger cleanup to the NS test entity — never wipe
  // Northwind / other tests' data.
  const ent = await prisma.legalEntity.findFirst({
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
  // ⚠️ EVERYTHING BELOW USED TO BE UNSCOPED, three lines under a comment
  // promising to "never wipe Northwind / other tests' data".
  //
  // `dimensionSet.deleteMany()` with no argument deletes every dimension set
  // belonging to every tenant on the database — 293 of them on the shared dev
  // instance — and `account.deleteMany({ sourceSystem: "NETSUITE" })` does the
  // same for accounts. DEMONSTRATED, not theorised: a NetSuite-sourced account
  // and a Dimension planted on a throwaway tenant both went 1 -> 0 from a
  // single run of this file.
  //
  // The justification given was that the NS mapper is the only dimension
  // consumer in v1.x. That is true and still does not license a global
  // delete: ELEVEN other suites write `sourceSystem: "NETSUITE"` rows, and
  // vitest runs files in parallel, so this beforeAll can fire while one of
  // them is mid-import. A suite that deletes another suite's rows produces a
  // failure in the OTHER file, which is the hardest kind of red to trace.
  const tenantId = await getDefaultTenantId(prisma);

  // Dimension catalogs are tenant-level, not entity-level, so tenant is the
  // narrowest scope available here. Within the tenant this file is the only
  // direct dimension consumer; the assertions below no longer depend on that
  // being true, because they count through this entity's own lines.
  await prisma.dimensionSetValue.deleteMany({ where: { dimensionSet: { tenantId } } });
  await prisma.dimensionSet.deleteMany({ where: { tenantId } });
  await prisma.dimensionValue.deleteMany({ where: { tenantId } });
  await prisma.dimension.deleteMany({ where: { tenantId } });
  await prisma.customFieldDefinition.deleteMany({
    where: { tenantId, sourceErpField: { startsWith: "cust" } },
  });
  // NETSUITE-sourced items / parties / accounts — scoped to THIS suite's
  // entity, not to every entity that has ever seen a NetSuite import.
  if (entityId) {
    await prisma.item.deleteMany({ where: { tenantId, entityId, sourceSystem: "NETSUITE" } });
    await prisma.partyRole.deleteMany({
      where: { party: { tenantId, entityId, sourceSystem: "NETSUITE" } },
    });
    await prisma.party.deleteMany({ where: { tenantId, entityId, sourceSystem: "NETSUITE" } });
    await prisma.account.deleteMany({ where: { tenantId, entityId, sourceSystem: "NETSUITE" } });
  }
}

async function seedMasterData() {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  const tenantId = await getDefaultTenantId(prisma);
  const entity = await prisma.legalEntity.upsert({
    where: { tenantId_code: { tenantId, code: ENTITY } },
    create: { tenantId, code: ENTITY, name: "NS Demo Co.", functionalCurrencyId: "USD" },
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
// Pure mapper unit — dimension-set hash determinism
// =========================================================================

describe("dimension-set hash", () => {
  it("is order-insensitive on assignments", () => {
    const a = dimensionSetHash([
      { dimensionCode: "CLASS", valueCode: "10" },
      { dimensionCode: "DEPARTMENT", valueCode: "20" },
    ]);
    const b = dimensionSetHash([
      { dimensionCode: "DEPARTMENT", valueCode: "20" },
      { dimensionCode: "CLASS", valueCode: "10" },
    ]);
    expect(a).toBe(b);
  });

  it("differs when any value differs", () => {
    const a = dimensionSetHash([{ dimensionCode: "CLASS", valueCode: "10" }]);
    const b = dimensionSetHash([{ dimensionCode: "CLASS", valueCode: "11" }]);
    expect(a).not.toBe(b);
  });

  it("differs when an assignment is added", () => {
    const a = dimensionSetHash([{ dimensionCode: "CLASS", valueCode: "10" }]);
    const b = dimensionSetHash([
      { dimensionCode: "CLASS", valueCode: "10" },
      { dimensionCode: "DEPARTMENT", valueCode: "20" },
    ]);
    expect(a).not.toBe(b);
  });
});

// =========================================================================
// Import structural invariants
// =========================================================================

describe("NS import: structural invariants", () => {
  it("imports the expected counts; TB balances after", async () => {
    const fixture = loadFixture();
    const result = await importFromNs(prisma, {
      entityCode: ENTITY,
      export: fixture,
    });

    expect(result.errors).toEqual([]);
    expect(result.accountsImported).toBe(7);
    expect(result.partiesImported).toBe(3); // 2 customers + 1 vendor
    expect(result.itemsImported).toBe(1);
    // 2 invoices + 1 bill + 1 cust pmt + 1 vendor pmt + 1 JE = 6
    expect(result.journalEntriesImported).toBe(6);
    expect(result.arOpenItemsOpened).toBe(2);
    expect(result.apOpenItemsOpened).toBe(1);
    expect(result.paymentsApplied).toBe(2);

    // Dimensions: CLASS, DEPARTMENT, LOCATION + custcol_region custom segment
    expect(result.dimensionsCreated).toBe(4);
    expect(result.dimensionValuesCreated).toBe(2 + 3 + 2 + 2); // 9 values total

    const tb = await getTrialBalance(prisma, SCOPE, new Date("2026-12-31"));
    expect(tb.totalDebit.equals(tb.totalCredit)).toBe(true);
  });

  it("Sub-ledger invariants: AR control = $12.5k (Invoice 10001 unpaid); AP = $0", async () => {
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    const openArBal = await openArBalance(prisma, ENTITY, "US_GAAP");
    expect(openArBal.equals(new Decimal(12_500))).toBe(true);

    const bs = await getBalanceSheet(prisma, SCOPE, new Date("2026-12-31"));
    const arRow = bs.assets.find((a) => a.code === "NS1200");
    expect(arRow).toBeDefined();
    expect(arRow!.amount.equals(openArBal)).toBe(true);

    const openApBal = await openApBalance(prisma, ENTITY, "US_GAAP");
    expect(openApBal.equals(new Decimal(0))).toBe(true);
  });

  it("lineage on every imported row", async () => {
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    const counts = await Promise.all([
      prisma.account.count({ where: { entity: { code: ENTITY }, sourceSystem: "NETSUITE" } }),
      prisma.party.count({ where: { entity: { code: ENTITY }, sourceSystem: "NETSUITE" } }),
      prisma.item.count({ where: { entity: { code: ENTITY }, sourceSystem: "NETSUITE" } }),
      prisma.journalEntry.count({ where: { entity: { code: ENTITY }, sourceSystem: "NETSUITE" } }),
    ]);
    expect(counts).toEqual([7, 3, 1, 6]);

    const sample = await prisma.journalEntry.findFirst({
      where: { entity: { code: ENTITY }, sourceRecordType: "Invoice" },
      select: { sourceRecordId: true, sourcePayload: true, mappingVersion: true },
    });
    expect(sample).toBeDefined();
    expect(sample!.mappingVersion).toBe("ns-v1");
    expect(sample!.sourcePayload).toBeDefined();
  });
});

// =========================================================================
// Dimension engine exercise — the headline of v0.6
// =========================================================================

describe("NS import: dimension engine populated", () => {
  it("populates Dimension / DimensionValue / DimensionSet / DimensionSetValue with the expected data", async () => {
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    const dimensions = await prisma.dimension.findMany({
      where: { tenantId: await getDefaultTenantId(prisma) },
      orderBy: { code: "asc" },
    });
    expect(dimensions.map((d) => d.code).sort()).toEqual(
      ["CLASS", "CUSTCOL_REGION", "DEPARTMENT", "LOCATION"].sort()
    );

    const departmentValues = await prisma.dimensionValue.findMany({
      where: { dimension: { code: "DEPARTMENT" } },
      orderBy: { code: "asc" },
    });
    expect(departmentValues.map((v) => v.code).sort()).toEqual(["20", "21", "22"].sort());

    // Unique combos in the fixture (each appears at least once on a line):
    //   Invoice 10001 line 1: CLASS=10, DEPT=20, LOC=30, REGION=100
    //   Invoice 10001 line 2: CLASS=11, DEPT=21, LOC=30, REGION=100
    //   Invoice 10002 line 1: CLASS=10, DEPT=21, LOC=31, REGION=101
    //   Bill    20001 line 1: CLASS=10, DEPT=22, LOC=30, REGION=100
    //   JE      50001 line 1: DEPT=22, LOC=30  (no class — partial set)
    //   JE      50001 line 2: DEPT=22, LOC=30  (same as line 1 → shares set)
    // → 5 distinct DimensionSets.
    // Counted through THIS entity's lines rather than as a table total.
    // `dimensionSet.count()` with no filter answers "how many dimension sets
    // exist anywhere", which is only the same number as long as nothing else
    // on the database has ever imported one — and the multi-subsidiary NS
    // suites import into the same tenant. The claim being tested is that this
    // fixture dedups to 5 distinct sets, so count the distinct sets its own
    // lines point at.
    const setIds = await prisma.journalLine.findMany({
      where: { entry: { entity: { code: ENTITY }, sourceSystem: "NETSUITE" }, dimensionSetId: { not: null } },
      select: { dimensionSetId: true },
      distinct: ["dimensionSetId"],
    });
    expect(setIds).toHaveLength(5);

    // Identical assignments dedup: line 1 and line 2 of the JE should
    // share one DimensionSet, not two.
    const jeLines = await prisma.journalLine.findMany({
      where: {
        entry: { entity: { code: ENTITY }, sourceSystem: "NETSUITE", sourceRecordType: "JournalEntry" },
      },
      select: { dimensionSetId: true },
      orderBy: { lineNo: "asc" },
    });
    expect(jeLines[0].dimensionSetId).toBe(jeLines[1].dimensionSetId);
    expect(jeLines[0].dimensionSetId).not.toBeNull();
  });

  it("each Invoice line carries a dimensionSetId; dimension set values match assignments", async () => {
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    const inv10001Lines = await prisma.journalLine.findMany({
      where: {
        entry: {
          entity: { code: ENTITY },
          sourceSystem: "NETSUITE",
          sourceRecordType: "Invoice",
          sourceRecordId: "10001",
        },
      },
      include: {
        dimensionSet: {
          include: {
            values: {
              include: {
                dimension: { select: { code: true } },
                dimensionValue: { select: { code: true } },
              },
            },
          },
        },
      },
      orderBy: { lineNo: "asc" },
    });

    // Invoice has 3 lines (1 AR + 2 revenue). The AR line has no dim
    // assignments; revenue lines do.
    expect(inv10001Lines).toHaveLength(3);
    expect(inv10001Lines[0].dimensionSetId).toBeNull(); // AR debit line — no dims

    // Revenue line 1 (the original NS line 1) had CLASS=10, DEPT=20, LOC=30, REGION=100.
    const line1Dims = inv10001Lines[1].dimensionSet!.values
      .map((dv) => `${dv.dimension.code}:${dv.dimensionValue.code}`)
      .sort();
    expect(line1Dims).toEqual(
      ["CLASS:10", "CUSTCOL_REGION:100", "DEPARTMENT:20", "LOCATION:30"].sort()
    );
  });

  it("aggregating by dimension produces sensible totals", async () => {
    // E.g., revenue total per department.
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    // Engineering (DEPT=20): Invoice 10001 line 1 = $7,500
    // Sales (DEPT=21): Invoice 10001 line 2 ($5,000) + Invoice 10002 line 1 ($8,000) = $13,000
    // G&A (DEPT=22): Bill expense $9,500 (not revenue) + JE founding (cash side, no revenue)

    const revLines = await prisma.journalLine.findMany({
      where: {
        account: { code: "NS4000" },
        entry: { entity: { code: ENTITY }, book: { code: "US_GAAP" } },
        dimensionSet: { values: { some: { dimension: { code: "DEPARTMENT" } } } },
      },
      include: {
        dimensionSet: {
          include: { values: { include: { dimension: true, dimensionValue: true } } },
        },
      },
    });

    const byDept = new Map<string, Decimal>();
    for (const l of revLines) {
      const deptValue = l.dimensionSet!.values.find((v) => v.dimension.code === "DEPARTMENT");
      if (!deptValue) continue;
      const code = deptValue.dimensionValue.code;
      const amount = new Decimal(l.credit.toString()).minus(new Decimal(l.debit.toString()));
      byDept.set(code, (byDept.get(code) ?? new Decimal(0)).plus(amount));
    }

    expect(byDept.get("20")?.toNumber() ?? 0).toBe(7_500);
    expect(byDept.get("21")?.toNumber() ?? 0).toBe(13_000);
  });
});

// =========================================================================
// Custom field exercise
// =========================================================================

describe("NS import: custom fields populate extensions + CustomFieldDefinition", () => {
  it("registers custom field definitions", async () => {
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    const defs = await prisma.customFieldDefinition.findMany({
      where: { tenantId: await getDefaultTenantId(prisma), sourceErpField: { startsWith: "cust" } },
      orderBy: { fieldKey: "asc" },
    });
    expect(defs.map((d) => d.fieldKey)).toEqual([
      "custbody_priority",
      "custentity_industry",
    ]);
  });

  it("populates extensions JSONB on customer with custentity_* fields", async () => {
    const fixture = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    const acme = await prisma.party.findFirstOrThrow({
      where: {
        entity: { code: ENTITY },
        sourceRecordId: "5000",
        sourceRecordType: "Customer",
      },
      select: { extensions: true },
    });
    expect(acme.extensions).toEqual({ custentity_industry: "Manufacturing" });
  });
});

// =========================================================================
// Idempotency
// =========================================================================

describe("NS import: idempotent", () => {
  it("re-running produces zero new rows", async () => {
    const fixture = loadFixture();
    const first = await importFromNs(prisma, { entityCode: ENTITY, export: fixture });
    const second = await importFromNs(prisma, { entityCode: ENTITY, export: fixture });

    expect(second.accountsImported).toBe(0);
    expect(second.accountsSkipped).toBe(first.accountsImported);
    expect(second.partiesImported).toBe(0);
    expect(second.partiesSkipped).toBe(first.partiesImported);
    expect(second.journalEntriesImported).toBe(0);
    expect(second.journalEntriesSkipped).toBe(first.journalEntriesImported);
  });
});

// =========================================================================
// Roundtrip
// =========================================================================

describe("NS roundtrip: export reconstructs the original", () => {
  it("export equals input (modulo _meta + array ordering)", async () => {
    const original = loadFixture();
    await importFromNs(prisma, { entityCode: ENTITY, export: original });
    const roundTripped = await exportToNs(prisma, { entityCode: ENTITY });

    // The fixture doesn't include Subsidiary in the export (we don't
    // import them yet), so drop from both sides for the comparison.
    const stripped: NsExport = { ...roundTripped, _meta: undefined, Subsidiary: undefined };
    const originalStripped: NsExport = { ...original, _meta: undefined, Subsidiary: undefined };

    const diff = diffNsExports(originalStripped, stripped);
    if (diff !== null) {
      expect(diff).toBe(null);
    }
  });
});
