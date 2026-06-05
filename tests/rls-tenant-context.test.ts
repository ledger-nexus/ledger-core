// Integration tests for RLS Phase 2 — `withTenantContext` helper.
//
// Runs against real Postgres. Verifies:
//   1. withTenantContext sets app.current_tenant_id via set_config
//   2. The GUC is scoped to the transaction (concurrent transactions
//      see their own values)
//   3. The GUC auto-resets at COMMIT (next transaction sees NULL)
//   4. Input validation rejects empty/null/undefined tenantId
//   5. withTenantContextReadOnly is read-only (DML errors)
//   6. getCurrentTenantGuc reads back what withTenantContext set
//
// Does NOT yet test RLS enforcement — Phase 1 policies aren't FORCED.
// Phase 3 ships the cross-tenant test suite that proves enforcement.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  withTenantContextReadOnly,
  getCurrentTenantGuc,
} from "../src/lib/db/tenant-context";

const prisma = new PrismaClient();

const TENANT_A_ID = "11111111-1111-1111-1111-111111111111";
const TENANT_B_ID = "22222222-2222-2222-2222-222222222222";

beforeAll(async () => {
  // No setup needed — tests use raw queries to read the GUC, no
  // tenant rows required.
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("withTenantContext — input validation", () => {
  it("throws on empty string tenantId", async () => {
    await expect(
      withTenantContext("", async () => "unreachable")
    ).rejects.toThrow(/tenantId is required/);
  });

  it("throws on null tenantId (TS bypass)", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withTenantContext(null as any, async () => "unreachable")
    ).rejects.toThrow(/tenantId is required/);
  });

  it("throws on undefined tenantId (TS bypass)", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      withTenantContext(undefined as any, async () => "unreachable")
    ).rejects.toThrow(/tenantId is required/);
  });

  it("does NOT invoke the callback when tenantId is invalid", async () => {
    let invoked = false;
    try {
      await withTenantContext("", async () => {
        invoked = true;
        return "x";
      });
    } catch {
      // expected
    }
    expect(invoked).toBe(false);
  });
});

describe("withTenantContext — GUC plumbing", () => {
  it("sets app.current_tenant_id inside the transaction", async () => {
    const result = await withTenantContext(TENANT_A_ID, async (tx) => {
      return getCurrentTenantGuc(tx);
    });
    expect(result).toBe(TENANT_A_ID);
  });

  it("GUC is NULL in a fresh transaction (not inherited from prior tx)", async () => {
    // First transaction sets it to A
    await withTenantContext(TENANT_A_ID, async () => "ok");

    // Fresh prisma.$transaction (no withTenantContext) should see NULL.
    // This proves set_config(_, _, true) is transaction-scoped not
    // connection-scoped.
    const result = await prisma.$transaction(async (tx) => {
      return tx.$queryRaw<Array<{ v: string | null }>>`
        SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS v
      `;
    });
    expect(result[0]?.v).toBeNull();
  });

  it("returns the callback's value", async () => {
    const result = await withTenantContext(TENANT_A_ID, async () => {
      return { count: 42, label: "test" };
    });
    expect(result).toEqual({ count: 42, label: "test" });
  });

  it("propagates errors from the callback (transaction rolls back)", async () => {
    await expect(
      withTenantContext(TENANT_A_ID, async () => {
        throw new Error("callback failure");
      })
    ).rejects.toThrow(/callback failure/);
  });

  it("treats tenantId as a string value, not as SQL (injection safety)", async () => {
    // Try a tenantId that looks like SQL — set_config() stores it as
    // a literal string value, not SQL. The parameterized $executeRaw
    // template literal protects against the DROP being executed.
    const malicious = "'); DROP TABLE tenant; --";
    const guc = await withTenantContext(malicious, async (tx) => {
      return getCurrentTenantGuc(tx);
    });
    // GUC was set to the literal string — proves no SQL was evaluated.
    expect(guc).toBe(malicious);
    // Verify the tenant table still exists — DROP did not execute.
    const rows = await prisma.$queryRaw<Array<{ exists: boolean }>>`
      SELECT EXISTS (
        SELECT FROM information_schema.tables
        WHERE table_schema = 'public' AND table_name = 'tenant'
      ) AS exists
    `;
    expect(rows[0]?.exists).toBe(true);
  });
});

describe("withTenantContext — concurrent isolation", () => {
  it("two concurrent transactions see their own GUC values", async () => {
    // Run two withTenantContext calls in parallel and verify each
    // sees its own tenantId. If set_config were connection-scoped
    // (not transaction-scoped), one would see the other's value.
    const [resultA, resultB] = await Promise.all([
      withTenantContext(TENANT_A_ID, async (tx) => {
        // Small delay to ensure overlap with B's transaction
        await new Promise((r) => setTimeout(r, 50));
        return getCurrentTenantGuc(tx);
      }),
      withTenantContext(TENANT_B_ID, async (tx) => {
        await new Promise((r) => setTimeout(r, 50));
        return getCurrentTenantGuc(tx);
      }),
    ]);
    expect(resultA).toBe(TENANT_A_ID);
    expect(resultB).toBe(TENANT_B_ID);
    expect(resultA).not.toBe(resultB);
  });
});

describe("withTenantContextReadOnly — read-only enforcement", () => {
  it("sets the GUC like the read-write variant", async () => {
    const result = await withTenantContextReadOnly(TENANT_A_ID, async (tx) => {
      return getCurrentTenantGuc(tx);
    });
    expect(result).toBe(TENANT_A_ID);
  });

  it("rejects DML attempts (INSERT) — Postgres error", async () => {
    // Attempt to INSERT inside a read-only transaction; Postgres should
    // throw. This is the defensive backstop for report code paths.
    await expect(
      withTenantContextReadOnly(TENANT_A_ID, async (tx) => {
        await tx.$executeRaw`
          INSERT INTO audit_log (id, "occurredAt", "actorUserId", "tenantId", "eventType", "metadata")
          VALUES (gen_random_uuid(), now(), null, ${TENANT_A_ID}::uuid, 'TEST', '{}'::jsonb)
        `;
        return "unreachable";
      })
    ).rejects.toThrow(); // exact error text is Postgres-version dependent
  });

  it("throws on empty tenantId (same validation as read-write)", async () => {
    await expect(
      withTenantContextReadOnly("", async () => "unreachable")
    ).rejects.toThrow(/tenantId is required/);
  });
});
