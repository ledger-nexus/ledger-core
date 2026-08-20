// The dimension admin actions.
//
// The property worth the most here is the parent lookup. `DimensionValue` is
// unique on `(dimensionId, code)` with NO tenant term, so if the action
// resolved its parent dimension by id alone, a caller could hang a value off
// another tenant's dimension and it would be accepted — the same shape as
// deficiency #32, in a table whose own constraint cannot catch it.
//
// Also covered: dimension codes are refused rather than upserted when they
// collide, because a code keys the DimensionSet hash and silently rewriting one
// changes the meaning of every set already built from it.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (opts: { name: string; value: string } | string, maybeValue?: string) => {
      if (typeof opts === "string") mockCookieStore.set(opts, { value: maybeValue ?? "" });
      else mockCookieStore.set(opts.name, { value: opts.value });
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { TENANT_COOKIE_NAME } from "@/lib/auth/tenant";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";
import {
  createDimensionAction,
  createDimensionValueAction,
} from "@/app/actions/dimensions";

const prisma = new PrismaClient();

const PREFIX = "dmx";
const SUFFIX = PREFIX + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let userA: string;
let userB: string;

function fd(entries: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.append(k, v);
  return f;
}
function signIn(userId: string, tenantSlug: string) {
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set(TENANT_COOKIE_NAME, { value: tenantSlug });
}

async function scrubOrphans() {
  const tenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: PREFIX } },
    select: { id: true },
  });
  const ids = tenants.map((t) => t.id);
  if (ids.length) {
    await prisma.dimensionValue.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.dimension.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  // The user delete goes inside the window — audit_log's append-only RULE
  // rewrites the FK integrity check. See tests/saved-views.test.ts.
  const users = await prisma.user.findMany({
    where: { email: { startsWith: PREFIX } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  if (userIds.length) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
  }
}

beforeAll(async () => {
  await scrubOrphans();
  const mkUser = async (tag: string) =>
    (
      await prisma.user.create({
        data: { email: `${PREFIX}-${tag}-${SUFFIX}@example.test`, displayName: `DMX ${tag}`, isActive: true },
        select: { id: true },
      })
    ).id;
  userA = await mkUser("a");
  userB = await mkUser("b");

  const mkTenant = async (tag: string, owner: string) => {
    const t = await prisma.tenant.create({
      data: { slug: `${PREFIX}-${tag}-${SUFFIX}`, name: `DMX ${tag}`, ownerUserId: owner },
      select: { id: true, slug: true },
    });
    await prisma.tenantMembership.create({ data: { tenantId: t.id, userId: owner, role: "OWNER" } });
    return t;
  };
  tenantA = await mkTenant("a", userA);
  tenantB = await mkTenant("b", userB);
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mockCookieStore.clear();
  await prisma.dimensionValue.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
  await prisma.dimension.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
});

describe("createDimensionAction", () => {
  it("creates a group in the caller's tenant and audits it", async () => {
    signIn(userA, tenantA.slug);
    expect(await createDimensionAction(fd({ code: "DEPARTMENT", name: "Department" }))).toEqual({
      ok: true,
    });

    const d = await prisma.dimension.findFirstOrThrow({
      where: { tenantId: tenantA.id, code: "DEPARTMENT" },
      select: { name: true, isRequired: true },
    });
    expect(d.name).toBe("Department");
    // The UI does not offer it and the action does not set it — the column
    // stays at its default rather than being quietly written.
    expect(d.isRequired).toBe(false);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: tenantA.id, action: "dimension.create" },
      select: { actorUserId: true, resource: true },
    });
    expect(audit?.actorUserId).toBe(userA);
    expect(audit?.resource).toBe("Dimension");
  });

  it("uppercases the code and rejects a shape that cannot key a hash", async () => {
    signIn(userA, tenantA.slug);
    expect(await createDimensionAction(fd({ code: "region", name: "Region" }))).toEqual({ ok: true });
    expect(
      await prisma.dimension.count({ where: { tenantId: tenantA.id, code: "REGION" } })
    ).toBe(1);

    expect((await createDimensionAction(fd({ code: "2BAD", name: "Bad" }))).ok).toBe(false);
    expect((await createDimensionAction(fd({ code: "HAS SPACE", name: "Bad" }))).ok).toBe(false);
  });

  it("refuses a duplicate code rather than upserting it", async () => {
    // A dimension code keys the DimensionSet hash. Rewriting one in place
    // would change what every existing set means.
    signIn(userA, tenantA.slug);
    await createDimensionAction(fd({ code: "CLASS", name: "Class" }));
    const second = await createDimensionAction(fd({ code: "CLASS", name: "Something else" }));
    expect(second.ok).toBe(false);

    const rows = await prisma.dimension.findMany({
      where: { tenantId: tenantA.id, code: "CLASS" },
      select: { name: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Class"); // unchanged
  });

  it("lets two tenants each own the same code", async () => {
    signIn(userA, tenantA.slug);
    await createDimensionAction(fd({ code: "LOCATION", name: "Location" }));
    signIn(userB, tenantB.slug);
    expect(await createDimensionAction(fd({ code: "LOCATION", name: "Location" }))).toEqual({
      ok: true,
    });
    expect(await prisma.dimension.count({ where: { code: "LOCATION", tenantId: { in: [tenantA.id, tenantB.id] } } })).toBe(2);
  });
});

describe("createDimensionValueAction", () => {
  it("adds a value to the caller's own dimension", async () => {
    signIn(userA, tenantA.slug);
    await createDimensionAction(fd({ code: "DEPARTMENT", name: "Department" }));
    const d = await prisma.dimension.findFirstOrThrow({
      where: { tenantId: tenantA.id, code: "DEPARTMENT" },
      select: { id: true },
    });

    expect(
      await createDimensionValueAction(fd({ dimensionId: d.id, code: "20", name: "Engineering" }))
    ).toEqual({ ok: true });
    expect(await prisma.dimensionValue.count({ where: { dimensionId: d.id } })).toBe(1);
  });

  it("⚠️ refuses to hang a value off ANOTHER TENANT's dimension", async () => {
    // The property this file exists for. DimensionValue is unique on
    // (dimensionId, code) with no tenant term, so the database cannot catch
    // this — only the action's WHERE can.
    signIn(userB, tenantB.slug);
    await createDimensionAction(fd({ code: "SECRET", name: "Theirs" }));
    const theirs = await prisma.dimension.findFirstOrThrow({
      where: { tenantId: tenantB.id, code: "SECRET" },
      select: { id: true },
    });

    signIn(userA, tenantA.slug);
    const result = await createDimensionValueAction(
      fd({ dimensionId: theirs.id, code: "X", name: "Injected" })
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("Dimension not found");
    expect(await prisma.dimensionValue.count({ where: { dimensionId: theirs.id } })).toBe(0);
  });

  it("refuses a duplicate value code within one group", async () => {
    signIn(userA, tenantA.slug);
    await createDimensionAction(fd({ code: "CLASS", name: "Class" }));
    const d = await prisma.dimension.findFirstOrThrow({
      where: { tenantId: tenantA.id, code: "CLASS" },
      select: { id: true },
    });
    await createDimensionValueAction(fd({ dimensionId: d.id, code: "10", name: "Product" }));
    const dup = await createDimensionValueAction(fd({ dimensionId: d.id, code: "10", name: "Other" }));
    expect(dup.ok).toBe(false);
    expect(await prisma.dimensionValue.count({ where: { dimensionId: d.id } })).toBe(1);
  });

  it("refuses when nobody is signed in", async () => {
    mockCookieStore.clear();
    await expect(createDimensionAction(fd({ code: "ANON", name: "Anon" }))).rejects.toThrow();
  });
});
