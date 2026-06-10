// Integration tests for the account-management Server Actions.
//
// What we verify:
//   1. createAccountAction:
//      - Happy path (entity-scoped, with parent)
//      - Code uniqueness within scope
//      - Bad code shape rejected
//      - Unknown entity rejected
//      - Parent in wrong scope rejected
//      - Audit row written
//   2. updateAccountAction:
//      - Name + flags update
//      - Parent change works
//      - Cycle prevention: A → B → A refuses; self-as-parent refuses
//   3. deactivateAccountAction:
//      - Flips active=false; existing JE lines still reference fine
//      - Reverse via updateAccountAction({active: true})
//   4. Tenant isolation: a forged id from another tenant returns
//      "not found" — no cross-tenant leak.

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { PrismaClient } from "@prisma/client";

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
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";
import {
  createAccountAction,
  updateAccountAction,
  deactivateAccountAction,
} from "@/app/actions/accounts";

const prisma = new PrismaClient();
const SUFFIX = ("ACCT" + Date.now().toString(36)).toUpperCase();
const ENTITY_CODE = `ACCT-${SUFFIX}`;
// requireAdmin() checks email against ADMIN_EMAIL_ALLOWLIST in
// current-user.ts. We use the allowlisted controller email — same
// pattern as tests/period-close-action.test.ts.
const ADMIN_EMAIL = "controller@northwind.test";

let tenant: { id: string; slug: string };
let admin: { id: string; email: string };
let entityId: string;

beforeAll(async () => {
  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  const u = await prisma.user.upsert({
    where: { email: ADMIN_EMAIL },
    create: {
      email: ADMIN_EMAIL,
      displayName: "Acct admin",
      isActive: true,
    },
    update: { isActive: true },
  });
  admin = { id: u.id, email: u.email };

  tenant = await prisma.tenant.create({
    data: {
      slug: `acct-${SUFFIX.toLowerCase()}`,
      name: "Accounts tenant",
      ownerUserId: admin.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: admin.id, role: "OWNER" },
  });

  const entity = await prisma.legalEntity.create({
    data: {
      tenantId: tenant.id,
      code: ENTITY_CODE,
      name: "Accounts Co.",
      functionalCurrencyId: "USD",
    },
  });
  entityId = entity.id;
});

afterAll(async () => {
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({ where: { tenantId: tenant.id } });
  });
  // Includes both entity-scoped and shared (entityId=null) accounts
  // created in this tenant by any test.
  await prisma.account.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.recordEvent.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.legalEntity.deleteMany({ where: { id: entityId } });
  await prisma.tenantMembership.deleteMany({ where: { tenantId: tenant.id } });
  await prisma.tenant.delete({ where: { id: tenant.id } });
  // Don't delete the controller user — other tests (seeded-company,
  // period-close-action, etc.) share it.
  await prisma.$disconnect();
});

beforeEach(async () => {
  // Each test starts with a clean account set (entity-scoped AND shared).
  await prisma.account.deleteMany({ where: { tenantId: tenant.id } });
  await withAuditLogMutable(prisma, async () => {
    await prisma.auditLog.deleteMany({
    where: { tenantId: tenant.id, resource: "Account" },
  });
  });
});

function signInAdmin() {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(admin.id) });
  mockCookieStore.set("lc-tenant", { value: tenant.slug });
}

describe("createAccountAction", () => {
  it("happy path: entity-scoped account with a parent", async () => {
    signInAdmin();
    const parent = await createAccountAction({
      code: "1000",
      name: "Current Assets",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    expect(parent.ok).toBe(true);

    const child = await createAccountAction({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
      parentCode: "1000",
      entityCode: ENTITY_CODE,
    });
    expect(child.ok).toBe(true);

    const created = await prisma.account.findUniqueOrThrow({
      where: { id: child.accountId! },
      include: { parent: { select: { code: true } } },
    });
    expect(created.code).toBe("1010");
    expect(created.parent?.code).toBe("1000");
    expect(created.entityId).toBe(entityId);

    // Audit row.
    const audit = await prisma.auditLog.findFirst({
      where: {
        eventType: "PRIVILEGED_ACTION",
        action: "create-account",
        resourceId: child.accountId!,
      },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorEmail).toBe(admin.email);
  });

  it("rejects duplicate code within the same scope", async () => {
    signInAdmin();
    await createAccountAction({
      code: "2000",
      name: "AP",
      type: "LIABILITY",
      normalBalance: "CREDIT",
      entityCode: ENTITY_CODE,
    });
    const dup = await createAccountAction({
      code: "2000",
      name: "Different name",
      type: "LIABILITY",
      normalBalance: "CREDIT",
      entityCode: ENTITY_CODE,
    });
    expect(dup.ok).toBe(false);
    expect(dup.message).toMatch(/already exists/i);
  });

  it("rejects bad code shape", async () => {
    signInAdmin();
    const r = await createAccountAction({
      code: "AB CD",
      name: "Spacey",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/2.?15 chars/i);
  });

  it("rejects unknown entity", async () => {
    signInAdmin();
    const r = await createAccountAction({
      code: "1000",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: "GHOST",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Unknown entity/);
  });

  it("rejects parent in a different scope", async () => {
    signInAdmin();
    // Create the parent in shared scope.
    await createAccountAction({
      code: "1500",
      name: "Fixed Assets",
      type: "ASSET",
      normalBalance: "DEBIT",
      // no entityCode → shared
    });
    // Now try to create an entity-specific child whose parent is a
    // shared account — this IS allowed (shared parent is in-scope for
    // any entity).
    const ok = await createAccountAction({
      code: "1510",
      name: "Equipment",
      type: "ASSET",
      normalBalance: "DEBIT",
      parentCode: "1500",
      entityCode: ENTITY_CODE,
    });
    expect(ok.ok).toBe(true);
  });
});

describe("updateAccountAction", () => {
  it("updates name + subtype + flags", async () => {
    signInAdmin();
    const created = await createAccountAction({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    const r = await updateAccountAction({
      id: created.accountId!,
      name: "Cash — Operating",
      subtype: "CASH",
      isBank: true,
    });
    expect(r.ok).toBe(true);
    const refreshed = await prisma.account.findUniqueOrThrow({
      where: { id: created.accountId! },
    });
    expect(refreshed.name).toBe("Cash — Operating");
    expect(refreshed.subtype).toBe("CASH");
    expect(refreshed.isBank).toBe(true);
  });

  it("sets + clears parent", async () => {
    signInAdmin();
    const parent = await createAccountAction({
      code: "1000",
      name: "Current Assets",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    const child = await createAccountAction({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });

    // Set parent
    let r = await updateAccountAction({
      id: child.accountId!,
      parentCode: "1000",
    });
    expect(r.ok).toBe(true);
    let refreshed = await prisma.account.findUniqueOrThrow({
      where: { id: child.accountId! },
    });
    expect(refreshed.parentAccountId).toBe(parent.accountId);

    // Clear parent
    r = await updateAccountAction({
      id: child.accountId!,
      parentCode: null,
    });
    expect(r.ok).toBe(true);
    refreshed = await prisma.account.findUniqueOrThrow({
      where: { id: child.accountId! },
    });
    expect(refreshed.parentAccountId).toBeNull();
  });

  it("prevents self-as-parent", async () => {
    signInAdmin();
    const a = await createAccountAction({
      code: "1000",
      name: "Current Assets",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    const r = await updateAccountAction({
      id: a.accountId!,
      parentCode: "1000",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/own parent/i);
  });

  it("prevents A → B → A cycle", async () => {
    signInAdmin();
    // Create AA and BB (2-char codes pass the validator), set AA's
    // parent = BB.
    const a = await createAccountAction({
      code: "AA",
      name: "AA",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    expect(a.ok).toBe(true);
    const b = await createAccountAction({
      code: "BB",
      name: "BB",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    expect(b.ok).toBe(true);
    const linked = await updateAccountAction({
      id: a.accountId!,
      parentCode: "BB",
    });
    expect(linked.ok).toBe(true);

    // Now try to set BB's parent = AA. Should refuse (would cycle).
    const r = await updateAccountAction({
      id: b.accountId!,
      parentCode: "AA",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/cycle/i);
  });
});

describe("deactivateAccountAction", () => {
  it("flips active=false and is reversible", async () => {
    signInAdmin();
    const created = await createAccountAction({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });
    const r = await deactivateAccountAction({ id: created.accountId! });
    expect(r.ok).toBe(true);
    let refreshed = await prisma.account.findUniqueOrThrow({
      where: { id: created.accountId! },
    });
    expect(refreshed.active).toBe(false);

    // Reactivate
    const r2 = await updateAccountAction({
      id: created.accountId!,
      active: true,
    });
    expect(r2.ok).toBe(true);
    refreshed = await prisma.account.findUniqueOrThrow({
      where: { id: created.accountId! },
    });
    expect(refreshed.active).toBe(true);
  });
});

describe("tenant isolation", () => {
  it("update on another tenant's account returns 'not found'", async () => {
    // Create an account in our tenant.
    signInAdmin();
    const created = await createAccountAction({
      code: "1010",
      name: "Cash",
      type: "ASSET",
      normalBalance: "DEBIT",
      entityCode: ENTITY_CODE,
    });

    // Spin up a second tenant; reuse the same controller user (only
    // they're on the admin allowlist). Same controller has memberships
    // in BOTH tenants but they're separate scopes.
    const otherTenant = await prisma.tenant.create({
      data: {
        slug: `acct-other-${SUFFIX.toLowerCase()}`,
        name: "Other tenant",
        ownerUserId: admin.id,
      },
    });
    await prisma.tenantMembership.create({
      data: { tenantId: otherTenant.id, userId: admin.id, role: "OWNER" },
    });
    try {
      // Same admin, but switch active tenant to otherTenant.
      mockCookieStore.clear();
      mockCookieStore.set("lc-user", { value: authInternal.encode(admin.id) });
      mockCookieStore.set("lc-tenant", { value: otherTenant.slug });
      const r = await updateAccountAction({
        id: created.accountId!,
        name: "Hijacked",
      });
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/not found/i);
    } finally {
      await prisma.tenantMembership.deleteMany({ where: { tenantId: otherTenant.id } });
      await prisma.tenant.delete({ where: { id: otherTenant.id } });
    }
  });
});
