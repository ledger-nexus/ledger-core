// Integration test for RLS Phase 2b — period close + reopen actions.
//
// Verifies the resolver chain (book/period/PeriodClose lookups) +
// mutation (create or delete PeriodClose) all run inside one
// withTenantContext tx with the GUC set to the entity's tenantId.
//
// Does NOT test the action functions themselves — those require admin
// auth setup which isn't available in this integration harness. This
// test pins the RLS plumbing pattern they use.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  getCurrentTenantGuc,
} from "../src/lib/db/tenant-context";

const prisma = new PrismaClient();

let tenantId: string;
let entityId: string;
let bookId: string;
let periodId: string;

beforeAll(async () => {
  // Resolve a known-good fixture: Northwind entity + US_GAAP book + the
  // first period on Northwind's calendar.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: "NORTHWIND" },
    select: { id: true, tenantId: true },
  });
  tenantId = entity.tenantId;
  entityId = entity.id;

  const book = await prisma.book.findUniqueOrThrow({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  bookId = book.id;

  const period = await prisma.period.findFirstOrThrow({
    where: { calendar: { entityId } },
    select: { id: true },
  });
  periodId = period.id;
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("period-close RLS plumbing", () => {
  it("close: resolver chain + create runs inside withTenantContext with GUC set", async () => {
    // Make sure this period is open to start with.
    await prisma.periodClose
      .deleteMany({
        where: { entityId, bookId, periodId },
      })
      .catch(() => undefined);

    let observedGuc: string | null = null;
    const result = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);

      // Mimic the action: book + period + existing-check + create, all
      // inside the same tx.
      const book = await tx.book.findUniqueOrThrow({
        where: { code: "US_GAAP" },
        select: { id: true },
      });
      const period = await tx.period.findFirstOrThrow({
        where: { calendar: { entityId } },
        select: { id: true },
      });
      const existing = await tx.periodClose.findUnique({
        where: {
          entityId_bookId_periodId: {
            entityId,
            bookId: book.id,
            periodId: period.id,
          },
        },
        select: { id: true },
      });
      expect(existing).toBeNull();

      const created = await tx.periodClose.create({
        data: {
          tenantId,
          entityId,
          bookId: book.id,
          periodId: period.id,
          closedBy: "test@example.com",
        },
        select: { id: true, closedAt: true },
      });
      return created;
    });

    expect(observedGuc).toBe(tenantId);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.closedAt).toBeInstanceOf(Date);

    // Cleanup.
    await prisma.periodClose.delete({ where: { id: result.id } });
  });

  it("reopen: resolver chain + delete runs inside withTenantContext", async () => {
    // Seed a PeriodClose row so reopen has something to delete.
    const seeded = await prisma.periodClose.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId,
        closedBy: "test-seed@example.com",
      },
      select: { id: true },
    });

    let observedGuc: string | null = null;
    await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      const existing = await tx.periodClose.findUnique({
        where: {
          entityId_bookId_periodId: { entityId, bookId, periodId },
        },
        select: { id: true },
      });
      expect(existing?.id).toBe(seeded.id);
      await tx.periodClose.delete({ where: { id: seeded.id } });
    });
    expect(observedGuc).toBe(tenantId);

    const after = await prisma.periodClose.findUnique({
      where: {
        entityId_bookId_periodId: { entityId, bookId, periodId },
      },
    });
    expect(after).toBeNull();
  });
});
