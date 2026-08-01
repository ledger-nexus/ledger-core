// Retention engine (#12 harvest). Runs against a real Postgres.
//
// This is the only scheduled job in the codebase that HARD-DELETES
// customer rows, so the tests are written around one question: does it
// delete exactly what the policy says and nothing else?
//
// Every policy gets a triple:
//   - a row just OLDER than the cutoff  → must be deleted
//   - a row just NEWER than the cutoff  → must survive
//   - a row in a state the policy doesn't target → must survive
//
// The clock is injected, so cutoffs are exact rather than relative to
// whenever CI happens to run.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runRetentionPurge } from "@/lib/retention/purge";
import { RETENTION_POLICIES } from "@/lib/retention/policies";
import { prisma as appPrisma } from "@/lib/db";
import { withAuditLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const SUFFIX = "ret" + Date.now().toString(36) + Math.floor(Math.random() * 9999);
const MARKER = "RET Retention Fixture";

/** Fixed clock. All fixtures are positioned relative to this. */
const NOW = new Date("2026-08-01T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY);

let tenantId: string;
let userId: string;
let inviterId: string;

/** Ids we expect gone / kept, filled during seeding. */
const expect_deleted: Record<string, string[]> = {};
const expect_kept: Record<string, string[]> = {};

async function scrub() {
  const staleTenants = await prisma.tenant.findMany({
    where: { slug: { startsWith: "ret-" } },
    select: { id: true },
  });
  const staleUsers = await prisma.user.findMany({
    where: { displayName: { startsWith: MARKER } },
    select: { id: true },
  });
  const tIds = staleTenants.map((t) => t.id);
  const uIds = staleUsers.map((u) => u.id);
  if (tIds.length) {
    await prisma.notification.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.tenantInvite.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.emailDelivery.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.tenantMembership.deleteMany({ where: { tenantId: { in: tIds } } });
    await prisma.tenant.deleteMany({ where: { id: { in: tIds } } });
  }
  if (uIds.length) {
    await prisma.notification.deleteMany({
      where: { recipientUserId: { in: uIds } },
    });
    // app_user hard-deletes need the audit-log mutable window. The
    // append-only RULE on audit_log rewrites queries, and Postgres'
    // referential-integrity check for audit_log.actorUserId then comes
    // back "unexpected result" — surfacing as an XX000, not an FK
    // error. Documented in CLAUDE.md; costs an hour if you meet it cold.
    await withAuditLogMutable(prisma, async () => {
      await prisma.auditLog.deleteMany({ where: { actorUserId: { in: uIds } } });
      await prisma.user.deleteMany({ where: { id: { in: uIds } } });
    });
  }
}

beforeAll(async () => {
  // Self-healing: a killed run skips afterAll and leaves residue that
  // would make the "kept" assertions below count strangers' rows.
  await scrub();

  const mk = (label: string) =>
    appPrisma.user.create({
      data: {
        email: `ret-${label}-${SUFFIX}@example.test`,
        displayName: `${MARKER} ${label}`,
      },
      select: { id: true },
    });
  userId = (await mk("recipient")).id;
  inviterId = (await mk("inviter")).id;

  const tenant = await prisma.tenant.create({
    data: { slug: `ret-${SUFFIX}`, name: "RET Co", ownerUserId: inviterId },
    select: { id: true },
  });
  tenantId = tenant.id;

  // ─── notification.seen (365d) ──────────────────────────────────────
  const seenOld = await prisma.notification.create({
    data: {
      tenantId, recipientUserId: userId, category: "SYSTEM",
      title: "seen, 400d ago", seenAt: ago(400), createdAt: ago(420),
    },
    select: { id: true },
  });
  const seenRecent = await prisma.notification.create({
    data: {
      tenantId, recipientUserId: userId, category: "SYSTEM",
      title: "seen, 300d ago", seenAt: ago(300), createdAt: ago(320),
    },
    select: { id: true },
  });

  // ─── notification.unseen_stale (730d) ──────────────────────────────
  const unseenAncient = await prisma.notification.create({
    data: {
      tenantId, recipientUserId: userId, category: "SYSTEM",
      title: "unseen, 800d old", seenAt: null, createdAt: ago(800),
    },
    select: { id: true },
  });
  // The row that proves the two notification policies don't overlap:
  // unseen and 400 days old. Older than the SEEN cutoff (365) but the
  // seen policy must not touch it, and the unseen policy's window is
  // 730, so it survives both.
  const unseenMiddle = await prisma.notification.create({
    data: {
      tenantId, recipientUserId: userId, category: "SYSTEM",
      title: "unseen, 400d old", seenAt: null, createdAt: ago(400),
    },
    select: { id: true },
  });

  expect_deleted.notification = [seenOld.id, unseenAncient.id];
  expect_kept.notification = [seenRecent.id, unseenMiddle.id];

  // ─── tenant_invite.terminal (30d) ──────────────────────────────────
  const inv = (
    data: Record<string, unknown>
  ) =>
    appPrisma.tenantInvite.create({
      data: {
        tenantId,
        email: `ret-inv-${Math.random().toString(36).slice(2)}@example.test`,
        role: "MEMBER",
        token: `tok-${Math.random().toString(36).slice(2)}${Date.now()}`,
        invitedById: inviterId,
        expiresAt: ago(-14),
        ...data,
      },
      select: { id: true },
    });

  const acceptedOld = await inv({ status: "ACCEPTED", acceptedAt: ago(45) });
  const revokedOld = await inv({ status: "REVOKED", revokedAt: ago(45) });
  const expiredOld = await inv({ status: "PENDING", expiresAt: ago(45) });
  const acceptedRecent = await inv({ status: "ACCEPTED", acceptedAt: ago(10) });
  // Still live: pending with a future expiry. The whole point of the
  // policy is that it must never delete a usable invite.
  const pendingLive = await inv({ status: "PENDING", expiresAt: ago(-7) });

  expect_deleted.tenantInvite = [acceptedOld.id, revokedOld.id, expiredOld.id];
  expect_kept.tenantInvite = [acceptedRecent.id, pendingLive.id];

  // ─── email_delivery.transient (90d) ────────────────────────────────
  const mkMail = (sentAt: Date) =>
    appPrisma.emailDelivery.create({
      data: {
        tenantId,
        toEmail: `ret-mail-${Math.random().toString(36).slice(2)}@example.test`,
        template: "test_fixture",
        subject: "fixture",
        status: "LOGGED_ONLY",
        sentAt,
      },
      select: { id: true },
    });
  const mailOld = await mkMail(ago(120));
  const mailRecent = await mkMail(ago(60));

  expect_deleted.emailDelivery = [mailOld.id];
  expect_kept.emailDelivery = [mailRecent.id];
});

afterAll(async () => {
  await scrub();
  await prisma.$disconnect();
  await appPrisma.$disconnect();
});

describe("policy catalog", () => {
  it("every policy id is unique and stable-looking", () => {
    const ids = RETENTION_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // ids land in audit rows; a rename breaks evidence continuity.
    for (const id of ids) expect(id).toMatch(/^[a-z_]+\.[a-z_]+$/);
  });

  it("no policy targets audit_log, journal entries, or users", () => {
    // Each of these is either legally required to persist or removed
    // through a deliberate, audited path — never on a timer.
    const ids = RETENTION_POLICIES.map((p) => p.id).join(" ");
    expect(ids).not.toMatch(/audit|journal|user|period/);
  });

  it("every retention window is positive", () => {
    for (const p of RETENTION_POLICIES) {
      expect(p.retentionDays, p.id).toBeGreaterThan(0);
    }
  });
});

describe("runRetentionPurge", () => {
  it("deletes exactly the rows past their window, and nothing else", async () => {
    const summary = await runRetentionPurge(prisma, NOW);

    expect(summary.totalErrors).toBe(0);
    expect(summary.results).toHaveLength(RETENTION_POLICIES.length);

    // Deleted.
    for (const id of expect_deleted.notification) {
      expect(
        await prisma.notification.findUnique({ where: { id } }),
        `notification ${id} should have been purged`
      ).toBeNull();
    }
    for (const id of expect_deleted.tenantInvite) {
      expect(
        await prisma.tenantInvite.findUnique({ where: { id } }),
        `invite ${id} should have been purged`
      ).toBeNull();
    }
    for (const id of expect_deleted.emailDelivery) {
      expect(
        await prisma.emailDelivery.findUnique({ where: { id } }),
        `delivery ${id} should have been purged`
      ).toBeNull();
    }

    // Survived. These matter more than the deletions — an over-broad
    // cutoff destroys data nobody asked it to.
    for (const id of expect_kept.notification) {
      expect(
        await prisma.notification.findUnique({ where: { id } }),
        `notification ${id} was inside its window and must survive`
      ).not.toBeNull();
    }
    for (const id of expect_kept.tenantInvite) {
      expect(
        await prisma.tenantInvite.findUnique({ where: { id } }),
        `invite ${id} was inside its window and must survive`
      ).not.toBeNull();
    }
    for (const id of expect_kept.emailDelivery) {
      expect(
        await prisma.emailDelivery.findUnique({ where: { id } }),
        `delivery ${id} was inside its window and must survive`
      ).not.toBeNull();
    }
  });

  it("is idempotent — a second run deletes nothing", async () => {
    // The cron can fire twice if a deploy interleaves with a Vercel
    // re-trigger. The second run must be a no-op, not a wider sweep.
    const again = await runRetentionPurge(prisma, NOW);
    expect(again.totalErrors).toBe(0);
    const touched = again.results.filter((r) => r.rowsDeleted > 0);
    expect(
      touched.map((r) => `${r.policyId}=${r.rowsDeleted}`),
      "second run should find nothing left in the fixture window"
    ).toEqual([]);
  });

  it("one failing policy does not stop the others", async () => {
    // A schema change that breaks one purge must not silently stop the
    // rest — that failure compounds daily and is invisible.
    const exploding = new Proxy(prisma, {
      get(target, prop: string) {
        if (prop === "notification") {
          return {
            deleteMany: () => Promise.reject(new Error("simulated DB failure")),
          };
        }
        return (target as never)[prop];
      },
    }) as unknown as PrismaClient;

    const summary = await runRetentionPurge(exploding, NOW);
    const failed = summary.results.filter((r) => r.error != null);
    const ran = summary.results.filter((r) => r.error == null);

    expect(failed.length).toBeGreaterThan(0);
    expect(ran.length).toBeGreaterThan(0);
    expect(summary.totalErrors).toBe(failed.length);
    // Sanitized: the raw DB message must not reach the audit row.
    for (const f of failed) {
      expect(f.error).not.toContain("simulated DB failure");
      expect(f.error).toMatch(/see server logs/);
    }
  });

  it("reports the clock it ran against", async () => {
    const summary = await runRetentionPurge(prisma, NOW);
    expect(summary.ranAt).toEqual(NOW);
  });
});
