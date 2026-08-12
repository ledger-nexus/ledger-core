// The NetSuite exporter must not read another tenant's dimensions.
//
// HOW THIS WAS FOUND, because the route matters more than the fix:
// `netsuite-mapping.test.ts` cleaned up with `prisma.dimension.deleteMany()`
// — no filter, every tenant. Scoping that cleanup to its own tenant made its
// roundtrip test fail with `CustomSegment: count differs (a=1, b=2)`. The
// exporter had always been reading dimensions globally; the unscoped test
// cleanup guaranteed no other tenant HAD any at assert time, so the leak was
// invisible. A test's cleanup was standing in for a production tenant filter.
//
// `Dimension` is tenant-scoped in the schema. `exportToNs` filtered on entity
// CODE, and entities are unique on `(tenantId, code)` — not on `code` — so
// nothing in the file bounded a single query to one tenant.
//
// ⚠️ NOTE ON WHAT IS ASSERTED. Dimensions are TENANT-level, not entity-level,
// so an export run for an entity in the default tenant correctly includes
// that tenant's own dimensions. The first draft of this suite asserted the
// output was empty and failed against the FIXED code for exactly that reason.
// The assertions therefore name the other tenant's rows specifically.
//
// ⚠️ WHICH HALF HAS ACTUALLY BEEN SEEN TO FAIL. Reverting the two `tenantId`
// filters in export.ts and re-running: the custom-segment test FAILS
// (`expected [ 'custcol_region', …(2) ] to not include 'nsts_their_segment'`).
// The Department test PASSES pre-fix. That is not a bug in the fix — both
// tenants own a dimension at code `DEPARTMENT` and the exporter picks with
// `.find(d => d.code === "DEPARTMENT")`, first match wins, so which tenant's
// department list you exported came down to row order and on this data the
// default tenant happened to win.
//
// It is kept as a regression guard, not offered as proof: the leak it covers
// is real (an unscoped `findMany` puts both tenants' rows in the array) and
// nondeterministic, which is worse than a reliable one, not better. The
// custom-segment test is the one carrying the evidence.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { exportToNs } from "@/lib/mappers/netsuite";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const PREFIX = "nsts";
const OURS = `${PREFIX}_own`;
const THEIRS_SLUG = `${PREFIX}-other-tenant`;

let ourTenantId: string;
let theirTenantId: string;

/** Cascade-delete every fixture this suite has ever created, by prefix. */
async function scrubOrphans() {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length) {
    await prisma.dimensionValue.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.dimension.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.legalEntity.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  // Our own side lives in the DEFAULT tenant, so it is scrubbed by code.
  const tid = await getDefaultTenantId(prisma);
  await prisma.dimensionValue.deleteMany({
    where: { tenantId: tid, dimension: { code: { startsWith: PREFIX.toUpperCase() } } },
  });
  await prisma.dimension.deleteMany({
    where: { tenantId: tid, code: { startsWith: PREFIX.toUpperCase() } },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId: tid, code: { startsWith: PREFIX } },
  });
}

beforeAll(async () => {
  // Self-healing per CLAUDE.md: a killed run skips afterAll, and a leaked
  // tenant here would be read by the very query under test.
  await scrubOrphans();

  ourTenantId = await getDefaultTenantId(prisma);
  await prisma.legalEntity.create({
    data: { tenantId: ourTenantId, code: OURS, name: "Export scope — ours", functionalCurrencyId: "USD" },
  });

  const theirs = await prisma.tenant.create({
    data: {
      slug: THEIRS_SLUG,
      name: "Export scope — another customer",
      ownerUserId: "00000000-0000-0000-0000-000000000000",
    },
    select: { id: true },
  });
  theirTenantId = theirs.id;

  // Their dimensions: one custom segment and one of the built-in three, so
  // both exporter reads are covered. Values too — the leak carried names.
  const custom = await prisma.dimension.create({
    data: { tenantId: theirTenantId, code: "NSTS_THEIR_SEGMENT", name: "Their confidential segment" },
    select: { id: true },
  });
  await prisma.dimensionValue.create({
    data: {
      tenantId: theirTenantId,
      dimensionId: custom.id,
      code: "SECRET1",
      name: "Their customer list entry",
    },
  });
  const dept = await prisma.dimension.create({
    data: { tenantId: theirTenantId, code: "DEPARTMENT", name: "Their departments" },
    select: { id: true },
  });
  await prisma.dimensionValue.create({
    data: { tenantId: theirTenantId, dimensionId: dept.id, code: "99", name: "Their secret department" },
  });
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

describe("exportToNs tenant scoping", () => {
  it("does not emit another tenant's custom segments", async () => {
    const out = await exportToNs(prisma, { entityCode: OURS });

    const segments = out.CustomSegment ?? [];
    expect(segments.map((s) => s.internalid)).not.toContain("nsts_their_segment");
    // The names travel with it, which is what makes this a data leak rather
    // than an id collision.
    expect(segments.flatMap((s) => s.values.map((v) => v.name))).not.toContain(
      "Their customer list entry"
    );
  });

  it("does not emit another tenant's Department values", async () => {
    const out = await exportToNs(prisma, { entityCode: OURS });

    const deptCodes = (out.Department ?? []).map((d) => d.internalid);
    expect(deptCodes).not.toContain("99");
    expect((out.Department ?? []).map((d) => d.name)).not.toContain("Their secret department");
  });

  it("still sees its OWN dimensions", async () => {
    // Guards the guard. Scoping a query to nothing also makes the two tests
    // above pass, and they would keep passing forever while the exporter
    // returned empty for every real caller.
    const mine = await prisma.dimension.create({
      data: { tenantId: ourTenantId, code: "NSTS_MINE", name: "Our own segment" },
      select: { id: true },
    });
    await prisma.dimensionValue.create({
      data: { tenantId: ourTenantId, dimensionId: mine.id, code: "M1", name: "Ours" },
    });

    const out = await exportToNs(prisma, { entityCode: OURS });
    const segments = out.CustomSegment ?? [];
    expect(segments.map((s) => s.internalid)).toContain("nsts_mine");
  });
});
