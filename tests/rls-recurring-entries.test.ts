// Integration test for RLS Phase 2b — recurring-entries actions.
//
// Verifies the GUC plumbing for the 3 simple actions migrated in this
// PR: create / setActive / delete. (runRecurringEntriesAction is a
// separate batch-helper migration — its per-iteration postJournalEntry
// calls each need independent tx boundaries by design.)
//
// CLEANUP IS IN afterAll, NOT AFTER THE ASSERTIONS. This suite posts no
// journal entries, so it was not part of #368 — but it creates
// RecurringEntry templates in shared NORTHWIND, and the templates are
// residue in exactly the same way. The original cleanup was the last
// statement of each `it`, which means it only ran when the test PASSED.
//
// Demonstrated, not assumed: flipping `expect(updated.count).toBe(1)` to
// `toBe(99)` and running the suite left `RLS-ACT-1786215627756` behind
// permanently. A leaked template is not inert — the recurring cron
// enumerates every active template in the tenant, and /automations lists
// them — so the failure mode is a test failure that quietly adds a
// scheduled posting to a shared dataset.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  withTenantContext,
  currentTenantId,
} from "../src/lib/tenant-context";

const prisma = new PrismaClient();

let tenantId: string;
let entityId: string;
let bookId: string;

/** Every template this suite creates, cleaned up in afterAll regardless of outcome. */
const createdTemplateIds: string[] = [];

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
  // deleteMany, not delete: the third test deletes its own template as the
  // thing under test, so by the time we get here some of these ids are
  // already gone. `delete` would throw on the first missing one and abandon
  // the rest.
  await prisma.recurringEntry.deleteMany({ where: { id: { in: createdTemplateIds } } });
  await prisma.$disconnect();
});

describe("recurring-entries RLS plumbing", () => {
  it("create: resolver chain + nested-line create runs inside withTenantContext", async () => {
    const code = `RLS-TEST-${Date.now()}`;
    let observedGuc: string | null = null;

    const created = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);

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

    createdTemplateIds.push(created.id);

    expect(observedGuc).toBe(tenantId);
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/i);
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
    createdTemplateIds.push(template.id);

    let observedGuc: string | null = null;
    const updated = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);
      return tx.recurringEntry.updateMany({
        where: { id: template.id, tenantId },
        data: { isActive: false },
      });
    });
    expect(observedGuc).toBe(tenantId);
    expect(updated.count).toBe(1);
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
    // Tracked even though deleting it IS the test: if the delete under test
    // fails, the template is exactly the residue we are here to prevent.
    createdTemplateIds.push(template.id);

    let observedGuc: string | null = null;
    const result = await withTenantContext(prisma, tenantId, async (tx) => {
      observedGuc = await currentTenantId(tx);
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
