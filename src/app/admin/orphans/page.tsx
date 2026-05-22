// Admin orphan dashboard.
//
// Surfaces records whose owner is no longer valid — user deactivated,
// queue deleted/inactive, owner id null, etc. The orphan-detection
// function (src/lib/ownership/orphan-detection.ts) does a full scan
// each render; for v1 that's fine, at scale move to a materialized
// daily-scan table.
//
// Permission: admin-only via requireAdmin (currently an email allowlist
// stub). When real role grants land, this becomes a permission check
// against `can_access:admin.orphans`.
//
// What this page does NOT do (deferred):
//   - Bulk reassign (multi-select + apply)
//   - "Run rules on this record" button (fires ON_USER_LIFECYCLE rules)
//   - CSV export
//   - Pagination (capped at findOrphans() default limit)

import Link from "next/link";
import { prisma } from "@/lib/db";
import { findOrphans } from "@/lib/ownership/orphan-detection";
import {
  getCurrentUser,
  isAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { OrphanReassignRow } from "./orphan-row";

const CAUSE_TONES: Record<string, "negative" | "warning" | "info" | "neutral"> = {
  OWNER_USER_NOT_FOUND: "negative",
  OWNER_USER_INACTIVE: "warning",
  OWNER_QUEUE_NOT_FOUND: "negative",
  OWNER_QUEUE_INACTIVE: "warning",
  OWNER_QUEUE_DELETED: "warning",
  OWNER_ID_NULL: "info",
};

const CAUSE_DISPLAY: Record<string, string> = {
  OWNER_USER_NOT_FOUND: "user not found",
  OWNER_USER_INACTIVE: "user deactivated",
  OWNER_QUEUE_NOT_FOUND: "queue not found",
  OWNER_QUEUE_INACTIVE: "queue inactive",
  OWNER_QUEUE_DELETED: "queue deleted",
  OWNER_ID_NULL: "no owner set",
};

export default async function OrphansPage() {
  // Permission gate. Surface a friendly error UI rather than 404 — admins
  // need to be able to debug their own access.
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return <PermissionDenied reason={new NotAuthenticatedError().message} />;
  }
  if (!isAdmin(currentUser)) {
    return <PermissionDenied reason={new NotAuthorizedError().message} />;
  }

  const [orphans, users, queues] = await Promise.all([
    findOrphans(prisma, { limit: 200 }),
    prisma.user.findMany({
      select: { id: true, displayName: true, isActive: true },
    }),
    prisma.queue.findMany({
      select: { id: true, name: true, isActive: true, deletedAt: true },
    }),
  ]);

  // Maps for resolving owner display labels — including inactive/deleted
  // ones so the dashboard can show "Jane Smith (deactivated)" etc.
  const userMap = new Map(users.map((u) => [u.id, u]));
  const queueMap = new Map(queues.map((q) => [q.id, q]));

  // Active-only options for the reassign dropdown (you can't reassign TO
  // a deactivated user or deleted queue).
  const activeUsers = users
    .filter((u) => u.isActive)
    .map((u) => ({ id: u.id, displayName: u.displayName }));
  const activeQueues = queues
    .filter((q) => q.isActive && !q.deletedAt)
    .map((q) => ({ id: q.id, name: q.name }));

  // Headline counts by cause + type.
  const causeCounts = new Map<string, number>();
  const typeCounts = new Map<string, number>();
  for (const o of orphans) {
    causeCounts.set(o.cause, (causeCounts.get(o.cause) ?? 0) + 1);
    typeCounts.set(o.recordType, (typeCounts.get(o.recordType) ?? 0) + 1);
  }

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Orphaned records</h1>
        <p className="text-sm text-ink-500">
          Records whose owner is no longer valid — typically because the user was
          deactivated or the queue was deleted. The reassignment-rules engine
          skips these records; the admin must resolve them explicitly.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Total orphans" value={String(orphans.length)} />
        <Metric
          label="Journal entries"
          value={String(typeCounts.get("JournalEntry") ?? 0)}
        />
        <Metric
          label="AR open items"
          value={String(typeCounts.get("ArOpenItem") ?? 0)}
        />
        <Metric
          label="Causes"
          value={String(causeCounts.size)}
          hint={[...causeCounts.entries()]
            .map(([k, v]) => `${CAUSE_DISPLAY[k] ?? k}: ${v}`)
            .join(", ")}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All orphaned records</CardTitle>
          <span className="text-xs text-ink-500">
            Capped at 200 per scan · click <span className="font-medium">reassign</span>{" "}
            to route to an active user or queue
          </span>
        </CardHeader>
        <CardContent className={orphans.length === 0 ? "" : "p-0"}>
          {orphans.length === 0 ? (
            <EmptyState
              title="No orphans detected"
              description="Every ownership-bearing record points at a valid user or active queue. The dashboard re-scans on every page load."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Type</TH>
                  <TH>Record</TH>
                  <TH>Entity / book</TH>
                  <TH>Last owner</TH>
                  <TH>Cause</TH>
                  <TH className="text-right">Age</TH>
                  <TH>Action</TH>
                </tr>
              </THead>
              <TBody>
                {orphans.map((o) => {
                  const ownerLabel = resolveOwnerLabel(o, userMap, queueMap);
                  const ageBadge = ageDaysBadge(o.ageDays);
                  return (
                    <TR key={`${o.recordType}:${o.recordId}`}>
                      <TD>
                        <Badge tone="neutral">{o.recordType}</Badge>
                      </TD>
                      <TD className="font-mono text-xs text-ink-700">
                        {o.recordType === "JournalEntry" ? (
                          <Link
                            href={`/journal-entries/${o.recordId}`}
                            className="hover:underline"
                          >
                            {o.recordId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span>{o.recordId.slice(0, 8)}</span>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-600">
                        <div>{o.entityCode}</div>
                        <div className="text-[11px] text-ink-400">{o.bookCode}</div>
                      </TD>
                      <TD className="text-xs">
                        {ownerLabel ? (
                          <span className="text-ink-700">{ownerLabel}</span>
                        ) : (
                          <span className="text-ink-400">—</span>
                        )}
                      </TD>
                      <TD>
                        <Badge tone={CAUSE_TONES[o.cause] ?? "neutral"}>
                          {CAUSE_DISPLAY[o.cause] ?? o.cause}
                        </Badge>
                      </TD>
                      <TD className="text-right">
                        <span className={ageBadge.className}>{o.ageDays}d</span>
                      </TD>
                      <TD>
                        <OrphanReassignRow
                          recordType={o.recordType}
                          recordId={o.recordId}
                          users={activeUsers}
                          queues={activeQueues}
                        />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>How orphans get created</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-600">
          <ul className="list-disc space-y-1 pl-5">
            <li>
              An admin deactivates a user without first reassigning their owned records
            </li>
            <li>An admin deletes (or soft-deletes) a queue that records were assigned to</li>
            <li>A bug or migration leaves <code className="font-mono">ownerId</code> set to an id that doesn&rsquo;t resolve</li>
            <li>
              A user&rsquo;s role/scope changes such that they lose access to a module
              they own records in (NOT yet detected by this scan — requires
              roles+permissions; coming when the catalog from{" "}
              <code className="font-mono">docs/ownership-and-rules.md</code> lands)
            </li>
          </ul>
          <p className="mt-3 text-ink-500">
            Periodic auto-scan + materialized table + role-change preflight UX are
            planned follow-ups. Today the page re-scans on load.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function PermissionDenied({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-ink-900">Admin only</h2>
        <p className="mt-1 text-sm text-ink-500">{reason}</p>
        <p className="mt-3 text-xs text-ink-400">
          Pick the <span className="font-medium">Carla Controller</span> user from
          the switcher in the header to view this page (interim email allowlist).
        </p>
      </CardContent>
    </Card>
  );
}

function Metric({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div className="mt-1 text-lg font-semibold text-ink-900">{value}</div>
        {hint ? <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div> : null}
      </CardContent>
    </Card>
  );
}

function resolveOwnerLabel(
  o: { ownerId: string | null; ownerType: "USER" | "QUEUE" },
  userMap: Map<string, { displayName: string; isActive: boolean }>,
  queueMap: Map<string, { name: string; isActive: boolean; deletedAt: Date | null }>
): string | null {
  if (!o.ownerId) return null;
  if (o.ownerType === "USER") {
    const u = userMap.get(o.ownerId);
    if (!u) return `(user ${o.ownerId.slice(0, 8)} — deleted)`;
    return u.isActive ? u.displayName : `${u.displayName} (deactivated)`;
  }
  const q = queueMap.get(o.ownerId);
  if (!q) return `(queue ${o.ownerId.slice(0, 8)} — deleted)`;
  if (q.deletedAt) return `${q.name} (deleted)`;
  if (!q.isActive) return `${q.name} (inactive)`;
  return q.name;
}

function ageDaysBadge(ageDays: number): { className: string } {
  if (ageDays > 30) return { className: "text-negative font-semibold" };
  if (ageDays > 14) return { className: "text-amber-700" };
  return { className: "text-ink-500" };
}
