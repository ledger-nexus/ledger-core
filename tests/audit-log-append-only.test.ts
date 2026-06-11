// SOC 2 CC5/CC7 — audit log append-only verification.
//
// Proves the Postgres RULE on `audit_log` silently no-ops UPDATE and
// DELETE attempts. An app-code path that tried to tamper would produce
// zero observable change.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

describe("audit_log — append-only DB enforcement (SOC 2 CC5/CC7)", () => {
  let testRowId: string;
  let originalAction: string;
  let tenantId: string;

  beforeAll(async () => {
    tenantId = await getDefaultTenantId(prisma);
    originalAction = `append_only_test_${Date.now()}`;
    const row = await prisma.auditLog.create({
      data: {
        tenantId,
        eventType: "PRIVILEGED_ACTION",
        action: originalAction,
        outcome: "SUCCESS",
        metadata: { note: "append-only verification fixture" },
      },
    });
    testRowId = row.id;
  });

  afterAll(async () => {
    // We can't delete the fixture row — that's the whole test. It
    // accumulates in the dev DB. Harmless (action prefix makes it
    // identifiable for hand cleanup if ever needed).
    await prisma.$disconnect();
  });

  it("UPDATE on audit_log silently no-ops (returns 0 affected rows)", async () => {
    // updateMany returns the count of mutated rows. With the RULE in
    // place this should be 0 — the rule converts the UPDATE into NOTHING.
    const result = await prisma.auditLog.updateMany({
      where: { id: testRowId },
      data: { action: "tampered" },
    });
    expect(result.count).toBe(0);

    // Verify the row's action field is unchanged.
    const row = await prisma.auditLog.findUnique({ where: { id: testRowId } });
    expect(row?.action).toBe(originalAction);
  });

  it("DELETE on audit_log silently no-ops (returns 0 affected rows)", async () => {
    const result = await prisma.auditLog.deleteMany({
      where: { id: testRowId },
    });
    expect(result.count).toBe(0);

    // Verify the row is still there.
    const row = await prisma.auditLog.findUnique({ where: { id: testRowId } });
    expect(row).not.toBeNull();
    expect(row?.id).toBe(testRowId);
  });

  it("INSERT remains unrestricted (auditPrivilegedAction can still write)", async () => {
    const action = `append_only_insert_${Date.now()}`;
    const row = await prisma.auditLog.create({
      data: {
        tenantId,
        eventType: "PRIVILEGED_ACTION",
        action,
        outcome: "SUCCESS",
      },
    });
    expect(row.id).toBeTruthy();
    expect(row.action).toBe(action);
  });
});
