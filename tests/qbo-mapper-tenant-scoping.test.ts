// The QBO mapper must not read, write, or dedupe across tenants.
//
// Found by asking whether #370's `exportToNs` leak was one file or the
// pattern. It was the pattern, and QBO is the worse of the two, because the
// importer WRITES.
//
// Three distinct defects, all from the same root — `code` is unique per
// `(tenantId, code)`, never on its own, and nothing here carried a tenant:
//
//   1. ENTITY RESOLUTION. `legalEntity.findFirstOrThrow({ where: { code } })`
//      under a comment that says "entity code unique per [tenantId, code];
//      use findFirst". Recognising that the code is not globally unique and
//      answering with `findFirst` picks an ARBITRARY tenant's entity — so an
//      import can land its journal entries in someone else's books.
//
//   2. IDEMPOTENCY. `account.findFirst({ sourceSystem: "QBO",
//      sourceRecordType: "Account", sourceRecordId })` — no tenant, no
//      entity. QBO account ids are small integers, so "1" collides across
//      every customer who ever connects QuickBooks. The second tenant to
//      import gets `accountsSkipped` and NO ACCOUNT, silently.
//
//   3. EXPORT. Every read in `exportToQbo` is bounded by entity code alone,
//      so two tenants with an entity coded `ACME` — or `MAIN`, or `HQ` —
//      export each other's rows.
//
// Each test below is written to fail against the unscoped version.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { importFromQbo, exportToQbo } from "@/lib/mappers/qbo";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import type { QboExport } from "@/lib/mappers/qbo/types";

const prisma = new PrismaClient();

const PREFIX = "qts";
const OUR_ENTITY = `${PREFIX}_shared_code`;
const THEIR_SLUG = `${PREFIX}-other-tenant`;
/** An entity code that exists ONLY in the other tenant. */
const THEIRS_ONLY = `${PREFIX}_only_theirs`;
/**
 * A QBO account id both tenants' exports happen to use — the common case.
 *
 * ⚠️ NOT literally "1", which is what makes this realistic, because the
 * shared dev database already holds QBO Account Id "1" from `qbo-sample.json`
 * IN THE DEFAULT TENANT. Using it made this suite fail for the right reason
 * on the wrong axis: a same-tenant collision, which the fix neither does nor
 * should prevent. A distinctive id isolates the CROSS-tenant claim.
 */
const COLLIDING_QBO_ID = "qts-90210";

let ourTenantId: string;
let theirTenantId: string;
let ourEntityId: string;
let theirEntityId: string;

function fixture(): QboExport {
  return {
    Account: [
      {
        Id: COLLIDING_QBO_ID,
        Name: "Checking",
        AccountType: "Bank",
        Active: true,
      },
    ],
  } as QboExport;
}

async function scrubOrphans() {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  const defaultTenant = await getDefaultTenantId(prisma);
  const all = [...ids, defaultTenant];

  const entities = await prisma.legalEntity.findMany({
    where: { tenantId: { in: all }, code: { startsWith: PREFIX } },
    select: { id: true },
  });
  const entityIds = entities.map((e) => e.id);
  if (entityIds.length) {
    await prisma.journalLine.deleteMany({ where: { entry: { entityId: { in: entityIds } } } });
    await prisma.journalEntry.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.account.deleteMany({ where: { entityId: { in: entityIds } } });
    await prisma.legalEntity.deleteMany({ where: { id: { in: entityIds } } });
  }
  if (ids.length) await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
}

beforeAll(async () => {
  // Self-healing per CLAUDE.md — leaked fixtures here would be read by the
  // very queries under test.
  await scrubOrphans();

  ourTenantId = await getDefaultTenantId(prisma);
  const ours = await prisma.legalEntity.create({
    data: { tenantId: ourTenantId, code: OUR_ENTITY, name: "Ours", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  ourEntityId = ours.id;

  const theirTenant = await prisma.tenant.create({
    data: {
      slug: THEIR_SLUG,
      name: "Another customer entirely",
      ownerUserId: "00000000-0000-0000-0000-000000000000",
    },
    select: { id: true },
  });
  theirTenantId = theirTenant.id;

  // Their entity carries the SAME code as ours — the realistic collision.
  const theirs = await prisma.legalEntity.create({
    data: { tenantId: theirTenantId, code: OUR_ENTITY, name: "Theirs", functionalCurrencyId: "USD" },
    select: { id: true },
  });
  theirEntityId = theirs.id;

  await prisma.legalEntity.create({
    data: {
      tenantId: theirTenantId,
      code: THEIRS_ONLY,
      name: "Only in their tenant",
      functionalCurrencyId: "USD",
    },
  });

  // They imported QuickBooks first, and their Checking account is QBO Id "1".
  await prisma.account.create({
    data: {
      tenantId: theirTenantId,
      entityId: theirEntityId,
      code: "QBO1",
      name: "Their checking account",
      type: "ASSET",
      normalBalance: "DEBIT",
      sourceSystem: "QBO",
      sourceRecordType: "Account",
      sourceRecordId: COLLIDING_QBO_ID,
      // The exporter reconstructs from the frozen payload and drops rows
      // without one, so a payload-less fixture cannot demonstrate the export
      // leak at all — it looked like a pass. This is the row that travels.
      sourcePayload: {
        Id: COLLIDING_QBO_ID,
        Name: "Their checking account",
        AccountType: "Bank",
        Active: true,
      },
    },
  });
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

describe("QBO mapper tenant scoping", () => {
  it("does not treat another tenant's QBO account id as already-imported", async () => {
    // THE SILENT ONE. Pre-fix the lookup finds THEIR account by
    // sourceRecordId alone, counts a skip, and our tenant ends up with no
    // Checking account at all — no error, no warning, just a missing row that
    // every later journal entry depends on.
    const result = await importFromQbo(prisma, {
      entityCode: OUR_ENTITY,
      tenantId: ourTenantId,
      export: fixture(),
    });

    expect(result.errors).toEqual([]);
    expect(result.accountsSkipped).toBe(0);
    expect(result.accountsImported).toBe(1);

    const ours = await prisma.account.count({
      where: { tenantId: ourTenantId, entityId: ourEntityId, sourceRecordId: COLLIDING_QBO_ID },
    });
    expect(ours).toBe(1);
  });

  it("refuses an entity code that belongs to a different tenant", async () => {
    // THE DANGEROUS ONE — a cross-tenant WRITE. Pre-fix, `findFirstOrThrow`
    // on code alone resolves THEIRS_ONLY to the other tenant's entity and the
    // import succeeds, depositing rows in their books. Post-fix there is no
    // such entity in our tenant, so it must throw rather than silently
    // retarget.
    await expect(
      importFromQbo(prisma, {
        entityCode: THEIRS_ONLY,
        tenantId: ourTenantId,
        export: fixture(),
      })
    ).rejects.toThrow();

    // And nothing landed in THEIR entity. (Counting "accounts in our tenant
    // not on our entity" was the first version of this and it read 36 — the
    // entire Northwind chart. The assertion has to name the entity the write
    // would have gone to.)
    const theirOnlyEntity = await prisma.legalEntity.findFirstOrThrow({
      where: { tenantId: theirTenantId, code: THEIRS_ONLY },
      select: { id: true },
    });
    const strays = await prisma.account.count({ where: { entityId: theirOnlyEntity.id } });
    expect(strays).toBe(0);
  });

  it("does not export another tenant's rows through a shared entity code", async () => {
    // Mints its own row rather than leaning on the import above. When this
    // depended on the first test, a pre-fix run failed with "expected [] to
    // include 'Checking'" — a CASCADE from that test's failure, which proves
    // nothing about the exporter. Independent fixture, independent evidence.
    await prisma.account.upsert({
      where: { entityId_code: { entityId: ourEntityId, code: "QBO-QTS" } },
      create: {
        tenantId: ourTenantId,
        entityId: ourEntityId,
        code: "QBO-QTS",
        name: "Checking",
        type: "ASSET",
        normalBalance: "DEBIT",
        sourceSystem: "QBO",
        sourceRecordType: "Account",
        sourceRecordId: `${COLLIDING_QBO_ID}-export`,
        sourcePayload: { Id: `${COLLIDING_QBO_ID}-export`, Name: "Checking" },
      },
      update: {},
    });

    const out = await exportToQbo(prisma, { entityCode: OUR_ENTITY, tenantId: ourTenantId });

    // Their "Their checking account" sits on an entity with the SAME code.
    const names = (out.Account ?? []).map((a) => a.Name);
    expect(names).not.toContain("Their checking account");
    // Ours, imported by the first test, must still come back — a query
    // scoped to nothing would also satisfy the assertion above.
    expect(names).toContain("Checking");
  });
});
