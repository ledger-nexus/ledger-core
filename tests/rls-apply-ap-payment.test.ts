// Integration test for RLS Phase 2b — Class T reference (applyApPayment).
//
// Verifies:
//   1. The inner-half (applyApPaymentInTx) runs cleanly inside a single
//      $transaction supplied by withTenantContext — no nested-tx attempt.
//   2. The app.current_tenant_id GUC is set for the duration of the
//      transaction, so RLS policies (once FORCED in Phase 3) will see
//      the tenant.
//   3. The outer wrapper (applyApPayment) preserves its original
//      PrismaClient-based contract for legacy callers (seeds, demo).
//
// Does NOT yet test RLS enforcement — Phase 1 policies aren't FORCED.
// Phase 3 ships the cross-tenant test suite that proves enforcement.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";
import {
  applyApPayment,
  applyApPaymentInTx,
  openApItem,
} from "../src/lib/accounting/sub-ledgers/ap";
import { postJournalEntry } from "../src/lib/accounting/post-journal";

const prisma = new PrismaClient();

// Tests bind to the seeded default tenant + an existing entity/book set
// that the AP control account (2000) is mapped against — same fixtures
// the AR/AP integration tests use.
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

  // Northwind seed gives us a known-good entity+book+party+AP control set.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { tenantId, code: "NORTHWIND" },
    select: { code: true },
  });
  entityCode = entity.code;
  bookCode = "US_GAAP";

  const party = await prisma.party.findFirstOrThrow({
    where: {
      tenantId,
      roles: { some: { role: "VENDOR" } },
      OR: [{ entityId: null }, { entity: { code: "NORTHWIND" } }],
    },
    select: { code: true },
  });
  partyCode = party.code;

  controlAccountCode = "2000"; // AP control per Northwind chart
  currencyCode = "USD";
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("applyApPayment Class T — RLS plumbing", () => {
  it("inner half (applyApPaymentInTx) runs inside withTenantContext with GUC set", async () => {
    // Setup: open an AP item via the existing legacy path (outer wrapper).
    // Done BEFORE withTenantContext to keep setup separate from the
    // assertion path — the assertion is about the migration target, not
    // about openApItem's own tenant-context story.
    const openingEntry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "Bill from vendor — opens AP",
      source: "MANUAL",
      sourceRecordType: "VendorBill",
      sourceRecordId: `RLS-AP-TEST-${Date.now()}`,
      createdBy: "test",
      lines: [
        { accountCode: "6000", debit: "100.00", description: "Expense" },
        {
          accountCode: controlAccountCode,
          credit: "100.00",
          partyCode,
          description: "Bill",
        },
      ],
    });
    const opened = await openApItem(prisma, {
      entityCode,
      bookCode,
      partyCode,
      openedByEntryId: openingEntry.id,
      openedDate: new Date("2026-06-01"),
      amount: "100.00",
      currencyCode,
      controlAccountCode,
      actorUserId: "system",
    });

    // The real assertion: inside withTenantContext, the GUC reads back
    // as our tenant AND the inner-half mutation runs successfully on the
    // same tx (no nested-$transaction explosion).
    let observedGuc: string | null = null;
    const result = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);

      const paymentEntry = await postJournalEntry(tx, {
        tenantId,
        entityCode,
        bookCode,
        currencyCode,
        documentDate: new Date("2026-06-15"),
        memo: "Payment",
        source: "MANUAL",
        sourceRecordType: "VendorPayment",
        sourceRecordId: `RLS-AP-PMT-${Date.now()}`,
        createdBy: "test",
        lines: [
          {
            accountCode: controlAccountCode,
            debit: "100.00",
            partyCode,
            description: "Pay bill",
          },
          { accountCode: "1000", credit: "100.00", description: "Cash" },
        ],
      });

      return applyApPaymentInTx(tx, {
        openItemId: opened.id,
        appliedByEntryId: paymentEntry.id,
        appliedAmount: "100.00",
        appliedDate: new Date("2026-06-15"),
      });
    });

    expect(observedGuc).toBe(tenantId);
    expect(result.applicationId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.status).toBe("APPLIED");
    expect(result.remainingBalance.equals(new Decimal(0))).toBe(true);
  });

  it("outer wrapper (applyApPayment) still works on a raw PrismaClient (legacy callers)", async () => {
    // Open + pay via the legacy outer wrapper — proves backward
    // compatibility for seeds + demo flow.
    const openingEntry = await postJournalEntry(prisma, {
      tenantId,
      entityCode,
      bookCode,
      currencyCode,
      documentDate: new Date("2026-06-01"),
      memo: "Bill — legacy path",
      source: "MANUAL",
      sourceRecordType: "VendorBill",
      sourceRecordId: `RLS-AP-LEGACY-${Date.now()}`,
      createdBy: "test",
      lines: [
        { accountCode: "6000", debit: "50.00", description: "Expense" },
        {
          accountCode: controlAccountCode,
          credit: "50.00",
          partyCode,
          description: "Bill",
        },
      ],
    });
    const opened = await openApItem(prisma, {
      entityCode,
      bookCode,
      partyCode,
      openedByEntryId: openingEntry.id,
      openedDate: new Date("2026-06-01"),
      amount: "50.00",
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
      memo: "Payment — legacy path",
      source: "MANUAL",
      sourceRecordType: "VendorPayment",
      sourceRecordId: `RLS-AP-LEGACY-PMT-${Date.now()}`,
      createdBy: "test",
      lines: [
        {
          accountCode: controlAccountCode,
          debit: "50.00",
          partyCode,
          description: "Pay bill",
        },
        { accountCode: "1000", credit: "50.00", description: "Cash" },
      ],
    });

    const result = await applyApPayment(prisma, {
      openItemId: opened.id,
      appliedByEntryId: paymentEntry.id,
      appliedAmount: "50.00",
      appliedDate: new Date("2026-06-15"),
    });

    expect(result.status).toBe("APPLIED");
    expect(result.remainingBalance.equals(new Decimal(0))).toBe(true);
  });
});
