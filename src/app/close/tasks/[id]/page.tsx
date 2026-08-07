// BlackLine arc — Phase 2 PR 4: Close task detail page.
//
// /close/tasks/[id] is where a controller goes to actually work a
// single close task. Wires PR 2's 7 status actions to affordances via
// the task-actions client island. Renders the dependency graph as a
// reverse-FK list with status badges on each predecessor — clicking a
// blocked dependency takes the user to its detail page, click-chains
// through the graph.
//
// Affordance matrix (status × who):
//
//   NOT_STARTED     [Start] · [Block] · [Reassign] · [Waive (admin)]
//   IN_PROGRESS     [Complete] · [Block] · [Reassign] · [Waive (admin)]
//   BLOCKED         [Unblock] · [Reassign] · [Waive (admin)]
//   DONE / WAIVED   read-only · evidence + completer rendered
//
// Server-side enforcement matrix lives in the Server Actions
// (src/app/actions/close-tasks.ts); the page's job is to render the
// right buttons for the current user/state. Server actions re-check
// on every submit — the page is presentational.

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant, isTenantAdmin } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils/format";
import type { CloseTaskStatus } from "@prisma/client";
import TaskActions from "./task-actions";
import CommentForm from "./comment-form";

const STATUS_TONES: Record<
  CloseTaskStatus,
  "neutral" | "positive" | "negative" | "warning" | "info"
> = {
  NOT_STARTED: "neutral",
  IN_PROGRESS: "info",
  BLOCKED: "negative",
  DONE: "positive",
  WAIVED: "neutral",
};

// Mirror of PR 3 — server-side overdue check.
function isOverdue(
  dueAt: Date | null,
  status: CloseTaskStatus,
  today: Date
): boolean {
  if (!dueAt) return false;
  if (status === "DONE" || status === "WAIVED") return false;
  return dueAt < today;
}

export default async function CloseTaskDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  if (!user || !tenant) return notFound();

  const task = await prisma.closeTask.findFirst({
    where: { id: params.id, tenantId: tenant.id },
    select: {
      id: true,
      name: true,
      description: true,
      category: true,
      status: true,
      requiredForClose: true,
      ownerId: true,
      ownerType: true,
      dueOffsetDays: true,
      dueAt: true,
      dependsOnIds: true,
      blockedReason: true,
      completedById: true,
      completedAt: true,
      evidenceUrl: true,
      evidenceNote: true,
      templateKey: true,
      createdAt: true,
      updatedAt: true,
      period: {
        select: { id: true, code: true, startsOn: true, endsOn: true },
      },
      entity: { select: { code: true, name: true } },
      book: { select: { code: true, name: true } },
      owner: { select: { id: true, displayName: true, email: true } },
      completer: { select: { displayName: true, email: true } },
      comments: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          body: true,
          createdAt: true,
          author: { select: { displayName: true } },
        },
      },
      // State-change timeline (migration 0011). Append-only log of
      // every status transition this task has gone through. Rendered
      // chronologically below the Details card.
      stateChanges: {
        orderBy: { changedAt: "asc" },
        select: {
          id: true,
          fromStatus: true,
          toStatus: true,
          reason: true,
          changedAt: true,
          changedBy: { select: { displayName: true, email: true } },
        },
      },
    },
  });
  if (!task) return notFound();

  // Resolve dependency targets — one query to pull all predecessor
  // names + statuses for the graph display. Bounded array (rare to
  // see more than ~5 deps on a single task).
  const predecessors =
    task.dependsOnIds.length > 0
      ? await prisma.closeTask.findMany({
          where: {
            id: { in: task.dependsOnIds },
            tenantId: tenant.id,
          },
          select: { id: true, name: true, status: true },
        })
      : [];

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const overdue = isOverdue(task.dueAt, task.status, today);

  const admin = isTenantAdmin(tenant);
  const isTerminal = task.status === "DONE" || task.status === "WAIVED";

  // Predecessor status check — surface "blocked by N" hint if user
  // tries to start while deps aren't ready. Server still enforces;
  // this is presentational.
  const blockingDeps = predecessors.filter(
    (p) => p.status !== "DONE" && p.status !== "WAIVED"
  );
  const canStartNow =
    (task.status === "NOT_STARTED" || task.status === "BLOCKED") &&
    blockingDeps.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-2">
        <div className="text-xs text-ink-500">
          <Link
            href={`/close/tasks?period=${task.period.code}`}
            className="text-accent-600 hover:underline"
          >
            ← All close tasks
          </Link>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">{task.name}</h1>
          <Badge tone={STATUS_TONES[task.status]}>{task.status}</Badge>
          <Badge tone="neutral">{task.category}</Badge>
          {!task.requiredForClose && (
            <Badge tone="neutral" title="Optional — does not block period close">
              optional
            </Badge>
          )}
          {overdue && <Badge tone="negative">overdue</Badge>}
        </div>
        <p className="text-xs text-ink-500">
          Period <span className="font-mono">{task.period.code}</span> (
          {formatDate(task.period.startsOn)} → {formatDate(task.period.endsOn)})
          {task.entity && (
            <> · {task.entity.code}{task.book ? ` / ${task.book.code}` : ""}</>
          )}
          {task.templateKey && (
            <> · from template <span className="font-mono">{task.templateKey}</span></>
          )}
        </p>
        {task.description && (
          <p className="text-sm text-ink-700">{task.description}</p>
        )}
      </header>

      {/* Action panel — branches on status. Each button calls one
          Server Action; rerenders via revalidatePath in the action. */}
      {!isTerminal && (
        <Card>
          <CardHeader>
            <CardTitle>Actions</CardTitle>
            <span className="text-xs text-ink-500">
              {task.status === "NOT_STARTED" && canStartNow
                ? "Ready to start"
                : task.status === "NOT_STARTED" && !canStartNow
                  ? `Waiting on: ${blockingDeps.map((d) => d.name).join(", ")}`
                  : task.status === "IN_PROGRESS"
                    ? "Mark complete with evidence, or pause"
                    : task.status === "BLOCKED"
                      ? "Currently blocked — unblock to resume"
                      : ""}
            </span>
          </CardHeader>
          <CardContent>
            <TaskActions
              taskId={task.id}
              status={task.status}
              canStart={canStartNow}
              ownerId={task.ownerId}
              currentUserId={user.id}
              admin={admin}
            />
          </CardContent>
        </Card>
      )}

      {/* Dependency graph — list-of-predecessors with status badges
          and click-through. The forward direction (descendants of this
          task) is intentionally not shown here; viewing a task in
          isolation prioritizes "what's blocking me" over "who's
          waiting on me". */}
      {predecessors.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              Dependencies ({predecessors.length})
            </CardTitle>
            <span className="text-xs text-ink-500">
              All must be DONE or WAIVED before this task can start
            </span>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {predecessors.map((p) => {
                const ready =
                  p.status === "DONE" || p.status === "WAIVED";
                return (
                  <li
                    key={p.id}
                    className="flex items-center justify-between rounded-md border border-ink-100 px-3 py-2"
                  >
                    <Link
                      href={`/close/tasks/${p.id}`}
                      className="text-sm text-ink-900 hover:underline"
                    >
                      {ready ? "✓" : "○"} {p.name}
                    </Link>
                    <Badge tone={STATUS_TONES[p.status]}>{p.status}</Badge>
                  </li>
                );
              })}
            </ul>
          </CardContent>
        </Card>
      )}

      {/* History — opened-at, due, blocked reason, completion. */}
      <Card>
        <CardHeader>
          <CardTitle>Details</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-y-2 text-sm">
            <dt className="text-ink-500">Owner</dt>
            <dd className="text-ink-700">
              {task.ownerType === "QUEUE" ? (
                <span>queue · {task.ownerId?.slice(0, 8) ?? "—"}</span>
              ) : task.owner?.displayName ? (
                task.owner.displayName
              ) : (
                <span className="text-ink-500">unassigned</span>
              )}
            </dd>
            <dt className="text-ink-500">Due</dt>
            <dd className={overdue ? "text-red-700 font-medium" : "text-ink-700"}>
              {task.dueAt ? formatDate(task.dueAt) : "—"}
              {task.dueOffsetDays != null && (
                <span className="ml-2 text-xs text-ink-500">
                  ({task.dueOffsetDays >= 0 ? "+" : ""}
                  {task.dueOffsetDays}d from period end)
                </span>
              )}
            </dd>
            <dt className="text-ink-500">Opened</dt>
            <dd className="text-ink-700">{formatDate(task.createdAt)}</dd>
            {task.status === "BLOCKED" && task.blockedReason && (
              <>
                <dt className="text-ink-500">Blocked because</dt>
                <dd className="text-red-700 whitespace-pre-wrap">
                  {task.blockedReason}
                </dd>
              </>
            )}
            {task.completedAt && (
              <>
                <dt className="text-ink-500">
                  {task.status === "WAIVED" ? "Waived" : "Completed"}
                </dt>
                <dd className="text-ink-700">
                  {formatDate(task.completedAt)}
                  {task.completer?.displayName && (
                    <> · {task.completer.displayName}</>
                  )}
                </dd>
              </>
            )}
            {task.evidenceUrl && (
              <>
                <dt className="text-ink-500">Evidence link</dt>
                <dd>
                  <a
                    href={task.evidenceUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="text-accent-600 hover:underline"
                  >
                    {task.evidenceUrl}
                  </a>
                </dd>
              </>
            )}
            {task.evidenceNote && (
              <>
                <dt className="text-ink-500">Evidence note</dt>
                <dd className="text-ink-700 whitespace-pre-wrap">
                  {task.evidenceNote}
                </dd>
              </>
            )}
            <dt className="text-ink-500">Last updated</dt>
            <dd className="text-ink-700">{formatDate(task.updatedAt)}</dd>
          </dl>
        </CardContent>
      </Card>

      {/* State-change timeline (migration 0011). Append-only log of
          every status transition this task has been through. Hidden
          for tasks with no history (rare — only backfill rows on
          pre-0011 data can leave a task with no entries). */}
      {task.stateChanges.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              State history ({task.stateChanges.length})
            </CardTitle>
            <span className="text-xs text-ink-500">
              Append-only — auditor record of every status transition
            </span>
          </CardHeader>
          <CardContent>
            <ol className="flex flex-col gap-2 text-sm">
              {task.stateChanges.map((sc) => {
                const isBackfill = sc.changedBy === null;
                return (
                  <li
                    key={sc.id}
                    className="flex flex-col gap-0.5 rounded-md border border-ink-100 px-3 py-2"
                  >
                    <div className="flex items-center gap-2 text-xs text-ink-500">
                      <span className="font-mono text-ink-700">
                        {sc.fromStatus ?? "INITIAL"}
                      </span>
                      <span>→</span>
                      <Badge tone={STATUS_TONES[sc.toStatus]}>
                        {sc.toStatus}
                      </Badge>
                      <span className="ml-auto">{formatDate(sc.changedAt)}</span>
                    </div>
                    <div className="text-xs text-ink-500">
                      {isBackfill ? (
                        <span className="italic">
                          system backfill (pre-0011)
                        </span>
                      ) : (
                        <>
                          by{" "}
                          <span className="text-ink-700">
                            {sc.changedBy?.displayName ?? sc.changedBy?.email ?? "—"}
                          </span>
                        </>
                      )}
                    </div>
                    {sc.reason && (
                      <p className="mt-1 whitespace-pre-wrap text-ink-700">
                        {sc.reason}
                      </p>
                    )}
                  </li>
                );
              })}
            </ol>
          </CardContent>
        </Card>
      )}

      {/* Comment thread — chronological. Append-only form below. */}
      <Card>
        <CardHeader>
          <CardTitle>
            Comments ({task.comments.length})
          </CardTitle>
          <span className="text-xs text-ink-500">
            Conversation thread — visible to everyone with tenant access
          </span>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {task.comments.length === 0 ? (
            <p className="text-sm text-ink-500">No comments yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 text-sm">
              {task.comments.map((c) => (
                <li
                  key={c.id}
                  className="rounded-md border border-ink-100 px-3 py-2"
                >
                  <div className="text-xs text-ink-500">
                    <span className="font-medium text-ink-700">
                      {c.author?.displayName ?? "—"}
                    </span>{" "}
                    · {formatDate(c.createdAt)}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-ink-800">
                    {c.body}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-ink-100 pt-4">
            <CommentForm taskId={task.id} />
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
