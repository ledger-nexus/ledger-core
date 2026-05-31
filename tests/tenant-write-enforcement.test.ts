// Substrate write enforcement tests (Phase 4a of multi-tenancy).
//
// Verifies:
//   1. postJournalEntry populates tenantId on JournalEntry from the entity.
//   2. postJournalEntry denormalizes tenantId onto every JournalLine.
//   3. When input.tenantId is provided and matches: write succeeds.
//   4. When input.tenantId is provided and DOESN'T match: UnknownEntityError
//      (Phase 4b: lookup is scoped by tenant so cross-tenant entities are
//      invisible — no information leak about other tenants' codes).
//   5. When the entity has no tenantId (data-integrity bug): EntityMissingTenantError.
//   6. Sub-ledger writes (openArItem, openApItem, createFixedAsset,
//      createLease, createRevenueContract) also populate tenantId.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { UnknownEntityError } from "@/lib/accounting/types";
import { openArItem } from "@/lib/accounting/sub-ledgers/ar";
import { openApItem } from "@/lib/accounting/sub-ledgers/ap";
import { createFixedAsset } from "@/lib/accounting/sub-ledgers/fixed-assets";
import { createLease } from "@/lib/accounting/sub-ledgers/leases";
import { createRevenueContract } from "@/lib/accounting/sub-ledgers/revenue-contracts";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string };
let tenantB: { id: string };
let entityA: { id: string; code: string };

beforeAll(async () => {
  // Two tenants. entityA belongs to tenantA. We'll attempt cross-tenant
  // writes from tenantB's perspective to verify rejection.
  tenantA = await prisma.tenant.create({
    data: {
      slug: `enforce-a-${SUFFIX}`,
      name: "Enforce Tenant A",
      ownerUserId: (await ensureSystemUser()).id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `enforce-b-${SUFFIX}`,
      name: "Enforce Tenant B",
      ownerUserId: (await ensureSystemUser()).id,
    },
  });

  // Create a self-contained entity for tenantA with one book + calendar +
  // chart so we can post a JE without dragging Northwind into the test.
  const ent = await prisma.legalEntity.create({
    data: {
      tenantId: tenantA.id,
      code: `ENFORCE-${SUFFIX}`,
      name: "Enforcement Entity",
      functionalCurrencyId: "USD",
    },
  });
  entityA = { id: ent.id, code: ent.code };

  // Minimal account chart — Cash (1000) and Capital (3000).
  await prisma.account.createMany({
    data: [
      {
        tenantId: tenantA.id,
        entityId: ent.id,
        code: "1000",
        name: "Cash",
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      {
        tenantId: tenantA.id,
        entityId: ent.id,
        code: "3000",
        name: "Owner's Capital",
        type: "EQUITY",
        normalBalance: "CREDIT",
      },
    ],
  });
});

afterAll(async () => {
  // FK from legal_entity → tenant is RESTRICT, so we have to tear down
  // the entity tree before deleting the tenants. Each sub-ledger has
  // a Cascade FK to the LegalEntity or to a JE that cascades, so deleting
  // entities + JEs handles most of it.
  const tenantIds = [tenantA.id, tenantB.id];
  // Leaves of the FK graph first.
  await prisma.arOpenItem.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.apOpenItem.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.fixedAsset.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.lease.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.revenueContract.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.account.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.partyRole.deleteMany({
    where: { party: { tenantId: { in: tenantIds } } },
  });
  await prisma.party.deleteMany({ where: { tenantId: { in: tenantIds } } });
  // FiscalCalendar + Period are linked to LegalEntity and may have been
  // created indirectly (postJournalEntry creates a period when none exists).
  // Need to drop them before LegalEntity.
  await prisma.periodClose.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.period.deleteMany({
    where: { calendar: { tenantId: { in: tenantIds } } },
  });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tenantIds } } });
  // audit_log is DB-level append-only (CC6 RULE) — escape hatch lets
  // cleanup remove rows that would otherwise block tenant.delete via FK.
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  });
  // RecordEvent.tenantId is RESTRICT; clean before tenant delete.
  await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });

  // Scope by this run's tenant IDs (not the `enforce-` slug prefix) so
  // we don't try to delete leftover tenants from prior aborted test runs.
  // Those leftovers should be hand-cleaned via the find-tenant-refs script.
  await prisma.tenant.deleteMany({
    where: { id: { in: tenantIds } },
  });
  await prisma.$disconnect();
});

async function ensureSystemUser(): Promise<{ id: string }> {
  // Single shared owner so both tenants reference a valid User.
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (u) return u;
  return prisma.user.create({
    data: {
      email: `enforce-owner-${SUFFIX}@example.test`,
      displayName: "Enforce Owner",
      isActive: true,
    },
  });
}

describe("postJournalEntry: tenantId auto-resolution", () => {
  it("populates JournalEntry.tenantId from the entity (no input.tenantId)", async () => {
    const result = await postJournalEntry(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-01"),
      memo: "tenantId auto-resolution test",
      lines: [
        { accountCode: "1000", debit: "1000" },
        { accountCode: "3000", credit: "1000" },
      ],
    });

    const je = await prisma.journalEntry.findUnique({
      where: { id: result.id },
      select: {
        tenantId: true,
        lines: { select: { tenantId: true } },
      },
    });
    expect(je!.tenantId).toBe(tenantA.id);
    // Every line denormalized to the same tenant.
    for (const line of je!.lines) {
      expect(line.tenantId).toBe(tenantA.id);
    }
  });

  it("succeeds when input.tenantId matches the entity's tenantId", async () => {
    const result = await postJournalEntry(prisma, {
      tenantId: tenantA.id,
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-01-02"),
      memo: "explicit tenant match",
      lines: [
        { accountCode: "1000", debit: "500" },
        { accountCode: "3000", credit: "500" },
      ],
    });
    const je = await prisma.journalEntry.findUnique({
      where: { id: result.id },
      select: { tenantId: true },
    });
    expect(je!.tenantId).toBe(tenantA.id);
  });

  it("rejects when input.tenantId mismatches the entity's tenantId", async () => {
    // Phase 4b: postJournalEntry now scopes the entity lookup to the
    // caller's tenant. A cross-tenant attempt (input.tenantId=B but
    // entity lives in A) returns no entity → UnknownEntityError. This
    // is the security improvement: the rejected caller can't even
    // discover whether another tenant owns "ACME" — the error doesn't
    // leak that information. Pre-Phase-4b this surfaced as
    // TenantScopeMismatchError.
    await expect(
      postJournalEntry(prisma, {
        tenantId: tenantB.id, // wrong tenant
        entityCode: entityA.code,
        bookCode: "US_GAAP",
        documentDate: new Date("2026-01-03"),
        memo: "cross-tenant attempt",
        lines: [
          { accountCode: "1000", debit: "100" },
          { accountCode: "3000", credit: "100" },
        ],
      })
    ).rejects.toBeInstanceOf(UnknownEntityError);
  });
});

// EntityMissingTenantError test obsolete after Phase 4b: the DB now
// has `tenantId NOT NULL` on legal_entity, so even raw SQL can't
// create or update an entity row with NULL tenantId. The application-
// layer guard in postJournalEntry remains as defense-in-depth (e.g.
// against a future schema regression), but the impossible-data
// scenario can no longer be set up in a test.
//
// describe.skip("postJournalEntry: EntityMissingTenantError") — kept
// for posterity; un-skip if NOT NULL is ever relaxed.

describe("Sub-ledger writes: tenantId denormalization", () => {
  // For these we need a JournalEntry to point openedByEntryId at + parties.
  let je: { id: string };
  let customerId: string;
  let vendorId: string;

  beforeAll(async () => {
    // Add AR / AP control accounts + a customer + a vendor.
    await prisma.account.createMany({
      data: [
        {
          tenantId: tenantA.id,
          entityId: entityA.id,
          code: "1200",
          name: "AR",
          type: "ASSET",
          normalBalance: "DEBIT",
          isControlAccount: true,
        },
        {
          tenantId: tenantA.id,
          entityId: entityA.id,
          code: "2000",
          name: "AP",
          type: "LIABILITY",
          normalBalance: "CREDIT",
          isControlAccount: true,
        },
        {
          tenantId: tenantA.id,
          entityId: entityA.id,
          code: "4000",
          name: "Revenue",
          type: "REVENUE",
          normalBalance: "CREDIT",
        },
        {
          tenantId: tenantA.id,
          entityId: entityA.id,
          code: "5000",
          name: "Expense",
          type: "EXPENSE",
          normalBalance: "DEBIT",
        },
      ],
    });
    const customer = await prisma.party.create({
      data: {
        tenantId: tenantA.id,
        entityId: entityA.id,
        code: `CUST-${SUFFIX}`,
        displayName: "Test Customer",
        roles: { create: { tenantId: tenantA.id, role: "CUSTOMER" } },
      },
    });
    const vendor = await prisma.party.create({
      data: {
        tenantId: tenantA.id,
        entityId: entityA.id,
        code: `VEND-${SUFFIX}`,
        displayName: "Test Vendor",
        roles: { create: { tenantId: tenantA.id, role: "VENDOR" } },
      },
    });
    customerId = customer.id;
    vendorId = vendor.id;

    // Post an opener JE that AR/AP can hang off.
    const opener = await postJournalEntry(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-02-01"),
      memo: "AR opener invoice",
      lines: [
        { accountCode: "1200", debit: "5000", partyCode: `CUST-${SUFFIX}` },
        { accountCode: "4000", credit: "5000" },
      ],
    });
    je = { id: opener.id };
  });

  it("openArItem denormalizes tenantId from the entity", async () => {
    const result = await openArItem(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      partyCode: `CUST-${SUFFIX}`,
      openedByEntryId: je.id,
      openedDate: new Date("2026-02-01"),
      amount: 5000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });
    const row = await prisma.arOpenItem.findUnique({
      where: { id: result.id },
      select: { tenantId: true, entityId: true },
    });
    expect(row!.tenantId).toBe(tenantA.id);
    expect(row!.entityId).toBe(entityA.id);
  });

  it("openApItem denormalizes tenantId from the entity", async () => {
    // Need a JE that opens an AP item.
    const apOpener = await postJournalEntry(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-02-02"),
      memo: "AP opener bill",
      lines: [
        { accountCode: "5000", debit: "200" },
        { accountCode: "2000", credit: "200", partyCode: `VEND-${SUFFIX}` },
      ],
    });
    const result = await openApItem(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      partyCode: `VEND-${SUFFIX}`,
      openedByEntryId: apOpener.id,
      openedDate: new Date("2026-02-02"),
      amount: 200,
      currencyCode: "USD",
      controlAccountCode: "2000",
    });
    const row = await prisma.apOpenItem.findUnique({
      where: { id: result.id },
      select: { tenantId: true },
    });
    expect(row!.tenantId).toBe(tenantA.id);
  });

  it("createFixedAsset denormalizes tenantId from the entity", async () => {
    const result = await createFixedAsset(prisma, {
      entityCode: entityA.code,
      code: `FA-${SUFFIX}`,
      description: "Test laptop",
      acquisitionDate: new Date("2026-03-01"),
      acquisitionCost: 1500,
      acquisitionCurrencyCode: "USD",
      assetAccountCode: "1000",
      books: [
        {
          bookCode: "US_GAAP",
          inServiceDate: new Date("2026-03-01"),
          usefulLifeMonths: 36,
          method: "STRAIGHT_LINE",
          depreciationExpenseAccountCode: "5000",
          accumDepreciationAccountCode: "1000",
        },
      ],
    });
    const row = await prisma.fixedAsset.findUnique({
      where: { id: result.id },
      select: { tenantId: true },
    });
    expect(row!.tenantId).toBe(tenantA.id);
  });

  it("createLease denormalizes tenantId from the entity", async () => {
    const result = await createLease(prisma, {
      entityCode: entityA.code,
      code: `LEASE-${SUFFIX}`,
      description: "Test office lease",
      lessorPartyCode: `VEND-${SUFFIX}`,
      leaseStartDate: new Date("2026-04-01"),
      leaseEndDate: new Date("2028-03-31"),
      paymentAmount: 1000,
      paymentFrequency: "MONTHLY",
      currencyCode: "USD",
      books: [
        {
          bookCode: "US_GAAP",
          classification: "OPERATING",
          discountRate: 0.05,
          rouAccountCode: "1000",
          liabilityAccountCode: "2000",
          expenseAccountCode: "5000",
        },
      ],
    });
    const row = await prisma.lease.findUnique({
      where: { id: result.id },
      select: { tenantId: true },
    });
    expect(row!.tenantId).toBe(tenantA.id);
  });

  it("createRevenueContract denormalizes tenantId from the entity", async () => {
    const result = await createRevenueContract(prisma, {
      entityCode: entityA.code,
      code: `RC-${SUFFIX}`,
      description: "Test SaaS contract",
      customerPartyCode: `CUST-${SUFFIX}`,
      contractStartDate: new Date("2026-05-01"),
      contractEndDate: new Date("2027-04-30"),
      totalContractValue: 12000,
      currencyCode: "USD",
      performanceObligations: [
        {
          sequenceNo: 1,
          description: "Monthly SaaS access",
          ssp: 12000,
          recognitionPattern: "OVER_TIME_STRAIGHT",
          startDate: new Date("2026-05-01"),
          endDate: new Date("2027-04-30"),
          revenueAccountCode: "4000",
          deferredAccountCode: "2000",
        },
      ],
      books: [{ bookCode: "US_GAAP", recognitionBasis: "ACCRUAL" }],
    });
    const row = await prisma.revenueContract.findUnique({
      where: { id: result.id },
      select: { tenantId: true },
    });
    expect(row!.tenantId).toBe(tenantA.id);
  });
});
