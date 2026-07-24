// Team management (#46 harvest slice ③): invites + roles + VIEWER.
//
// What's pinned here:
//   - VIEWER floors: read-only role passes canViewReports, refused by
//     every mutation floor
//   - inviteMemberAction: MEMBER caller refused (authz-failure path);
//     duplicate-PENDING refusal works against the ENCRYPTED email
//     column (equality rewritten onto emailHash — the check would
//     silently pass if the rewrite broke); existing members can't be
//     re-invited; OWNER isn't invitable; the invite email lands as an
//     EmailDelivery row (LOGGED_ONLY — no key in tests)
//   - acceptInvite state machine: hijack refusal (email mismatch),
//     happy path (membership at the stored role + audit row), re-follow
//     idempotency, revoked, lazy expiry flip
//   - role changes / removal: OWNER protections + the ADMIN-vs-ADMIN
//     escalation-war safeguard; per-tenant removal deletes ONLY the
//     membership, never the global User row

import {
  describe,
  it,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  vi,
} from "vitest";
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
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import {
  canPostJournalEntries,
  canViewReports,
  canClosePeriods,
  canManageMemberships,
} from "@/lib/auth/policy";
import {
  inviteMemberAction,
  revokeInviteAction,
  changeMemberRoleAction,
  removeMemberAction,
} from "@/app/actions/team";
import { acceptInvite } from "@/lib/team/accept-invite";
import { _internal as authInternal } from "@/lib/auth/current-user";
import { prisma as appPrisma } from "@/lib/db";

const prisma = new PrismaClient();
const SUFFIX = "azt" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const USER_MARKER = "AZT Team Fixture";

let tenantA: { id: string; slug: string };
let owner: { id: string; email: string };
let admin: { id: string; email: string };
let member: { id: string; email: string };
/** Exists globally, NO membership anywhere — the invited person. */
let invitee: { id: string; email: string };

function signInAs(userId: string) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(userId) });
  mockCookieStore.set("lc-tenant", { value: tenantA.slug });
}

async function scrubStale() {
  const staleTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "azt" } },
    select: { id: true },
  });
  const tIds = staleTenants.map((t) => t.id);
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: USER_MARKER } },
    select: { id: true },
  });
  const uIds = staleUsers.map((u) => u.id);
  if (tIds.length > 0) {
    await prisma.emailDelivery.deleteMany({ where: { tenantId: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { tenantId: { in: tIds } } });
    });
    // tenant delete cascades invites + memberships
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
  }
  if (uIds.length > 0) {
    await prisma.tenantInvite.deleteMany({
      where: { invitedById: { in: uIds } },
    });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: uIds } } });
      await prisma.user.deleteMany({ where: { id: { in: uIds } } });
    });
  }
}

beforeAll(async () => {
  await scrubStale();

  // Users are created through the APP client, not the raw one. The
  // extension computes emailHash on write; a raw-client user would carry
  // a NULL hash, and if a prior suite in this worker process left
  // FIELD_DETERMINISTIC_KEY set (encrypted-fields-extension.test.ts sets
  // process.env directly), the rewritten equality filter in the
  // already-a-member check would match nothing — the documented
  // raw-client rollout gap, reproduced in a fixture.
  const mk = async (label: string) => {
    const created = await appPrisma.user.create({
      data: {
        email: `azt-${label}-${SUFFIX}@example.test`,
        displayName: `${USER_MARKER} ${label}`,
      },
      select: { id: true, email: true },
    });
    return created;
  };
  owner = await mk("owner");
  admin = await mk("admin");
  member = await mk("member");
  invitee = await mk("invitee");

  tenantA = await prisma.tenant.create({
    data: { slug: `azt-a-${SUFFIX}`, name: "AZT A", ownerUserId: owner.id },
    select: { id: true, slug: true },
  });
  await prisma.tenantMembership.createMany({
    data: [
      { tenantId: tenantA.id, userId: owner.id, role: "OWNER" },
      { tenantId: tenantA.id, userId: admin.id, role: "ADMIN" },
      { tenantId: tenantA.id, userId: member.id, role: "MEMBER" },
    ],
  });
});

beforeEach(() => {
  // No provider key → every invite email takes the LOGGED_ONLY path.
  vi.stubEnv("RESEND_API_KEY", "");
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterAll(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  if (tenantA) {
    const tIds = [tenantA.id];
    const uIds = [owner.id, admin.id, member.id, invitee.id];
    await prisma.emailDelivery.deleteMany({ where: { tenantId: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({
        where: {
          OR: [{ tenantId: { in: tIds } }, { actorUserId: { in: uIds } }],
        },
      });
    });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.user.deleteMany({ where: { id: { in: uIds } } });
    });
  }
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

// ─── VIEWER floors ───────────────────────────────────────────────────────

describe("VIEWER role floors", () => {
  it("reads pass, every mutation floor refuses", () => {
    expect(canViewReports("VIEWER")).toBe(true);
    expect(canPostJournalEntries("VIEWER")).toBe(false);
    expect(canClosePeriods("VIEWER")).toBe(false);
    expect(canManageMemberships("VIEWER")).toBe(false);
  });
});

// ─── inviteMemberAction ──────────────────────────────────────────────────

describe("inviteMemberAction", () => {
  it("refuses a MEMBER caller (authz-failure path)", async () => {
    signInAs(member.id);
    const r = await inviteMemberAction({
      email: "nobody@example.test",
      role: "MEMBER",
    });
    expect(r.ok).toBe(false);
  });

  it("refuses the OWNER role", async () => {
    signInAs(admin.id);
    const r = await inviteMemberAction({
      email: "nobody@example.test",
      role: "OWNER",
    });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("reserved");
  });

  it("creates a PENDING invite, fires the LOGGED_ONLY email, refuses a duplicate", async () => {
    signInAs(admin.id);
    const r = await inviteMemberAction({ email: invitee.email, role: "MEMBER" });
    expect(r.ok).toBe(true);
    expect(r.emailStatus).toBe("LOGGED_ONLY");
    expect(r.acceptUrl).toContain("/invites/accept?token=");

    // Row exists and reads back the plaintext through the app client.
    const row = await appPrisma.tenantInvite.findUnique({
      where: { id: r.inviteId! },
    });
    expect(row?.status).toBe("PENDING");
    expect(row?.email).toBe(invitee.email.toLowerCase());
    expect(row?.tenantId).toBe(tenantA.id);

    // The invite email persisted as an EmailDelivery row.
    const delivery = await appPrisma.emailDelivery.findFirst({
      where: { tenantId: tenantA.id, template: "tenant_invite" },
      orderBy: { sentAt: "desc" },
    });
    expect(delivery?.status).toBe("LOGGED_ONLY");
    expect(delivery?.toEmail).toBe(invitee.email.toLowerCase());

    // Duplicate while PENDING — this equality filter runs against the
    // ENCRYPTED email column via the emailHash rewrite. If the rewrite
    // broke, the filter would match nothing and this would wrongly
    // succeed.
    const dup = await inviteMemberAction({
      email: invitee.email.toUpperCase(),
      role: "VIEWER",
    });
    expect(dup.ok).toBe(false);
    expect(dup.message).toContain("pending invite");
  });

  it("refuses inviting an existing member", async () => {
    signInAs(admin.id);
    const r = await inviteMemberAction({ email: member.email, role: "VIEWER" });
    expect(r.ok).toBe(false);
    expect(r.message).toContain("already a member");
  });
});

// ─── acceptInvite ────────────────────────────────────────────────────────

describe("acceptInvite", () => {
  it("refuses the wrong signed-in user (hijack protection)", async () => {
    const invite = await appPrisma.tenantInvite.findFirst({
      where: { tenantId: tenantA.id, status: "PENDING" },
      select: { token: true },
    });
    const outcome = await acceptInvite(invite!.token, {
      id: member.id,
      email: member.email,
      displayName: "wrong person",
    });
    expect(outcome.kind).toBe("email-mismatch");
  });

  it("accepts for the invited user: membership at stored role + audit row", async () => {
    const invite = await appPrisma.tenantInvite.findFirst({
      where: { tenantId: tenantA.id, status: "PENDING" },
      select: { token: true, id: true, role: true },
    });
    const outcome = await acceptInvite(invite!.token, {
      id: invitee.id,
      email: invitee.email,
      displayName: "invitee",
    });
    expect(outcome.kind).toBe("accepted");

    const membership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenantA.id, userId: invitee.id },
      select: { role: true },
    });
    expect(membership?.role).toBe(invite!.role);

    const flipped = await appPrisma.tenantInvite.findUnique({
      where: { id: invite!.id },
      select: { status: true, acceptedAt: true },
    });
    expect(flipped?.status).toBe("ACCEPTED");
    expect(flipped?.acceptedAt).not.toBeNull();

    const audit = await prisma.auditLog.findFirst({
      where: {
        action: "team.accept_invite",
        resourceId: invite!.id,
        actorUserId: invitee.id,
      },
    });
    expect(audit).not.toBeNull();

    // Re-follow by the same user → already-member, not an error.
    const again = await acceptInvite(invite!.token, {
      id: invitee.id,
      email: invitee.email,
      displayName: "invitee",
    });
    expect(again.kind).toBe("already-member");
  });

  it("refuses a revoked invite", async () => {
    signInAs(admin.id);
    const created = await inviteMemberAction({
      email: `azt-rev-${SUFFIX}@example.test`,
      role: "MEMBER",
    });
    expect(created.ok).toBe(true);
    const revoked = await revokeInviteAction({ inviteId: created.inviteId! });
    expect(revoked.ok).toBe(true);

    const row = await appPrisma.tenantInvite.findUnique({
      where: { id: created.inviteId! },
      select: { token: true },
    });
    const outcome = await acceptInvite(row!.token, {
      id: invitee.id,
      email: `azt-rev-${SUFFIX}@example.test`,
      displayName: "x",
    });
    expect(outcome.kind).toBe("revoked");
  });

  it("lazy-flips an expired invite to EXPIRED", async () => {
    signInAs(admin.id);
    const created = await inviteMemberAction({
      email: `azt-exp-${SUFFIX}@example.test`,
      role: "MEMBER",
    });
    expect(created.ok).toBe(true);
    await appPrisma.tenantInvite.update({
      where: { id: created.inviteId! },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    const row = await appPrisma.tenantInvite.findUnique({
      where: { id: created.inviteId! },
      select: { token: true },
    });
    const outcome = await acceptInvite(row!.token, {
      id: invitee.id,
      email: `azt-exp-${SUFFIX}@example.test`,
      displayName: "x",
    });
    expect(outcome.kind).toBe("expired");
    const after = await appPrisma.tenantInvite.findUnique({
      where: { id: created.inviteId! },
      select: { status: true },
    });
    expect(after?.status).toBe("EXPIRED");
  });
});

// ─── role changes + removal ──────────────────────────────────────────────

describe("changeMemberRoleAction / removeMemberAction", () => {
  it("OWNER cannot be demoted; nobody can be promoted to OWNER", async () => {
    signInAs(admin.id);
    const ownerMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenantA.id, userId: owner.id },
      select: { id: true },
    });
    const demote = await changeMemberRoleAction({
      membershipId: ownerMembership!.id,
      role: "MEMBER",
    });
    expect(demote.ok).toBe(false);

    const memberMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenantA.id, userId: member.id },
      select: { id: true },
    });
    const promote = await changeMemberRoleAction({
      membershipId: memberMembership!.id,
      role: "OWNER",
    });
    expect(promote.ok).toBe(false);
  });

  it("an ADMIN cannot change or remove another ADMIN — only the OWNER can", async () => {
    // Second admin to be the target (app client — see mk() note).
    const admin2 = await appPrisma.user.create({
      data: {
        email: `azt-admin2-${SUFFIX}@example.test`,
        displayName: `${USER_MARKER} admin2`,
      },
      select: { id: true },
    });
    const m2 = await prisma.tenantMembership.create({
      data: { tenantId: tenantA.id, userId: admin2.id, role: "ADMIN" },
      select: { id: true },
    });

    signInAs(admin.id);
    const asAdmin = await changeMemberRoleAction({
      membershipId: m2.id,
      role: "MEMBER",
    });
    expect(asAdmin.ok).toBe(false);
    expect(asAdmin.message).toContain("OWNER");

    signInAs(owner.id);
    const asOwner = await changeMemberRoleAction({
      membershipId: m2.id,
      role: "VIEWER",
    });
    expect(asOwner.ok).toBe(true);
    const after = await prisma.tenantMembership.findUnique({
      where: { id: m2.id },
      select: { role: true },
    });
    expect(after?.role).toBe("VIEWER");

    // Cleanup the extra fixture (membership row + user).
    await prisma.tenantMembership.delete({ where: { id: m2.id } });
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: admin2.id } });
      await prisma.user.delete({ where: { id: admin2.id } });
    });
  });

  it("self-removal refused; removal deletes the membership, not the user", async () => {
    signInAs(admin.id);
    const own = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenantA.id, userId: admin.id },
      select: { id: true },
    });
    const self = await removeMemberAction({ membershipId: own!.id });
    expect(self.ok).toBe(false);

    // Remove the invitee (joined during the accept test).
    const inviteeMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenantA.id, userId: invitee.id },
      select: { id: true },
    });
    const removed = await removeMemberAction({
      membershipId: inviteeMembership!.id,
    });
    expect(removed.ok).toBe(true);

    const goneMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenantA.id, userId: invitee.id },
    });
    expect(goneMembership).toBeNull();
    // Global User row untouched — per-tenant removal only.
    const stillExists = await prisma.user.findUnique({
      where: { id: invitee.id },
      select: { isActive: true },
    });
    expect(stillExists?.isActive).toBe(true);
  });
});
