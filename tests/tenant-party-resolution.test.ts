// Validation: cross-tenant party leakage in sub-ledger writes.
//
// Same pattern as the account-resolution test: tenant A and tenant B
// each have a shared party (entityId=null) with code "CUSTOMER_X".
// When tenant A opens an AR item with partyCode=CUSTOMER_X, does the
// engine resolve to tenant A's party or could it pick up tenant B's?
//
// The lookup in openArItem/openApItem today:
//
//   prisma.party.findFirstOrThrow({
//     where: {
//       code: input.partyCode,
//       OR: [{ entityId: null }, { entity: { code: input.entityCode } }],
//     },
//   });
//
// No tenantId filter. Same as the account bug. Postgres treats NULL !=
// NULL in the [entityId, code] unique, so both shared parties coexist.
// findFirstOrThrow returns whichever Postgres surfaces first.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { openArItem } from "@/lib/accounting/sub-ledgers/ar";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = "party" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string };
let tenantB: { id: string };
let entityA: { id: string; code: string };
let entityB: { id: string; code: string };
let partyA: { id: string };
let partyB: { id: string };

beforeAll(async () => {
  const owner = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!owner) throw new Error("Run Northwind seed first.");

  tenantA = await prisma.tenant.create({
    data: {
      slug: `party-leak-a-${SUFFIX}`,
      name: "Party A",
      ownerUserId: owner.id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `party-leak-b-${SUFFIX}`,
      name: "Party B",
      ownerUserId: owner.id,
    },
  });

  const eA = await prisma.legalEntity.create({
    data: {
      tenantId: tenantA.id,
      code: `PARTY-LEAK-A-${SUFFIX}`,
      name: "P-A",
      functionalCurrencyId: "USD",
    },
  });
  const eB = await prisma.legalEntity.create({
    data: {
      tenantId: tenantB.id,
      code: `PARTY-LEAK-B-${SUFFIX}`,
      name: "P-B",
      functionalCurrencyId: "USD",
    },
  });
  entityA = { id: eA.id, code: eA.code };
  entityB = { id: eB.id, code: eB.code };

  // Accounts both tenants need to post + open AR.
  for (const t of [
    { tenantId: tenantA.id, suffix: "A" },
    { tenantId: tenantB.id, suffix: "B" },
  ]) {
    await prisma.account.createMany({
      data: [
        {
          tenantId: t.tenantId,
          entityId: null,
          code: "1200",
          name: `AR (${t.suffix})`,
          type: "ASSET",
          normalBalance: "DEBIT",
          isControlAccount: true,
        },
        {
          tenantId: t.tenantId,
          entityId: null,
          code: "4000",
          name: `Revenue (${t.suffix})`,
          type: "REVENUE",
          normalBalance: "CREDIT",
        },
      ],
    });
  }

  // Shared party (entityId=null) in EACH tenant with the SAME code.
  const pA = await prisma.party.create({
    data: {
      tenantId: tenantA.id,
      entityId: null,
      code: `CUSTOMER_X_${SUFFIX}`,
      displayName: "Customer X (Tenant A)",
      roles: { create: { tenantId: tenantA.id, role: "CUSTOMER" } },
    },
  });
  const pB = await prisma.party.create({
    data: {
      tenantId: tenantB.id,
      entityId: null,
      code: `CUSTOMER_X_${SUFFIX}`,
      displayName: "Customer X (Tenant B)",
      roles: { create: { tenantId: tenantB.id, role: "CUSTOMER" } },
    },
  });
  partyA = { id: pA.id };
  partyB = { id: pB.id };
});

afterAll(async () => {
  const tenantIds = [tenantA.id, tenantB.id];
  await prisma.arApplication.deleteMany({
    where: { openItem: { tenantId: { in: tenantIds } } },
  });
  await prisma.arOpenItem.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.journalLine.deleteMany({
    where: { entry: { tenantId: { in: tenantIds } } },
  });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.account.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.partyRole.deleteMany({
    where: { party: { tenantId: { in: tenantIds } } },
  });
  await prisma.party.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
  });
  // RecordEvent.tenantId is RESTRICT; must clean before tenant delete.
  await prisma.recordEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.$disconnect();
});

describe("openArItem: cross-tenant party leakage", () => {
  it("opens an AR item bound to tenant A's party, not tenant B's", async () => {
    // First post a JE so we have something to anchor openedByEntryId to.
    const opener = await postJournalEntry(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-04-01"),
      memo: "AR opener for cross-tenant party test",
      lines: [
        { accountCode: "1200", debit: 1000, partyCode: `CUSTOMER_X_${SUFFIX}` },
        { accountCode: "4000", credit: 1000 },
      ],
    });

    // Now open the AR item.
    const result = await openArItem(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      partyCode: `CUSTOMER_X_${SUFFIX}`,
      openedByEntryId: opener.id,
      openedDate: new Date("2026-04-01"),
      amount: 1000,
      currencyCode: "USD",
      controlAccountCode: "1200",
    });

    const row = await prisma.arOpenItem.findUnique({
      where: { id: result.id },
      select: {
        partyId: true,
        tenantId: true,
        party: { select: { tenantId: true, displayName: true } },
      },
    });
    expect(row).not.toBeNull();
    expect(row!.party.tenantId).toBe(tenantA.id);
    expect(row!.party.tenantId).not.toBe(tenantB.id);
    expect(row!.party.displayName).toMatch(/Tenant A/);
    expect(row!.partyId).toBe(partyA.id);
    expect(row!.partyId).not.toBe(partyB.id);
  });

  it("postJournalEntry partyCode resolution: tenant A's JE binds to tenant A's party", async () => {
    // The JE-line partyCode lookup has the same shape as the AR
    // lookup; verify it too.
    const result = await postJournalEntry(prisma, {
      entityCode: entityA.code,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-04-15"),
      memo: "party-resolution-on-JE-line test",
      lines: [
        { accountCode: "1200", debit: 250, partyCode: `CUSTOMER_X_${SUFFIX}` },
        { accountCode: "4000", credit: 250 },
      ],
    });
    const lines = await prisma.journalLine.findMany({
      where: { entryId: result.id, partyId: { not: null } },
      select: {
        partyId: true,
        party: { select: { tenantId: true } },
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0].party!.tenantId).toBe(tenantA.id);
    expect(lines[0].partyId).toBe(partyA.id);
  });
});
