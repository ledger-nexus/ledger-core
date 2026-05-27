// Admin AI budget overview.
//
// Read-only operator view: per-tenant Anthropic spend this calendar
// month + recent threshold alerts across all three AI-using companion
// repos (recon, revenue-rec, fa-amort).
//
// Architecture note: ledger-core does not own the AI suggestion tables.
// This page reads from them via raw SQL through getCurrentMonthSpendByTenant
// + getRecentAlerts in src/lib/ai-budget-summary.ts. Mirror models in
// ledger-core's schema would create a reverse dependency from substrate
// to consumer; raw SQL is the right escape hatch for read-only
// aggregation across the shared DB.
//
// Permissions: admin-only via the email allowlist (same as audit-log).
// When per-tenant RBAC lands the gate moves to that policy layer.

import * as React from "react";
import {
  getCurrentUser,
  isAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/utils/format";
import {
  getCurrentMonthSpendByTenant,
  getRecentAlerts,
  currentMonthKey,
  type TenantSpendRow,
  type RecentAlert,
} from "@/lib/ai-budget-summary";

export default async function AiBudgetPage() {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return <PermissionDenied reason={new NotAuthenticatedError().message} />;
  }
  if (!isAdmin(currentUser)) {
    return <PermissionDenied reason={new NotAuthorizedError().message} />;
  }

  const [spendRows, alerts] = await Promise.all([
    getCurrentMonthSpendByTenant(),
    getRecentAlerts(50),
  ]);

  const monthKey = currentMonthKey();
  const totalSpend = spendRows.reduce(
    (acc, r) => acc + Number(r.spentUsd.toFixed(2)),
    0
  );
  const tenantsAtRisk = spendRows.filter((r) =>
    r.pctOfCap.greaterThanOrEqualTo(80)
  ).length;
  const tenantsCapReached = spendRows.filter((r) =>
    r.pctOfCap.greaterThanOrEqualTo(100)
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">AI budget</h2>
        <p className="text-xs text-ink-500">
          Anthropic spend across recon, revenue-rec, and fa-amort for the
          current calendar month ({monthKey} UTC). Enforcement happens in each
          companion repo&rsquo;s Server Actions; this page is read-only.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <KpiCard
          label="Tenants with activity"
          value={spendRows.length.toString()}
          hint={`this month`}
        />
        <KpiCard
          label="Σ spend"
          value={formatMoney(totalSpend.toFixed(2))}
          hint="all tenants, all repos"
        />
        <KpiCard
          label="At 80%+"
          value={tenantsAtRisk.toString()}
          hint="warning fired"
          tone={tenantsAtRisk > 0 ? "warning" : undefined}
        />
        <KpiCard
          label="At cap"
          value={tenantsCapReached.toString()}
          hint="further calls refused"
          tone={tenantsCapReached > 0 ? "negative" : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Per-tenant spend, {monthKey}</CardTitle>
          <span className="text-xs text-ink-500">
            Sorted by % of cap used. Tenants with zero AI activity this month
            don&rsquo;t appear here.
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {spendRows.length === 0 ? (
            <EmptyState
              title="No AI activity this month"
              description="No tenant has triggered an AI call across the three companion repos yet this calendar month."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Tenant</TH>
                  <TH className="text-right">Spend</TH>
                  <TH className="text-right">Cap</TH>
                  <TH className="text-right">% used</TH>
                  <TH className="text-right">recon</TH>
                  <TH className="text-right">revenue-rec</TH>
                  <TH className="text-right">fa-amort</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {spendRows.map((row) => (
                  <SpendRow key={row.tenantId} row={row} />
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Recent threshold alerts</CardTitle>
          <span className="text-xs text-ink-500">
            Up to 50 most recent crossings across the three companion repos.
            Each row corresponds to a webhook delivery (when{" "}
            <code className="font-mono">AI_ALERT_WEBHOOK_URL</code> is set in
            the originating repo&rsquo;s env).
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {alerts.length === 0 ? (
            <EmptyState
              title="No alerts on record"
              description="No tenant has crossed an 80% or 100% threshold yet. The empty state is the healthy state."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Source</TH>
                  <TH>Tenant</TH>
                  <TH>Month</TH>
                  <TH>Threshold</TH>
                  <TH className="text-right">Spend at fire</TH>
                  <TH className="text-right">Cap at fire</TH>
                </tr>
              </THead>
              <TBody>
                {alerts.map((a, i) => (
                  <AlertRow key={`${a.tenantId}-${a.monthKey}-${a.source}-${a.threshold}-${i}`} alert={a} />
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SpendRow({ row }: { row: TenantSpendRow }) {
  const pct = Number(row.pctOfCap.toFixed(1));
  const tone: "positive" | "warning" | "negative" =
    pct >= 100 ? "negative" : pct >= 80 ? "warning" : "positive";
  const status: string = pct >= 100 ? "AT CAP" : pct >= 80 ? "WARN" : "OK";
  return (
    <TR>
      <TD>
        <div className="font-medium text-ink-900">{row.tenantName}</div>
        <div className="text-[11px] text-ink-500 font-mono">{row.tenantSlug}</div>
      </TD>
      <TD className="text-right amount-cell font-semibold">
        ${row.spentUsd.toFixed(2)}
      </TD>
      <TD className="text-right amount-cell">
        ${row.capUsd.toFixed(2)}
        {!row.capIsExplicit && (
          <div className="text-[10px] text-ink-400">(env default)</div>
        )}
      </TD>
      <TD className="text-right amount-cell tabular-nums">{pct.toFixed(1)}%</TD>
      <TD className="text-right amount-cell text-ink-500 text-xs">
        ${row.byRepo.recon.toFixed(2)}
      </TD>
      <TD className="text-right amount-cell text-ink-500 text-xs">
        ${row.byRepo.revenueRec.toFixed(2)}
      </TD>
      <TD className="text-right amount-cell text-ink-500 text-xs">
        ${row.byRepo.faAmort.toFixed(2)}
      </TD>
      <TD>
        <Badge tone={tone}>{status}</Badge>
      </TD>
    </TR>
  );
}

function AlertRow({ alert }: { alert: RecentAlert }) {
  const tone: "warning" | "negative" =
    alert.threshold >= 100 ? "negative" : "warning";
  return (
    <TR>
      <TD className="text-xs font-mono text-ink-700">
        {alert.sentAt.toISOString().replace("T", " ").slice(0, 19)}
      </TD>
      <TD className="text-xs font-mono text-ink-600">{alert.source}</TD>
      <TD>
        <div className="text-sm text-ink-900">{alert.tenantName}</div>
        <div className="text-[11px] text-ink-500 font-mono">{alert.tenantSlug}</div>
      </TD>
      <TD className="text-xs font-mono">{alert.monthKey}</TD>
      <TD>
        <Badge tone={tone}>{alert.threshold}%</Badge>
      </TD>
      <TD className="text-right amount-cell">${alert.spentUsd.toFixed(2)}</TD>
      <TD className="text-right amount-cell text-ink-500">
        ${alert.capUsd.toFixed(2)}
      </TD>
    </TR>
  );
}

function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "warning" | "negative";
}) {
  return (
    <Card>
      <CardContent className="px-4 py-3">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
          {label}
        </div>
        <div
          className={`mt-1 text-lg font-semibold ${
            tone === "negative"
              ? "text-negative"
              : tone === "warning"
                ? "text-warning"
                : "text-ink-900"
          }`}
        >
          {value}
        </div>
        {hint && (
          <div className="mt-0.5 text-[11px] text-ink-500">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

function PermissionDenied({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-ink-900">Admin only</h2>
        <p className="mt-1 text-sm text-ink-500">{reason}</p>
        <p className="mt-3 text-xs text-ink-400">
          AI budget access requires the admin role. Pick an admin user from
          the switcher in the header.
        </p>
      </CardContent>
    </Card>
  );
}
