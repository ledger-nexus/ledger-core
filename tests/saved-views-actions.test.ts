// The saved-view Server Actions themselves — not a mirror of their queries.
//
// ⚠️ WHY THIS FILE EXISTS SEPARATELY FROM tests/saved-views.test.ts.
//
// That suite asserts Prisma behaviour that RESEMBLES the actions: it builds the
// same `where` clauses by hand and checks the rows come out right. That is a
// real test of the data model and it is not a test of `saveViewAction`. If the
// action forgot its tenant filter, or skipped Zod, or never wrote an audit row,
// every assertion over there would still pass.
//
// So this file calls the exported actions, with the cookie store mocked the way
// `tests/accounts-actions.test.ts` established, and asserts the things only the
// action can get wrong: authorization, validation, the audit trail, and the
// upsert-not-duplicate rule.

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
import { saveViewAction, deleteViewAction, listViews } from "@/app/actions/saved-views";

const prisma = new PrismaClient();

const PREFIX = "sva";
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

/** Sign in as a user, in a tenant. Mirrors what the dev switcher writes. */
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
    await prisma.savedView.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: ids } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: ids } } });
    });
    await prisma.recordEvent.deleteMany({ where: { tenantId: { in: ids } } });
    await prisma.tenant.deleteMany({ where: { id: { in: ids } } });
  }
  // The user delete goes INSIDE the window — audit_log's append-only RULE
  // rewrites the FK integrity check and blocks it otherwise, with or without
  // audit rows. See tests/saved-views.test.ts for the full note.
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
        data: { email: `${PREFIX}-${tag}-${SUFFIX}@example.test`, displayName: `SVA ${tag}`, isActive: true },
        select: { id: true },
      })
    ).id;
  userA = await mkUser("a");
  userB = await mkUser("b");

  const mkTenant = async (tag: string, owner: string) => {
    const t = await prisma.tenant.create({
      data: { slug: `${PREFIX}-${tag}-${SUFFIX}`, name: `SVA ${tag}`, ownerUserId: owner },
      select: { id: true, slug: true },
    });
    // requireCurrentTenant resolves through membership, not ownership.
    await prisma.tenantMembership.create({
      data: { tenantId: t.id, userId: owner, role: "OWNER" },
    });
    return t;
  };
  tenantA = await mkTenant("a", userA);
  tenantB = await mkTenant("b", userB);
  // Both users are members of A so "another owner, same tenant" is testable.
  await prisma.tenantMembership.create({
    data: { tenantId: tenantA.id, userId: userB, role: "MEMBER" },
  });
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

beforeEach(async () => {
  mockCookieStore.clear();
  await prisma.savedView.deleteMany({ where: { tenantId: { in: [tenantA.id, tenantB.id] } } });
});

describe("saveViewAction", () => {
  it("saves a view for the signed-in user in their current tenant", async () => {
    signIn(userA, tenantA.slug);
    const result = await saveViewAction(
      fd({ surface: "journal-entries", name: "Q2", query: "from=2026-04-01&to=2026-06-30" })
    );
    expect(result).toEqual({ ok: true });

    const row = await prisma.savedView.findFirstOrThrow({
      where: { tenantId: tenantA.id, ownerId: userA, name: "Q2" },
      select: { query: true, shared: true, surface: true },
    });
    expect(row).toEqual({
      query: "from=2026-04-01&to=2026-06-30",
      shared: false,
      surface: "journal-entries",
    });
  });

  it("writes an audit row naming the actor, the tenant and the view", async () => {
    // Only the action can get this wrong, which is the point of this file.
    signIn(userA, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "Audited", query: "q=x" }));

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: tenantA.id, action: "saved_view.save" },
      orderBy: { occurredAt: "desc" },
      select: { actorUserId: true, resource: true, resourceId: true, tenantId: true },
    });
    expect(audit).not.toBeNull();
    expect(audit!.actorUserId).toBe(userA);
    expect(audit!.resource).toBe("SavedView");
    expect(audit!.tenantId).toBe(tenantA.id);
    expect(audit!.resourceId).toBeTruthy();
  });

  it("re-saving the same name updates rather than duplicating", async () => {
    signIn(userA, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "Same", query: "q=first" }));
    await saveViewAction(fd({ surface: "journal-entries", name: "Same", query: "q=second" }));

    const rows = await prisma.savedView.findMany({
      where: { tenantId: tenantA.id, ownerId: userA, name: "Same" },
      select: { query: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("q=second");
  });

  describe("validation", () => {
    it("rejects a query that looks like a URL", async () => {
      // ⚠️ The security-relevant one. `query` is concatenated into an href, so
      // a stored "view" carrying `//evil.example/x` would render an off-site
      // link under a name the user trusts.
      signIn(userA, tenantA.slug);
      const result = await saveViewAction(
        fd({ surface: "journal-entries", name: "Evil", query: "//evil.example/x" })
      );
      expect(result.ok).toBe(false);
      expect(await prisma.savedView.count({ where: { name: "Evil" } })).toBe(0);
    });

    it("rejects a scheme-prefixed query", async () => {
      signIn(userA, tenantA.slug);
      const result = await saveViewAction(
        fd({ surface: "journal-entries", name: "Scheme", query: "javascript:alert(1)" })
      );
      expect(result.ok).toBe(false);
      expect(await prisma.savedView.count({ where: { name: "Scheme" } })).toBe(0);
    });

    it("rejects an empty name and a non-slug surface", async () => {
      signIn(userA, tenantA.slug);
      expect((await saveViewAction(fd({ surface: "journal-entries", name: "  ", query: "q=1" }))).ok).toBe(false);
      expect((await saveViewAction(fd({ surface: "../etc", name: "N", query: "q=1" }))).ok).toBe(false);
      expect(await prisma.savedView.count({ where: { tenantId: tenantA.id } })).toBe(0);
    });
  });

  it("refuses when nobody is signed in", async () => {
    mockCookieStore.clear();
    await expect(
      saveViewAction(fd({ surface: "journal-entries", name: "Anon", query: "q=1" }))
    ).rejects.toThrow();
    expect(await prisma.savedView.count({ where: { name: "Anon" } })).toBe(0);
  });
});

describe("deleteViewAction", () => {
  it("deletes the caller's own view and audits it", async () => {
    signIn(userA, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "Mine", query: "q=1" }));
    const v = await prisma.savedView.findFirstOrThrow({
      where: { tenantId: tenantA.id, ownerId: userA, name: "Mine" },
      select: { id: true },
    });

    const result = await deleteViewAction(fd({ id: v.id }));
    expect(result).toEqual({ ok: true });
    expect(await prisma.savedView.count({ where: { id: v.id } })).toBe(0);

    const audit = await prisma.auditLog.findFirst({
      where: { tenantId: tenantA.id, action: "saved_view.delete", resourceId: v.id },
    });
    expect(audit).not.toBeNull();
  });

  it("refuses another user's view in the same tenant, and says only 'not found'", async () => {
    signIn(userA, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "A's", query: "q=1" }));
    const v = await prisma.savedView.findFirstOrThrow({
      where: { tenantId: tenantA.id, ownerId: userA, name: "A's" },
      select: { id: true },
    });

    signIn(userB, tenantA.slug);
    const result = await deleteViewAction(fd({ id: v.id }));
    expect(result.ok).toBe(false);
    // ⚠️ "not found", never "not yours" — the latter confirms the id is real.
    expect(result.ok === false && result.error).toBe("View not found");
    expect(await prisma.savedView.count({ where: { id: v.id } })).toBe(1);
  });

  it("refuses a view belonging to another tenant", async () => {
    signIn(userB, tenantB.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "B tenant", query: "q=1" }));
    const v = await prisma.savedView.findFirstOrThrow({
      where: { tenantId: tenantB.id, name: "B tenant" },
      select: { id: true },
    });

    // Same user, switched into tenant A, holding a real id from tenant B.
    signIn(userB, tenantA.slug);
    const result = await deleteViewAction(fd({ id: v.id }));
    expect(result.ok).toBe(false);
    expect(await prisma.savedView.count({ where: { id: v.id } })).toBe(1);
  });
});

describe("listViews", () => {
  it("returns own + shared within the tenant, and nothing from another", async () => {
    signIn(userA, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "A private", query: "q=1" }));
    signIn(userB, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "B shared", query: "q=2", shared: "on" }));
    await saveViewAction(fd({ surface: "journal-entries", name: "B private", query: "q=3" }));
    signIn(userB, tenantB.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "Other tenant shared", query: "q=4", shared: "on" }));

    signIn(userA, tenantA.slug);
    const names = (await listViews("journal-entries")).map((v) => v.name).sort();
    expect(names).toEqual(["A private", "B shared"]);
  });

  it("does not leak views from another surface", async () => {
    signIn(userA, tenantA.slug);
    await saveViewAction(fd({ surface: "journal-entries", name: "JE", query: "q=1" }));
    await saveViewAction(fd({ surface: "close-tasks", name: "Tasks", query: "q=2" }));

    expect((await listViews("journal-entries")).map((v) => v.name)).toEqual(["JE"]);
    expect((await listViews("close-tasks")).map((v) => v.name)).toEqual(["Tasks"]);
  });
});
