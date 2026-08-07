// BlackLine arc — Phase 4 PR 2: /close/alerts list page.
//
// Aggregated alert stream across all three pillars (Recons, Tasks,
// Flux). Sorted by severity then by age. Per-alert badges + deep
// links so the controller goes from "what's wrong" to "where to fix
// it" in one click.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import {
  getCloseAlerts,
  summarizeAlerts,
  type AlertSeverity,
  type AlertPillar,
} from "@/lib/close/alerts";

const SEVERITY_TONES: Record<
  AlertSeverity,
  "negative" | "warning" | "neutral"
> = {
  high: "negative",
  medium: "warning",
  low: "neutral",
};

const PILLAR_LABELS: Record<AlertPillar, string> = {
  recon: "Recon",
  task: "Task",
  flux: "Flux",
  assertion: "Assertion",
};

const ALL_SEVERITIES: AlertSeverity[] = ["high", "medium", "low"];
const ALL_PILLARS: AlertPillar[] = ["recon", "task", "flux", "assertion"];

export default async function CloseAlertsPage({
  searchParams,
}: {
  searchParams: { period?: string; severity?: string; pillar?: string };
}) {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="Scope not found"
        description="Sign in and select a tenant with at least one entity."
      />
    );
  }

  const entity = await prisma.legalEntity.findFirst({
    where: { tenantId: scope.tenantId, code: scope.entityCode },
    select: { id: true, code: true, name: true },
  });
  const book = await prisma.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true, code: true, name: true },
  });

  if (!entity || !book) {
    return (
      <EmptyState
        title="Scope not found"
        description="Sign in and pick a tenant."
      />
    );
  }

  const allPeriods = await prisma.period.findMany({
    where: { calendar: { entityId: entity.id } },
    orderBy: { startsOn: "desc" },
    take: 12,
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });
  if (allPeriods.length === 0) {
    return (
      <EmptyState
        title="No periods seeded"
        description="This entity has no fiscal calendar yet, so there is nothing to raise alerts against."
      />
    );
  }

  let selectedPeriod = allPeriods[0];
  if (searchParams.period) {
    const match = allPeriods.find((p) => p.code === searchParams.period);
    if (match) selectedPeriod = match;
  } else {
    const closes = await prisma.periodClose.findMany({
      where: { entityId: entity.id, bookId: book.id },
      select: { periodId: true },
    });
    const closedIds = new Set(closes.map((c) => c.periodId));
    const latestOpen = allPeriods.find((p) => !closedIds.has(p.id));
    if (latestOpen) selectedPeriod = latestOpen;
  }

  const alerts = await getCloseAlerts(prisma, {
    tenantId: scope.tenantId,
    entityId: entity.id,
    bookId: book.id,
    periodId: selectedPeriod.id,
    periodCode: selectedPeriod.code,
  });

  // Filter pills.
  const severityFilter =
    searchParams.severity && (ALL_SEVERITIES as string[]).includes(searchParams.severity)
      ? (searchParams.severity as AlertSeverity)
      : null;
  const pillarFilter =
    searchParams.pillar && (ALL_PILLARS as string[]).includes(searchParams.pillar)
      ? (searchParams.pillar as AlertPillar)
      : null;

  const filtered = alerts.filter(
    (a) =>
      (severityFilter === null || a.severity === severityFilter) &&
      (pillarFilter === null || a.pillar === pillarFilter)
  );

  const histogram = summarizeAlerts(alerts);

  function urlWith(overrides: {
    period?: string;
    severity?: string | null;
    pillar?: string | null;
  }): string {
    const p = new URLSearchParams();
    p.set("period", overrides.period ?? selectedPeriod.code);
    const sev = overrides.severity !== undefined ? overrides.severity : severityFilter;
    if (sev) p.set("severity", sev);
    const pil = overrides.pillar !== undefined ? overrides.pillar : pillarFilter;
    if (pil) p.set("pillar", pil);
    return `?${p.toString()}`;
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="font-display text-2xl font-bold tracking-tight text-ink-900">Close alerts</h1>
        <p className="text-sm text-ink-500">
          Cross-pillar alerts for this period. Sorted by severity, oldest
          first within severity.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Scope: <span className="font-mono">{entity.code}</span> ·{" "}
          <span className="font-mono">{book.code}</span> · Period{" "}
          <span className="font-mono">{selectedPeriod.code}</span>
        </p>
      </header>

      {/* Period chips */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-ink-500">Period:</span>
        {allPeriods.map((p) => {
          const active = p.id === selectedPeriod.id;
          return (
            <Link
              key={p.id}
              href={urlWith({ period: p.code })}
              className={
                active
                  ? "rounded-md bg-ink-900 px-2 py-1 font-mono text-white"
                  : "rounded-md border border-ink-200 px-2 py-1 font-mono text-ink-700 hover:bg-ink-50"
              }
            >
              {p.code}
            </Link>
          );
        })}
      </div>

      {/* Filter strip — severity + pillar pills */}
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Link
          href={urlWith({ severity: null, pillar: null })}
          className={
            !severityFilter && !pillarFilter
              ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
              : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
          }
        >
          All · {histogram.total}
        </Link>
        <span className="text-ink-300">·</span>
        {ALL_SEVERITIES.map((sev) => {
          const count = histogram.bySeverity[sev];
          if (count === 0) return null;
          const active = severityFilter === sev;
          return (
            <Link
              key={sev}
              href={urlWith({ severity: sev })}
              className={
                active
                  ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
                  : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
              }
            >
              {sev} · {count}
            </Link>
          );
        })}
        <span className="text-ink-300">·</span>
        {ALL_PILLARS.map((pil) => {
          const count = histogram.byPillar[pil];
          if (count === 0) return null;
          const active = pillarFilter === pil;
          return (
            <Link
              key={pil}
              href={urlWith({ pillar: pil })}
              className={
                active
                  ? "rounded-full bg-ink-900 px-2.5 py-0.5 font-medium text-white"
                  : "rounded-full bg-ink-100 px-2.5 py-0.5 font-medium text-ink-700 hover:bg-ink-200"
              }
            >
              {PILLAR_LABELS[pil]} · {count}
            </Link>
          );
        })}
      </div>

      {filtered.length === 0 ? (
        <Card>
          <CardContent>
            <EmptyState
              title={
                histogram.total === 0
                  ? "No alerts — close is clean"
                  : "No alerts match these filters"
              }
              description={
                histogram.total === 0
                  ? "Either everything is signed off or no pillars have been instantiated yet."
                  : "Clear the filters to see all alerts."
              }
            />
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>
              {filtered.length} alert{filtered.length === 1 ? "" : "s"}
            </CardTitle>
            <span className="text-xs text-ink-500">
              Click any row to jump to the gap
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {filtered.map((a) => (
              <Link
                key={a.id}
                href={a.href}
                className="flex flex-col gap-1 rounded-md border border-ink-100 px-3 py-2 hover:border-ink-200 hover:bg-ink-50"
              >
                <div className="flex items-center gap-2">
                  <Badge tone={SEVERITY_TONES[a.severity]}>{a.severity}</Badge>
                  <Badge tone="neutral">{PILLAR_LABELS[a.pillar]}</Badge>
                  <span className="text-sm font-medium text-ink-900">
                    {a.title}
                  </span>
                  <span className="ml-auto text-xs text-ink-500">
                    {a.ageDays === 0
                      ? "today"
                      : a.ageDays === 1
                        ? "1 day ago"
                        : `${a.ageDays} days ago`}
                  </span>
                </div>
                <p className="text-xs text-ink-600">{a.description}</p>
                <span className="text-[11px] text-ink-500">
                  Created {formatDate(a.createdAt)}
                </span>
              </Link>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
