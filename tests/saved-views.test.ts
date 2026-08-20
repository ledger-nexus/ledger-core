// Saved views — storage, scoping, and the round trip back through the URL.
//
// The interesting properties are not "does it save". They are:
//   * a view belongs to a tenant AND an owner, and neither is decorative
//   * re-saving a name REPLACES rather than duplicating
//   * a stored query string round-trips through the surface's own spec, so a
//     view means the same thing tomorrow as it did when it was saved
//   * a view whose parameters no longer exist DEGRADES, it does not throw
//
// The last one is why `query` is a string rather than a JSON config: the
// surface's spec is what reads it back, and `parseUrlState` never throws.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";
import {
  buildUrl,
  defaultsOf,
  int,
  isoDate,
  parseUrlState,
  str,
  type SurfaceSpec,
} from "@/lib/url-state";

const prisma = new PrismaClient();

const PREFIX = "svw";
const SUFFIX = PREFIX + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: string;
let tenantB: string;
let userA: string;
let userB: string;

/** The journal-entries spec, mirrored — see the drift note in the last test. */
const SPEC = {
  from: isoDate("2026-01-01"),
  to: isoDate("2026-12-31"),
  q: str(""),
  page: int(1, { min: 1 }),
} satisfies SurfaceSpec;

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

  // ⚠️ THE USER DELETE ITSELF GOES INSIDE THE MUTABLE WINDOW — not just the
  // audit rows. `audit_log` is append-only via a DB RULE, and the rule rewrites
  // the referential-integrity check Postgres runs for
  // `audit_log_actorUserId_fkey`, so deleting an app_user fails with:
  //
  //   referential integrity query on "app_user" from constraint
  //   "audit_log_actorUserId_fkey" gave unexpected result
  //   HINT: This is most likely due to a rule having rewritten the query.
  //
  // It fails whether or not the user has any audit rows, so "clear the audit
  // rows first" does not help. CLAUDE.md says this outright ("app_user
  // hard-deletes need the same window"); the first version of this function
  // put only the auditLog delete in the window and leaked 2 users — MEASURED,
  // after the suite reported 7 passed. Reading the rule is not the same as
  // applying it.
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
  // Self-healing per CLAUDE.md — a killed run leaves tenants behind, and a
  // leaked one here would sit inside the very scope these tests assert on.
  await scrubOrphans();

  const mkUser = async (tag: string) =>
    (
      await prisma.user.create({
        data: { email: `${PREFIX}-${tag}-${SUFFIX}@example.test`, displayName: `SV ${tag}`, isActive: true },
        select: { id: true },
      })
    ).id;
  userA = await mkUser("a");
  userB = await mkUser("b");

  const mkTenant = async (tag: string, owner: string) =>
    (
      await prisma.tenant.create({
        data: { slug: `${PREFIX}-${tag}-${SUFFIX}`, name: `SV ${tag}`, ownerUserId: owner },
        select: { id: true },
      })
    ).id;
  tenantA = await mkTenant("a", userA);
  tenantB = await mkTenant("b", userB);
});

afterAll(async () => {
  await scrubOrphans();
  await prisma.$disconnect();
});

describe("SavedView storage", () => {
  it("re-saving a name replaces the view rather than duplicating it", async () => {
    const key = {
      tenantId_surface_ownerId_name: {
        tenantId: tenantA,
        surface: "journal-entries",
        ownerId: userA,
        name: "Q2 review",
      },
    };
    await prisma.savedView.upsert({
      where: key,
      create: { tenantId: tenantA, surface: "journal-entries", ownerId: userA, name: "Q2 review", query: "from=2026-04-01" },
      update: { query: "from=2026-04-01" },
    });
    await prisma.savedView.upsert({
      where: key,
      create: { tenantId: tenantA, surface: "journal-entries", ownerId: userA, name: "Q2 review", query: "from=2026-04-01&to=2026-06-30" },
      update: { query: "from=2026-04-01&to=2026-06-30" },
    });

    const rows = await prisma.savedView.findMany({
      where: { tenantId: tenantA, ownerId: userA, name: "Q2 review" },
      select: { query: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].query).toBe("from=2026-04-01&to=2026-06-30");
  });

  it("the same view name may exist for two different owners", async () => {
    // Scoped per owner so two people can each keep a view called "Mine" —
    // a tenant-wide unique name would make the second person rename theirs.
    await prisma.savedView.create({
      data: { tenantId: tenantA, surface: "journal-entries", ownerId: userA, name: "Mine", query: "q=a" },
    });
    await prisma.savedView.create({
      data: { tenantId: tenantA, surface: "journal-entries", ownerId: userB, name: "Mine", query: "q=b" },
    });
    const rows = await prisma.savedView.findMany({
      where: { tenantId: tenantA, surface: "journal-entries", name: "Mine" },
    });
    expect(rows).toHaveLength(2);
  });

  it("the listing query returns own + shared, and nothing from another tenant", async () => {
    // Mirrors listViews()'s predicate. The tenant term is the load-bearing
    // one: without it, `OR: [{ownerId}, {shared: true}]` returns every shared
    // view on the database — the exact shape deficiency #32 was about.
    await prisma.savedView.createMany({
      data: [
        { tenantId: tenantA, surface: "journal-entries", ownerId: userA, name: "A private", query: "q=1", shared: false },
        { tenantId: tenantA, surface: "journal-entries", ownerId: userB, name: "B shared", query: "q=2", shared: true },
        { tenantId: tenantA, surface: "journal-entries", ownerId: userB, name: "B private", query: "q=3", shared: false },
        { tenantId: tenantB, surface: "journal-entries", ownerId: userB, name: "Other tenant shared", query: "q=4", shared: true },
      ],
    });

    const visible = await prisma.savedView.findMany({
      where: {
        tenantId: tenantA,
        surface: "journal-entries",
        OR: [{ ownerId: userA }, { shared: true }],
      },
      select: { name: true },
    });
    const names = visible.map((v) => v.name).sort();
    expect(names).toContain("A private");
    expect(names).toContain("B shared");
    expect(names).not.toContain("B private");
    // The one that matters: another tenant's SHARED view is still invisible.
    expect(names).not.toContain("Other tenant shared");
  });

  it("a delete scoped to tenant + owner refuses another owner's view", async () => {
    const v = await prisma.savedView.create({
      data: { tenantId: tenantA, surface: "journal-entries", ownerId: userA, name: "Only A may delete", query: "q=x" },
      select: { id: true },
    });
    // userB attempts it with the right id — the predicate must still refuse.
    const attempt = await prisma.savedView.deleteMany({
      where: { id: v.id, tenantId: tenantA, ownerId: userB },
    });
    expect(attempt.count).toBe(0);
    expect(await prisma.savedView.count({ where: { id: v.id } })).toBe(1);

    const owned = await prisma.savedView.deleteMany({
      where: { id: v.id, tenantId: tenantA, ownerId: userA },
    });
    expect(owned.count).toBe(1);
  });
});

describe("SavedView round trip through the surface spec", () => {
  it("a stored query string parses back to the state it was saved from", async () => {
    const state = { from: "2026-04-01", to: "2026-06-30", q: "vacation", page: 3 };
    // Exactly what the page stores: buildUrl's output minus the leading "?".
    const query = buildUrl("", SPEC, state).replace(/^\?/, "");

    await prisma.savedView.create({
      data: { tenantId: tenantA, surface: "journal-entries", ownerId: userA, name: "Round trip", query },
    });
    const row = await prisma.savedView.findFirstOrThrow({
      where: { tenantId: tenantA, ownerId: userA, name: "Round trip" },
      select: { query: true },
    });

    const parsed = parseUrlState(SPEC, Object.fromEntries(new URLSearchParams(row.query)));
    expect(parsed).toEqual(state);
  });

  it("a view referencing parameters that no longer exist DEGRADES, never throws", async () => {
    // The stale-view case, and the reason `query` is a string rather than a
    // JSON config with its own deserializer to keep in step. A surface that
    // drops a filter leaves old views naming it; they must fall back to the
    // surface defaults rather than 500.
    await prisma.savedView.create({
      data: {
        tenantId: tenantA,
        surface: "journal-entries",
        ownerId: userA,
        name: "Stale",
        query: "from=2026-04-01&removedFilter=whatever&page=notanumber",
      },
    });
    const row = await prisma.savedView.findFirstOrThrow({
      where: { tenantId: tenantA, ownerId: userA, name: "Stale" },
      select: { query: true },
    });

    const parsed = parseUrlState(SPEC, Object.fromEntries(new URLSearchParams(row.query)));
    expect(parsed.from).toBe("2026-04-01"); // the still-valid part survives
    expect(parsed.page).toBe(defaultsOf(SPEC).page); // garbage falls back
    expect("removedFilter" in parsed).toBe(false); // unknown key ignored
  });

  it("an empty query means the surface's default state", async () => {
    // "Save view" on an untouched surface stores "" — and loading it must
    // land on the plain route, not on `/journal-entries?`.
    const query = buildUrl("", SPEC, defaultsOf(SPEC)).replace(/^\?/, "");
    expect(query).toBe("");
    const parsed = parseUrlState(SPEC, Object.fromEntries(new URLSearchParams(query)));
    expect(parsed).toEqual(defaultsOf(SPEC));
  });
});
