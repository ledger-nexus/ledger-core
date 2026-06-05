// RLS Phase 2b reference test — pins markNotificationsReadAction's
// migrated behavior.
//
// The action was migrated 2026-06-05 from raw-prisma to
// withTenantContext as the canonical Group A reference (smallest
// production Server Action with real DB work via a helper).
//
// Verifies:
//   1. The action still successfully marks notifications as seen
//      (functional behavior preserved across the migration)
//   2. The GUC `app.current_tenant_id` is set during the action's
//      DB work (proves the withTenantContext wrapper is wired —
//      the load-bearing assertion for Phase 3's FORCE to work)
//
// Does NOT yet test cross-tenant denial (FORCED RLS arrives in
// Phase 3). What this test pins is the plumbing — once Phase 3
// runs, the cross-tenant denial test added there will rely on
// this plumbing being correctly wired.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { markRead } from "../src/lib/notifications";
import { withTenantContext, getCurrentTenantGuc } from "../src/lib/db/tenant-context";

const prisma = new PrismaClient();
const SUFFIX = "rlsmr" + Date.now().toString(36);

let TEST_TENANT_ID: string;
let TEST_USER_ID: string;

async function cleanup() {
  if (!TEST_TENANT_ID) return;
  await prisma.notification.deleteMany({
    where: { title: { startsWith: `RLS-MR-${SUFFIX}` } },
  });
}

beforeAll(async () => {
  // Resolve the default seeded tenant + a real user; FK constraints
  // require real rows.
  const tenant = await prisma.tenant.findUniqueOrThrow({
    where: { slug: "default" },
    select: { id: true },
  });
  TEST_TENANT_ID = tenant.id;

  // Find any user that has a membership in the default tenant.
  const membership = await prisma.tenantMembership.findFirst({
    where: { tenantId: TEST_TENANT_ID },
    select: { userId: true },
  });
  if (!membership) throw new Error("No user in default tenant; seed first.");
  TEST_USER_ID = membership.userId;

  await cleanup();
});

afterAll(async () => {
  await cleanup();
  await prisma.$disconnect();
});

describe("RLS Phase 2b — markRead works inside withTenantContext", () => {
  it("markRead invoked with tx client successfully marks notifications", async () => {
    // Seed an unread notification for the test user.
    const notif = await prisma.notification.create({
      data: {
        tenantId: TEST_TENANT_ID,
        recipientUserId: TEST_USER_ID,
        category: "SYSTEM",
        title: `RLS-MR-${SUFFIX} unread`,
        body: "test body",
        seenAt: null,
      },
    });

    // Mark it inside a withTenantContext transaction.
    const { markedCount } = await withTenantContext(TEST_TENANT_ID, async (tx) => {
      return markRead(tx, TEST_USER_ID, [notif.id]);
    });

    expect(markedCount).toBe(1);

    // Verify the seenAt was actually set in the DB.
    const after = await prisma.notification.findUniqueOrThrow({
      where: { id: notif.id },
    });
    expect(after.seenAt).not.toBeNull();
  });

  it("getCurrentTenantGuc returns the tenantId inside the transaction (proves plumbing)", async () => {
    let observedGuc: string | null = null;
    await withTenantContext(TEST_TENANT_ID, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      return null;
    });
    expect(observedGuc).toBe(TEST_TENANT_ID);
  });

  it("markRead with empty notificationIds array is a no-op (regression check)", async () => {
    const { markedCount } = await withTenantContext(TEST_TENANT_ID, async (tx) => {
      return markRead(tx, TEST_USER_ID, []);
    });
    // Empty array → updateMany with id IN () → 0 rows affected.
    expect(markedCount).toBe(0);
  });

  it("markRead with null notificationIds marks ALL the user's unread notifications", async () => {
    // Seed 2 unread + 1 already-read; null should mark only the 2 unread.
    await prisma.notification.create({
      data: {
        tenantId: TEST_TENANT_ID,
        recipientUserId: TEST_USER_ID,
        category: "SYSTEM",
        title: `RLS-MR-${SUFFIX} bulk-1`,
        body: "",
        seenAt: null,
      },
    });
    await prisma.notification.create({
      data: {
        tenantId: TEST_TENANT_ID,
        recipientUserId: TEST_USER_ID,
        category: "SYSTEM",
        title: `RLS-MR-${SUFFIX} bulk-2`,
        body: "",
        seenAt: null,
      },
    });
    await prisma.notification.create({
      data: {
        tenantId: TEST_TENANT_ID,
        recipientUserId: TEST_USER_ID,
        category: "SYSTEM",
        title: `RLS-MR-${SUFFIX} bulk-already-read`,
        body: "",
        seenAt: new Date(),
      },
    });

    const { markedCount } = await withTenantContext(TEST_TENANT_ID, async (tx) => {
      return markRead(tx, TEST_USER_ID, null);
    });

    // 2 unread should be marked; the already-read one stays.
    // (>=2 because earlier tests in this file may have seeded more.)
    expect(markedCount).toBeGreaterThanOrEqual(2);
  });
});
