// RLS Phase 3 — cross-tenant test suite.
//
// Status: SCAFFOLD. The migration SQL that flips FORCE ROW LEVEL SECURITY
// has not yet been applied. These tests are designed to be run under BOTH
// modes via a CI matrix (Decision E from rls-phase-3-design.md):
//
//   1. Pre-FORCE (Phase 1+2a+2b only): every test that asserts
//      "GUC missing → 0 rows" or "cross-tenant write rejected" is
//      SKIPPED. The remaining tests verify the GUC plumbing works.
//
//   2. Post-FORCE (Phase 3): all tests run. The "GUC missing → 0 rows"
//      tests are the load-bearing fail-closed evidence. The
//      "cross-tenant write rejected" tests prove WITH CHECK policies.
//
// To run only the suite that's load-bearing pre-FORCE:
//     npx vitest run tests/rls-phase-3-cross-tenant.test.ts -t plumbing
//
// To run the full suite (will fail pre-FORCE on the fail-closed tests):
//     RLS_FORCE_ENABLED=1 npx vitest run tests/rls-phase-3-cross-tenant.test.ts
//
// See docs/architecture/rls-phase-3-design.md "Cross-tenant test suite
// design" for the 6-category structure.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  getCurrentTenantGuc,
} from "../src/lib/db/tenant-context";
import { postJournalEntry } from "../src/lib/accounting/post-journal";

const prisma = new PrismaClient();

// Run the full FORCE-required suite only when the env flag is set. CI
// matrix runs once without (pre-FORCE) and once with (post-FORCE).
const FORCE_ENABLED = process.env.RLS_FORCE_ENABLED === "1";

let tenantAId: string;
let tenantBId: string;
let entityAId: string;
let entityBId: string;
let actorUserId: string;

beforeAll(async () => {
  // Resolve a real user id for tenant ownership.
  const anyUser = await prisma.user.findFirstOrThrow({ select: { id: true } });
  actorUserId = anyUser.id;

  // Create two disposable tenants with fully-isolated fixtures: 1
  // entity each, 1 currency (shared global), the Northwind book
  // (shared global) usable from either tenant.
  const slug = `rls-p3-${Date.now().toString().slice(-8)}`;

  const tA = await prisma.tenant.create({
    data: {
      slug: `${slug}-a`,
      name: "RLS Phase 3 test — tenant A",
      ownerUserId: actorUserId,
    },
    select: { id: true },
  });
  tenantAId = tA.id;

  const tB = await prisma.tenant.create({
    data: {
      slug: `${slug}-b`,
      name: "RLS Phase 3 test — tenant B",
      ownerUserId: actorUserId,
    },
    select: { id: true },
  });
  tenantBId = tB.id;

  // Ensure currency exists (shared global, RLS-exempt).
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });
  await prisma.book.upsert({
    where: { code: "US_GAAP" },
    create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
    update: {},
  });

  // Tenant A: entity A_CORP.
  const eA = await prisma.legalEntity.create({
    data: {
      tenantId: tenantAId,
      code: "A_CORP",
      name: "A Corp",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  entityAId = eA.id;

  // Tenant B: entity B_CORP.
  const eB = await prisma.legalEntity.create({
    data: {
      tenantId: tenantBId,
      code: "B_CORP",
      name: "B Corp",
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  entityBId = eB.id;
});

afterAll(async () => {
  // Cascade cleanup.
  const tenantIds = [tenantAId, tenantBId];
  await prisma.journalLine.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.party.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

// ─────────────────────────────────────────────────────────────────────
// Category 1: GUC missing → 0 rows (fail-closed verification)
//
// These tests verify Phase 3 FORCE works as designed: queries without
// the GUC set return 0 rows from tenant-scoped tables. Pre-FORCE these
// are advisory and would pass — running them under RLS_FORCE_ENABLED
// confirms FORCE is on and load-bearing.
// ─────────────────────────────────────────────────────────────────────

describe.skipIf(!FORCE_ENABLED)("RLS Phase 3 — Cat 1: GUC missing → 0 rows", () => {
  it("legalEntity.findMany without GUC returns 0 rows", async () => {
    const rows = await prisma.legalEntity.findMany({
      where: { id: { in: [entityAId, entityBId] } },
    });
    expect(rows).toHaveLength(0);
  });

  it("journalEntry.findMany without GUC returns 0 rows", async () => {
    // Seed a JE inside withTenantContext so it exists.
    await withTenantContext(tenantAId, async (tx) =>
      postJournalEntry(tx, {
        tenantId: tenantAId,
        entityCode: "A_CORP",
        bookCode: "US_GAAP",
        currencyCode: "USD",
        documentDate: new Date("2026-06-01"),
        memo: "Cat 1 fail-closed test",
        source: "MANUAL",
        sourceRecordType: "RlsCat1",
        sourceRecordId: `cat1-${Date.now()}`,
        createdBy: "test",
        lines: [
          { accountCode: "1000", debit: "1.00" },
          { accountCode: "4000", credit: "1.00" },
        ],
      })
    );

    // Outside GUC: row not visible.
    const rows = await prisma.journalEntry.findMany({
      where: { tenantId: tenantAId, memo: "Cat 1 fail-closed test" },
    });
    expect(rows).toHaveLength(0);
  });

  // Add one test per direct-tenantId table — TODO: enumerate the
  // remaining ~28 tables. Each is a 3-line test. CI will catch a
  // regression on any one.
});

// ─────────────────────────────────────────────────────────────────────
// Category 2: Correct GUC → correct tenant's rows
//
// Runs under both pre- and post-FORCE. Pre-FORCE: pure plumbing test.
// Post-FORCE: positive confirmation that RLS isn't over-filtering.
// ─────────────────────────────────────────────────────────────────────

describe("RLS Phase 3 plumbing — Cat 2: Correct GUC scopes rows", () => {
  it("tenant A's GUC sees only A's entity", async () => {
    const rows = await withTenantContext(tenantAId, async (tx) =>
      tx.legalEntity.findMany({
        where: { id: { in: [entityAId, entityBId] } },
        select: { id: true, tenantId: true },
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entityAId);
    expect(rows[0].tenantId).toBe(tenantAId);
  });

  it("tenant B's GUC sees only B's entity", async () => {
    const rows = await withTenantContext(tenantBId, async (tx) =>
      tx.legalEntity.findMany({
        where: { id: { in: [entityAId, entityBId] } },
        select: { id: true, tenantId: true },
      })
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(entityBId);
    expect(rows[0].tenantId).toBe(tenantBId);
  });

  it("getCurrentTenantGuc reads back the configured tenant", async () => {
    const observed = await withTenantContext(tenantAId, async (tx) =>
      getCurrentTenantGuc(tx)
    );
    expect(observed).toBe(tenantAId);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Category 3: Cross-tenant write attempts rejected
//
// Tests the WITH CHECK clause of the policies. Post-FORCE only.
// Pre-FORCE the writes succeed because policies are advisory.
// ─────────────────────────────────────────────────────────────────────

describe.skipIf(!FORCE_ENABLED)("RLS Phase 3 — Cat 3: Cross-tenant write rejected", () => {
  it("create with mismatched tenantId throws under FORCE", async () => {
    await expect(
      withTenantContext(tenantAId, async (tx) =>
        tx.party.create({
          data: {
            tenantId: tenantBId, // ← mismatch
            entityId: entityBId,
            code: "INTRUDER",
            displayName: "Cross-tenant intrusion attempt",
          },
        })
      )
    ).rejects.toThrow();
  });

  it("update setting tenantId across boundary throws under FORCE", async () => {
    // Seed a row in tenant A.
    const seeded = await withTenantContext(tenantAId, async (tx) =>
      tx.party.create({
        data: {
          tenantId: tenantAId,
          entityId: entityAId,
          code: `CAT3-${Date.now()}`,
          displayName: "Cat 3 update target",
        },
        select: { id: true },
      })
    );

    // Try to flip its tenantId from B's GUC.
    await expect(
      withTenantContext(tenantBId, async (tx) =>
        tx.party.update({
          where: { id: seeded.id },
          data: { tenantId: tenantBId },
        })
      )
    ).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────
// Category 4: WITH CHECK clause enforcement (insert/update audits)
//
// Post-FORCE only. Each tenant-scoped table's policy should reject any
// INSERT or UPDATE that produces a row whose tenantId doesn't match the
// GUC. Category 3 already tests the obvious case; Cat 4 adds variants
// for tables with denormalized tenantId (JournalLine, FixedAssetBookAttributes).
// ─────────────────────────────────────────────────────────────────────

describe.skipIf(!FORCE_ENABLED)("RLS Phase 3 — Cat 4: WITH CHECK enforcement", () => {
  it.todo(
    "JournalLine.tenantId mismatch with parent JournalEntry → rejected"
  );
  it.todo(
    "FixedAssetBookAttributes mismatch with parent FixedAsset.tenantId → rejected"
  );
});

// ─────────────────────────────────────────────────────────────────────
// Category 5: Shape-specific regression — verify each migration shape
//
// Pre- and post-FORCE. Uses the existing Phase 2b tests as templates.
// Each shape has at least one test confirming the migrated call site
// works under FORCE.
// ─────────────────────────────────────────────────────────────────────

describe("RLS Phase 3 — Cat 5: Shape regression", () => {
  it("Shape W2 (postJournalEntry tx-aware): JE post via withTenantContext", async () => {
    const je = await withTenantContext(tenantAId, async (tx) =>
      postJournalEntry(tx, {
        tenantId: tenantAId,
        entityCode: "A_CORP",
        bookCode: "US_GAAP",
        currencyCode: "USD",
        documentDate: new Date("2026-06-01"),
        memo: "Cat 5 W2 shape",
        source: "MANUAL",
        sourceRecordType: "RlsCat5",
        sourceRecordId: `cat5-w2-${Date.now()}`,
        createdBy: "test",
        lines: [
          { accountCode: "1000", debit: "1.00" },
          { accountCode: "4000", credit: "1.00" },
        ],
      })
    );
    expect(je.id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it.todo("Shape T1 (single-helper Class T): apply*Payment via inner-tx");
  it.todo("Shape T2 (multi-step in-action): reverse-journal-entry");
  it.todo("Shape E (tenant-from-entity): period-close");
  it.todo("Shape M (multi-tenant batch): user-lifecycle deactivation");
  it.todo("Shape P (per-iteration batch): runRecurringEntries");
});

// ─────────────────────────────────────────────────────────────────────
// Category 6: Known-exception paths verification
//
// Confirms that paths INTENTIONALLY outside withTenantContext continue
// to function — they don't try to read tenant-scoped rows so should
// be unaffected by FORCE.
// ─────────────────────────────────────────────────────────────────────

describe("RLS Phase 3 — Cat 6: Known-exception paths", () => {
  it("Currency upsert (shared global) succeeds without GUC", async () => {
    const c = await prisma.currency.findUnique({ where: { code: "USD" } });
    expect(c).not.toBeNull();
  });

  it("Book upsert (shared global) succeeds without GUC", async () => {
    const b = await prisma.book.findUnique({ where: { code: "US_GAAP" } });
    expect(b).not.toBeNull();
  });

  it.todo(
    "setCurrentUserAction: User-table lookup succeeds without GUC (shared global)"
  );
  it.todo(
    "setTenantAction: TenantMembership lookup across tenants (intentional)"
  );
});
