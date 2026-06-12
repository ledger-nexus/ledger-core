// Validation tests for cross-tenant account/party leakage in the
// posting engine.
//
// The hypothesis under test: when tenant A's `postJournalEntry` resolves
// an `accountCode`, can it accidentally bind to tenant B's account?
//
// The lookup today (src/lib/accounting/post-journal.ts, ~line 161) is:
//
//   prisma.account.findMany({
//     where: {
//       code: { in: codes },
//       active: true,
//       OR: [{ entityId: null }, { entityId: entity.id }],
//     },
//   });
//
// It doesn't filter by tenantId. Two tenants can each have a shared-chart
// account with code "1000" (entityId=null, different tenantId). Postgres
// treats NULL as not-equal in unique constraints, so the [entityId, code]
// unique allows both rows. The findMany returns both. Then the engine's
// dedup map (codeToAccount) picks whichever Postgres surfaces last —
// non-deterministic across tenants.
//
// Result: a JE in tenant A could end up referencing tenant B's account.
// JournalLine.tenantId is denormalized from the entry (tenant A), but
// JournalLine.accountId points at tenant B's row. Data-integrity violation.
//
// This test SHOULD FAIL on the current engine. If it passes, the engine
// is already tenant-safe (and I'll leave the test as a regression guard).
// If it fails, the engine needs a tenantId filter on the account lookup.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = "acc" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string };
let tenantB: { id: string };
let entityA: { id: string; code: string };
let entityB: { id: string; code: string };
let accountA1000: { id: string };
let accountB1000: { id: string };

beforeAll(async () => {
  // Reuse the seeded admin as owner for both tenants.
  const owner = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!owner) {
    throw new Error("Run Northwind seed first.");
  }

  // Self-healing safety net: scrub orphan tenants from prior killed runs.
  // If a previous sweep was interrupted (kill signal, OOM, CI timeout),
  // afterAll didn't run and acc-leak-* tenants leaked. These tenants
  // hold accounts at code "1000" with entityId=null + tenantId=<orphan>,
  // which getTrialBalance picks up (it doesn't tenant-scope account
  // queries — a pre-existing gap that RLS Phase 3 FORCE will fix
  // portfolio-wide; see task #127). The leaked accounts then poison
  // FX consolidation tests by replacing the global "Cash" account in
  // their dedup, blanking the cash row.
  //
  // Cheap to run: O(orphans), zero rows for the happy path.
  const orphans = await prisma.tenant.findMany({
    where: { slug: { startsWith: "acc-leak-" } },
    select: { id: true },
  });
  const orphanIds = orphans.map((o) => o.id);
  if (orphanIds.length > 0) {
    await prisma.journalLine.deleteMany({
      where: { entry: { tenantId: { in: orphanIds } } },
    });
    await prisma.journalEntry.deleteMany({
      where: { tenantId: { in: orphanIds } },
    });
    await prisma.account.deleteMany({
      where: { tenantId: { in: orphanIds } },
    });
    await prisma.legalEntity.deleteMany({
      where: { tenantId: { in: orphanIds } },
    });
    await prisma.auditLog.deleteMany({
      where: { tenantId: { in: orphanIds } },
    });
    await prisma.tenant.deleteMany({
      where: { id: { in: orphanIds } },
    });
  }

  tenantA = await prisma.tenant.create({
    data: {
      slug: `acc-leak-a-${SUFFIX}`,
      name: "Account-Leak Tenant A",
      ownerUserId: owner.id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `acc-leak-b-${SUFFIX}`,
      name: "Account-Leak Tenant B",
      ownerUserId: owner.id,
    },
  });

  // Two entities with the SAME code suffix — one per tenant.
  // We use distinct codes (ENT-A vs ENT-B) so we don't trip the
  // global @unique on LegalEntity.code that still applies pre-Phase-4b-followup.
  const eA = await prisma.legalEntity.create({
    data: {
      tenantId: tenantA.id,
      code: `ACC-LEAK-A-${SUFFIX}`,
      name: "Acc A",
      functionalCurrencyId: "USD",
    },
  });
  const eB = await prisma.legalEntity.create({
    data: {
      tenantId: tenantB.id,
      code: `ACC-LEAK-B-${SUFFIX}`,
      name: "Acc B",
      functionalCurrencyId: "USD",
    },
  });
  entityA = { id: eA.id, code: eA.code };
  entityB = { id: eB.id, code: eB.code };

  // Each tenant seeds a SHARED-CHART "1000" account (entityId=null).
  // The unique constraint is [entityId, code]; with entityId=null,
  // Postgres treats NULL != NULL for unique purposes, so both rows coexist.
  // Each is in its own tenant.
  const aA = await prisma.account.create({
    data: {
      tenantId: tenantA.id,
      entityId: null,
      code: "1000",
      name: "Cash (Tenant A)",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
  });
  const aB = await prisma.account.create({
    data: {
      tenantId: tenantB.id,
      entityId: null,
      code: "1000",
      name: "Cash (Tenant B)",
      type: "ASSET",
      normalBalance: "DEBIT",
    },
  });
  accountA1000 = { id: aA.id };
  accountB1000 = { id: aB.id };

  // Also need a 3000 (equity) per tenant for balanced JEs.
  await prisma.account.create({
    data: {
      tenantId: tenantA.id,
      entityId: null,
      code: "3000",
      name: "Capital (A)",
      type: "EQUITY",
      normalBalance: "CREDIT",
    },
  });
  await prisma.account.create({
    data: {
      tenantId: tenantB.id,
      entityId: null,
      code: "3000",
      name: "Capital (B)",
      type: "EQUITY",
      normalBalance: "CREDIT",
    },
  });
});

afterAll(async () => {
  const tenantIds = [tenantA.id, tenantB.id];
  await prisma.journalLine.deleteMany({
    where: { entry: { tenantId: { in: tenantIds } } },
  });
  await prisma.journalEntry.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await prisma.account.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.legalEntity.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("postJournalEntry: cross-tenant account leakage", () => {
  it("posting to tenant A's entity binds to tenant A's '1000' account (not tenant B's)", async () => {
    const result = await postJournalEntry(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-03-15"),
      memo: "tenantA seed post",
      lines: [
        { accountCode: "1000", debit: 100 },
        { accountCode: "3000", credit: 100 },
      ],
    });

    // Pull the resulting JournalLine for code 1000 and check which
    // Account row it bound to.
    const lines = await prisma.journalLine.findMany({
      where: { entryId: result.id, debit: { gt: 0 } },
      select: {
        accountId: true,
        tenantId: true,
        account: { select: { tenantId: true, name: true } },
      },
    });

    expect(lines).toHaveLength(1);
    const line = lines[0];

    // The PRIMARY assertion: the resolved Account belongs to tenant A,
    // not tenant B. If this fails, the engine has a tenantId-filter bug.
    expect(line.account.tenantId).toBe(tenantA.id);
    expect(line.account.tenantId).not.toBe(tenantB.id);
    expect(line.account.name).toMatch(/Tenant A/);

    // And the line's denormalized tenantId matches the entry's.
    expect(line.tenantId).toBe(tenantA.id);

    // accountId should be tenant A's 1000, not tenant B's.
    expect(line.accountId).toBe(accountA1000.id);
    expect(line.accountId).not.toBe(accountB1000.id);
  });

  it("posting to tenant B's entity binds to tenant B's '1000' (symmetric check)", async () => {
    const result = await postJournalEntry(prisma, {
      entityCode: entityB.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-03-15"),
      memo: "tenantB seed post",
      lines: [
        { accountCode: "1000", debit: 50 },
        { accountCode: "3000", credit: 50 },
      ],
    });

    const lines = await prisma.journalLine.findMany({
      where: { entryId: result.id, debit: { gt: 0 } },
      select: { accountId: true, account: { select: { tenantId: true } } },
    });

    expect(lines).toHaveLength(1);
    expect(lines[0].account.tenantId).toBe(tenantB.id);
    expect(lines[0].accountId).toBe(accountB1000.id);
  });
});
