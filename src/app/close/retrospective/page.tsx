// BlackLine arc — Phase 4 PR 3: /close/retrospective page.
//
// Close-process improvement loop view. Four panels:
//   - Days-to-close trend (sparkline + SLA target band)
//   - Avg task lead time by category (horizontal bar)
//   - Exception-rate trend (sparkline)
//   - Recurring blockers (top 10 templates)
//
// This is the controller's "are we getting better at closing" lens.
// No mutations — pure read.

import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import { getCloseRetrospective } from "@/lib/close/retrospective";

const CATEGORY_LABELS: Record<string, string> = {
  ACCRUAL: "Accrual",
  RECON: "Reconciliation",
  DEPRECIATION: "Depreciation",
  FX: "FX",
  REVENUE: "Revenue",
  INVENTORY: "Inventory",
  TAX: "Tax",
  REPORTING: "Reporting",
  ADMIN: "Admin",
};

function fmtRate(n: number | null): string {
  if (n === null) return "—";
  return `${(n * 100).toFixed(1)}%`;
}

function fmtDays(n: number | null): string {
  if (n === null) return "—";
  return `${n.toFixed(1)} d`;
}

export default async function CloseRetrospectivePage({
  searchParams,
}: {
  searchParams: { lookback?: string; target?: string };
}) {
  const scope = getScope();
  const tenant = await getCurrentTenant();

  const entity = await prisma.legalEntity.findFirst({
    where: { code: scope.entityCode, ...(tenant ? { tenantId: tenant.id } : {}) },
    select: { id: true, code: true, name: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true, name: true },
  });

  if (!tenant || !entity || !book) {
    return (
      <EmptyState
        title="Scope not found"
        description="Sign in and pick a tenant + (entity, book)."
      />
    );
  }

  // Parse + clamp inputs. Default lookback = 12 periods; default
  // target = 5 calendar days (BlackLine F1000 baseline).
  const lookbackRaw = parseInt(searchParams.lookback ?? "12", 10);
  const lookback = Number.isFinite(lookbackRaw)
    ? Math.max(3, Math.min(36, lookbackRaw))
    : 12;
  const targetRaw = parseInt(searchParams.target ?? "5", 10);
  const targetDays = Number.isFinite(targetRaw)
    ? Math.max(1, Math.min(30, targetRaw))
    : 5;

  const retro = await getCloseRetrospective(
    prisma,
    { tenantId: tenant.id, entityId: entity.id, bookId: book.id },
    lookback,
    targetDays
  );

  // Sparkline helpers — render as a row of fixed-height cells colored
  // by metTarget / by rate magnitude. No SVG, no client-side JS;
  // works under server-component static rendering.
  const dtcMax = Math.max(
    targetDays + 1,
    ...retro.daysToCloseTrend.map((p) => p.daysToClose)
  );

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">
          Close retrospective
        </h1>
        <p className="text-sm text-ink-500">
          Last {lookback} periods · target close-day +{targetDays}
        </p>
        <p className="mt-1 text-xs text-ink-500">
          Scope: <span className="font-mono">{entity.code}</span> ·{" "}
          <span className="font-mono">{book.code}</span>
        </p>
      </header>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs uppercase tracking-wide text-ink-500">
              Avg days to close
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-ink-900">
              {fmtDays(retro.summary.avgDaysToClose)}
            </div>
            <div className="text-[11px] text-ink-500">
              over {retro.summary.closedPeriodCount} closed period
              {retro.summary.closedPeriodCount === 1 ? "" : "s"}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs uppercase tracking-wide text-ink-500">
              % met SLA
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-ink-900">
              {fmtRate(retro.summary.pctMetTarget)}
            </div>
            <div className="text-[11px] text-ink-500">
              ≤{targetDays} days from period end
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs uppercase tracking-wide text-ink-500">
              Recon exception rate
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-ink-900">
              {fmtRate(retro.summary.avgExceptionRate)}
            </div>
            <div className="text-[11px] text-ink-500">
              {retro.summary.totalReconsCompleted} recons
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-xs uppercase tracking-wide text-ink-500">
              Tasks completed
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-2xl font-semibold text-ink-900">
              {retro.summary.totalTasksCompleted}
            </div>
            <div className="text-[11px] text-ink-500">
              across the window
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Days-to-close trend */}
      <Card>
        <CardHeader>
          <CardTitle>Days to close, by period</CardTitle>
          <span className="text-xs text-ink-500">
            Green: met +{targetDays}-day SLA · Red: slipped
          </span>
        </CardHeader>
        <CardContent>
          {retro.daysToCloseTrend.length === 0 ? (
            <EmptyState
              title="No closed periods in window"
              description="Close a period to start the trend."
            />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="py-1 font-medium">Period</th>
                  <th className="py-1 font-medium">Closed</th>
                  <th className="py-1 text-right font-medium">Days</th>
                  <th className="py-1 font-medium">vs target</th>
                </tr>
              </thead>
              <tbody>
                {retro.daysToCloseTrend.map((p) => {
                  const widthPct = Math.min(100, (p.daysToClose / dtcMax) * 100);
                  return (
                    <tr key={p.periodId} className="border-t border-ink-100">
                      <td className="py-1 font-mono">{p.periodCode}</td>
                      <td className="py-1 text-ink-600">{formatDate(p.closedAt)}</td>
                      <td className="py-1 text-right font-mono">{p.daysToClose}</td>
                      <td className="py-1">
                        <div className="flex items-center gap-2">
                          <div className="relative h-2 w-32 overflow-hidden rounded bg-ink-100">
                            <div
                              className={
                                p.metTarget
                                  ? "absolute inset-y-0 left-0 bg-emerald-500"
                                  : "absolute inset-y-0 left-0 bg-rose-500"
                              }
                              style={{ width: `${widthPct}%` }}
                            />
                            <div
                              className="absolute inset-y-0 w-px bg-ink-400"
                              style={{ left: `${(targetDays / dtcMax) * 100}%` }}
                              title={`Target: ${targetDays}d`}
                            />
                          </div>
                          <Badge tone={p.metTarget ? "positive" : "negative"}>
                            {p.metTarget ? "met" : "slipped"}
                          </Badge>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Task lead time by category */}
      <Card>
        <CardHeader>
          <CardTitle>Average task lead time, by category</CardTitle>
          <span className="text-xs text-ink-500">
            createdAt → DONE, in calendar days. Sorted worst → best.
          </span>
        </CardHeader>
        <CardContent>
          {retro.taskLeadTime.length === 0 ? (
            <EmptyState
              title="No completed tasks in window"
              description="Mark tasks DONE to populate the bars."
            />
          ) : (
            <div className="flex flex-col gap-1.5 text-xs">
              {(() => {
                const max = Math.max(...retro.taskLeadTime.map((c) => c.avgLeadDays), 1);
                return retro.taskLeadTime.map((c) => {
                  const widthPct = (c.avgLeadDays / max) * 100;
                  return (
                    <div key={c.category} className="flex items-center gap-2">
                      <span className="w-32 text-ink-700">
                        {CATEGORY_LABELS[c.category] ?? c.category}
                      </span>
                      <div className="relative h-3 flex-1 overflow-hidden rounded bg-ink-100">
                        <div
                          className="absolute inset-y-0 left-0 bg-ink-700"
                          style={{ width: `${widthPct}%` }}
                        />
                      </div>
                      <span className="w-20 text-right font-mono">
                        {c.avgLeadDays.toFixed(1)} d
                      </span>
                      <span className="w-16 text-right text-ink-500">
                        n={c.sampleSize}
                      </span>
                    </div>
                  );
                });
              })()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Exception-rate trend */}
      <Card>
        <CardHeader>
          <CardTitle>Recon exception rate, by period</CardTitle>
          <span className="text-xs text-ink-500">
            Exceptions / total recons. Trending down = process improving.
          </span>
        </CardHeader>
        <CardContent>
          {retro.exceptionRateTrend.every((p) => p.totalRecons === 0) ? (
            <EmptyState
              title="No recons in window"
              description="Open a period and instantiate recons."
            />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="py-1 font-medium">Period</th>
                  <th className="py-1 text-right font-medium">Recons</th>
                  <th className="py-1 text-right font-medium">Exceptions</th>
                  <th className="py-1 text-right font-medium">Rate</th>
                  <th className="py-1 font-medium" />
                </tr>
              </thead>
              <tbody>
                {retro.exceptionRateTrend.map((p) => {
                  if (p.totalRecons === 0) {
                    return (
                      <tr key={p.periodId} className="border-t border-ink-100 text-ink-400">
                        <td className="py-1 font-mono">{p.periodCode}</td>
                        <td className="py-1 text-right">—</td>
                        <td className="py-1 text-right">—</td>
                        <td className="py-1 text-right">—</td>
                        <td className="py-1" />
                      </tr>
                    );
                  }
                  const widthPct = p.rate * 100;
                  const hot = p.rate >= 0.1;
                  return (
                    <tr key={p.periodId} className="border-t border-ink-100">
                      <td className="py-1 font-mono">{p.periodCode}</td>
                      <td className="py-1 text-right font-mono">{p.totalRecons}</td>
                      <td className="py-1 text-right font-mono">{p.exceptionCount}</td>
                      <td className="py-1 text-right font-mono">
                        {(p.rate * 100).toFixed(1)}%
                      </td>
                      <td className="py-1">
                        <div className="relative h-2 w-32 overflow-hidden rounded bg-ink-100">
                          <div
                            className={
                              hot
                                ? "absolute inset-y-0 left-0 bg-rose-500"
                                : "absolute inset-y-0 left-0 bg-amber-400"
                            }
                            style={{ width: `${Math.min(100, widthPct)}%` }}
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Recurring blockers */}
      <Card>
        <CardHeader>
          <CardTitle>Recurring blockers</CardTitle>
          <span className="text-xs text-ink-500">
            Top templates by BLOCKED hits across the window. Process-fix
            candidates.
          </span>
        </CardHeader>
        <CardContent>
          {retro.recurringBlockers.length === 0 ? (
            <EmptyState
              title="No blockers — process is healthy"
              description="No close tasks in the BLOCKED state for the lookback window."
            />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="py-1 font-medium">Task</th>
                  <th className="py-1 font-medium">Template key</th>
                  <th className="py-1 text-right font-medium">Blocked</th>
                  <th className="py-1 text-right font-medium">Total</th>
                  <th className="py-1 text-right font-medium">Block rate</th>
                </tr>
              </thead>
              <tbody>
                {retro.recurringBlockers.map((b) => (
                  <tr
                    key={`${b.templateKey ?? "adhoc"}:${b.name}`}
                    className="border-t border-ink-100"
                  >
                    <td className="py-1 text-ink-900">{b.name}</td>
                    <td className="py-1 font-mono text-ink-500">
                      {b.templateKey ?? <span className="italic">ad-hoc</span>}
                    </td>
                    <td className="py-1 text-right font-mono">{b.blockedCount}</td>
                    <td className="py-1 text-right font-mono">{b.totalCount}</td>
                    <td className="py-1 text-right font-mono">
                      {(b.blockRate * 100).toFixed(1)}%
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
