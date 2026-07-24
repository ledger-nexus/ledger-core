// Admin user-lifecycle dashboard.
//
// Lists every user with their active/deactivated status, currently-owned
// record counts (a proxy for "what happens if I deactivate them?"), and
// per-user actions:
//
//   - Active users: "Deactivate" expands a preflight panel — pick a
//     reassignment target (queue or user) OR opt to let records become
//     orphans (admin triages later via /admin/orphans)
//   - Deactivated users: "Reactivate" flips them back to active
//
// Permission-gated by requireAdmin (currently controller@northwind.test only).
//
// This page is intentionally the orphan dashboard's prevention-side
// counterpart. The deactivation preflight is the in-miniature version of
// the broader role-change preflight UX from docs/ownership-and-rules.md.

import { prisma } from "@/lib/db";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getViewerRole } from "@/lib/auth/authorize";
import { canManageUsers } from "@/lib/auth/policy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { DeactivateForm, ReactivateButton } from "./deactivate-form";

export default async function UsersPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return <PermissionDenied reason={new NotAuthenticatedError().message} />;
  }
  if (!canManageUsers(await getViewerRole())) {
    return <PermissionDenied reason="This page requires admin access" />;
  }

  const [users, queues, ownerJeCounts, ownerArCounts] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ isActive: "desc" }, { displayName: "asc" }],
      select: {
        id: true,
        email: true,
        displayName: true,
        isActive: true,
        deactivatedAt: true,
        createdAt: true,
      },
    }),
    prisma.queue.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, name: true },
      orderBy: { code: "asc" },
    }),
    // Bulk count of JournalEntry ownership by user. groupBy is faster
    // than N+1 per-user queries.
    prisma.journalEntry.groupBy({
      by: ["ownerId"],
      where: { ownerType: "USER", ownerId: { not: null } },
      _count: { _all: true },
    }),
    prisma.arOpenItem.groupBy({
      by: ["ownerId"],
      where: {
        ownerType: "USER",
        ownerId: { not: null },
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      _count: { _all: true },
    }),
  ]);

  const jeCountById = new Map<string, number>();
  for (const row of ownerJeCounts) {
    if (row.ownerId) jeCountById.set(row.ownerId, row._count._all);
  }
  const arCountById = new Map<string, number>();
  for (const row of ownerArCounts) {
    if (row.ownerId) arCountById.set(row.ownerId, row._count._all);
  }

  // Pool for the "reassign all to: user X" picker — exclude the user
  // being deactivated AND any other inactive user.
  const allActiveUsers = users
    .filter((u) => u.isActive)
    .map((u) => ({ id: u.id, displayName: u.displayName }));

  const activeCount = users.filter((u) => u.isActive).length;
  const inactiveCount = users.length - activeCount;

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">Users</h1>
        <p className="text-sm text-ink-500">
          Deactivating a user is what creates orphan records — this page is
          the prevention-side counterpart to{" "}
          <code className="font-mono">/admin/orphans</code>. Reassign owned
          records BEFORE flipping isActive, or skip and triage via the
          orphan dashboard afterward.
        </p>
      </header>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Metric label="Total users" value={String(users.length)} />
        <Metric label="Active" value={String(activeCount)} />
        <Metric label="Deactivated" value={String(inactiveCount)} />
        <Metric
          label="Owned records"
          value={String(
            [...jeCountById.values()].reduce((a, b) => a + b, 0) +
              [...arCountById.values()].reduce((a, b) => a + b, 0)
          )}
          hint="JE + open AR across all users"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>All users</CardTitle>
          <span className="text-xs text-ink-500">
            "Owned" counts only OPEN/PARTIAL/REOPENED AR items + all JEs (terminal states are excluded — those are frozen historical records)
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <tr>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Status</TH>
                <TH className="text-right">Owned (JE / AR)</TH>
                <TH>Deactivated</TH>
                <TH>Action</TH>
              </tr>
            </THead>
            <TBody>
              {users.map((u) => {
                const jeCount = jeCountById.get(u.id) ?? 0;
                const arCount = arCountById.get(u.id) ?? 0;
                const isCurrent = u.id === currentUser.id;
                return (
                  <TR key={u.id}>
                    <TD className="text-ink-900">
                      {u.displayName}
                      {isCurrent ? (
                        <span className="ml-1 text-[10px] text-ink-400">(you)</span>
                      ) : null}
                    </TD>
                    <TD className="font-mono text-xs text-ink-600">{u.email}</TD>
                    <TD>
                      <Badge tone={u.isActive ? "positive" : "neutral"}>
                        {u.isActive ? "Active" : "Deactivated"}
                      </Badge>
                    </TD>
                    <TD className="text-right text-xs text-ink-600">
                      <span className={jeCount + arCount > 0 ? "font-semibold" : ""}>
                        {jeCount} / {arCount}
                      </span>
                    </TD>
                    <TD className="text-xs text-ink-500">
                      {u.deactivatedAt
                        ? u.deactivatedAt.toISOString().slice(0, 10)
                        : "—"}
                    </TD>
                    <TD>
                      {isCurrent ? (
                        <span className="text-[11px] text-ink-400">
                          can't act on self
                        </span>
                      ) : u.isActive ? (
                        <DeactivateForm
                          userId={u.id}
                          userName={u.displayName}
                          ownedCounts={{
                            JournalEntry: jeCount,
                            ArOpenItem: arCount,
                          }}
                          queues={queues}
                          users={allActiveUsers.filter((au) => au.id !== u.id)}
                        />
                      ) : (
                        <ReactivateButton userId={u.id} userName={u.displayName} />
                      )}
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Demo scenario</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-600">
          <ol className="list-decimal space-y-1 pl-5">
            <li>
              Pick a user that owns records (Anna AR Clerk owns the small AR
              items; Carla Controller owns the large Globex one via the
              senior-collectors queue membership)
            </li>
            <li>
              Click <span className="font-medium text-red-700">Deactivate</span>{" "}
              and choose <span className="font-medium">Skip</span> — records
              become orphans
            </li>
            <li>
              Open{" "}
              <code className="font-mono">/admin/orphans</code> — you&rsquo;ll
              see them surface with cause{" "}
              <span className="font-mono">user deactivated</span>
            </li>
            <li>
              Reassign them via the orphan dashboard, or reactivate the user
              here
            </li>
          </ol>
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
          Pick the <span className="font-medium">Carla Controller</span> user
          from the switcher in the header to view this page (interim email
          allowlist).
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
