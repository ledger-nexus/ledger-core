// Proves period_reopen_log is append-only at the DB level: UPDATE and DELETE
// silently no-op (Postgres RULE → DO INSTEAD NOTHING), so a reopen record can't
// be tampered with even via raw SQL, while INSERT stays allowed (appending is
// the whole point). Same enforcement + rationale as audit_log.
//
// The row is inserted with arbitrary UUIDs — period_reopen_log has no FK
// relations, so no tenant/entity/book fixtures are required.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { withPeriodReopenLogMutable } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();

const ENTITY_CODE = "PRLAPPEND";
const T = "11111111-1111-1111-1111-111111111111";
const E = "22222222-2222-2222-2222-222222222222";
const B = "33333333-3333-3333-3333-333333333333";

let rowId: string;

beforeAll(async () => {
  // Clear residue from any prior interrupted run (suspend rules to delete).
  await withPeriodReopenLogMutable(prisma, () =>
    prisma.periodReopenLog.deleteMany({ where: { entityCode: ENTITY_CODE } })
  );
  const row = await prisma.periodReopenLog.create({
    data: {
      tenantId: T,
      entityId: E,
      bookId: B,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      periodCode: "2026-05",
      reason: "original reason",
      reopenedBy: "tester@example.test",
    },
  });
  rowId = row.id;
});

afterAll(async () => {
  await withPeriodReopenLogMutable(prisma, () =>
    prisma.periodReopenLog.deleteMany({ where: { entityCode: ENTITY_CODE } })
  );
  await prisma.$disconnect();
});

describe("period_reopen_log append-only enforcement", () => {
  it("silently no-ops UPDATE — the reason cannot be tampered with", async () => {
    const res = await prisma.periodReopenLog.updateMany({
      where: { id: rowId },
      data: { reason: "TAMPERED" },
    });
    expect(res.count).toBe(0);
    const row = await prisma.periodReopenLog.findUnique({ where: { id: rowId } });
    expect(row?.reason).toBe("original reason");
  });

  it("silently no-ops DELETE — the record cannot be removed", async () => {
    const res = await prisma.periodReopenLog.deleteMany({ where: { id: rowId } });
    expect(res.count).toBe(0);
    const row = await prisma.periodReopenLog.findUnique({ where: { id: rowId } });
    expect(row).not.toBeNull();
  });

  it("still allows INSERT — appending a new reopen record works", async () => {
    const extra = await prisma.periodReopenLog.create({
      data: {
        tenantId: T,
        entityId: E,
        bookId: B,
        entityCode: ENTITY_CODE,
        bookCode: "US_GAAP",
        periodCode: "2026-06",
        reason: "second reopen",
        reopenedBy: "tester@example.test",
      },
    });
    expect(extra.id).toBeTruthy();
    const count = await prisma.periodReopenLog.count({ where: { entityCode: ENTITY_CODE } });
    expect(count).toBe(2);
  });
});
