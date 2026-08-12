// Integration test for RLS Phase 2b — Class T reference (applyArPayment).
//
// Mirror of tests/rls-apply-ap-payment.test.ts on the AR side. Same
// pattern: prove the inner-half runs cleanly inside withTenantContext
// + the outer wrapper preserves backward compatibility.
//
// Does NOT yet test RLS enforcement — Phase 1 policies aren't FORCED.
// Phase 3 ships the cross-tenant test suite that proves enforcement.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";
import {
  applyArPayment,
  applyArPaymentInTx,
  openArItem,
} from "../src/lib/accounting/sub-ledgers/ar";
import { postJournalEntry } from "../src/lib/accounting/post-journal";
import { deleteEntries } from "./helpers/ledger-cleanup";

const prisma = new PrismaClient();
// Every entry this suite posts, so afterAll can remove exactly those.
// Delete-by-id is the only precise option here: these suites stamp
// generic domain sourceRecordTypes (VendorBill, CustomerInvoice,
// Payment) that the Northwind seed also uses, so a marker sweep would
// take seed rows with it.
const createdEntryIds: string[] = [];

let tenantId: string;
let entityCode: string;
let bookCode: string;
let partyCode: string;
let controlAccountCode: string;
let currencyCode: string;

beforeAll(async () => {
  const tenant = await prisma.tenant.findFirstOrThrow({
    where: { slug: "default" },
    select: { id: true },
  });
  tenantId = tenant.id;

  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { tenantId, code: "NORTHWIND" },
    select: { code: true },
  });
  entityCode = entity.code;
  bookCode = "US_GAAP";

  const party = await prisma.party.findFirstOrThrow({
    where: {
      tenantId,
      roles: { some: { role: "CUSTOMER" } },
      OR: [{ entityId: null }, { entity: { code: "NORTHWIND" } }],
    },
    select: { code: true },
  });
  partyCode = party.code;

  controlAccountCode = "1200"; // AR control per Northwind chart
  currencyCode = "USD";
});

afterAll(async () => {
  // This suite writes into the SHARED Northwind entity. Leaving entries
  // behind drifts every exact-total assertion downstream of it.
  await deleteEntries(prisma, createdEntryIds).catch(() => {});
  await prisma.$disconnect();
});

describe("applyArPayment Class T — RLS plumbing", () => {
  it("inner half (applyArPaymentInTx) runs inside withTenantContext with GUC set", async () => {
    const openingEntry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "Invoice — opens AR",
      source: "MANUAL",
      sourceRecordType: "CustomerInvoice",
      sourceRecordId: `RLS-AR-TEST-${Date.now()}`,
      createdBy: "test",
      lines: [
        {
          accountCode: controlAccountCode,
          debit: "75.00",
          partyCode,
          description: "Invoice",
        },
        { accountCode: "4000", credit: "75.00", description: "Revenue" },
      ],
    });
    createdEntryIds.push(openingEntry.id);
    const opened = await openArItem(prisma, {
      tenantId,
      entityCode,
      bookCode,
      partyCode,
      openedByEntryId: openingEntry.id,
      openedDate: new Date("2026-06-01"),
      amount: "75.00",
      currencyCode,
      controlAccountCode,
      actorUserId: "system",
    });

    let observedGuc: string | null = null;
    const result = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);

      const paymentEntry = await postJournalEntry(tx, {
        tenantId,
        entityCode,
        bookCode,
        currencyCode,
        documentDate: new Date("2026-06-15"),
        memo: "Cash receipt",
        source: "MANUAL",
        sourceRecordType: "Payment",
        sourceRecordId: `RLS-AR-PMT-${Date.now()}`,
        createdBy: "test",
        lines: [
          { accountCode: "1000", debit: "75.00", description: "Cash receipt" },
          {
            accountCode: controlAccountCode,
            credit: "75.00",
            partyCode,
            description: "Apply payment",
          },
        ],
      });

      createdEntryIds.push(paymentEntry.id);

      return applyArPaymentInTx(tx, {
        openItemId: opened.id,
        appliedByEntryId: paymentEntry.id,
        appliedAmount: "75.00",
        appliedDate: new Date("2026-06-15"),
      });
    });

    expect(observedGuc).toBe(tenantId);
    expect(result.applicationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.status).toBe("APPLIED");
    expect(result.remainingBalance.equals(new Decimal(0))).toBe(true);
  });

  it("outer wrapper (applyArPayment) still works on a raw PrismaClient (legacy callers)", async () => {
    const openingEntry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "Invoice — legacy path",
      source: "MANUAL",
      sourceRecordType: "CustomerInvoice",
      sourceRecordId: `RLS-AR-LEGACY-${Date.now()}`,
      createdBy: "test",
      lines: [
        {
          accountCode: controlAccountCode,
          debit: "40.00",
          partyCode,
          description: "Invoice",
        },
        { accountCode: "4000", credit: "40.00", description: "Revenue" },
      ],
    });
    createdEntryIds.push(openingEntry.id);
    const opened = await openArItem(prisma, {
      tenantId,
      entityCode,
      bookCode,
      partyCode,
      openedByEntryId: openingEntry.id,
      openedDate: new Date("2026-06-01"),
      amount: "40.00",
      currencyCode,
      controlAccountCode,
      actorUserId: "system",
    });

    const paymentEntry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-15"),
      memo: "Cash receipt — legacy path",
      source: "MANUAL",
      sourceRecordType: "Payment",
      sourceRecordId: `RLS-AR-LEGACY-PMT-${Date.now()}`,
      createdBy: "test",
      lines: [
        { accountCode: "1000", debit: "40.00", description: "Cash receipt" },
        {
          accountCode: controlAccountCode,
          credit: "40.00",
          partyCode,
          description: "Apply payment",
        },
      ],
    });

    createdEntryIds.push(paymentEntry.id);

    const result = await applyArPayment(prisma, {
      openItemId: opened.id,
      appliedByEntryId: paymentEntry.id,
      appliedAmount: "40.00",
      appliedDate: new Date("2026-06-15"),
    });

    expect(result.status).toBe("APPLIED");
    expect(result.remainingBalance.equals(new Decimal(0))).toBe(true);
  });
});
