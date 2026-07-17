// Regression for the test-only audit-log cleanup helper
// (tests/_helpers/audit-log-cleanup.ts).
//
// withAuditLogMutableTransaction suspends the two append-only rules AND the
// two parent FKs on audit_log inside ONE transaction, runs a cleanup
// callback, repairs orphaned rows, then restores everything with the exact
// production actions. The load-bearing safety property: if the cleanup
// callback throws, the transaction MUST roll back and leave audit_log's
// protections exactly as production ships them — a killed test run must
// never leave audit_log mutable or its FKs weakened.
//
// This asserts that restoration contract directly. It's distinct from
// tests/audit-log-append-only.test.ts, which proves the steady-state block;
// here we prove the block (and the FK actions) SURVIVE a rolled-back cleanup.

import { describe, it, expect, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { withAuditLogMutableTransaction } from "./_helpers/audit-log-cleanup";

const prisma = new PrismaClient();
const HAS_DB = !!process.env.DATABASE_URL;

/** Referential actions Postgres reports for a named FK constraint. */
async function fkActions(
  name: string
): Promise<{ update_rule: string; delete_rule: string } | null> {
  const rows = await prisma.$queryRawUnsafe<
    { update_rule: string; delete_rule: string }[]
  >(
    `SELECT update_rule, delete_rule
       FROM information_schema.referential_constraints
      WHERE constraint_name = $1`,
    name
  );
  return rows[0] ?? null;
}

async function ruleExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRawUnsafe<{ rulename: string }[]>(
    `SELECT rulename FROM pg_rules WHERE tablename = 'audit_log' AND rulename = $1`,
    name
  );
  return rows.length > 0;
}

describe.skipIf(!HAS_DB)(
  "withAuditLogMutableTransaction — a rolled-back cleanup restores production protections",
  () => {
    afterAll(async () => {
      await prisma.$disconnect();
    });

    it("propagates a thrown cleanup error (the transaction rolls back)", async () => {
      const boom = new Error("cleanup blew up");
      await expect(
        withAuditLogMutableTransaction(prisma, async () => {
          throw boom;
        })
      ).rejects.toBe(boom);
    });

    it("restores both parent FKs with their exact production actions after a rollback", async () => {
      await withAuditLogMutableTransaction(prisma, async () => {
        throw new Error("force rollback");
      }).catch(() => {});

      // actorUserId: ON UPDATE CASCADE ON DELETE SET NULL
      expect(await fkActions("audit_log_actorUserId_fkey")).toEqual({
        update_rule: "CASCADE",
        delete_rule: "SET NULL",
      });
      // tenantId: ON UPDATE CASCADE ON DELETE RESTRICT
      expect(await fkActions("audit_log_tenantId_fkey")).toEqual({
        update_rule: "CASCADE",
        delete_rule: "RESTRICT",
      });
    });

    it("restores both append-only rules after a rollback", async () => {
      await withAuditLogMutableTransaction(prisma, async () => {
        throw new Error("force rollback");
      }).catch(() => {});

      expect(await ruleExists("audit_log_no_update")).toBe(true);
      expect(await ruleExists("audit_log_no_delete")).toBe(true);
    });

    it("keeps direct UPDATE and DELETE on audit_log blocked after a rollback", async () => {
      await withAuditLogMutableTransaction(prisma, async () => {
        throw new Error("force rollback");
      }).catch(() => {});

      // INSERT is always allowed; UPDATE/DELETE must no-op (the restored
      // rules convert them to NOTHING → 0 rows affected, row unchanged).
      const tenantId = await getDefaultTenantId(prisma);
      const action = `helper_regression_${Date.now()}`;
      const row = await prisma.auditLog.create({
        data: { tenantId, eventType: "PRIVILEGED_ACTION", action, outcome: "SUCCESS" },
      });

      const upd = await prisma.auditLog.updateMany({
        where: { id: row.id },
        data: { action: "tampered" },
      });
      expect(upd.count).toBe(0);

      const del = await prisma.auditLog.deleteMany({ where: { id: row.id } });
      expect(del.count).toBe(0);

      const still = await prisma.auditLog.findUnique({ where: { id: row.id } });
      expect(still?.action).toBe(action); // unchanged and still present
    });

    it("a SUCCESSFUL cleanup also leaves the protections intact (commit path)", async () => {
      // The non-throwing path re-adds FKs + rules explicitly before commit;
      // assert it lands in the same fully-armed state as the rollback path.
      await withAuditLogMutableTransaction(prisma, async () => {
        /* no-op cleanup */
      });
      expect(await ruleExists("audit_log_no_update")).toBe(true);
      expect(await ruleExists("audit_log_no_delete")).toBe(true);
      expect(await fkActions("audit_log_actorUserId_fkey")).toEqual({
        update_rule: "CASCADE",
        delete_rule: "SET NULL",
      });
      expect(await fkActions("audit_log_tenantId_fkey")).toEqual({
        update_rule: "CASCADE",
        delete_rule: "RESTRICT",
      });
    });
  }
);
