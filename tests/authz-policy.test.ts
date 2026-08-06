// Per-tenant RBAC policy layer (src/lib/auth/policy.ts + authorize.ts).
//
// Two halves:
//
//   1. Pure catalog semantics — role hierarchy, floors, requirePermission
//      throw shape. No DB.
//
//   2. Integration through real gated Server Actions against the real DB:
//      - a MEMBER is refused by an ADMIN-floor action AND the refusal
//        writes an ACCESS_DENIED audit row (CC7.2)
//      - an ADMIN passes the same gate
//      - the tenant pin holds: an ADMIN of tenant A cannot resolve
//        tenant B's entity by code (period close) or touch a user who
//        is not a member of tenant A (user lifecycle) — CC6.3: the
//        allowlist's "global admin" semantics must NOT survive the
//        migration to per-tenant roles.
//
// Auth: Server Actions read the `lc-user` HMAC cookie + `lc-tenant`
// slug cookie. We mint per-run users/tenants (prefix "azp") and pin
// lc-tenant explicitly — never rely on single-membership auto-resolve,
// which breaks when a concurrent suite grants the same user another
// membership.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

// next/headers mock — hoisted before modules that import it.
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
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));

// revalidatePath no-ops outside a Next request scope.
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  canPostJournalEntries,
  canClosePeriods,
  canManageUsers,
  canRemoveOwner,
  canViewAdminPages,
  requirePermission,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { closePeriodAction } from "@/app/actions/period-close";
import {
  deactivateUserAction,
  reactivateUserAction,
} from "@/app/actions/user-lifecycle";
import {
  _internal as authInternal,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { NotAuthenticatedError as TenantNotAuthenticatedError } from "@/lib/auth/tenant";

const prisma = new PrismaClient();

const SUFFIX = "azp" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
// displayName carries the stale-fixture marker: User.email is encrypted
// at rest, so a startsWith sweep on email would (deliberately) throw
// EncryptedFieldQueryError. displayName is plaintext.
const USER_MARKER = "AZP Authz Fixture";

let tenantA: { id: string; slug: string };
let tenantB: { id: string; slug: string };
let adminA: { id: string };
let memberA: { id: string };
let outsiderB: { id: string };

function signInAs(userId: string, tenantSlug: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set("lc-tenant", { value: tenantSlug });
}

async function scrubStaleFixtures() {
  // Self-healing: a killed run skips afterAll. Find residue by marker
  // and delete in FK order. Tenants first (memberships cascade), then
  // users inside the audit-mutable window (app_user hard-deletes trip
  // the append-only RULE's referential-integrity query otherwise).
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: USER_MARKER } },
    select: { id: true },
  });
  const staleIds = staleUsers.map((u) => u.id);
  const staleTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "azp" } },
    select: { id: true },
  });
  const staleTenantIds = staleTenants.map((t) => t.id);
  if (staleTenantIds.length > 0) {
    await prisma.legalEntity.deleteMany({
      where: { tenantId: { in: staleTenantIds } },
    });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({
        where: { tenantId: { in: staleTenantIds } },
      });
    });
    await prisma.tenantMembership.deleteMany({
      where: { tenantId: { in: staleTenantIds } },
    });
    await prisma.tenant.deleteMany({ where: { id: { in: staleTenantIds } } });
  }
  if (staleIds.length > 0) {
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({
        where: { actorUserId: { in: staleIds } },
      });
      await prisma.user.deleteMany({ where: { id: { in: staleIds } } });
    });
  }
}

beforeAll(async () => {
  await scrubStaleFixtures();

  adminA = await prisma.user.create({
    data: {
      email: `azp-admin-${SUFFIX}@example.test`,
      displayName: `${USER_MARKER} Admin`,
    },
    select: { id: true },
  });
  memberA = await prisma.user.create({
    data: {
      email: `azp-member-${SUFFIX}@example.test`,
      displayName: `${USER_MARKER} Member`,
    },
    select: { id: true },
  });
  outsiderB = await prisma.user.create({
    data: {
      email: `azp-outsider-${SUFFIX}@example.test`,
      displayName: `${USER_MARKER} Outsider`,
    },
    select: { id: true },
  });

  tenantA = await prisma.tenant.create({
    data: { slug: `azp-a-${SUFFIX}`, name: "AZP A", ownerUserId: adminA.id },
    select: { id: true, slug: true },
  });
  tenantB = await prisma.tenant.create({
    data: { slug: `azp-b-${SUFFIX}`, name: "AZP B", ownerUserId: adminA.id },
    select: { id: true, slug: true },
  });

  await prisma.tenantMembership.create({
    data: { tenantId: tenantA.id, userId: adminA.id, role: "ADMIN" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenantA.id, userId: memberA.id, role: "MEMBER" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenantB.id, userId: outsiderB.id, role: "MEMBER" },
  });

  // Entity in tenant B ONLY — the cross-tenant pin test target.
  await prisma.legalEntity.create({
    data: {
      tenantId: tenantB.id,
      code: `AZPB-${SUFFIX}`.toUpperCase(),
      name: "AZP B Entity",
      functionalCurrencyId: "USD",
    },
  });
});

afterAll(async () => {
  if (!tenantA || !tenantB) {
    // beforeAll died before fixtures existed — nothing to clean.
    await prisma.$disconnect();
    return;
  }
  const tenantIds = [tenantA.id, tenantB.id];
  const userIds = [adminA.id, memberA.id, outsiderB.id];
  await prisma.legalEntity.deleteMany({ where: { tenantId: { in: tenantIds } } });
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({
      where: {
        OR: [{ tenantId: { in: tenantIds } }, { actorUserId: { in: userIds } }],
      },
    });
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: tenantIds } },
  });
  await prisma.tenant.deleteMany({ where: { id: { in: tenantIds } } });
  await withAuditLogMutable(prisma, async () => {
    await prisma.user.deleteMany({ where: { id: { in: userIds } } });
  });
  await prisma.$disconnect();
});

// ─── 1. Pure catalog semantics ───────────────────────────────────────────

describe("policy catalog: role hierarchy + floors", () => {
  it("MEMBER floor admits every role", () => {
    expect(canPostJournalEntries("MEMBER")).toBe(true);
    expect(canPostJournalEntries("ADMIN")).toBe(true);
    expect(canPostJournalEntries("OWNER")).toBe(true);
  });

  it("ADMIN floor refuses MEMBER, admits ADMIN and OWNER", () => {
    expect(canClosePeriods("MEMBER")).toBe(false);
    expect(canClosePeriods("ADMIN")).toBe(true);
    expect(canClosePeriods("OWNER")).toBe(true);
    expect(canManageUsers("MEMBER")).toBe(false);
    expect(canViewAdminPages("MEMBER")).toBe(false);
  });

  it("null/undefined role fails every check, including the lowest floor", () => {
    expect(canPostJournalEntries(null)).toBe(false);
    expect(canPostJournalEntries(undefined)).toBe(false);
    expect(canClosePeriods(null)).toBe(false);
  });

  it("canRemoveOwner is false for every role — even OWNER", () => {
    expect(canRemoveOwner("OWNER")).toBe(false);
    expect(canRemoveOwner("ADMIN")).toBe(false);
  });

  it("requirePermission throws a typed error carrying permission + role", () => {
    expect(() =>
      requirePermission("period.close", "MEMBER", canClosePeriods)
    ).toThrowError(PermissionDeniedError);
    let thrown: unknown = null;
    try {
      requirePermission("period.close", "MEMBER", canClosePeriods);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(PermissionDeniedError);
    const err = thrown as PermissionDeniedError;
    expect(err.permission).toBe("period.close");
    expect(err.role).toBe("MEMBER");
    // Passing check: no throw.
    expect(() =>
      requirePermission("period.close", "ADMIN", canClosePeriods)
    ).not.toThrow();
  });
});

// ─── 2. Gated actions against the real DB ────────────────────────────────

describe("requirePermitted through real Server Actions", () => {
  it("refuses a MEMBER at an ADMIN-floor action and audits the denial", async () => {
    signInAs(memberA.id, tenantA.slug);
    const res = await closePeriodAction({
      entityCode: "ANY",
      bookCode: "US_GAAP",
      periodCode: "2026-01",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("admin permission");

    const denial = await prisma.auditLog.findFirst({
      where: {
        eventType: "ACCESS_DENIED",
        action: "period.close",
        actorUserId: memberA.id,
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(denial).not.toBeNull();
  });

  it("audits an UNAUTHENTICATED attempt at a gated action (CC7.2)", async () => {
    // `deactivateUserAction` is deliberate: it is one of the eighteen
    // action files whose catch block did NOT write this row, so it only
    // passes because requirePermitted now audits at the throw site. Ten
    // other files (period-close among them) hand-rolled the audit and
    // would pass either way — they cannot discriminate.
    mockCookieStore.clear(); // signed out entirely
    const since = new Date(Date.now() - 1000);

    const res = await deactivateUserAction({ userId: memberA.id });
    expect(res.ok).toBe(false);

    const denial = await prisma.auditLog.findFirst({
      where: {
        eventType: "ACCESS_DENIED",
        action: "user.manage",
        // No actor — nobody was signed in. The attempt is still a fact
        // the log has to carry.
        actorUserId: null,
        occurredAt: { gte: since },
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(denial).not.toBeNull();
    expect((denial!.metadata as { reason?: string })?.reason).toBe(
      "Not authenticated"
    );
    expect(denial!.outcome).toBe("FAILURE");
  });

  it("NotAuthenticatedError is one class, so every instanceof check matches", () => {
    // Two classes of this name used to exist — this one and a second in
    // ./tenant that requireCurrentTenant threw. Action catch blocks
    // import THIS one, so the check was silently false for anything the
    // tenant resolver raised: handled branch skipped, no audit row.
    expect(TenantNotAuthenticatedError).toBe(NotAuthenticatedError);
  });

  it("admits an ADMIN past the gate (fails later on unknown entity, not permission)", async () => {
    signInAs(adminA.id, tenantA.slug);
    const res = await closePeriodAction({
      entityCode: "NO-SUCH-ENTITY",
      bookCode: "US_GAAP",
      periodCode: "2026-01",
    });
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Unknown entity");
  });

  it("tenant pin: an ADMIN of tenant A cannot resolve tenant B's entity by code", async () => {
    signInAs(adminA.id, tenantA.slug);
    const res = await closePeriodAction({
      entityCode: `AZPB-${SUFFIX}`.toUpperCase(),
      bookCode: "US_GAAP",
      periodCode: "2026-01",
    });
    // Under the old global-admin allowlist this lookup would have found
    // tenant B's entity. The pin must make it indistinguishable from a
    // nonexistent code.
    expect(res.ok).toBe(false);
    expect(res.message).toContain("Unknown entity");
  });

  it("user lifecycle: cannot deactivate a user outside the current tenant", async () => {
    signInAs(adminA.id, tenantA.slug);
    const res = await deactivateUserAction({ userId: outsiderB.id });
    expect(res.ok).toBe(false);
    // Same message as a nonexistent UUID — no existence oracle.
    expect(res.message).toBe("User not found");
    const stillActive = await prisma.user.findUnique({
      where: { id: outsiderB.id },
      select: { isActive: true },
    });
    expect(stillActive?.isActive).toBe(true);
  });

  it("user lifecycle: deactivate + reactivate a same-tenant member, with audit rows", async () => {
    signInAs(adminA.id, tenantA.slug);

    const off = await deactivateUserAction({ userId: memberA.id });
    expect(off.ok).toBe(true);
    const flipped = await prisma.user.findUnique({
      where: { id: memberA.id },
      select: { isActive: true },
    });
    expect(flipped?.isActive).toBe(false);

    const auditRow = await prisma.auditLog.findFirst({
      where: {
        action: "user.deactivate",
        resourceId: memberA.id,
        actorUserId: adminA.id,
        tenantId: tenantA.id,
      },
      orderBy: { occurredAt: "desc" },
    });
    expect(auditRow).not.toBeNull();

    const on = await reactivateUserAction(memberA.id);
    expect(on.ok).toBe(true);
    const restored = await prisma.user.findUnique({
      where: { id: memberA.id },
      select: { isActive: true },
    });
    expect(restored?.isActive).toBe(true);
  });

  it("refuses a MEMBER at user.manage as well (catalog floor, not action-specific)", async () => {
    signInAs(memberA.id, tenantA.slug);
    const res = await deactivateUserAction({ userId: adminA.id });
    expect(res.ok).toBe(false);
  });
});
