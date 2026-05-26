// Multi-entity consolidation report.
//
// Picks a root entity (defaults to the first entity with descendants —
// for the demo seed, ACME_GROUP), shows per-entity contributions side by
// side with the consolidated total, and surfaces eliminated intercompany
// balances explicitly.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney, moneyClass } from "@/lib/utils/format";

export default async function ConsolidationPage({
  searchParams,
}: {
  searchParams: { root?: string; asOf?: string };
}) {
  const scope = getScope();
  const asOf = searchParams.asOf ?? "2026-06-30";

  // List entities that have at least one descendant — those are the only
  // sensible roots. Tenant-scoped (Phase 4c): only show the current
  // tenant's entities so consolidation can't cross tenant boundaries.
  const tenant = await getCurrentTenant();
  const allEntities = await prisma.legalEntity.findMany({
    where: tenant ? { tenantId: tenant.id } : { id: "__none__" },
    select: { id: true, code: true, name: true, parentEntityId: true },
    orderBy: { code: "asc" },
  });
  const parentIdSet = new Set(allEntities.map((e) => e.parentEntityId).filter(Boolean) as string[]);
  const rootCandidates = allEntities.filter((e) => parentIdSet.has(e.id));

  const root = searchParams.root ?? rootCandidates[0]?.code ?? scope.entityCode;

  if (rootCandidates.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Consolidation</h2>
        <EmptyState
          title="No multi-entity hierarchy in the database"
          description="The Northwind seed creates a single entity. Run pnpm db:seed (or POST /api/admin/reset) to load the Acme Group consolidation demo (parent + 2 subs)."
        />
      </div>
    );
  }

  const report = await getConsolidatedTrialBalance(prisma, {
    rootEntityCode: root,
    bookCode: scope.bookCode,
    asOf: new Date(asOf),
  });

  const csvUrl = `/api/reports/consolidation/csv?root=${root}&asOf=${asOf}`;
  const subEntityCodes = report.entitiesIncluded
    .filter((e) => !e.isRoot)
    .map((e) => e.code);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Consolidation</h2>
          <p className="text-sm text-ink-500">
            {report.rootEntityName} ({report.rootEntityCode}) · {report.bookCode} · as of{" "}
            {formatDate(report.asOf)} · {report.entitiesIncluded.length} entities
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form method="GET" className="flex items-end gap-2">
            <div>
              <Label htmlFor="root">Root entity</Label>
              <Select name="root" id="root" defaultValue={root} className="min-w-[180px]">
                {rootCandidates.map((e) => (
                  <option key={e.code} value={e.code}>
                    {e.code} — {e.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="asOf">As of</Label>
              <Input type="date" name="asOf" id="asOf" defaultValue={asOf} />
            </div>
            <button
              type="submit"
              className="h-9 rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
            >
              Run
            </button>
          </form>
          <Link
            href={csvUrl}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">Reconciliation</div>
            <div className="font-mono text-sm text-ink-700">
              Pre-elim Σ Dr {formatMoney(report.preEliminationTotalDebit)} = Σ Cr{" "}
              {formatMoney(report.preEliminationTotalCredit)} | Post-elim Σ Dr{" "}
              {formatMoney(report.consolidatedTotalDebit)} = Σ Cr{" "}
              {formatMoney(report.consolidatedTotalCredit)}
            </div>
            {!report.netIcImbalance.isZero() && (
              <div className="mt-1 text-xs text-negative">
                IC imbalance: {formatMoney(report.netIcImbalance)} — one side of an IC entry was booked
                without its counterparty.
              </div>
            )}
          </div>
          <Badge tone={report.balances ? "positive" : "negative"}>
            {report.balances ? "Consolidated TB balances ✓" : "UNBALANCED"}
          </Badge>
        </CardContent>
      </Card>

      {/* Entity contributions */}
      <Card>
        <CardHeader>
          <CardTitle>Entity contributions</CardTitle>
          <span className="text-xs text-ink-500">{report.entitiesIncluded.length} entities included</span>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <tr>
                <TH>Entity</TH>
                <TH>Role</TH>
              </tr>
            </THead>
            <TBody>
              {report.entitiesIncluded.map((e) => (
                <TR key={e.code}>
                  <TD className="font-mono text-xs text-ink-700">
                    {e.code} <span className="text-ink-400">— {e.name}</span>
                  </TD>
                  <TD>
                    <Badge tone={e.isRoot ? "info" : "neutral"}>{e.isRoot ? "Root" : "Subsidiary"}</Badge>
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {/* Elimination summary */}
      {report.eliminationSummary.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Intercompany eliminations</CardTitle>
            <Badge tone="warning">{report.eliminationSummary.length} accounts eliminated</Badge>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Account</TH>
                  <TH>Subtype</TH>
                  <TH className="text-right">Debit eliminated</TH>
                  <TH className="text-right">Credit eliminated</TH>
                </tr>
              </THead>
              <TBody>
                {report.eliminationSummary.map((e) => (
                  <TR key={e.accountCode}>
                    <TD className="font-mono text-xs text-ink-700">{e.accountCode}</TD>
                    <TD className="text-ink-900">{e.accountName}</TD>
                    <TD>
                      <Badge tone="neutral">{e.subtype}</Badge>
                    </TD>
                    <TD className="amount-cell text-right">{formatMoney(e.totalDebitEliminated)}</TD>
                    <TD className="amount-cell text-right">{formatMoney(e.totalCreditEliminated)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Consolidated TB */}
      <Card>
        <CardHeader>
          <CardTitle>Consolidated trial balance</CardTitle>
          <span className="text-xs text-ink-500">Per-entity columns + post-elimination total</span>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <tr>
                <TH>Code</TH>
                <TH>Account</TH>
                <TH>Type</TH>
                {subEntityCodes.map((c) => (
                  <TH key={c} className="text-right">
                    {c}
                  </TH>
                ))}
                <TH className="text-right">Sum (pre-elim)</TH>
                <TH className="text-right">Eliminated</TH>
                <TH className="text-right">Consolidated</TH>
              </tr>
            </THead>
            <TBody>
              {report.rows
                .filter((r) => !r.consolidatedDebit.isZero() || !r.consolidatedCredit.isZero() || r.isEliminated)
                .map((r) => {
                  const perByEntity = new Map(
                    r.perEntity.map((p) => [p.entityCode, p])
                  );
                  return (
                    <TR key={r.accountCode}>
                      <TD className="font-mono text-xs text-ink-700">{r.accountCode}</TD>
                      <TD className="text-ink-900">{r.accountName}</TD>
                      <TD className="text-ink-500">{r.type}</TD>
                      {subEntityCodes.map((c) => {
                        const p = perByEntity.get(c);
                        const net = p
                          ? new Decimal(p.debit.toString()).minus(new Decimal(p.credit.toString()))
                          : new Decimal(0);
                        return (
                          <TD key={c} className="amount-cell text-right text-ink-500">
                            {net.isZero() ? "" : formatMoney(net)}
                          </TD>
                        );
                      })}
                      <TD className="amount-cell text-right text-ink-700">
                        {formatMoney(r.totalDebit.minus(r.totalCredit))}
                      </TD>
                      <TD className="amount-cell text-right">
                        {r.isEliminated ? (
                          <span className="text-negative">
                            ({formatMoney(r.eliminatedDebit.minus(r.eliminatedCredit).abs())})
                          </span>
                        ) : (
                          ""
                        )}
                      </TD>
                      <TD
                        className={`amount-cell text-right font-semibold ${moneyClass(r.consolidatedBalance)}`}
                      >
                        {r.isEliminated && r.consolidatedDebit.isZero() && r.consolidatedCredit.isZero()
                          ? "—"
                          : formatMoney(r.consolidatedBalance)}
                      </TD>
                    </TR>
                  );
                })}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
