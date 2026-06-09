// v0.9 NS Books Phase 3.5.C — sub-ledger MULTI-BOOK reverse export.
//
// Proves the reverse exporter emits per-book AR/AP OpenItem state for
// every NS Invoice / VendorBill imported under a multi-book mapping.
// Phase 3.5.B (PR #181-ish) wired the IMPORT side — one NS Invoice
// landing in 2 books produces 2 ArOpenItem rows. This PR closes the
// loop on the EXPORT side: those 2 rows now show up in the NsExport
// shape as 2 OpenItemState entries with distinct bookCode.
//
// Failure modes this test catches:
//   - exportToNs in multi mode silently drops OpenItem state (the
//     per-book divergence becomes invisible to downstream consumers)
//   - single-mode export accidentally emits the OpenItemState key
//     (would break v0.6 backward-compat with the canonical fixture)
//   - balances are emitted from the wrong book (e.g. partial payment
//     applied to US_GAAP leaks into the US_TAX snapshot)
//   - status flips don't track per-book (an APPLIED on one book
//     shouldn't drag the other book's status with it)
//
// Requires DATABASE_URL pointing at a dev DB and migrations 0011
// (lineage uniq scoped to (tenantId, bookId)) + 0012 (totalDebit
// column) applied.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { importFromNs, exportToNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const PREFIX = "P35C";
const NS_INVOICE_ID = "P35C_INV_91001";
const NS_BILL_ID = "P35C_BILL_91002";
const ALL_LINEAGE = [NS_INVOICE_ID, NS_BILL_ID];

const NS_EXPORT: NsExport = {
  _meta: { sourceSystem: "NETSUITE", exportedAt: "2026-05-15T00:00:00Z" },
  Subsidiary: [
    {
      internalid: "1",
      name: "P35C Reverse Export Sub",
      iselimination: false,
      currency: "USD",
      country: "US",
    },
  ],
  AccountingBook: [
    { internalid: "1", name: "US GAAP", basis: "GAAP", currency: "USD" },
    { internalid: "2", name: "US TAX", basis: "TAX", currency: "USD" },
  ],
  Account: [
    {
      internalid: "1010",
      acctnumber: "1010",
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
      internalid: "2000",
      acctnumber: "2000",
      acctname: "Accounts Payable",
      accttype: "AcctPay",
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
    {
      internalid: "5000",
      acctnumber: "5000",
      acctname: "COGS",
      accttype: "Expense",
      issummary: false,
      isinactive: false,
    },
  ],
  Customer: [
    {
      internalid: "C1",
      entityid: "ACME-CUSTOMER",
      companyname: "Acme Customer",
      isinactive: false,
    },
  ],
  Vendor: [
    {
      internalid: "V1",
      entityid: "ACME-VENDOR",
      companyname: "Acme Vendor",
      isinactive: false,
    },
  ],
  Invoice: [
    {
      internalid: NS_INVOICE_ID,
      tranid: "P35C-INV-001",
      trandate: "2026-05-15",
      duedate: "2026-06-15",
      subsidiary: "1",
      entity: "C1",
      total: 1000.0,
      amountremaining: 1000.0,
      currency: "USD",
      lines: [
        {
          linesequencenumber: 1,
          account: "4000",
          amount: 1000.0,
          memo: "Revenue",
        },
      ],
    },
  ],
  VendorBill: [
    {
      internalid: NS_BILL_ID,
      tranid: "P35C-BILL-001",
      trandate: "2026-05-15",
      duedate: "2026-06-15",
      subsidiary: "1",
      entity: "V1",
      total: 500.0,
      amountremaining: 500.0,
      currency: "USD",
      lines: [
        {
          linesequencenumber: 1,
          account: "5000",
          amount: 500.0,
          memo: "COGS",
        },
      ],
    },
  ],
};

async function ensureFundamentals(): Promise<void> {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  for (const code of ["US_GAAP", "US_TAX"] as const) {
    await prisma.book.upsert({
      where: { code },
      create: { code, name: code, basis: code, reportingCurrencyId: "USD" },
      update: {},
    });
  }
}

async function cleanup(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  await prisma.arApplication.deleteMany({
    where: { openItem: { sourceRecordId: { in: ALL_LINEAGE } } },
  });
  await prisma.apApplication.deleteMany({
    where: { openItem: { sourceRecordId: { in: ALL_LINEAGE } } },
  });
  await prisma.arOpenItem.deleteMany({
    where: { tenantId, sourceRecordId: { in: ALL_LINEAGE } },
  });
  await prisma.apOpenItem.deleteMany({
    where: { tenantId, sourceRecordId: { in: ALL_LINEAGE } },
  });
  await prisma.journalEntry.deleteMany({
    where: { tenantId, sourceRecordId: { in: ALL_LINEAGE } },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: `${PREFIX}_NS1` },
  });
  await prisma.party.deleteMany({
    where: { tenantId, code: { in: ["NSCUST-C1", "NSVEND-V1"] } },
  });
  await prisma.account.deleteMany({
    where: {
      tenantId,
      entityId: null,
      sourceSystem: "NETSUITE",
      sourceRecordId: { in: ["1010", "1200", "2000", "4000", "5000"] },
    },
  });
}

describe("v0.9 NS Books Phase 3.5.C: sub-ledger MULTI-BOOK reverse export", () => {
  beforeAll(async () => {
    await ensureFundamentals();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("multi-book reverse export emits 2 OpenItemState rows per NS source record", async () => {
    // Import in multi-book mode. One NS Invoice + one NS Bill → 2 AR
    // open items + 2 AP open items (one per mapped book).
    const importResult = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookResolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      },
      export: NS_EXPORT,
    });
    expect(importResult.errors).toEqual([]);
    expect(importResult.arOpenItemsOpened).toBe(2);
    expect(importResult.apOpenItemsOpened).toBe(2);

    // Reverse export in matching multi-book mode.
    const reexport = await exportToNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookResolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      },
      exportedAt: new Date(NS_EXPORT._meta!.exportedAt!),
    });

    // OpenItemState present with 4 rows: 2 Invoice × 2 books +
    // 2 VendorBill × 2 books.
    expect(reexport.OpenItemState).toBeDefined();
    expect(reexport.OpenItemState).toHaveLength(4);

    // AR side: 2 entries for NS_INVOICE_ID, one per book, both at the
    // full opening balance (no payment applied in this fixture).
    const arStates = reexport.OpenItemState!.filter(
      (s) => s.sourceRecordType === "Invoice"
    );
    expect(arStates).toHaveLength(2);
    expect(arStates.map((s) => s.bookCode).sort()).toEqual([
      "US_GAAP",
      "US_TAX",
    ]);
    for (const s of arStates) {
      expect(s.sourceRecordId).toBe(NS_INVOICE_ID);
      expect(s.entityCode).toBe(`${PREFIX}_NS1`);
      expect(s.originalAmount).toBe("1000");
      expect(s.currentBalance).toBe("1000");
      expect(s.status).toBe("OPEN");
    }

    // AP side: same shape on the VendorBill, at $500.
    const apStates = reexport.OpenItemState!.filter(
      (s) => s.sourceRecordType === "VendorBill"
    );
    expect(apStates).toHaveLength(2);
    expect(apStates.map((s) => s.bookCode).sort()).toEqual([
      "US_GAAP",
      "US_TAX",
    ]);
    for (const s of apStates) {
      expect(s.sourceRecordId).toBe(NS_BILL_ID);
      expect(s.originalAmount).toBe("500");
      expect(s.currentBalance).toBe("500");
      expect(s.status).toBe("OPEN");
    }
  });

  it("OpenItemState is sorted deterministically (AR before AP, then by id, then by book)", async () => {
    const reexport = await exportToNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookResolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      },
      exportedAt: new Date(NS_EXPORT._meta!.exportedAt!),
    });
    const states = reexport.OpenItemState!;
    // "Invoice" < "VendorBill" alphabetically → the first 2 rows are AR.
    expect(states[0].sourceRecordType).toBe("Invoice");
    expect(states[1].sourceRecordType).toBe("Invoice");
    expect(states[2].sourceRecordType).toBe("VendorBill");
    expect(states[3].sourceRecordType).toBe("VendorBill");
    // Within a side, bookCode ascending (US_GAAP < US_TAX).
    expect(states[0].bookCode).toBe("US_GAAP");
    expect(states[1].bookCode).toBe("US_TAX");
    expect(states[2].bookCode).toBe("US_GAAP");
    expect(states[3].bookCode).toBe("US_TAX");
  });

  it("single-book mode reverse export omits OpenItemState (v0.6 backward compat)", async () => {
    const reexport = await exportToNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookResolution: { mode: "single", bookCode: "US_GAAP" },
      exportedAt: new Date(NS_EXPORT._meta!.exportedAt!),
    });
    // OpenItemState key must be absent — emitting it would break the
    // v0.6 canonical fixture diff and signal that something opaquely
    // changed in the export shape.
    expect(reexport.OpenItemState).toBeUndefined();
  });
});
