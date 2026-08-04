// withTenantContext tests (RLS Phase 1 foundation).
//
// NOTE: distinct from tests/tenant-context.test.ts, which covers the
// application-level tenant *resolution* (getCurrentTenant et al.). This
// covers the DB-layer tenant GUC that future RLS policies will read.
//
// Proves the mechanism works the way later RLS policies will depend on:
//   1. Inside the context, app.current_tenant_id == the tenantId.
//   2. The tx client + the GUC share one connection (two reads agree).
//   3. The GUC is transaction-local — it does NOT leak onto pooled
//      connections used by later queries.
//   4. A non-UUID tenantId is rejected before any SQL runs.
//
// No RLS is enabled yet, so this only exercises set_config /
// current_setting — pure Postgres, no schema dependency, no seed needed.

import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  withTenantContext,
  currentTenantId,
  InvalidTenantIdError,
  TENANT_GUC,
} from "@/lib/tenant-context";

const prisma = new PrismaClient();
// Any well-formed UUID works — nothing FK-references the GUC value yet.
const TID = "11111111-2222-3333-4444-555555555555";

afterAll(async () => {
  await prisma.$disconnect();
});

describe("withTenantContext", () => {
  it("sets app.current_tenant_id inside the transaction", async () => {
    const seen = await withTenantContext(prisma, TID, (tx) => currentTenantId(tx));
    expect(seen).toBe(TID);
  });

  it("the tx client shares the connection the GUC was set on", async () => {
    const [a, b] = await withTenantContext(prisma, TID, async (tx) => {
      const first = await currentTenantId(tx);
      const second = await currentTenantId(tx); // second round-trip, same tx
      return [first, second] as const;
    });
    expect(a).toBe(TID);
    expect(b).toBe(TID);
  });

  it("is transaction-local: the GUC does not leak to later queries", async () => {
    await withTenantContext(prisma, TID, async () => null);
    // A fresh query outside any context must not see the tenant GUC,
    // even if it reuses the connection (SET LOCAL reverts at commit).
    const rows = await prisma.$queryRaw<Array<{ tid: string | null }>>`
      SELECT current_setting(${TENANT_GUC}, TRUE) AS tid
    `;
    const tid = rows[0]?.tid;
    expect(tid === "" || tid == null).toBe(true);
  });

  it("rejects a non-UUID tenantId before running any SQL", async () => {
    await expect(
      withTenantContext(prisma, "not-a-uuid", async () => 1)
    ).rejects.toBeInstanceOf(InvalidTenantIdError);
  });
});
