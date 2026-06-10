-- BlackLine arc follow-on — Close-task state history (v1.18 limitation closure).
--
-- Closes the documented gap in `src/lib/close/retrospective.ts`:
-- recurring-blockers was current-snapshot only, so a template that
-- hit BLOCKED four periods ago and was since unblocked would not
-- appear. This append-only state-change log lets the replay walker
-- count EVER-blocked, not currently-blocked.
--
-- Write protocol: every status-mutating Server Action wraps the
-- `closeTask.update` + `closeTaskStateChange.create` in one
-- $transaction. The `changedById` field is NULLABLE only to permit
-- the backfill at the bottom of this file to land an initial row
-- for every pre-existing close-task without inventing a fake actor.
-- The Server Action helper requires a non-null value for live writes.
--
-- Rollback:
--   DROP INDEX IF EXISTS "idx_close_task_state_change_to_status";
--   DROP INDEX IF EXISTS "idx_close_task_state_change_tenant_at";
--   DROP INDEX IF EXISTS "idx_close_task_state_change_task_at";
--   DROP TABLE IF EXISTS "close_task_state_change";

CREATE TABLE "close_task_state_change" (
  "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenantId"    UUID NOT NULL,
  "closeTaskId" UUID NOT NULL,
  "fromStatus"  "CloseTaskStatus",
  "toStatus"    "CloseTaskStatus" NOT NULL,
  "reason"      TEXT,
  "changedById" UUID,
  "changedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "close_task_state_change_pkey" PRIMARY KEY ("id")
);

-- FKs. Cascade on close-task delete (state log goes with the task).
-- Restrict on tenant delete (matches sibling close-task tables).
-- ON DELETE SET NULL for the actor — if the user is deleted, the
-- audit row survives but loses attribution. The DSR path requires
-- this so erasure doesn't tombstone the close-process history.
ALTER TABLE "close_task_state_change"
  ADD CONSTRAINT "close_task_state_change_tenantId_fkey"
  FOREIGN KEY ("tenantId") REFERENCES "tenant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "close_task_state_change"
  ADD CONSTRAINT "close_task_state_change_closeTaskId_fkey"
  FOREIGN KEY ("closeTaskId") REFERENCES "close_task"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "close_task_state_change"
  ADD CONSTRAINT "close_task_state_change_changedById_fkey"
  FOREIGN KEY ("changedById") REFERENCES "app_user"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

-- Indexes for the two hot read paths:
--   (closeTaskId, changedAt)  — fetch the timeline of one task
--   (tenantId, changedAt)     — replay walker over a tenant's window
--   (tenantId, toStatus)      — quickly count "ever hit BLOCKED" per tenant
CREATE INDEX "idx_close_task_state_change_task_at"
  ON "close_task_state_change"("closeTaskId", "changedAt");
CREATE INDEX "idx_close_task_state_change_tenant_at"
  ON "close_task_state_change"("tenantId", "changedAt");
CREATE INDEX "idx_close_task_state_change_to_status"
  ON "close_task_state_change"("tenantId", "toStatus");

-- Backfill an initial state-change row for every pre-existing task.
-- changedById is NULL on backfill rows — they predate the wiring.
-- changedAt copies the task's createdAt so the timeline reads cleanly.
-- toStatus copies the CURRENT status (best-effort baseline; we can't
-- reconstruct intermediate transitions without an audit-log replay).
-- reason copies blockedReason when status=BLOCKED, evidenceNote for
-- WAIVED, NULL otherwise.
INSERT INTO "close_task_state_change"
  ("id", "tenantId", "closeTaskId", "fromStatus", "toStatus", "reason", "changedById", "changedAt")
SELECT
  gen_random_uuid(),
  ct."tenantId",
  ct."id",
  NULL,
  ct."status",
  CASE
    WHEN ct."status" = 'BLOCKED' THEN ct."blockedReason"
    WHEN ct."status" = 'WAIVED'  THEN ct."evidenceNote"
    ELSE NULL
  END,
  NULL,
  ct."createdAt"
FROM "close_task" ct;

-- Append-only enforcement. Same intent as audit_log: trigger refuses
-- direct UPDATE or DELETE on the state-change table. CC7.2 requires
-- that once recorded, a state transition cannot be silently rewritten.
--
-- Carve-out for FK cascade: when a CloseTask is deleted, Postgres
-- cascades the delete to its state-change rows. The trigger fires at
-- depth > 1 in that case. We allow cascade deletes through so tenant
-- teardown / right-to-erasure works correctly. Direct DELETE from a
-- client query is always depth = 1 and still blocked.
CREATE OR REPLACE FUNCTION "close_task_state_change_block_mutation"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    -- Cascade from close_task DELETE. Permit.
    RETURN OLD;
  END IF;
  RAISE EXCEPTION
    'close_task_state_change is append-only — % blocked',
    TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "close_task_state_change_no_update"
  BEFORE UPDATE ON "close_task_state_change"
  FOR EACH ROW EXECUTE FUNCTION "close_task_state_change_block_mutation"();

CREATE TRIGGER "close_task_state_change_no_delete"
  BEFORE DELETE ON "close_task_state_change"
  FOR EACH ROW EXECUTE FUNCTION "close_task_state_change_block_mutation"();
