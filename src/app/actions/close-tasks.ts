// BlackLine arc — Phase 2 PR 2: Close Task Server Actions.
//
// Eight actions covering the close-task lifecycle:
//
//   instantiateCalendarForPeriod  Bulk-creates tasks from active
//                                 templates. Resolves dependsOnKeys
//                                 → ids. Cycle-prevention via DFS.
//                                 Idempotent (skip-on-templateKey-
//                                 collision per period).
//   startTask                     NOT_STARTED|BLOCKED → IN_PROGRESS.
//                                 Refuses if any dependency isn't
//                                 terminal (DONE or WAIVED).
//   completeTask                  IN_PROGRESS → DONE. Optional
//                                 evidenceUrl + evidenceNote.
//   blockTask                     Any non-terminal → BLOCKED with
//                                 reason.
//   unblockTask                   BLOCKED → IN_PROGRESS (resumes mid-
//                                 progress; doesn't reset preparer
//                                 fields like recon sendBack does).
//   waiveTask                     Admin-only. Any non-terminal →
//                                 WAIVED with reason.
//   reassignTask                  Owner OR admin. Sets ownerId +
//                                 ownerType.
//   addCloseTaskComment           Anyone with tenant access. Append-
//                                 only thread.
//
// SOC 2 baseline (per the global CLAUDE.md):
//   CC6.3 every action requires user + tenant. waiveTask escalates
//         to admin.
//   CC6.1 every read + write tenant-scoped via tenantId. Cross-
//         tenant attempts return NOT_FOUND.
//   CC6.8 Zod on every input. Status-mismatch errors land before
//         any DB write.
//   CC7.2 every successful mutation writes a PRIVILEGED_ACTION row.
//         Per-row audit (not aggregated) because tasks have meaningful
//         per-row provenance (who started/completed/blocked what).
//         instantiateCalendarForPeriod is the one exception — one
//         aggregate audit row per invocation since N templates = N
//         tasks would balloon the log.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma, CloseTaskStatus } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant, requireTenantAdmin } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";

// ─────────────────────────────────────────────────────────────────────────
// Validation schemas
// ─────────────────────────────────────────────────────────────────────────
const uuid = z.string().uuid();

const StartInput = z.object({ taskId: uuid });
const CompleteInput = z.object({
  taskId: uuid,
  evidenceUrl: z.string().url().max(500).optional(),
  evidenceNote: z.string().max(2000).optional(),
});
const BlockInput = z.object({
  taskId: uuid,
  reason: z.string().min(1).max(2000),
});
const UnblockInput = z.object({ taskId: uuid });
const WaiveInput = z.object({
  taskId: uuid,
  reason: z.string().min(1).max(2000),
});
const ReassignInput = z.object({
  taskId: uuid,
  ownerId: uuid,
  ownerType: z.enum(["USER", "QUEUE"]),
});
const CommentInput = z.object({
  taskId: uuid,
  body: z.string().min(1).max(4000),
});
const InstantiateInput = z.object({ periodId: uuid });

export type TaskResult =
  | { ok: true; taskId?: string }
  | { ok: false; code: string; error: string };

export type InstantiateResult =
  | {
      ok: true;
      created: number;
      skipped: number; // template instantiated already → no-op
      total: number;
    }
  | { ok: false; code: string; error: string };

function fail(code: string, error: string): TaskResult {
  return { ok: false, code, error };
}

// Terminal statuses — actions that "advance" the task refuse to operate
// on these. They're the audit-stable end states.
const TERMINAL: CloseTaskStatus[] = ["DONE", "WAIVED"];

// ─────────────────────────────────────────────────────────────────────────
// recordStateChange (migration 0011 — close-task state history)
//
// Append-only state-transition log writer. Called inside every
// status-mutating action's transaction. The DB trigger on
// close_task_state_change refuses UPDATE/DELETE, so once written this
// row is part of the permanent audit trail.
//
// `changedById` is REQUIRED on live writes (only the migration
// backfill rows have a null actor; that's enforced here, not at the
// schema level, to keep backfill SQL clean).
// ─────────────────────────────────────────────────────────────────────────
async function recordStateChange(
  tx: Prisma.TransactionClient,
  args: {
    tenantId: string;
    closeTaskId: string;
    fromStatus: CloseTaskStatus | null;
    toStatus: CloseTaskStatus;
    reason: string | null;
    changedById: string;
  }
): Promise<void> {
  await tx.closeTaskStateChange.create({
    data: {
      tenantId: args.tenantId,
      closeTaskId: args.closeTaskId,
      fromStatus: args.fromStatus,
      toStatus: args.toStatus,
      reason: args.reason,
      changedById: args.changedById,
    },
  });
}

// ─────────────────────────────────────────────────────────────────────────
// startTask
//
// NOT_STARTED|BLOCKED → IN_PROGRESS. Refuses if any dependency isn't
// in a terminal state. Mirrors BlackLine's "you can't work this until
// the predecessors are done" UX — a controller who tries to run
// depreciation before accruing payroll gets a clear blocker, not a
// silent state change.
// ─────────────────────────────────────────────────────────────────────────
export async function startTask(
  input: z.infer<typeof StartInput>
): Promise<TaskResult> {
  const parsed = StartInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: {
      id: true,
      status: true,
      dependsOnIds: true,
      periodId: true,
    },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");
  if (TERMINAL.includes(task.status)) {
    return fail("TERMINAL", `Cannot start a ${task.status} task`);
  }
  if (task.status === "IN_PROGRESS") {
    // Idempotent: already running. Return success without audit.
    return { ok: true, taskId: task.id };
  }

  // Dependency check. A task can start when every predecessor is DONE
  // or WAIVED. Anything else (NOT_STARTED, IN_PROGRESS, BLOCKED)
  // blocks. We pull all predecessors in one query — the dependsOnIds
  // array is bounded (a single task rarely depends on more than ~5).
  if (task.dependsOnIds.length > 0) {
    const predecessors = await prisma.closeTask.findMany({
      where: {
        id: { in: task.dependsOnIds },
        tenantId: tenant.id,
      },
      select: { id: true, name: true, status: true },
    });
    const blocking = predecessors.filter(
      (p) => !TERMINAL.includes(p.status)
    );
    if (blocking.length > 0) {
      return fail(
        "BLOCKED_BY_DEPENDENCY",
        `Waiting on: ${blocking.map((b) => b.name).join(", ")}`
      );
    }
    // Sanity check: if every predecessor existed and is terminal, OK.
    // Missing predecessors (deleted upstream task) are not a hard
    // block — log it but allow the start. The dep array is advisory
    // when its targets vanish.
  }

  await prisma.$transaction(async (tx) => {
    await tx.closeTask.update({
      where: { id: task.id },
      data: { status: "IN_PROGRESS" },
    });
    await recordStateChange(tx, {
      tenantId: tenant.id,
      closeTaskId: task.id,
      fromStatus: task.status,
      toStatus: "IN_PROGRESS",
      reason: null,
      changedById: user.id,
    });
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.start",
    resource: "CloseTask",
    resourceId: task.id,
    tenantId: tenant.id,
    metadata: { previousStatus: task.status },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  revalidatePath(`/close/tasks`);
  return { ok: true, taskId: task.id };
}

// ─────────────────────────────────────────────────────────────────────────
// completeTask  IN_PROGRESS → DONE.
// ─────────────────────────────────────────────────────────────────────────
export async function completeTask(
  input: z.infer<typeof CompleteInput>
): Promise<TaskResult> {
  const parsed = CompleteInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: { id: true, status: true },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");
  if (task.status === "DONE") return { ok: true, taskId: task.id };
  if (task.status !== "IN_PROGRESS") {
    return fail(
      "WRONG_STATUS",
      `Cannot complete a ${task.status} task — start it first`
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.closeTask.update({
      where: { id: task.id },
      data: {
        status: "DONE",
        completedById: user.id,
        completedAt: new Date(),
        evidenceUrl: parsed.data.evidenceUrl ?? null,
        evidenceNote: parsed.data.evidenceNote ?? null,
      },
    });
    await recordStateChange(tx, {
      tenantId: tenant.id,
      closeTaskId: task.id,
      fromStatus: task.status,
      toStatus: "DONE",
      reason: null,
      changedById: user.id,
    });
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.complete",
    resource: "CloseTask",
    resourceId: task.id,
    tenantId: tenant.id,
    metadata: {
      hasEvidenceUrl: !!parsed.data.evidenceUrl,
      hasEvidenceNote: !!parsed.data.evidenceNote,
    },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  revalidatePath(`/close/tasks`);
  return { ok: true, taskId: task.id };
}

// ─────────────────────────────────────────────────────────────────────────
// blockTask  Any non-terminal → BLOCKED with reason.
// ─────────────────────────────────────────────────────────────────────────
export async function blockTask(
  input: z.infer<typeof BlockInput>
): Promise<TaskResult> {
  const parsed = BlockInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: { id: true, status: true },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");
  if (TERMINAL.includes(task.status)) {
    return fail("TERMINAL", `Cannot block a ${task.status} task`);
  }
  if (task.status === "BLOCKED") return { ok: true, taskId: task.id };

  const reasonTrimmed = parsed.data.reason.trim();
  await prisma.$transaction(async (tx) => {
    await tx.closeTask.update({
      where: { id: task.id },
      data: {
        status: "BLOCKED",
        blockedReason: reasonTrimmed,
      },
    });
    await recordStateChange(tx, {
      tenantId: tenant.id,
      closeTaskId: task.id,
      fromStatus: task.status,
      toStatus: "BLOCKED",
      reason: reasonTrimmed,
      changedById: user.id,
    });
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.block",
    resource: "CloseTask",
    resourceId: task.id,
    tenantId: tenant.id,
    metadata: {
      previousStatus: task.status,
      reason: parsed.data.reason.trim(),
    },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  revalidatePath(`/close/tasks`);
  return { ok: true, taskId: task.id };
}

// ─────────────────────────────────────────────────────────────────────────
// unblockTask  BLOCKED → IN_PROGRESS (clears blockedReason).
// ─────────────────────────────────────────────────────────────────────────
export async function unblockTask(
  input: z.infer<typeof UnblockInput>
): Promise<TaskResult> {
  const parsed = UnblockInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: { id: true, status: true, blockedReason: true },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");
  if (task.status !== "BLOCKED") {
    return fail("WRONG_STATUS", `Cannot unblock a ${task.status} task`);
  }

  await prisma.$transaction(async (tx) => {
    await tx.closeTask.update({
      where: { id: task.id },
      data: {
        status: "IN_PROGRESS",
        blockedReason: null,
      },
    });
    await recordStateChange(tx, {
      tenantId: tenant.id,
      closeTaskId: task.id,
      fromStatus: "BLOCKED",
      toStatus: "IN_PROGRESS",
      reason: null,
      changedById: user.id,
    });
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.unblock",
    resource: "CloseTask",
    resourceId: task.id,
    tenantId: tenant.id,
    metadata: { clearedReason: task.blockedReason },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  revalidatePath(`/close/tasks`);
  return { ok: true, taskId: task.id };
}

// ─────────────────────────────────────────────────────────────────────────
// waiveTask  Admin-only. Any non-terminal → WAIVED. Reason mandatory.
// ─────────────────────────────────────────────────────────────────────────
export async function waiveTask(
  input: z.infer<typeof WaiveInput>
): Promise<TaskResult> {
  const parsed = WaiveInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();
  // requireTenantAdmin throws TenantAdminRequiredError; map to a
  // structured TaskResult for the UI.
  try {
    await requireTenantAdmin();
  } catch {
    return fail(
      "NOT_ADMIN",
      "Only a tenant admin can waive a close task"
    );
  }

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: { id: true, status: true },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");
  if (TERMINAL.includes(task.status)) {
    return fail("TERMINAL", `Cannot waive a ${task.status} task`);
  }

  const waiveReason = parsed.data.reason.trim();
  await prisma.$transaction(async (tx) => {
    await tx.closeTask.update({
      where: { id: task.id },
      data: {
        status: "WAIVED",
        completedById: user.id,
        completedAt: new Date(),
        // Stash the reason in evidenceNote so the audit-trail is
        // read-out from the same field downstream renderers use for
        // completion evidence. (The audit_log + state-change rows
        // also carry it.)
        evidenceNote: `WAIVED: ${waiveReason}`,
      },
    });
    await recordStateChange(tx, {
      tenantId: tenant.id,
      closeTaskId: task.id,
      fromStatus: task.status,
      toStatus: "WAIVED",
      reason: waiveReason,
      changedById: user.id,
    });
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.waive",
    resource: "CloseTask",
    resourceId: task.id,
    tenantId: tenant.id,
    metadata: {
      previousStatus: task.status,
      reason: parsed.data.reason.trim(),
    },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  revalidatePath(`/close/tasks`);
  return { ok: true, taskId: task.id };
}

// ─────────────────────────────────────────────────────────────────────────
// reassignTask  Owner OR admin. Sets new ownerId + ownerType.
// ─────────────────────────────────────────────────────────────────────────
export async function reassignTask(
  input: z.infer<typeof ReassignInput>
): Promise<TaskResult> {
  const parsed = ReassignInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: { id: true, ownerId: true },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");

  // Authorize: current owner OR admin. Other users can't reassign
  // someone else's task to themselves.
  let isAdmin = false;
  try {
    await requireTenantAdmin();
    isAdmin = true;
  } catch {
    isAdmin = false;
  }
  if (task.ownerId !== user.id && !isAdmin) {
    return fail(
      "FORBIDDEN",
      "Only the task owner or a tenant admin can reassign"
    );
  }

  await prisma.closeTask.update({
    where: { id: task.id },
    data: {
      ownerId: parsed.data.ownerId,
      ownerType: parsed.data.ownerType,
    },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.reassign",
    resource: "CloseTask",
    resourceId: task.id,
    tenantId: tenant.id,
    metadata: {
      previousOwnerId: task.ownerId,
      newOwnerId: parsed.data.ownerId,
      newOwnerType: parsed.data.ownerType,
      asAdmin: isAdmin && task.ownerId !== user.id,
    },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  revalidatePath(`/close/tasks`);
  return { ok: true, taskId: task.id };
}

// ─────────────────────────────────────────────────────────────────────────
// addCloseTaskComment  Anyone with tenant access. Append-only.
// ─────────────────────────────────────────────────────────────────────────
export async function addCloseTaskComment(
  input: z.infer<typeof CommentInput>
): Promise<TaskResult> {
  const parsed = CommentInput.safeParse(input);
  if (!parsed.success) {
    return fail("VALIDATION_FAILED", parsed.error.errors[0]?.message ?? "Invalid input");
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const task = await prisma.closeTask.findFirst({
    where: { id: parsed.data.taskId, tenantId: tenant.id },
    select: { id: true },
  });
  if (!task) return fail("NOT_FOUND", "Task not found");

  const comment = await prisma.closeTaskComment.create({
    data: {
      tenantId: tenant.id,
      closeTaskId: task.id,
      body: parsed.data.body.trim(),
      authorId: user.id,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.comment",
    resource: "CloseTaskComment",
    resourceId: comment.id,
    tenantId: tenant.id,
    metadata: {
      taskId: task.id,
      length: parsed.data.body.trim().length,
    },
  });
  revalidatePath(`/close/tasks/${task.id}`);
  return { ok: true, taskId: task.id };
}

// ═════════════════════════════════════════════════════════════════════════
// instantiateCalendarForPeriod
//
// Bulk-creates one CloseTask per active CloseTaskTemplate for the
// given period. Resolves each template's defaultDependsOnKeys to the
// matching templateKey-tagged task UUIDs. Idempotent on
// (periodId, templateKey) — already-instantiated templates skip.
//
// Cycle prevention: depth-first scan over the template graph BEFORE
// any DB write. A cycle (A → B → A) fails with INSTANTIATE_CYCLE,
// not a partial write.
// ═════════════════════════════════════════════════════════════════════════
export async function instantiateCalendarForPeriod(
  input: z.infer<typeof InstantiateInput>
): Promise<InstantiateResult> {
  const parsed = InstantiateInput.safeParse(input);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_FAILED", error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  const period = await prisma.period.findFirst({
    where: { id: parsed.data.periodId, tenantId: tenant.id },
    select: { id: true, code: true, endsOn: true },
  });
  if (!period) {
    return { ok: false, code: "NOT_FOUND", error: "Period not in this tenant" };
  }

  // Refuse if the period is closed for any (entity, book) tuple — same
  // reasoning as recon auto-open. Instantiating a calendar against a
  // frozen period is a controller workflow error.
  const anyClose = await prisma.periodClose.findFirst({
    where: { tenantId: tenant.id, periodId: period.id },
    select: { id: true },
  });
  if (anyClose) {
    return {
      ok: false,
      code: "PERIOD_CLOSED",
      error: "Cannot instantiate calendar for a closed period",
    };
  }

  // Pull every active template for the tenant.
  const templates = await prisma.closeTaskTemplate.findMany({
    where: { tenantId: tenant.id, active: true },
    select: {
      key: true,
      name: true,
      description: true,
      category: true,
      defaultOwnerId: true,
      defaultOwnerType: true,
      defaultDueOffsetDays: true,
      requiredForClose: true,
      defaultDependsOnKeys: true,
    },
  });

  if (templates.length === 0) {
    return { ok: true, created: 0, skipped: 0, total: 0 };
  }

  // ── Cycle prevention ────────────────────────────────────────────
  // DFS each template; if we revisit a node in the current path, fail.
  const keyToDeps = new Map<string, string[]>();
  for (const t of templates) {
    keyToDeps.set(t.key, t.defaultDependsOnKeys);
  }
  const VISITING = 1;
  const DONE_DFS = 2;
  const state = new Map<string, 1 | 2>();
  function visit(key: string, path: string[]): string | null {
    if (state.get(key) === DONE_DFS) return null;
    if (state.get(key) === VISITING) {
      // Cycle. Report the loop for human debugging.
      const loopStart = path.indexOf(key);
      const loop = path.slice(loopStart).concat(key).join(" → ");
      return loop;
    }
    state.set(key, VISITING);
    const deps = keyToDeps.get(key) ?? [];
    for (const d of deps) {
      // Skip missing-template references — they're advisory dangling
      // pointers, not a structural cycle.
      if (!keyToDeps.has(d)) continue;
      const found = visit(d, path.concat(key));
      if (found) return found;
    }
    state.set(key, DONE_DFS);
    return null;
  }
  for (const t of templates) {
    const cycle = visit(t.key, []);
    if (cycle) {
      return {
        ok: false,
        code: "INSTANTIATE_CYCLE",
        error: `Cyclic template dependency: ${cycle}`,
      };
    }
  }

  // Find templates already instantiated for this period — those will
  // be skipped. Identified by (periodId, templateKey) on close_task.
  const existing = await prisma.closeTask.findMany({
    where: {
      tenantId: tenant.id,
      periodId: period.id,
      templateKey: { in: templates.map((t) => t.key) },
    },
    select: { templateKey: true },
  });
  const existingKeys = new Set(existing.map((e) => e.templateKey));

  // Tasks to create. We create in two passes: first all rows without
  // dependsOnIds (since we need each task's id to populate its
  // dependents' arrays), then update dependents with resolved ids.
  // BUT — Postgres lets us do this in one round via a key→id map
  // computed AFTER first-insert. Cleaner: insert all, then update
  // those that have deps in a second pass.
  const toCreate = templates.filter((t) => !existingKeys.has(t.key));

  // First pass: createMany with empty dependsOnIds. Returns count, not
  // ids, so we need a follow-up findMany to build the key→id map.
  const createData: Prisma.CloseTaskCreateManyInput[] = toCreate.map(
    (t) => ({
      tenantId: tenant.id,
      // Tenant-wide instantiation: no entity/book scoping yet. PR 5
      // will handle the (entity, book) fan-out when the seed defines
      // BS-tied tasks.
      periodId: period.id,
      templateKey: t.key,
      name: t.name,
      description: t.description,
      category: t.category,
      status: "NOT_STARTED" as const,
      requiredForClose: t.requiredForClose,
      ownerId: t.defaultOwnerId,
      ownerType: t.defaultOwnerType,
      dueOffsetDays: t.defaultDueOffsetDays,
      dueAt:
        t.defaultDueOffsetDays != null
          ? offsetFromPeriod(period.endsOn, t.defaultDueOffsetDays)
          : null,
      dependsOnIds: [],
    })
  );
  const createResult = await prisma.closeTask.createMany({
    data: createData,
    skipDuplicates: false,
  });

  // Second pass: build the key→id map (now including pre-existing
  // tasks from earlier instantiations) and update rows that have
  // dependsOnKeys → dependsOnIds.
  const allTasksForPeriod = await prisma.closeTask.findMany({
    where: {
      tenantId: tenant.id,
      periodId: period.id,
      templateKey: { in: templates.map((t) => t.key) },
    },
    select: { id: true, templateKey: true },
  });
  const keyToId = new Map<string, string>();
  for (const t of allTasksForPeriod) {
    if (t.templateKey) keyToId.set(t.templateKey, t.id);
  }

  // Update each just-created task with resolved dependsOnIds. Templates
  // without deps stay at [] (the default).
  for (const t of toCreate) {
    if (t.defaultDependsOnKeys.length === 0) continue;
    const resolvedIds: string[] = [];
    for (const depKey of t.defaultDependsOnKeys) {
      const id = keyToId.get(depKey);
      if (id) resolvedIds.push(id);
      // Missing dep key → silently dropped (advisory dangling).
    }
    if (resolvedIds.length === 0) continue;
    const newTaskId = keyToId.get(t.key);
    if (!newTaskId) continue;
    await prisma.closeTask.update({
      where: { id: newTaskId },
      data: { dependsOnIds: resolvedIds },
    });
  }

  // Third pass: state-history initial rows (fromStatus=null) for
  // each just-created task. createMany lands them all in one round
  // trip — append-only trigger lets the bulk-insert through. We can't
  // bundle this with the createMany at the top because we need the
  // task ids, which only land after the find-by-templateKey above.
  const newTaskIds = toCreate
    .map((t) => keyToId.get(t.key))
    .filter((id): id is string => !!id);
  if (newTaskIds.length > 0) {
    await prisma.closeTaskStateChange.createMany({
      data: newTaskIds.map((id) => ({
        tenantId: tenant.id,
        closeTaskId: id,
        fromStatus: null,
        toStatus: "NOT_STARTED" as const,
        reason: null,
        changedById: user.id,
      })),
    });
  }

  // ONE aggregate audit row per invocation.
  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.period.instantiate",
    resource: "CloseTask",
    resourceId: `${period.code}`,
    tenantId: tenant.id,
    metadata: {
      periodId: period.id,
      templatesConsidered: templates.length,
      created: createResult.count,
      skipped: existingKeys.size,
    },
  });
  revalidatePath(`/close/tasks`);

  return {
    ok: true,
    created: createResult.count,
    skipped: existingKeys.size,
    total: allTasksForPeriod.length,
  };
}

// Helper: period.endsOn + offsetDays. Negative offset = before period
// end. The TS Date arithmetic is in milliseconds; we use millis-per-day
// directly since we don't need DST-aware math (fiscal calendars are
// date-only).
function offsetFromPeriod(endsOn: Date, offsetDays: number): Date {
  const MS_PER_DAY = 1000 * 60 * 60 * 24;
  return new Date(endsOn.getTime() + offsetDays * MS_PER_DAY);
}
