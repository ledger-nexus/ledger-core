// Multi-entity consolidation report.
//
// Picks a root entity (defaults to the first entity with descendants —
// for the demo seed, ACME_GROUP), shows per-entity contributions side by
// side with the consolidated total, and surfaces eliminated intercompany
// balances explicitly.

import Link from "next/link";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getConsolidatedTrialBalance } from "@/lib/accounting/reports/consolidation";
import { FxRateNotFoundError } from "@/lib/accounting/fx";

// #152's derivation: a quarter back from asOf, day 1 — a sensible
// default window for the WEIGHTED_AVG rate so translation runs without
// the operator hand-picking a start date.
function deriveDefaultPeriodStart(asOf: string): string {
  const d = new Date(asOf);
  d.setUTCMonth(d.getUTCMonth() - 3);
  d.setUTCDate(1);
  return d.toISOString().slice(0, 10);
}
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney, moneyClass } from "@/lib/utils/format";

export default async function ConsolidationPage({
  searchParams,
}: {
  searchParams: { root?: string; asOf?: string; periodStart?: string };
}) {
  // Tenant-verified scope (closes the cross-tenant read leak the raw
  // lc-scope cookie used to enable).
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing reports."
      />
    );
  }
  const asOf = searchParams.asOf ?? "2026-06-30";
  // Period start drives WEIGHTED_AVG translation rates. Default: quarter
  // back from asOf, day 1 (#152's derivation) — so mixed-currency groups
  // get ASC 830 translation by default instead of the naïve sum.
  const periodStart = searchParams.periodStart ?? deriveDefaultPeriodStart(asOf);

  // List entities that have at least one descendant — those are the only
  // sensible roots. Tenant-scoped (Phase 4c): only show the current
  // tenant's entities so consolidation can't cross tenant boundaries.
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return (
      <EmptyState
        title="No tenant available"
        description="Sign in and select a tenant with at least one entity before viewing reports."
      />
    );
  }
  const allEntities = await prisma.legalEntity.findMany({
    where: { tenantId: tenant.id },
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
          description="Consolidation combines a parent entity with its subsidiaries. This book has a single entity, so there is nothing to consolidate."
        />
      </div>
    );
  }

  // tenantId from the session, never from the URL: ?root= is
  // client-controlled, and without the tenant pin it could name another
  // tenant's entity code and consolidate that tenant's books.
  //
  // Translation degrades gracefully: a mixed-currency group whose FX
  // table lacks the needed CLOSE rates falls back to the naïve-sum
  // report (with the disclosure banner + a rates-missing note) instead
  // of a 500. A translated statement at a guessed rate would be worse
  // than either.
  let report;
  let translationRatesMissing = false;
  try {
    report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: root,
      bookCode: scope.bookCode,
      asOf: new Date(asOf),
      periodStart: new Date(periodStart),
      tenantId: tenant.id,
    });
  } catch (e) {
    if (!(e instanceof FxRateNotFoundError)) throw e;
    translationRatesMissing = true;
    report = await getConsolidatedTrialBalance(prisma, {
      rootEntityCode: root,
      bookCode: scope.bookCode,
      asOf: new Date(asOf),
      tenantId: tenant.id,
    });
  }

  const csvUrl = `/api/reports/consolidation/csv?root=${root}&asOf=${asOf}&periodStart=${periodStart}`;
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
              <Label htmlFor="periodStart">Period start</Label>
              <Input
                type="date"
                name="periodStart"
                id="periodStart"
                defaultValue={periodStart}
              />
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

      {/* Translation status. ACTIVE: per-line functional balances were
          translated at category rates (#334 Phase A → Phase B) and the
          CTA plug balances the statement — positive-tone banner with the
          per-entity CLOSE rates. NOT active on a mixed-currency group:
          the original naïve-sum disclosure, plus the reason when it's a
          missing FX rate. */}
      {report.translationActive && (
        // Tone rides on the card surface, not a 4px strip down its left
        // edge. The tint plus the Badge already say "positive"; the strip
        // only added a second, louder voice saying the same thing.
        <Card className="border-positive/30 bg-positive/5">
          <CardContent className="px-5 py-4">
            <div className="flex items-start gap-3">
              <Badge tone="positive">FX translation active</Badge>
              <div className="text-sm text-ink-900">
                <div>
                  Foreign entities translated from{" "}
                  <strong>functional-currency balances</strong> (ASC 830
                  current-rate method):{" "}
                  {Object.entries(report.translationRateByEntity)
                    .filter(([, rate]) => rate !== null)
                    .map(([code, rate], i, arr) => (
                      <span key={code}>
                        <code className="rounded bg-white px-1.5 py-0.5 text-xs ring-1 ring-ink-200">
                          {code} @ {rate}
                        </code>
                        {i < arr.length - 1 ? ", " : ""}
                      </span>
                    ))}
                  . Cumulative translation adjustment:{" "}
                  <span className="font-mono">
                    {formatMoney(report.cumulativeTranslationAdjustment)}
                  </span>{" "}
                  (credit-positive, in equity as the CTA row).
                </div>
                <div className="mt-1.5 text-xs text-ink-500">
                  BS accounts at the period-end CLOSE rate, P&amp;L at the
                  period average, HISTORICAL equity frozen at contribution
                  rates. FX revaluation true-ups carry zero functional
                  amount, so the temporal-method adjustment never
                  compounds into this view.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}
      {report.hasMultiCurrency && !report.translationActive && (
        // `warning` resolved to nothing until it was added to the config,
        // so this callout shipped untinted with a default border while its
        // positive twin above was green — the Badge was carrying the tone
        // single-handed.
        <Card className="border-warning/30 bg-warning/5">
          <CardContent className="px-5 py-4">
            <div className="flex items-start gap-3">
              <Badge tone="warning">FX translation not active</Badge>
              <div className="text-sm text-ink-900">
                <div>
                  Included entities use{" "}
                  {report.distinctCurrencies.length} distinct functional
                  currencies:{" "}
                  {report.distinctCurrencies.map((c, i) => (
                    <span key={c}>
                      <code className="rounded bg-white px-1.5 py-0.5 text-xs ring-1 ring-ink-200">
                        {c}
                      </code>
                      {i < report.distinctCurrencies.length - 1 ? ", " : ""}
                    </span>
                  ))}
                  . The consolidated totals below are{" "}
                  <strong>naïve sums of debit/credit values in each
                    entity's own currency</strong>{" "}
                  — they are NOT FX-translated to a single reporting
                  currency.
                </div>
                {translationRatesMissing && (
                  <div className="mt-1.5 text-xs font-medium text-negative">
                    Translation could not run: the FX table is missing a
                    CLOSE rate for at least one functional-currency pair
                    in [{periodStart} … {asOf}]. Add the rates and re-run.
                  </div>
                )}
                <div className="mt-1.5 text-xs text-ink-500">
                  Until translation runs, treat
                  cross-currency consolidated balances as indicative
                  only. Per-entity TBs (in their own currency) are
                  accurate.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

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
                    {e.code} <span className="text-ink-500">— {e.name}</span>
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
