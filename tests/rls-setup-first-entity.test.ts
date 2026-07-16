// Integration test for RLS Phase 2b — setup-first-entity bootstrap.
//
// Verifies the GUC is set during the multi-table bootstrap (entity +
// calendar + 12 periods + optional 12 accounts) and that the idempotency
// check inside the wrap correctly short-circuits a re-entry.
//
// Uses a fresh disposable tenant so we don't poison the seeded default.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";

const prisma = new PrismaClient();

let throwawayTenantId: string;

beforeAll(async () => {
  // Borrow an existing user id from the seeded default tenant — the
  // throwaway tenant just needs an ownerUserId reference.
  const anyUser = await prisma.user.findFirstOrThrow({
    select: { id: true },
  });

  // Create a brand-new tenant for this test. cleanup deletes all rows
  // we create. slug must be globally unique.
  const slug = `rls-setup-${Date.now().toString().slice(-8)}`;
  const t = await prisma.tenant.create({
    data: { slug, name: `RLS Setup Test ${slug}`, ownerUserId: anyUser.id },
    select: { id: true },
  });
  throwawayTenantId = t.id;
});

afterAll(async () => {
  // Cascade-clean: delete accounts → periods → calendars → entities → tenant.
  // FK chain blocks any out-of-order delete attempts.
  await prisma.account.deleteMany({ where: { tenantId: throwawayTenantId } });
  await prisma.period.deleteMany({ where: { tenantId: throwawayTenantId } });
  await prisma.fiscalCalendar.deleteMany({ where: { tenantId: throwawayTenantId } });
  await prisma.legalEntity.deleteMany({ where: { tenantId: throwawayTenantId } });
  await prisma.tenant.delete({ where: { id: throwawayTenantId } });
  await prisma.$disconnect();
});

describe("setup-first-entity RLS plumbing", () => {
  it("bootstrap runs inside withTenantContext with GUC set", async () => {
    let observedGuc: string | null = null;
    const out = await withTenantContext(prisma, throwawayTenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);

      // Idempotency: empty tenant → no entities yet.
      const count = await tx.legalEntity.count({ where: { tenantId: throwawayTenantId } });
      expect(count).toBe(0);

      // Bootstrap a minimal entity + calendar + period + a single account
      // (the production action does 12 periods + 12 accounts, but the
      // point of this test is the GUC + tx plumbing, not the row count).
      const entity = await tx.legalEntity.create({
        data: {
          tenantId: throwawayTenantId,
          code: "RLSTEST",
          name: "RLS Setup Test Entity",
          functionalCurrencyId: "USD",
        },
        select: { id: true, code: true },
      });

      const cal = await tx.fiscalCalendar.create({
        data: {
          tenantId: throwawayTenantId,
          entityId: entity.id,
          code: "RLSTEST_2026",
          name: "RLS test 2026 cal",
          periodFrequency: "MONTHLY",
        },
        select: { id: true },
      });

      await tx.period.create({
        data: {
          tenantId: throwawayTenantId,
          calendarId: cal.id,
          code: "2026-01",
          ordinal: 1,
          startsOn: new Date(Date.UTC(2026, 0, 1)),
          endsOn: new Date(Date.UTC(2026, 1, 0)),
        },
      });

      await tx.account.create({
        data: {
          tenantId: throwawayTenantId,
          entityId: entity.id,
          code: "1000",
          name: "Cash — RLS test",
          type: "ASSET",
          normalBalance: "DEBIT",
        },
      });

      return entity;
    });

    expect(observedGuc).toBe(throwawayTenantId);
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(out.code).toBe("RLSTEST");

    // Verify writes committed.
    const persisted = await prisma.legalEntity.findUniqueOrThrow({
      where: { id: out.id },
      select: { code: true },
    });
    expect(persisted.code).toBe("RLSTEST");
  });

  it("idempotency: re-entry on a populated tenant short-circuits inside the tx", async () => {
    // The throwawayTenantId now has 1 entity from the prior test.
    let observedGuc: string | null = null;
    let entityCountInsideTx = -1;
    let didCreate = false;

    await withTenantContext(prisma, throwawayTenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);
      entityCountInsideTx = await tx.legalEntity.count({
        where: { tenantId: throwawayTenantId },
      });
      if (entityCountInsideTx > 0) {
        return; // Early-exit branch — no writes committed.
      }
      didCreate = true;
      await tx.legalEntity.create({
        data: {
          tenantId: throwawayTenantId,
          code: "WOULDNOTCREATE",
          name: "would not create",
          functionalCurrencyId: "USD",
        },
      });
    });

    expect(observedGuc).toBe(throwawayTenantId);
    expect(entityCountInsideTx).toBeGreaterThan(0);
    expect(didCreate).toBe(false);

    // Verify NO new entity was created.
    const stillJustOne = await prisma.legalEntity.findMany({
      where: { tenantId: throwawayTenantId, code: "WOULDNOTCREATE" },
    });
    expect(stillJustOne).toHaveLength(0);
  });
});
