// Integration test for RLS Phase 2b — runRecurringEntries batch helper.
//
// This is the deliberately-deferred case from PR #76 (recurring-entries
// simple actions). The helper is a batch runner: each per-iteration
// postJournalEntry call must be in its own tx so a bad period doesn't
// roll back already-posted periods. The migration uses per-iteration
// withTenantContext(prisma, template.tenantId, ...).
//
// Verifies:
//   1. The runner posts JEs with the correct sourceRecordId pattern.
//   2. Re-running with the same throughDate is idempotent (the
//      partial unique index dedups; entriesPosted=0 the second time).
//   3. The runner's per-iteration tx wrap doesn't break the
//      "batch advances lastPostedDate only past the last successful
//      period" contract.
//
// DELIBERATELY NOT CHANGED by the afterAll sweep that fixed
// rls-internal-je-route and rls-recurring-entries. #368 listed this suite
// as a suspected leaker; measurement says otherwise. Its cleanup is already
// in a `finally`, so it runs on the failure path too — which is the whole
// property the other two were missing — and it deletes by
// `sourceRecordId startsWith <template uuid>`, which cannot match a seed row.
// It posts 4 entries and removes 4. Rewriting it to match the others would
// be churn against a suite that already holds the invariant.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { runRecurringEntries } from "../src/lib/accounting/recurring";

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

describe("runRecurringEntries — per-iteration RLS plumbing", () => {
  it("posts JEs with substrate lineage + idempotent re-run", async () => {
    // Seed a monthly template starting Feb 2026, isActive, no endDate.
    // throughDate = May 31, 2026 → expect 4 posts (Feb, Mar, Apr, May).
    const template = await prisma.recurringEntry.create({
      data: {
        tenantId,
        entityId,
        bookId,
        code: `RLS-RUN-${Date.now().toString().slice(-8)}`,
        memo: "RLS run-recurring test",
        currencyId: "USD",
        cadence: "MONTHLY",
        startDate: new Date(Date.UTC(2026, 1, 1)), // Feb 1
        createdBy: "test",
        lines: {
          create: [
            { lineNo: 1, accountCode: "1000", debit: "10.0000", credit: "0.0000" },
            { lineNo: 2, accountCode: "4000", debit: "0.0000", credit: "10.0000" },
          ],
        },
      },
      select: { id: true },
    });

    try {
      // First run: 4 periods posted.
      const first = await runRecurringEntries(prisma, {
        throughDate: new Date(Date.UTC(2026, 4, 31)), // May 31
        tenantId,
        templateId: template.id,
        triggeredBy: "test",
      });
      expect(first.entriesPosted).toBe(4);
      expect(first.templates).toHaveLength(1);
      expect(first.templates[0].posted).toBe(4);
      expect(first.templates[0].errors).toHaveLength(0);

      // Confirm the JEs landed with the right lineage.
      const posted = await prisma.journalEntry.findMany({
        where: {
          tenantId,
          sourceSystem: "SUBSTRATE",
          sourceRecordType: "RecurringEntry",
          sourceRecordId: { startsWith: `${template.id}:` },
        },
        orderBy: { documentDate: "asc" },
        select: { sourceRecordId: true, status: true },
      });
      expect(posted).toHaveLength(4);
      expect(posted.every((p) => p.status === "POSTED")).toBe(true);

      // Second run: idempotency contract — the unique-lineage dedupe in
      // postJournalEntry returns the existing entry. From the runner's
      // perspective, those still count as "posted" because the call
      // succeeds — but the template is idle since lastPostedDate
      // already advanced past throughDate.
      const second = await runRecurringEntries(prisma, {
        throughDate: new Date(Date.UTC(2026, 4, 31)),
        tenantId,
        templateId: template.id,
        triggeredBy: "test",
      });
      expect(second.entriesPosted).toBe(0);
      expect(second.templatesIdle).toBe(1);

      // Verify still only 4 JEs (no duplicates).
      const postedAgain = await prisma.journalEntry.count({
        where: {
          tenantId,
          sourceSystem: "SUBSTRATE",
          sourceRecordType: "RecurringEntry",
          sourceRecordId: { startsWith: `${template.id}:` },
        },
      });
      expect(postedAgain).toBe(4);
    } finally {
      // Cleanup: JournalLine FK is ON DELETE CASCADE, so deleting JEs
      // cascades to lines automatically.
      await prisma.journalEntry.deleteMany({
        where: {
          tenantId,
          sourceRecordId: { startsWith: `${template.id}:` },
        },
      });
      await prisma.recurringEntry.delete({ where: { id: template.id } });
    }
  });
});
