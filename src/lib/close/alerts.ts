// BlackLine arc — Phase 4 PR 2: cross-pillar alerts aggregator.
//
// `getCloseAlerts(prisma, scope)` walks all three pillars (Recons,
// Tasks, Flux) and returns a unified Alert[] sorted by severity
// (high → medium → low) then by age (oldest first).
//
// Severity rules:
//   high   — needs immediate eyes (recon EXCEPTION, blocked task with
//            reason, flux statement with majority pending lines)
//   medium — slipping but not stuck (recon PREPARED awaiting review,
//            overdue task, flux statement with some pending)
//   low    — informational (recon SENT_BACK, task NOT_STARTED past
//            window, immaterial flux activity)
//
// Each alert carries an `href` deep-link so the operator clicks
// through to the exact place to act.

import type { DbClient } from "@/lib/db";


export type AlertSeverity = "high" | "medium" | "low";
export type AlertPillar = "recon" | "task" | "flux";

export interface CloseAlert {
  id: string;
  severity: AlertSeverity;
  pillar: AlertPillar;
  title: string;
  description: string;
  ageDays: number;
  href: string;
  createdAt: Date;
}

interface Scope {
  tenantId: string;
  entityId: string;
  bookId: string;
  periodId: string;
  periodCode: string;
}

function daysBetween(a: Date, b: Date): number {
  const MS = 1000 * 60 * 60 * 24;
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / MS);
}

export async function getCloseAlerts(
  prisma: DbClient,
  scope: Scope,
  now: Date = new Date()
): Promise<CloseAlert[]> {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);

  const alerts: CloseAlert[] = [];

  // ── Reconciliation pillar ────────────────────────────────────────
  const recons = await prisma.reconciliation.findMany({
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      bookId: scope.bookId,
      periodId: scope.periodId,
      status: { in: ["EXCEPTION", "PREPARED", "IN_PROGRESS"] },
    },
    select: {
      id: true,
      status: true,
      updatedAt: true,
      preparedAt: true,
      account: { select: { code: true, name: true } },
    },
  });
  for (const r of recons) {
    const href = `/close/reconciliations/${r.id}`;
    if (r.status === "EXCEPTION") {
      alerts.push({
        id: `recon:${r.id}`,
        severity: "high",
        pillar: "recon",
        title: `EXCEPTION on ${r.account.code} ${r.account.name}`,
        description: "Reconciliation is over tolerance; preparer needs to investigate the diff.",
        ageDays: daysBetween(r.updatedAt, now),
        href,
        createdAt: r.updatedAt,
      });
    } else if (r.status === "PREPARED") {
      const since = r.preparedAt ?? r.updatedAt;
      const age = daysBetween(since, now);
      alerts.push({
        id: `recon:${r.id}`,
        severity: age >= 2 ? "medium" : "low",
        pillar: "recon",
        title: `Awaiting reviewer: ${r.account.code} ${r.account.name}`,
        description: "Preparer signed off; a different user needs to review.",
        ageDays: age,
        href,
        createdAt: since,
      });
    } else if (r.status === "IN_PROGRESS") {
      // IN_PROGRESS via send-back. Only flag if stale (>5 days) —
      // recently-sent-back recons are normal.
      const age = daysBetween(r.updatedAt, now);
      if (age >= 5) {
        alerts.push({
          id: `recon:${r.id}`,
          severity: "low",
          pillar: "recon",
          title: `Stale send-back: ${r.account.code} ${r.account.name}`,
          description: "Sent back to preparer over 5 days ago; no re-submit yet.",
          ageDays: age,
          href,
          createdAt: r.updatedAt,
        });
      }
    }
  }

  // ── Close-task pillar ────────────────────────────────────────────
  const tasks = await prisma.closeTask.findMany({
    where: {
      tenantId: scope.tenantId,
      periodId: scope.periodId,
      status: { in: ["BLOCKED", "NOT_STARTED", "IN_PROGRESS"] },
    },
    select: {
      id: true,
      name: true,
      status: true,
      requiredForClose: true,
      dueAt: true,
      updatedAt: true,
      blockedReason: true,
    },
  });
  for (const t of tasks) {
    const href = `/close/tasks/${t.id}`;
    if (t.status === "BLOCKED") {
      alerts.push({
        id: `task:${t.id}`,
        severity: t.requiredForClose ? "high" : "medium",
        pillar: "task",
        title: `Blocked: ${t.name}`,
        description: t.blockedReason ?? "No reason provided.",
        ageDays: daysBetween(t.updatedAt, now),
        href,
        createdAt: t.updatedAt,
      });
    } else if (t.dueAt && t.dueAt < today) {
      // Overdue non-terminal task. Required → medium; optional → low.
      alerts.push({
        id: `task:${t.id}`,
        severity: t.requiredForClose ? "medium" : "low",
        pillar: "task",
        title: `Overdue: ${t.name}`,
        description: `Due ${t.dueAt.toISOString().slice(0, 10)}; still ${t.status}.`,
        ageDays: daysBetween(t.dueAt, now),
        href,
        createdAt: t.dueAt,
      });
    }
  }

  // ── Flux pillar ──────────────────────────────────────────────────
  // The latest statement for this (entity, book, toPeriod). One alert
  // per material line that's NEEDS_COMMENT.
  const stmt = await prisma.fluxStatement.findFirst({
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      bookId: scope.bookId,
      toPeriodId: scope.periodId,
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true, createdAt: true, status: true },
  });
  if (stmt) {
    const pendingLines = await prisma.fluxLine.findMany({
      where: { statementId: stmt.id, status: "NEEDS_COMMENT" },
      orderBy: { deltaAmount: "desc" },
      select: {
        id: true,
        deltaAmount: true,
        deltaPercent: true,
        account: { select: { code: true, name: true } },
      },
    });
    const statementAge = daysBetween(stmt.createdAt, now);
    for (const line of pendingLines) {
      // Severity by magnitude: lines older than 3 days OR with very
      // large deltas → high. Otherwise medium.
      const sev: AlertSeverity = statementAge >= 3 ? "high" : "medium";
      alerts.push({
        id: `flux:${line.id}`,
        severity: sev,
        pillar: "flux",
        title: `Flux pending: ${line.account.code} ${line.account.name}`,
        description: `Delta ${line.deltaAmount.toString()}${line.deltaPercent ? ` (${line.deltaPercent.toString()}%)` : ""} — needs commentary.`,
        ageDays: statementAge,
        href: `/close/flux/${stmt.id}`,
        createdAt: stmt.createdAt,
      });
    }
  }

  // Severity order: high (0) → medium (1) → low (2). Within severity,
  // oldest first.
  const SEV_ORDER: Record<AlertSeverity, number> = { high: 0, medium: 1, low: 2 };
  alerts.sort((a, b) => {
    const so = SEV_ORDER[a.severity] - SEV_ORDER[b.severity];
    if (so !== 0) return so;
    return b.ageDays - a.ageDays; // oldest first within severity
  });

  return alerts;
}

/** Histogram for the page header / API summary. */
export interface AlertHistogram {
  total: number;
  bySeverity: Record<AlertSeverity, number>;
  byPillar: Record<AlertPillar, number>;
}

export function summarizeAlerts(alerts: CloseAlert[]): AlertHistogram {
  const histogram: AlertHistogram = {
    total: alerts.length,
    bySeverity: { high: 0, medium: 0, low: 0 },
    byPillar: { recon: 0, task: 0, flux: 0 },
  };
  for (const a of alerts) {
    histogram.bySeverity[a.severity]++;
    histogram.byPillar[a.pillar]++;
  }
  return histogram;
}
