// v0.8 FX Phase 2 test — NS exchangerate precedence.
//
// Proves the importer prefers a transaction's NS-supplied
// `exchangerate` field over the seeded FxRate row. ASC 830 requires
// recording at the rate in effect at the transaction date; NS's
// posting-time rate is the authoritative source, the seeded rate is
// a fallback for older exports.
//
// The fixture's UK invoice (10003, currency=GBP) doesn't carry
// exchangerate, so it uses the seeded 1.27. This test constructs a
// minimal NsExport that DOES carry an exchangerate (a fictional 1.50
// to make the difference unmistakable from the seeded rate) and
// verifies the JE lines reflect 1.50, not 1.27.
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { importFromNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const PREFIX = "FXPHASE2"; // distinct from VANDEMO / VANE2E / VANRT

async function ensureCurrencies() {
  for (const c of ["USD", "GBP"]) {
    await prisma.currency.upsert({
      where: { code: c },
      create: { code: c, name: c, decimals: 2, symbol: c },
      update: {},
    });
  }
}

// Seed GBP→USD at 1.20 — DIFFERENT from the NS-supplied 1.50 below.
// If the importer ignores the NS rate and uses the seeded rate, the
// test fails: the line lands at 1200 instead of 1500.
async function ensureSeededRate() {
  await prisma.fxRate.upsert({
    where: {
      fromCurrencyId_toCurrencyId_asOf_rateType: {
        fromCurrencyId: "GBP",
        toCurrencyId: "USD",
        asOf: new Date("2026-01-01"),
        rateType: "SPOT",
      },
    },
    create: {
      fromCurrencyId: "GBP",
      toCurrencyId: "USD",
      asOf: new Date("2026-01-01"),
      rate: "1.2000",
      rateType: "SPOT",
    },
    update: { rate: "1.2000" },
  });
}

async function cleanup() {
  const tenantId = await getDefaultTenantId(prisma);
  const lineageIds = ["91001", "91002"];

  const jeIds = (
    await prisma.journalEntry.findMany({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordId: { in: lineageIds },
        tenantId,
      },
      select: { id: true },
    })
  ).map((j) => j.id);

  if (jeIds.length > 0) {
    await prisma.arApplication.deleteMany({
      where: {
        OR: [
          { appliedByEntryId: { in: jeIds } },
          { openItem: { openedByEntryId: { in: jeIds } } },
        ],
      },
    });
    await prisma.arOpenItem.deleteMany({
      where: { openedByEntryId: { in: jeIds } },
    });
  }

  await prisma.journalEntry.deleteMany({
    where: { sourceSystem: "NETSUITE", sourceRecordId: { in: lineageIds }, tenantId },
  });

  await prisma.party.deleteMany({
    where: { sourceSystem: "NETSUITE", tenantId, sourceRecordId: { in: ["97001"] } },
  });
  // Don't delete the global-chart accounts (NS1200, NS4000) — they're
  // shared with other NS test suites (VANDEMO / VANE2E / VANRT) and
  // their JEs would block the delete via the gl_entry_line FK. The
  // accounts persist across tests; that's fine, the importer's
  // lineage-triple upsert makes re-creation idempotent.
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: { in: [`${PREFIX}_NS1`] } },
  });
}

describe("NS exchangerate precedence (v0.8 FX Phase 2)", () => {
  beforeAll(async () => {
    await ensureCurrencies();
    await ensureSeededRate();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("uses NS-supplied exchangerate (1.50) over seeded rate (1.20)", async () => {
    const nsExport: NsExport = {
      _meta: { sourceSystem: "NETSUITE", exportedAt: "2026-04-15T00:00:00Z" },
      Subsidiary: [
        {
          internalid: "1",
          name: "FX Phase 2 Test Sub",
          iselimination: false,
          currency: "USD",
          country: "US",
        },
      ],
      Account: [
        {
          internalid: "1200",
          acctnumber: "1200",
          acctname: "Accounts Receivable",
          accttype: "AcctRec",
          issummary: false,
          isinactive: false,
        },
        {
          internalid: "4000",
          acctnumber: "4000",
          acctname: "Revenue",
          accttype: "Income",
          issummary: false,
          isinactive: false,
        },
      ],
      Customer: [
        {
          internalid: "97001",
          entityid: "C-FX-CUST",
          companyname: "FX Test Customer",
          isinactive: false,
          subsidiary: "1",
        },
      ],
      Invoice: [
        {
          internalid: "91001",
          tranid: "INV-FX-EXR",
          trandate: "2026-04-15",
          duedate: "2026-05-15",
          subsidiary: "1",
          entity: "97001",
          total: 1000,
          amountremaining: 1000,
          currency: "GBP",
          // The headline of this test — NS-supplied rate (1.50) MUST
          // override the seeded GBP→USD rate (1.20) loaded above.
          exchangerate: 1.5,
          lines: [
            {
              linesequencenumber: 1,
              account: "4000",
              amount: 1000,
              memo: "FX phase 2 — NS rate precedence",
            },
          ],
        },
      ],
    };

    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });
    expect(result.errors).toEqual([]);
    expect(result.journalEntriesImported).toBe(1);

    // Confirm the JE landed with fxRate = 1.50 and lines scaled by 1.50.
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceSystem: "NETSUITE", sourceRecordType: "Invoice", sourceRecordId: "91001" },
      select: {
        currencyId: true,
        fxRate: true,
        lines: {
          select: { debit: true, credit: true, transactionAmount: true, reportingAmount: true },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(je.currencyId).toBe("GBP");
    expect(je.fxRate.toString()).toBe("1.5");
    // Each line: GBP 1,000 × 1.50 = USD 1,500
    for (const l of je.lines) {
      // Debit XOR credit; one is 0, the other is 1500.
      const usd = Number(l.debit) + Number(l.credit);
      expect(usd).toBe(1500);
      const gbp = Math.abs(Number(l.transactionAmount));
      expect(gbp).toBe(1000);
      expect(Math.abs(Number(l.reportingAmount))).toBe(1500);
    }
  });

  it("falls back to seeded rate (1.20) when exchangerate field is omitted", async () => {
    const nsExport: NsExport = {
      _meta: { sourceSystem: "NETSUITE", exportedAt: "2026-04-15T00:00:00Z" },
      Subsidiary: [
        {
          internalid: "1",
          name: "FX Phase 2 Test Sub",
          iselimination: false,
          currency: "USD",
          country: "US",
        },
      ],
      Account: [
        {
          internalid: "1200",
          acctnumber: "1200",
          acctname: "Accounts Receivable",
          accttype: "AcctRec",
          issummary: false,
          isinactive: false,
        },
        {
          internalid: "4000",
          acctnumber: "4000",
          acctname: "Revenue",
          accttype: "Income",
          issummary: false,
          isinactive: false,
        },
      ],
      Customer: [
        {
          internalid: "97001",
          entityid: "C-FX-CUST",
          companyname: "FX Test Customer",
          isinactive: false,
          subsidiary: "1",
        },
      ],
      Invoice: [
        {
          internalid: "91002",
          tranid: "INV-FX-NOR",
          trandate: "2026-04-15",
          duedate: "2026-05-15",
          subsidiary: "1",
          entity: "97001",
          total: 1000,
          amountremaining: 1000,
          currency: "GBP",
          // Note: NO exchangerate field — the seeded 1.20 should apply.
          lines: [
            {
              linesequencenumber: 1,
              account: "4000",
              amount: 1000,
              memo: "FX phase 2 — fallback to seeded rate",
            },
          ],
        },
      ],
    };

    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });
    expect(result.errors).toEqual([]);

    const je = await prisma.journalEntry.findFirstOrThrow({
      where: { sourceSystem: "NETSUITE", sourceRecordType: "Invoice", sourceRecordId: "91002" },
      select: {
        fxRate: true,
        lines: {
          select: { debit: true, credit: true },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(je.fxRate.toString()).toBe("1.2");
    // GBP 1,000 × 1.20 = USD 1,200
    for (const l of je.lines) {
      const usd = Number(l.debit) + Number(l.credit);
      expect(usd).toBe(1200);
    }
  });
});
