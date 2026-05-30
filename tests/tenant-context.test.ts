// Tenant context helper tests.
//
// Verifies the resolution algorithm in src/lib/auth/tenant.ts:
//   1. No current user → null / NotAuthenticatedError
//   2. User with 0 memberships → null / NoTenantMembershipError
//   3. User with 1 membership → auto-resolves, no cookie required
//   4. User with N>1 memberships + no cookie → null / NoTenantSelectedError
//   5. User with N>1 memberships + valid cookie → that tenant
//   6. User with N>1 memberships + cookie pointing at non-member tenant
//      → falls back to null (NoTenantSelectedError), does not leak access
//   7. Soft-deleted tenant is invisible — membership row is ignored
//
// Auth scope: tests mock next/headers and inject a dev-cookie HMAC
// matching the test User's UUID. Same pattern as period-close-action.test.ts.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (
      opts: { name: string; value: string } | string,
      maybeValue?: string
    ) => {
      if (typeof opts === "string") {
        mockCookieStore.set(opts, { value: maybeValue ?? "" });
      } else {
        mockCookieStore.set(opts.name, { value: opts.value });
      }
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
}));

vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

import { _internal } from "@/lib/auth/current-user";
import {
  getCurrentTenant,
  requireCurrentTenant,
  listMyTenants,
  isTenantAdmin,
  NoTenantSelectedError,
  NoTenantMembershipError,
  NotAuthenticatedError,
  TENANT_COOKIE_NAME,
} from "@/lib/auth/tenant";
import {
  createMyFirstTenantAction,
  setTenantAction,
} from "@/app/actions/set-tenant";

const prisma = new PrismaClient();

// Per-test scratch tenants and a unique user.
let testUser: { id: string; email: string };
let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };

// Pick a slug suffix so parallel test runs don't collide.
const SUFFIX = Date.now().toString(36) + Math.floor(Math.random() * 9999);

function signInAs(userId: string): void {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: _internal.encode(userId) });
}

function signOut(): void {
  mockCookieStore.delete("lc-user");
}

function setTenantCookie(slug: string): void {
  mockCookieStore.set(TENANT_COOKIE_NAME, { value: slug });
}

function clearTenantCookie(): void {
  mockCookieStore.delete(TENANT_COOKIE_NAME);
}

beforeAll(async () => {
  testUser = await prisma.user.create({
    data: {
      email: `tenant-test-${SUFFIX}@example.test`,
      displayName: "Tenant Test User",
      isActive: true,
    },
  });
  tenantA = await prisma.tenant.create({
    data: {
      slug: `test-tenant-a-${SUFFIX}`,
      name: "Test Tenant A",
      ownerUserId: testUser.id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `test-tenant-b-${SUFFIX}`,
      name: "Test Tenant B",
      ownerUserId: testUser.id,
    },
  });
});

afterAll(async () => {
  // Best-effort cleanup. After auditPrivilegedAction added tenant scoping,
  // audit_log rows reference tenant via FK — must drop them before the
  // tenant. Order: actor-scoped audit rows → tenant-scoped audit rows →
  // tenants → user.
  const testTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: `test-tenant-` } },
    select: { id: true },
  });
  const tenantIds = testTenants.map((t) => t.id);
  // Audit log is append-only at the DB level. Use the test-only
  // escape hatch to clean up between runs without leaving orphan
  // rows that block tenant deletion.
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { actorUserId: testUser.id } });
    if (tenantIds.length > 0) {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    }
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await prisma.user.deleteMany({ where: { id: testUser.id } }).catch(() => {});
  await prisma.$disconnect();
});

beforeEach(async () => {
  signOut();
  clearTenantCookie();
  // Reset memberships between cases.
  await prisma.tenantMembership.deleteMany({
    where: { userId: testUser.id },
  });
});

describe("getCurrentTenant: resolution order", () => {
  it("returns null when no user is signed in", async () => {
    expect(await getCurrentTenant()).toBeNull();
  });

  it("returns null when the user has 0 memberships", async () => {
    signInAs(testUser.id);
    expect(await getCurrentTenant()).toBeNull();
  });

  it("auto-resolves a single membership without a cookie", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "OWNER" },
    });
    const t = await getCurrentTenant();
    expect(t).not.toBeNull();
    expect(t!.slug).toBe(tenantA.slug);
    expect(t!.role).toBe("OWNER");
  });

  it("returns null when N>1 memberships and no cookie set", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "MEMBER" },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenantB.id, userId: testUser.id, role: "MEMBER" },
    });
    expect(await getCurrentTenant()).toBeNull();
  });

  it("honors the cookie when it names a valid membership", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "MEMBER" },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenantB.id, userId: testUser.id, role: "ADMIN" },
    });
    setTenantCookie(tenantB.slug);
    const t = await getCurrentTenant();
    expect(t!.slug).toBe(tenantB.slug);
    expect(t!.role).toBe("ADMIN");
  });

  it("ignores a cookie pointing at a tenant the user is NOT a member of", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "MEMBER" },
    });
    // Cookie says tenantB, but no membership there. Should fall back —
    // since user has exactly 1 valid membership (A), auto-resolve to A.
    setTenantCookie(tenantB.slug);
    const t = await getCurrentTenant();
    expect(t!.slug).toBe(tenantA.slug);
  });

  it("treats soft-deleted tenants as invisible", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "OWNER" },
    });
    await prisma.tenant.update({
      where: { id: tenantA.id },
      data: { deletedAt: new Date() },
    });
    expect(await getCurrentTenant()).toBeNull();
    // Restore for subsequent tests.
    await prisma.tenant.update({
      where: { id: tenantA.id },
      data: { deletedAt: null },
    });
  });
});

describe("requireCurrentTenant: error discrimination", () => {
  it("throws NotAuthenticatedError when not signed in", async () => {
    await expect(requireCurrentTenant()).rejects.toBeInstanceOf(
      NotAuthenticatedError
    );
  });

  it("throws NoTenantMembershipError for a signed-in user with 0 memberships", async () => {
    signInAs(testUser.id);
    await expect(requireCurrentTenant()).rejects.toBeInstanceOf(
      NoTenantMembershipError
    );
  });

  it("throws NoTenantSelectedError for multi-tenant user without cookie", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "MEMBER" },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenantB.id, userId: testUser.id, role: "MEMBER" },
    });
    await expect(requireCurrentTenant()).rejects.toBeInstanceOf(
      NoTenantSelectedError
    );
  });

  it("returns the tenant when valid", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "OWNER" },
    });
    const t = await requireCurrentTenant();
    expect(t.slug).toBe(tenantA.slug);
  });
});

describe("listMyTenants", () => {
  it("returns [] when not signed in", async () => {
    expect(await listMyTenants()).toEqual([]);
  });

  it("returns all active memberships for the signed-in user", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "OWNER" },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenantB.id, userId: testUser.id, role: "MEMBER" },
    });
    const list = await listMyTenants();
    expect(list).toHaveLength(2);
    expect(list.map((t) => t.slug).sort()).toEqual(
      [tenantA.slug, tenantB.slug].sort()
    );
  });

  it("omits soft-deleted tenants", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "OWNER" },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenantB.id, userId: testUser.id, role: "MEMBER" },
    });
    await prisma.tenant.update({
      where: { id: tenantB.id },
      data: { deletedAt: new Date() },
    });
    const list = await listMyTenants();
    expect(list.map((t) => t.slug)).toEqual([tenantA.slug]);
    await prisma.tenant.update({
      where: { id: tenantB.id },
      data: { deletedAt: null },
    });
  });
});

describe("isTenantAdmin", () => {
  it("returns false for null", () => {
    expect(isTenantAdmin(null)).toBe(false);
  });
  it("returns true for OWNER", () => {
    expect(
      isTenantAdmin({ id: "x", slug: "x", name: "x", role: "OWNER" })
    ).toBe(true);
  });
  it("returns true for ADMIN", () => {
    expect(
      isTenantAdmin({ id: "x", slug: "x", name: "x", role: "ADMIN" })
    ).toBe(true);
  });
  it("returns false for MEMBER", () => {
    expect(
      isTenantAdmin({ id: "x", slug: "x", name: "x", role: "MEMBER" })
    ).toBe(false);
  });
});

describe("setTenantAction: cookie set rejects non-member tenants", () => {
  it("rejects switching to a tenant the user is not a member of", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "MEMBER" },
    });

    const fd = new FormData();
    fd.set("tenantSlug", tenantB.slug);
    await expect(setTenantAction(fd)).rejects.toThrow(/not a member/i);
  });

  it("writes the cookie when membership is valid", async () => {
    signInAs(testUser.id);
    await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: testUser.id, role: "OWNER" },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: tenantB.id, userId: testUser.id, role: "MEMBER" },
    });

    const fd = new FormData();
    fd.set("tenantSlug", tenantB.slug);
    await setTenantAction(fd);
    expect(mockCookieStore.get(TENANT_COOKIE_NAME)?.value).toBe(tenantB.slug);

    // And getCurrentTenant now reflects the switch.
    const t = await getCurrentTenant();
    expect(t!.slug).toBe(tenantB.slug);
  });
});

describe("createMyFirstTenantAction", () => {
  it("rejects when not signed in", async () => {
    const result = await createMyFirstTenantAction({
      slug: `created-${SUFFIX}`,
      name: "Created",
    });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/signed in/i);
  });

  it("rejects an invalid slug", async () => {
    signInAs(testUser.id);
    for (const bad of ["AB", "with space", "-leading", "trailing-", "--double"]) {
      const r = await createMyFirstTenantAction({ slug: bad, name: "X" });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/Slug/i);
    }
  });

  it("creates a tenant + OWNER membership atomically and sets the cookie", async () => {
    signInAs(testUser.id);
    const slug = `created-${SUFFIX}`;
    const result = await createMyFirstTenantAction({
      slug,
      name: "Created Tenant",
    });
    expect(result.ok).toBe(true);
    expect(result.tenantSlug).toBe(slug);

    const dbTenant = await prisma.tenant.findUnique({ where: { slug } });
    expect(dbTenant).not.toBeNull();
    expect(dbTenant!.ownerUserId).toBe(testUser.id);

    const dbMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: dbTenant!.id, userId: testUser.id },
    });
    expect(dbMembership).not.toBeNull();
    expect(dbMembership!.role).toBe("OWNER");

    expect(mockCookieStore.get(TENANT_COOKIE_NAME)?.value).toBe(slug);

    // Clean up. auditPrivilegedAction writes a tenant-scoped row;
    // FK blocks tenant delete unless audit_log rows are gone first.
    // audit_log is DB-level append-only — use the test-only escape
    // hatch.
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: dbTenant!.id } });
    });
    await prisma.tenant.delete({ where: { id: dbTenant!.id } });
  });

  it("rejects a duplicate slug", async () => {
    signInAs(testUser.id);
    const slug = `dup-${SUFFIX}`;
    const r1 = await createMyFirstTenantAction({ slug, name: "first" });
    expect(r1.ok).toBe(true);
    const r2 = await createMyFirstTenantAction({ slug, name: "second" });
    expect(r2.ok).toBe(false);
    expect(r2.message).toMatch(/already exists/i);
    // Clean up — same FK-aware pattern as above.
    const created = await prisma.tenant.findMany({ where: { slug }, select: { id: true } });
    if (created.length > 0) {
      await withAuditLogMutable(prisma, async () => {
        await prisma.auditLog.deleteMany({
          where: { tenantId: { in: created.map((t) => t.id) } },
        });
      });
      await prisma.tenant.deleteMany({ where: { slug } });
    }
  });
});
