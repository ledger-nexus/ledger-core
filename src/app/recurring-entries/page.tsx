// Recurring journal entries — list page.
//
// Shows every template in the current tenant with: code, scope (entity /
// book), cadence, posting history (start, last posted, end), how many
// periods are due as of today, and an active toggle. Admin-only controls
// for "Run through today", pause/resume, and delete.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getViewerRole } from "@/lib/auth/authorize";
import { canManageRecurringEntries } from "@/lib/auth/policy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import { enumerateDueDates } from "@/lib/accounting/recurring";
import RecurringRowActions from "./row-actions";
import RunAllButton from "./run-all-button";

export default async function RecurringEntriesPage() {
  const tenant = await getCurrentTenant();
  const admin = canManageRecurringEntries(await getViewerRole());

  if (!tenant) {
    return (
      <EmptyState
        title="No active tenant"
        description="Sign in and select a tenant before viewing recurring entries."
      />
    );
  }

  const templates = await prisma.recurringEntry.findMany({
    where: { tenantId: tenant.id },
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
    select: {
      id: true,
      code: true,
      memo: true,
      cadence: true,
      startDate: true,
      endDate: true,
      lastPostedDate: true,
      isActive: true,
      entity: { select: { code: true } },
      book: { select: { code: true } },
      _count: { select: { lines: true } },
    },
  });

  // "Through today" — same default the Run-all button uses. Showing this
  // up front so admins can see at a glance which templates have entries
  // queued up that they haven't fired yet.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const rows = templates.map((t) => {
    const due = t.isActive
      ? enumerateDueDates({
          cadence: t.cadence,
          startDate: t.startDate,
          lastPostedDate: t.lastPostedDate,
          endDate: t.endDate,
          throughDate: today,
        })
      : [];
    return { ...t, dueCount: due.length, nextDueDate: due[0] ?? null };
  });

  const totalDue = rows.reduce((s, r) => s + r.dueCount, 0);

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">Recurring entries</h1>
          <p className="text-sm text-ink-500 mt-1 max-w-prose">
            Templates that fire on a schedule. Every cadence step posts a fresh
            journal entry via the substrate — same posting boundary, same audit
            trail, same period-close semantics as any manual JE. Re-running on
            the same date is a no-op (lineage dedup).
          </p>
          {totalDue > 0 && (
            <p className="text-sm text-amber-700 mt-2">
              {totalDue} period{totalDue === 1 ? "" : "s"} due across active templates as of today.
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {admin && (
            <>
              <RunAllButton today={today.toISOString().slice(0, 10)} disabled={totalDue === 0} />
              <Link href="/recurring-entries/new">
                <Button>New template</Button>
              </Link>
            </>
          )}
        </div>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Templates ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              title="No recurring entries yet"
              description={
                admin
                  ? "Create your first template to automate predictable monthly entries (rent, payroll, subscriptions)."
                  : "Ask an admin to create the first template."
              }
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Memo</TH>
                  <TH>Scope</TH>
                  <TH>Cadence</TH>
                  <TH>Lines</TH>
                  <TH>Start</TH>
                  <TH>Last posted</TH>
                  <TH>Due</TH>
                  <TH>Status</TH>
                  {admin && <TH>Actions</TH>}
                </TR>
              </THead>
              <TBody>
                {rows.map((r) => (
                  <TR key={r.id}>
                    <TD>
                      <Link
                        href={`/recurring-entries/${r.id}`}
                        className="font-mono text-link hover:underline"
                      >
                        {r.code}
                      </Link>
                    </TD>
                    <TD className="max-w-xs truncate" title={r.memo}>
                      {r.memo}
                    </TD>
                    <TD className="font-mono text-xs text-ink-500">
                      {r.entity.code} · {r.book.code}
                    </TD>
                    <TD>
                      <Badge tone="info">{r.cadence}</Badge>
                    </TD>
                    <TD className="text-right tabular-nums">{r._count.lines}</TD>
                    <TD>{formatDate(r.startDate)}</TD>
                    <TD>{r.lastPostedDate ? formatDate(r.lastPostedDate) : "—"}</TD>
                    <TD className="text-right tabular-nums">
                      {r.dueCount > 0 ? (
                        <span className="text-amber-700">{r.dueCount}</span>
                      ) : (
                        <span className="text-ink-400">0</span>
                      )}
                    </TD>
                    <TD>
                      {r.isActive ? (
                        <Badge tone="positive">Active</Badge>
                      ) : (
                        <Badge tone="neutral">Paused</Badge>
                      )}
                    </TD>
                    {admin && (
                      <TD>
                        <RecurringRowActions
                          id={r.id}
                          code={r.code}
                          isActive={r.isActive}
                          dueCount={r.dueCount}
                          today={today.toISOString().slice(0, 10)}
                        />
                      </TD>
                    )}
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
