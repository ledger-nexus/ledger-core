// v0.8 FX Phase 3 test — realized FX gain/loss on AR/AP application.
//
// When a foreign-currency invoice is collected at a rate different
// from the rate at which it was originally booked, ASC 830 calls the
// rate-delta a realized FX gain or loss. This test proves the
// importer posts the correct three-leg payment JE:
//
//   Invoice posts at 1.27:  AR Cr 1,270 USD (= 1,000 GBP × 1.27)
//   Payment posts at 1.30:  Cash Dr 1,300 USD
//                           AR Dr 1,270 USD (clears at invoice rate)
//                           FX Gain Cr 30 USD  (realized gain)
//
// Without Phase 3, the payment JE would have AR Dr 1,300 USD — the
// AR balance over-clears by 30 USD and the FX gain is silently lost.
//
// Two test cases: customer payment with gain, vendor payment with
// loss (mirror of the gain case to confirm both signs work).
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { importFromNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const PREFIX = "FXPHASE3"; // distinct from VANDEMO / FXPHASE2 / etc.

async function ensureCurrencies() {
  for (const c of ["USD", "GBP"]) {
    await prisma.currency.upsert({
      where: { code: c },
      create: { code: c, name: c, decimals: 2, symbol: c },
      update: {},
    });
  }
}

async function cleanup() {
  const tenantId = await getDefaultTenantId(prisma);
  // All lineage ids the test creates — clean by these.
  const lineageIds = ["93001", "93002", "93003", "93004"];

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
    await prisma.apApplication.deleteMany({
      where: {
        OR: [
          { appliedByEntryId: { in: jeIds } },
          { openItem: { openedByEntryId: { in: jeIds } } },
        ],
      },
    });
    await prisma.arOpenItem.deleteMany({ where: { openedByEntryId: { in: jeIds } } });
    await prisma.apOpenItem.deleteMany({ where: { openedByEntryId: { in: jeIds } } });
  }

  await prisma.journalEntry.deleteMany({
    where: { sourceSystem: "NETSUITE", sourceRecordId: { in: lineageIds }, tenantId },
  });
  await prisma.party.deleteMany({
    where: {
      sourceSystem: "NETSUITE",
      tenantId,
      sourceRecordId: { in: ["98001", "98002"] },
    },
  });
  // NS account lineage triples are tenant-global; another suite's
  // entity-scoped NS1200 etc. would make the importer's dedupe skip
  // creating ours, and posting can't see another entity's account.
  // Clear the shared-lineage accounts so this suite recreates them in
  // its own scope. Sequential vitest (singleFork) makes this safe.
  // NEUTRALIZE (not delete) the residue lineage: other suites' JE lines
  // may reference these accounts (FK), so deletion can throw. Nulling
  // the lineage triple makes the importer's dedupe miss — this suite
  // then creates fresh accounts in its own scope — while the residue
  // rows keep their FK integrity and stop appearing in NS exports.
  await prisma.account.updateMany({
    where: {
      sourceSystem: "NETSUITE",
      tenantId,
      sourceRecordId: { in: ["1000", "1200", "2000", "4000", "7200"] },
    },
    data: { sourceSystem: null, sourceRecordType: null, sourceRecordId: null },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: { in: [`${PREFIX}_NS1`] } },
  });
}

describe("v0.8 FX Phase 3: realized gain/loss on AR/AP", () => {
  beforeAll(async () => {
    await ensureCurrencies();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("customer payment at higher rate posts a realized FX gain", async () => {
    // Invoice 93001: GBP 1000 @ rate 1.27 = USD 1,270 booked AR
    // Payment 93002: GBP 1000 @ rate 1.30 = USD 1,300 cash received
    //   → realized FX GAIN of 30 USD (= 1000 × (1.30 - 1.27))
    const nsExport: NsExport = {
      _meta: { sourceSystem: "NETSUITE", exportedAt: "2026-04-30T00:00:00Z" },
      Subsidiary: [
        {
          internalid: "1",
          name: "FX Phase 3 Test Sub",
          iselimination: false,
          currency: "USD",
          country: "US",
        },
      ],
      Account: [
        {
          internalid: "1000",
          acctnumber: "1000",
          acctname: "Cash",
          accttype: "Bank",
          issummary: false,
          isinactive: false,
        },
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
          internalid: "98001",
          entityid: "C-FX-GAIN",
          companyname: "FX Gain Customer",
          isinactive: false,
          subsidiary: "1",
        },
      ],
      Invoice: [
        {
          internalid: "93001",
          tranid: "INV-FX-GAIN",
          trandate: "2026-04-15",
          duedate: "2026-05-15",
          subsidiary: "1",
          entity: "98001",
          total: 1000,
          amountremaining: 0,
          currency: "GBP",
          exchangerate: 1.27,
          lines: [
            {
              linesequencenumber: 1,
              account: "4000",
              amount: 1000,
              memo: "FX phase 3 — gain test",
            },
          ],
        },
      ],
      CustomerPayment: [
        {
          internalid: "93002",
          trandate: "2026-05-15",
          subsidiary: "1",
          entity: "98001",
          total: 1000,
          currency: "GBP",
          exchangerate: 1.3,
          depositaccount: "1000",
          apply: [{ doc: "93001", amount: 1000 }],
        },
      ],
    };

    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });
    expect(result.errors).toEqual([]);
    // FX gain/loss warning should surface (= operator-visible
    // confirmation that the importer DID post the FX adjustment).
    expect(result.warnings.some((w) => /FX gain/.test(w))).toBe(true);

    // Inspect the payment JE — should have three lines: Cash Dr, AR Cr
    // at invoice rate, FX Gain Cr.
    const je = await prisma.journalEntry.findFirstOrThrow({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType: "CustomerPayment",
        sourceRecordId: "93002",
      },
      select: {
        fxRate: true,
        lines: {
          select: {
            debit: true,
            credit: true,
            account: { select: { code: true, subtype: true } },
          },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(je.fxRate.toString()).toBe("1.3");
    expect(je.lines.length).toBe(3);

    const byCode = Object.fromEntries(je.lines.map((l) => [l.account.code, l]));
    expect(Number(byCode["NS1000"].debit)).toBe(1300); // cash @ pmt rate
    expect(Number(byCode["NS1200"].credit)).toBe(1270); // AR @ invoice rate
    // FX gain line — credit-side because gain (revenue-like outcome).
    const fxLine = je.lines.find((l) => l.account.subtype === "FX_GAIN_LOSS_REALIZED");
    expect(fxLine).toBeDefined();
    expect(Number(fxLine!.credit)).toBe(30);
    expect(Number(fxLine!.debit)).toBe(0);
  });

  it("vendor payment at higher rate posts a realized FX loss", async () => {
    // Bill 93003: GBP 1000 @ rate 1.27 = USD 1,270 booked AP
    // Payment 93004: GBP 1000 @ rate 1.30 = USD 1,300 cash paid
    //   → realized FX LOSS of 30 USD (we paid MORE in USD than we booked)
    const nsExport: NsExport = {
      _meta: { sourceSystem: "NETSUITE", exportedAt: "2026-04-30T00:00:00Z" },
      Subsidiary: [
        {
          internalid: "1",
          name: "FX Phase 3 Test Sub",
          iselimination: false,
          currency: "USD",
          country: "US",
        },
      ],
      Account: [
        {
          internalid: "1000",
          acctnumber: "1000",
          acctname: "Cash",
          accttype: "Bank",
          issummary: false,
          isinactive: false,
        },
        {
          internalid: "2000",
          acctnumber: "2000",
          acctname: "Accounts Payable",
          accttype: "AcctPay",
          issummary: false,
          isinactive: false,
        },
        {
          internalid: "7200",
          acctnumber: "7200",
          acctname: "Professional Fees",
          accttype: "Expense",
          issummary: false,
          isinactive: false,
        },
      ],
      Vendor: [
        {
          internalid: "98002",
          entityid: "V-FX-LOSS",
          companyname: "FX Loss Vendor",
          isinactive: false,
          subsidiary: "1",
        },
      ],
      VendorBill: [
        {
          internalid: "93003",
          tranid: "BILL-FX-LOSS",
          trandate: "2026-04-15",
          duedate: "2026-05-15",
          subsidiary: "1",
          entity: "98002",
          total: 1000,
          amountremaining: 0,
          currency: "GBP",
          exchangerate: 1.27,
          lines: [
            {
              linesequencenumber: 1,
              account: "7200",
              amount: 1000,
              memo: "FX phase 3 — loss test",
            },
          ],
        },
      ],
      VendorPayment: [
        {
          internalid: "93004",
          trandate: "2026-05-15",
          subsidiary: "1",
          entity: "98002",
          total: 1000,
          currency: "GBP",
          exchangerate: 1.3,
          account: "1000",
          apply: [{ doc: "93003", amount: 1000 }],
        },
      ],
    };

    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookCode: "US_GAAP",
      export: nsExport,
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings.some((w) => /FX loss/.test(w))).toBe(true);

    const je = await prisma.journalEntry.findFirstOrThrow({
      where: {
        sourceSystem: "NETSUITE",
        sourceRecordType: "VendorPayment",
        sourceRecordId: "93004",
      },
      select: {
        fxRate: true,
        lines: {
          select: {
            debit: true,
            credit: true,
            account: { select: { code: true, subtype: true } },
          },
          orderBy: { lineNo: "asc" },
        },
      },
    });
    expect(je.fxRate.toString()).toBe("1.3");
    expect(je.lines.length).toBe(3);

    const byCode = Object.fromEntries(je.lines.map((l) => [l.account.code, l]));
    expect(Number(byCode["NS1000"].credit)).toBe(1300); // cash @ pmt rate
    expect(Number(byCode["NS2000"].debit)).toBe(1270); // AP @ invoice rate
    // FX loss line — debit-side because loss.
    const fxLine = je.lines.find((l) => l.account.subtype === "FX_GAIN_LOSS_REALIZED");
    expect(fxLine).toBeDefined();
    expect(Number(fxLine!.debit)).toBe(30);
    expect(Number(fxLine!.credit)).toBe(0);
  });
});
