// BlackLine arc — Phase 2 PR 1 tests.
//
// Round-trips the new schema:
//   - CloseTask: enum status / category, UUID[] dependsOnIds, nullable
//     entityId/bookId, FK on completer
//   - CloseTaskTemplate: idempotent re-seed via composite @@unique
//     (tenantId, key)
//   - CloseTaskComment: FK cascade-on-delete from CloseTask
//
// Cheap unit-flavored against real Postgres — no Server Actions yet
// (PR 2 ships those). These tests pin the schema shape so future PRs
// can build on a stable contract.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";

const prisma = new PrismaClient();

const SUFFIX =
  "ct1" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantId: string;
let userId: string;
let entityId: string;
let bookId: string;
let periodId: string;
const created: {
  templates: string[];
  tasks: string[];
  comments: string[];
} = { templates: [], tasks: [], comments: [] };

beforeAll(async () => {
  tenantId = await getDefaultTenantId(prisma);
  const u = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true },
  });
  if (!u) throw new Error("Run Northwind seed first.");
  userId = u.id;

  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId, code: "NORTHWIND" },
    select: { id: true },
  });
  if (!entity) throw new Error("Need Northwind entity");
  entityId = entity.id;

  const book = await prisma.book.findUnique({
    where: { code: "US_GAAP" },
    select: { id: true },
  });
  if (!book) throw new Error("Need US_GAAP book");
  bookId = book.id;

  const period = await prisma.period.findFirst({
    where: { tenantId, calendar: { entityId } },
    select: { id: true },
  });
  if (!period) throw new Error("Need a period");
  periodId = period.id;
});

afterAll(async () => {
  await prisma.closeTaskComment.deleteMany({
    where: { id: { in: created.comments } },
  });
  await prisma.closeTask.deleteMany({
    where: { id: { in: created.tasks } },
  });
  await prisma.closeTaskTemplate.deleteMany({
    where: { id: { in: created.templates } },
  });
  await prisma.$disconnect();
});

describe("CloseTask schema — Phase 2 PR 1", () => {
  it("round-trips a CloseTask with all enum + array fields populated", async () => {
    const task = await prisma.closeTask.create({
      data: {
        tenantId,
        entityId,
        bookId,
        periodId,
        templateKey: `${SUFFIX}_ACCRUE_PAYROLL`,
        name: "Accrue payroll",
        description: "Estimate unpaid wages through period end",
        category: "ACCRUAL",
        status: "NOT_STARTED",
        requiredForClose: true,
        ownerId: userId,
        ownerType: "USER",
        dueOffsetDays: -2,
        dueAt: new Date("2026-06-28"),
        dependsOnIds: [],
      },
      select: {
        id: true,
        status: true,
        category: true,
        dependsOnIds: true,
        entityId: true,
        bookId: true,
        ownerType: true,
      },
    });
    created.tasks.push(task.id);
    expect(task.status).toBe("NOT_STARTED");
    expect(task.category).toBe("ACCRUAL");
    expect(task.dependsOnIds).toEqual([]);
    expect(task.entityId).toBe(entityId);
    expect(task.bookId).toBe(bookId);
    expect(task.ownerType).toBe("USER");
  });

  it("supports null entityId/bookId for tenant-wide tasks", async () => {
    const task = await prisma.closeTask.create({
      data: {
        tenantId,
        // entityId + bookId intentionally null (org-wide admin task)
        periodId,
        templateKey: `${SUFFIX}_SEND_NOTIFICATION`,
        name: "Send close-complete notification",
        category: "ADMIN",
        requiredForClose: false,
      },
      select: { entityId: true, bookId: true, requiredForClose: true },
    });
    expect(task.entityId).toBeNull();
    expect(task.bookId).toBeNull();
    expect(task.requiredForClose).toBe(false);
  });

  it("stores a multi-UUID dependsOnIds array and reads it back", async () => {
    const a = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Predecessor A",
        category: "ACCRUAL",
      },
      select: { id: true },
    });
    const b = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Predecessor B",
        category: "ACCRUAL",
      },
      select: { id: true },
    });
    const dependent = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Run depreciation",
        category: "DEPRECIATION",
        dependsOnIds: [a.id, b.id],
      },
      select: { id: true, dependsOnIds: true },
    });
    created.tasks.push(a.id, b.id, dependent.id);
    expect(dependent.dependsOnIds).toHaveLength(2);
    expect(dependent.dependsOnIds).toContain(a.id);
    expect(dependent.dependsOnIds).toContain(b.id);
  });

  it("CloseTaskTemplate is idempotent on (tenantId, key)", async () => {
    const key = `${SUFFIX}_RUN_DEPRECIATION`;
    const t1 = await prisma.closeTaskTemplate.create({
      data: {
        tenantId,
        key,
        name: "Run depreciation",
        category: "DEPRECIATION",
        defaultDueOffsetDays: -1,
        requiredForClose: true,
        defaultDependsOnKeys: [`${SUFFIX}_ACCRUE_PAYROLL`],
      },
      select: { id: true },
    });
    created.templates.push(t1.id);
    // Re-creating with the same (tenantId, key) → uniqueness violation.
    await expect(
      prisma.closeTaskTemplate.create({
        data: {
          tenantId,
          key,
          name: "Run depreciation (dup)",
          category: "DEPRECIATION",
        },
      })
    ).rejects.toThrow(/unique/i);
    // Upsert path: same composite key → updates rather than throws.
    const upserted = await prisma.closeTaskTemplate.upsert({
      where: { tenantId_key: { tenantId, key } },
      update: { name: "Run depreciation (renamed)" },
      create: {
        tenantId,
        key,
        name: "should not create",
        category: "DEPRECIATION",
      },
      select: { id: true, name: true },
    });
    expect(upserted.id).toBe(t1.id);
    expect(upserted.name).toBe("Run depreciation (renamed)");
  });

  it("CloseTaskComment cascades on task delete", async () => {
    const task = await prisma.closeTask.create({
      data: {
        tenantId,
        periodId,
        name: "Disposable task",
        category: "ADMIN",
      },
      select: { id: true },
    });
    const c1 = await prisma.closeTaskComment.create({
      data: {
        tenantId,
        closeTaskId: task.id,
        body: "First thought",
        authorId: userId,
      },
      select: { id: true },
    });
    const c2 = await prisma.closeTaskComment.create({
      data: {
        tenantId,
        closeTaskId: task.id,
        body: "Follow-up",
        authorId: userId,
      },
      select: { id: true },
    });
    // Sanity check: both rows exist before delete.
    const beforeCount = await prisma.closeTaskComment.count({
      where: { closeTaskId: task.id },
    });
    expect(beforeCount).toBe(2);
    // Delete the parent task. Cascade rule on close_task_comment.closeTaskId
    // must clean up the comments without a manual deleteMany.
    await prisma.closeTask.delete({ where: { id: task.id } });
    const afterCount = await prisma.closeTaskComment.count({
      where: { closeTaskId: task.id },
    });
    expect(afterCount).toBe(0);
    // c1 + c2 are gone via cascade; no entries pushed to created.comments
    // so afterAll doesn't try to re-delete them.
  });
});
