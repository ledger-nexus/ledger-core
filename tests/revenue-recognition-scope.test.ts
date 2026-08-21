// The straight-line recognition runner must not recognize another tenant's
// revenue.
//
// ⚠️ THIS GAP SURVIVED #32, IN A FILE #32 EDITED.
//
// That sweep made `tenantId` required on the four sub-ledger writers and
// scoped their `legalEntity.findFirstOrThrow({ where: { code } })` lookups.
// `createRevenueContract` in this very module was one of them. But
// `runStraightLineRecognition` does not resolve an entity first — it queries
// CONTRACTS directly, `revenueContract.findMany({ where: { entity: { code } } })`
// — so it never matched the pattern being swept, and kept resolving by an
// entity code that is unique per `(tenantId, code)` and not on its own.
//
// The lesson is the one #32 aimed at deficiency #28: fixing the shape you
// searched for is not the same as fixing the defect class. #28 was closed by
// fixing the one function that was reported; #32 was written by searching for
// one query shape. Same error, one PR apart.
//
// ⚠️ The tenant-scope guard could not catch this either. It classifies a
// `where` naming `entity:` as "bounded by entity" and excludes it — which is
// right for most surfaces and wrong precisely where entity codes collide
// across tenants. Noted rather than changed: reclassifying would flag 83
// sites, most of them fine.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { runStraightLineRecognition } from "@/lib/accounting/sub-ledgers/revenue-contracts";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const PREFIX = "rvs";
const SUFFIX = PREFIX + Date.now().toString(36) + Math.floor(Math.random() * 9999);
/** ⚠️ ONE code, TWO tenants — the whole point of the test. */
const SHARED_ENTITY_CODE = `${PREFIX}_SHARED`;

let tenantA: string;
let tenantB: string;
let entityA: string;
let entityB: string;
let bookId: string;

async function scrubOrphans() {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (!ids.length) return scrubUsers();

  const contracts = await prisma.revenueContract.findMany({
    where: { tenantId: { in: ids } },
    select: { id: true },
  });
  const cIds = contracts.map((c) => c.id);
  await prisma.performanceObligation.deleteMany({ where: { contractId: { in: cIds } } });
  await prisma.revenueContractBookAttributes.deleteMany({ where: { contractId: { in: cIds } } });
  await prisma.revenueContract.deleteMany({ where: { id: { in: cIds } } });
  await prisma.journalLine.deleteMany({ where: { entry: { tenantId: { in: ids } } } });
  await prisma.journalEntry.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.account.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.party.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.period.deleteMany({ where: { calendar: { tenantId: { in: ids } } } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
  });
  await prisma.recordEvent.deleteMany({ where: { tenantId: { in: ids } } });
  await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  await scrubUsers();
}

async function scrubUsers() {
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  // Inside the window — the append-only RULE rewrites the FK check.
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { actorUserId: { in: ids } } });
    await prisma.user.deleteMany({ where: { id: { in: ids } } });
  });
}

/** A tenant with one entity, a chart, and one ACTIVE contract worth 1200/yr. */
async function seedTenant(tag: string, amount: string) {
  const owner = await prisma.user.create({
    data: { email: `${PREFIX}-${tag}-${SUFFIX}@example.test`, displayName: `RVS ${tag}`, isActive: true },
    select: { id: true },
  });
  const tenant = await prisma.tenant.create({
    data: { slug: `${PREFIX}-${tag}-${SUFFIX}`, name: `RVS ${tag}`, ownerUserId: owner.id },
    select: { id: true },
  });
  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: SHARED_ENTITY_CODE, // deliberately identical across tenants
      name: `RVS ${tag} Co`,
      functionalCurrencyId: "USD",
    },
    select: { id: true },
  });
  await prisma.account.createMany({
    data: [
      { tenantId: tenant.id, entityId: entity.id, code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
      { tenantId: tenant.id, entityId: entity.id, code: "2200", name: "Deferred revenue", type: "LIABILITY", normalBalance: "CREDIT" },
    ],
  });
  const party = await prisma.party.create({
    data: { tenantId: tenant.id, entityId: entity.id, code: `CUST-${tag}`, displayName: `Cust ${tag}` },
    select: { id: true },
  });
  const contract = await prisma.revenueContract.create({
    data: {
      tenantId: tenant.id,
      entityId: entity.id,
      customerPartyId: party.id,
      code: `RC-${tag}-${SUFFIX}`.slice(0, 30),
      description: `${tag} contract`,
      currencyId: "USD",
      contractStartDate: new Date("2026-01-01"),
      contractEndDate: new Date("2026-12-31"),
      totalContractValue: amount,
      status: "ACTIVE",
      performanceObligations: {
        create: [
          {
            sequenceNo: 1,
            description: "Subscription",
            ssp: amount,
            recognitionPattern: "OVER_TIME_STRAIGHT",
            startDate: new Date("2026-01-01"),
            endDate: new Date("2026-12-31"),
            revenueAccountCode: "4000",
            deferredAccountCode: "2200",
          },
        ],
      },
      bookAttributes: { create: [{ bookId, recognitionBasis: "ACCRUAL" }] },
    },
    select: { id: true },
  });
  return { tenantId: tenant.id, entityId: entity.id, contractId: contract.id };
}

beforeAll(async () => {
  await scrubOrphans();
  const book = await prisma.book.findUniqueOrThrow({ where: { code: "US_GAAP" }, select: { id: true } });
  bookId = book.id;
  const a = await seedTenant("a", "1200.0000");
  const b = await seedTenant("b", "9600.0000");
  tenantA = a.tenantId;
  entityA = a.entityId;
  tenantB = b.tenantId;
  entityB = b.entityId;
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

describe("runStraightLineRecognition tenant scoping", () => {
  it("recognizes only the caller's tenant, when both tenants share an entity code", async () => {
    // Both tenants own an entity coded rvs_SHARED. Before the fix this query
    // matched on the code alone, so a run for tenant A swept in tenant B's
    // contract and posted its revenue into A's books.
    const result = await runStraightLineRecognition(prisma, {
      tenantId: tenantA,
      entityCode: SHARED_ENTITY_CODE,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });

    // 6 of 12 months of A's 1200 = 600. B's 9600 must contribute nothing.
    expect(result.totalRecognized.toFixed(2)).toBe("600.00");

    // And nothing landed in B's books.
    const bEntries = await prisma.journalEntry.count({ where: { tenantId: tenantB } });
    expect(bEntries).toBe(0);
  });

  it("leaves the other tenant's obligation untouched", async () => {
    // recognizedToDate is the durable evidence: if the run had swept B's
    // contract in, its PO would carry a balance even though nobody asked.
    const bPo = await prisma.performanceObligation.findFirstOrThrow({
      where: { contract: { tenantId: tenantB } },
      select: { recognizedToDate: true },
    });
    expect(bPo.recognizedToDate.toString()).toMatch(/^0(\.0+)?$/);
  });

  it("recognizes tenant B's own contract when B asks", async () => {
    // Guards the guard: scoping a query to nothing also makes the two tests
    // above pass, forever, while the runner does nothing for anyone.
    const result = await runStraightLineRecognition(prisma, {
      tenantId: tenantB,
      entityCode: SHARED_ENTITY_CODE,
      bookCode: "US_GAAP",
      throughDate: new Date("2026-06-30"),
      source: "SEED",
    });
    expect(result.totalRecognized.toFixed(2)).toBe("4800.00"); // 6/12 of 9600
  });
});
