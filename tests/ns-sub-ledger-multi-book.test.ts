// v0.9 NS Books Phase 3.5.B — sub-ledger per-book loop integration test.
//
// Proves the importer's 4 sub-ledger paths (Invoice/VendorBill/
// CustomerPayment/VendorPayment) now write per-book sub-ledger rows
// under multi-book mode:
//
//   1. Multi-book Invoice creates N ArOpenItem rows (one per mapped
//      book) all sharing the same lineage triple, distinct (entity, book).
//   2. Multi-book VendorBill creates N ApOpenItem rows by the same shape.
//   3. CustomerPayment applies to the matching-book Invoice's open
//      item (US_GAAP payment → US_GAAP open item, US_TAX payment →
//      US_TAX open item — never cross-book).
//   4. VendorPayment applies the same way on the AP side.
//   5. Idempotent re-import: re-running produces the same row counts
//      and rebuilds the per-book lookup map correctly.
//
// Requires the Phase 3.5.A migration 0011 to be applied (lineage uniq
// scoped to (tenantId, bookId)) — without it the create() would
// short-circuit on a pre-existing global uniq.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { importFromNs } from "@/lib/mappers/netsuite";
import type { NsExport } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const PREFIX = "P35B";
const NS_INVOICE_ID = "P35B_INV_90001";
const NS_BILL_ID = "P35B_BILL_90002";
const NS_PMT_ID = "P35B_PMT_90003";
const NS_VPAY_ID = "P35B_VPAY_90004";
const ALL_LINEAGE = [NS_INVOICE_ID, NS_BILL_ID, NS_PMT_ID, NS_VPAY_ID];

const NS_EXPORT: NsExport = {
  _meta: { sourceSystem: "NETSUITE", exportedAt: "2026-04-15T00:00:00Z" },
  Subsidiary: [
    {
      internalid: "1",
      name: "P35B Test Sub",
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
      tranid: "P35B-INV-001",
      trandate: "2026-04-15",
      duedate: "2026-05-15",
      subsidiary: "1",
      entity: "C1",
      total: 1000.0,
      amountremaining: 1000.0,
      currency: "USD",
      // Invoice lines use `amount` (mapper auto-credits + auto-adds
      // the AR Dr line for the total).
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
      tranid: "P35B-BILL-001",
      trandate: "2026-04-15",
      duedate: "2026-05-15",
      subsidiary: "1",
      entity: "V1",
      total: 500.0,
      amountremaining: 500.0,
      currency: "USD",
      // Bill lines use `amount` (mapper auto-debits + auto-adds the AP
      // Cr line for the total).
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
  // CustomerPayment uses { total, depositaccount, apply: [{doc, amount}] }
  // shape. The mapper auto-builds Cash Dr / AR Cr lines from
  // depositaccount + the applied AR amounts.
  CustomerPayment: [
    {
      internalid: NS_PMT_ID,
      trandate: "2026-04-20",
      subsidiary: "1",
      entity: "C1",
      total: 1000.0,
      currency: "USD",
      depositaccount: "1010",
      apply: [{ doc: NS_INVOICE_ID, amount: 1000.0 }],
    },
  ],
  // VendorPayment uses { total, account, apply: [{doc, amount}] } —
  // `account` is the Cash account to credit when the bill is paid.
  VendorPayment: [
    {
      internalid: NS_VPAY_ID,
      trandate: "2026-04-20",
      subsidiary: "1",
      entity: "V1",
      total: 500.0,
      currency: "USD",
      account: "1010",
      apply: [{ doc: NS_BILL_ID, amount: 500.0 }],
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
  // FK-safe order: applications → open items → JEs → entity-scoped
  // accounts/parties → entities.
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
  // The NS importer uses the global chart for multi-mode (entityId:
  // null per the Phase 3 chart-of-accounts decision). Don't drop those
  // accounts — they may be shared across tests. Just drop our entity
  // + party rows.
  await prisma.legalEntity.deleteMany({
    where: { tenantId, code: `${PREFIX}_NS1` },
  });
  // Party codes follow the nsCustomerCode/nsVendorCode helpers:
  // "NSCUST-C1" and "NSVEND-V1".
  await prisma.party.deleteMany({
    where: {
      tenantId,
      code: { in: ["NSCUST-C1", "NSVEND-V1"] },
    },
  });
  // Clean up the NS-prefixed accounts this test introduces to the
  // global chart. Without this, the netsuite-roundtrip-multi-sub
  // fixture's account-count diff sees stale rows + fails.
  await prisma.account.deleteMany({
    where: {
      tenantId,
      entityId: null,
      sourceSystem: "NETSUITE",
      sourceRecordId: { in: ["1010", "1200", "2000", "4000", "5000"] },
    },
  });
}

describe("v0.9 NS Books Phase 3.5.B: sub-ledger per-book sub-ledger writes", () => {
  beforeAll(async () => {
    await ensureFundamentals();
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("multi-book import creates 2 ArOpenItem rows per NS Invoice + 2 ApOpenItem rows per NS Bill", async () => {
    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookResolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      },
      export: NS_EXPORT,
    });
    expect(result.errors).toEqual([]);

    // Per-book sub-ledger counters: each NS Invoice / Bill creates one
    // OpenItem per book. 1 invoice × 2 books = 2 AR open items; same
    // for AP.
    expect(result.arOpenItemsOpened).toBe(2);
    expect(result.apOpenItemsOpened).toBe(2);
    // Per-book JE counts: 4 transactions × 2 books = 8 JEs.
    expect(result.journalEntriesImported).toBe(8);
    // Each payment applies to ONE invoice/bill per book = 2 AR + 2 AP
    // applications.
    expect(result.paymentsApplied).toBe(4);

    // Confirm the AR rows actually exist on BOTH books with the same
    // lineage triple.
    const arRows = await prisma.arOpenItem.findMany({
      where: { sourceRecordId: NS_INVOICE_ID },
      select: { book: { select: { code: true } }, currentBalance: true },
    });
    const arBooks = arRows.map((r) => r.book.code).sort();
    expect(arBooks).toEqual(["US_GAAP", "US_TAX"]);
    // After application of the $1000 payment, currentBalance is 0 on BOTH books.
    for (const r of arRows) {
      expect(Number(r.currentBalance)).toBe(0);
    }

    // Same shape for AP.
    const apRows = await prisma.apOpenItem.findMany({
      where: { sourceRecordId: NS_BILL_ID },
      select: { book: { select: { code: true } }, currentBalance: true },
    });
    const apBooks = apRows.map((r) => r.book.code).sort();
    expect(apBooks).toEqual(["US_GAAP", "US_TAX"]);
    for (const r of apRows) {
      expect(Number(r.currentBalance)).toBe(0);
    }
  });

  it("ArApplication rows are book-scoped (US_GAAP payment → US_GAAP open item)", async () => {
    // Each AR application points at the openedByEntry of the payment
    // JE AND the openItemId of the invoice. The book on both sides must
    // match — no cross-book application.
    const apps = await prisma.arApplication.findMany({
      where: { openItem: { sourceRecordId: NS_INVOICE_ID } },
      select: {
        appliedByEntry: { select: { book: { select: { code: true } } } },
        openItem: { select: { book: { select: { code: true } } } },
        appliedAmount: true,
      },
    });
    expect(apps.length).toBe(2);
    for (const a of apps) {
      expect(a.appliedByEntry.book.code).toBe(a.openItem.book.code);
      expect(Number(a.appliedAmount)).toBe(1000);
    }
  });

  it("ApApplication rows are book-scoped (US_GAAP payment → US_GAAP open item)", async () => {
    const apps = await prisma.apApplication.findMany({
      where: { openItem: { sourceRecordId: NS_BILL_ID } },
      select: {
        appliedByEntry: { select: { book: { select: { code: true } } } },
        openItem: { select: { book: { select: { code: true } } } },
        appliedAmount: true,
      },
    });
    expect(apps.length).toBe(2);
    for (const a of apps) {
      expect(a.appliedByEntry.book.code).toBe(a.openItem.book.code);
      expect(Number(a.appliedAmount)).toBe(500);
    }
  });

  it("re-running the import is idempotent (same row counts; per-book map rebuilds)", async () => {
    // Second run: alreadyImported guard kicks in for each NS source
    // record; sub-ledger paths re-build the per-book map from existing
    // rows. No new ArOpenItem / ApOpenItem rows are created.
    const result = await importFromNs(prisma, {
      entityResolution: { mode: "multi", entityCodePrefix: PREFIX },
      bookResolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      },
      export: NS_EXPORT,
    });
    // Every source record skipped on re-import.
    expect(result.journalEntriesSkipped).toBe(4);
    expect(result.arOpenItemsOpened).toBe(0);
    expect(result.apOpenItemsOpened).toBe(0);
    expect(result.paymentsApplied).toBe(0);

    // Row counts on the dev DB unchanged.
    const arCount = await prisma.arOpenItem.count({
      where: { sourceRecordId: NS_INVOICE_ID },
    });
    expect(arCount).toBe(2);
    const apCount = await prisma.apOpenItem.count({
      where: { sourceRecordId: NS_BILL_ID },
    });
    expect(apCount).toBe(2);
  });
});
