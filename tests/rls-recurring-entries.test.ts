// Integration test for RLS Phase 2b — recurring-entries actions.
//
// Verifies the GUC plumbing for the 3 simple actions migrated in this
// PR: create / setActive / delete. (runRecurringEntriesAction is a
// separate batch-helper migration — its per-iteration postJournalEntry
// calls each need independent tx boundaries by design.)

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

beforeAll(async () => {
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
});

afterAll(async () => {
  await prisma.$disconnect();
});

describe("recurring-entries RLS plumbing", () => {
  it("create: resolver chain + nested-line create runs inside withTenantContext", async () => {
    const code = `RLS-TEST-${Date.now()}`;
    let observedGuc: string | null = null;

    const created = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);

      const entity = await tx.legalEntity.findFirstOrThrow({
        where: { tenantId, code: "NORTHWIND" },
        select: { id: true },
      });
      const book = await tx.book.findUniqueOrThrow({
        where: { code: "US_GAAP" },
        select: { id: true },
      });
      return tx.recurringEntry.create({
        data: {
          tenantId,
          entityId: entity.id,
          bookId: book.id,
          code,
          memo: "RLS test recurring",
          currencyId: "USD",
          cadence: "MONTHLY",
          startDate: new Date("2026-06-01"),
          createdBy: "test",
          lines: {
            create: [
              { lineNo: 1, accountCode: "1000", debit: "1.0000", credit: "0.0000" },
              { lineNo: 2, accountCode: "4000", debit: "0.0000", credit: "1.0000" },
            ],
          },
        },
        select: { id: true },
      });
    });

    expect(observedGuc).toBe(tenantId);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);

    // Cleanup.
    await prisma.recurringEntry.delete({ where: { id: created.id } });
  });

  it("setActive: updateMany runs inside withTenantContext", async () => {
    // Seed a template.
    const template = await prisma.recurringEntry.create({
      data: {
        tenantId,
        entityId,
        bookId,
        code: `RLS-ACT-${Date.now()}`,
        memo: "RLS test",
        currencyId: "USD",
        cadence: "MONTHLY",
        startDate: new Date("2026-06-01"),
        createdBy: "test",
        lines: {
          create: [
            { lineNo: 1, accountCode: "1000", debit: "1.0000", credit: "0.0000" },
            { lineNo: 2, accountCode: "4000", debit: "0.0000", credit: "1.0000" },
          ],
        },
      },
      select: { id: true },
    });

    let observedGuc: string | null = null;
    const updated = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      return tx.recurringEntry.updateMany({
        where: { id: template.id, tenantId },
        data: { isActive: false },
      });
    });
    expect(observedGuc).toBe(tenantId);
    expect(updated.count).toBe(1);

    // Cleanup.
    await prisma.recurringEntry.delete({ where: { id: template.id } });
  });

  it("delete: findFirst + delete inside one withTenantContext tx", async () => {
    const template = await prisma.recurringEntry.create({
      data: {
        tenantId,
        entityId,
        bookId,
        code: `RLS-DEL-${Date.now()}`,
        memo: "RLS test delete",
        currencyId: "USD",
        cadence: "MONTHLY",
        startDate: new Date("2026-06-01"),
        createdBy: "test",
        lines: {
          create: [
            { lineNo: 1, accountCode: "1000", debit: "1.0000", credit: "0.0000" },
            { lineNo: 2, accountCode: "4000", debit: "0.0000", credit: "1.0000" },
          ],
        },
      },
      select: { id: true },
    });

    let observedGuc: string | null = null;
    const result = await withTenantContext(tenantId, async (tx) => {
      observedGuc = await getCurrentTenantGuc(tx);
      const found = await tx.recurringEntry.findFirst({
        where: { id: template.id, tenantId },
        select: { id: true },
      });
      if (!found) return null;
      await tx.recurringEntry.delete({ where: { id: found.id } });
      return found;
    });

    expect(observedGuc).toBe(tenantId);
    expect(result?.id).toBe(template.id);

    const after = await prisma.recurringEntry.findUnique({
      where: { id: template.id },
    });
    expect(after).toBeNull();
  });
});
