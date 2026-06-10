// Month-end review composite page.
//
// One URL, one period, three statements:
//   1. Trial Balance     (as of periodEnd)
//   2. Income Statement  (periodStart .. periodEnd)
//   3. Balance Sheet     (as of periodEnd)
//
// This is the page a controller actually opens when closing the books.
// Today they'd open three separate report tabs and eyeball the numbers
// for consistency; this page renders all three at once with a banner
// at the top showing close status and a one-click Close button if the
// scope's (entity, book, period) is still open.
//
// Period selection is via ?period=YYYY-MM in the URL. Default: latest
// CLOSED period if any exist; otherwise latest period overall. This
// optimizes for the most common workflow ("show me what I just closed")
// while staying functional on first-use ("nothing closed yet → here's
// the current month").

import Link from "next/link";
import { prisma } from "@/lib/db";
import { resolveCurrentScope } from "@/lib/scope";
import {
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
} from "@/lib/accounting/reports";
import { checkSubledgerTies } from "@/lib/accounting/subledger-ties";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { getFluxRollup, fluxRollupLine } from "@/lib/flux/rollup";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate } from "@/lib/utils/format";

interface SearchParams {
  period?: string;
  /** Optional override of the cookie scope — makes URLs shareable. */
  entity?: string;
  /** Optional override of the cookie scope — makes URLs shareable. */
  book?: string;
}

/**
 * Build a query string for the CSV/PDF download links that preserves
 * any URL-override scope (?entity=&book=) the page itself was opened
 * with. Without this, clicking "Download CSV" from a shared demo URL
 * would silently fall back to the cookie scope, which is usually
 * Northwind — yielding the wrong packet.
 */
function packetQuery(periodCode: string, sp: SearchParams): string {
  const parts = [`period=${encodeURIComponent(periodCode)}`];
  if (sp.entity) parts.push(`entity=${encodeURIComponent(sp.entity)}`);
  if (sp.book) parts.push(`book=${encodeURIComponent(sp.book)}`);
  return parts.join("&");
}

export default async function MonthEndPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const scope = await resolveCurrentScope({
    entity: searchParams.entity,
    book: searchParams.book,
  });
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing month-end."
      />
    );
  }

  // Phase 4b: entity code unique per [tenantId, code]; use findFirst.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: scope.entityCode },
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
        description={`Could not resolve entity "${scope.entityCode}" / book "${scope.bookCode}".`}
      />
    );
  }

  // Resolve the period either from ?period= or the auto-selected default.
  const allPeriods = await prisma.period.findMany({
    orderBy: { startsOn: "desc" },
    select: { id: true, code: true, startsOn: true, endsOn: true },
  });
  if (allPeriods.length === 0) {
    return (
      <EmptyState
        title="No periods seeded"
        description="Run pnpm db:seed to create the fiscal calendar before reviewing month-end."
      />
    );
  }

  let selectedPeriod = allPeriods[0];
  if (searchParams.period) {
    const match = allPeriods.find((p) => p.code === searchParams.period);
    if (match) selectedPeriod = match;
  } else {
    // Prefer the latest CLOSED period for this scope; fall back to latest.
    const latestClose = await prisma.periodClose.findFirst({
      where: { entityId: entity.id, bookId: book.id },
      orderBy: { period: { startsOn: "desc" } },
      select: { period: { select: { id: true, code: true, startsOn: true, endsOn: true } } },
    });
    if (latestClose?.period) selectedPeriod = latestClose.period;
  }

  const close = await prisma.periodClose.findUnique({
    where: {
      entityId_bookId_periodId: {
        entityId: entity.id,
        bookId: book.id,
        periodId: selectedPeriod.id,
      },
    },
    select: { closedAt: true, closedBy: true },
  });
  const isClosed = !!close;

  const tenant = await getCurrentTenant();

  // Run the three reports + sub-ledger ties + flux rollup in parallel.
  // All are independent reads against (entity, book, periodEnd).
  const [tb, is, bs, subledgerTies, fluxRollup] = await Promise.all([
    getTrialBalance(
      prisma,
      { entityCode: entity.code, bookCode: book.code },
      selectedPeriod.endsOn
    ),
    getIncomeStatement(
      prisma,
      { entityCode: entity.code, bookCode: book.code },
      selectedPeriod.startsOn,
      selectedPeriod.endsOn
    ),
    getBalanceSheet(
      prisma,
      { entityCode: entity.code, bookCode: book.code },
      selectedPeriod.endsOn
    ),
    checkSubledgerTies(prisma, {
      entityCode: entity.code,
      bookCode: book.code,
      asOf: selectedPeriod.endsOn,
    }),
    tenant
      ? getFluxRollup(prisma, {
          tenantId: tenant.id,
          entityId: entity.id,
          bookId: book.id,
          toPeriodId: selectedPeriod.id,
        })
      : Promise.resolve(null),
  ]);

  const tbTies = tb.totalDebit.equals(tb.totalCredit);
  const bsTies = bs.totalAssets.equals(bs.totalLiabilities.plus(bs.totalEquity));
  const allSubTies = subledgerTies.every(
    (t) => t.status === "ok" || t.status === "no_control_account"
  );
  const checkedSubTies = subledgerTies.filter(
    (t) => t.status !== "no_control_account"
  );

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-xl font-semibold text-ink-900">Month-end review</h1>
        <p className="text-sm text-ink-500">
          Trial balance + income statement + balance sheet, all in one place, for a
          single period. The standard month-end close checklist condensed to one URL.
        </p>
        <p className="text-xs text-ink-500 mt-1">
          Scope: <span className="font-mono">{entity.code}</span> ·{" "}
          <span className="font-mono">{book.code}</span> · Period{" "}
          <span className="font-mono">{selectedPeriod.code}</span> (
          {formatDate(selectedPeriod.startsOn)} → {formatDate(selectedPeriod.endsOn)})
        </p>
      </header>

      {/* Status + period picker */}
      <Card>
        <CardHeader>
          <CardTitle>
            {isClosed ? (
              <span className="flex items-center gap-2">
                <Badge tone="negative">Closed</Badge>
                <span className="text-sm font-normal text-ink-700">
                  on {formatDate(close.closedAt)} by{" "}
                  <span className="font-mono">{close.closedBy ?? "—"}</span>
                </span>
              </span>
            ) : (
              <span className="flex items-center gap-2">
                <Badge tone="positive">Open</Badge>
                <span className="text-sm font-normal text-ink-700">
                  Posting still allowed. Visit{" "}
                  <Link href="/periods" className="text-accent-600 hover:underline">
                    Periods
                  </Link>{" "}
                  to close.
                </span>
              </span>
            )}
          </CardTitle>
          <span className="text-xs text-ink-500">
            Tie-out checks:{" "}
            <span className={tbTies ? "text-emerald-700" : "text-red-700"}>
              {tbTies ? "✓" : "✗"} TB DR/CR ties
            </span>{" "}
            ·{" "}
            <span className={bsTies ? "text-emerald-700" : "text-red-700"}>
              {bsTies ? "✓" : "✗"} BS A = L + E
            </span>
            {checkedSubTies.length > 0 && (
              <>
                {" "}
                ·{" "}
                <span className={allSubTies ? "text-emerald-700" : "text-red-700"}>
                  {allSubTies ? "✓" : "✗"} Sub-ledger ties
                </span>
              </>
            )}
            {fluxRollup && (
              <>
                {" "}
                ·{" "}
                <span
                  className={
                    fluxRollup.signedOff ? "text-emerald-700" : "text-red-700"
                  }
                >
                  {fluxRollup.signedOff ? "✓" : "✗"} Flux signed off (
                  {fluxRollup.signed}/{fluxRollup.material})
                </span>
              </>
            )}
          </span>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <form className="flex items-end gap-3" method="get">
              {/* Preserve URL-override scope across form GET so a shareable
                  ?entity=&book= link doesn't drop the overrides when the
                  user picks a different period. */}
              {searchParams.entity ? (
                <input type="hidden" name="entity" value={searchParams.entity} />
              ) : null}
              {searchParams.book ? (
                <input type="hidden" name="book" value={searchParams.book} />
              ) : null}
              <label className="flex flex-col gap-1 text-xs text-ink-500">
                Period
                <select
                  name="period"
                  defaultValue={selectedPeriod.code}
                  className="rounded border border-ink-200 px-2 py-1 text-sm font-mono"
                >
                  {allPeriods.map((p) => (
                    <option key={p.id} value={p.code}>
                      {p.code} ({formatDate(p.startsOn)} → {formatDate(p.endsOn)})
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="submit"
                className="rounded bg-ink-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-ink-800"
              >
                Switch period
              </button>
            </form>
            <div className="flex items-end gap-2 text-xs">
              <a
                href={`/api/reports/month-end/csv?${packetQuery(selectedPeriod.code, searchParams)}`}
                className="rounded border border-ink-200 px-3 py-1.5 font-medium text-ink-700 hover:bg-ink-50"
                download
              >
                Download CSV
              </a>
              <a
                href={`/api/reports/month-end/pdf?${packetQuery(selectedPeriod.code, searchParams)}`}
                className="rounded bg-ink-900 px-3 py-1.5 font-medium text-white hover:bg-ink-800"
                download
              >
                Download PDF
              </a>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Sub-ledger ties detail. Renders only when there's at least one
          checked tie (i.e. the chart has a control account for AR or AP).
          Surfaces the math behind the green/red flag in the tie-out
          checks line — CPAs want to see the numbers, not just a check. */}
      {checkedSubTies.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              Sub-ledger reconciliation
              <Badge tone={allSubTies ? "positive" : "negative"}>
                {allSubTies ? "All ties OK" : "Drift detected"}
              </Badge>
            </CardTitle>
            <span className="text-xs text-ink-500">
              GL control account vs sum of open sub-ledger items, as of{" "}
              {formatDate(selectedPeriod.endsOn)}.
            </span>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <tr>
                  <TH>Tie</TH>
                  <TH>Control account</TH>
                  <TH className="text-right">GL balance</TH>
                  <TH className="text-right">Sub-ledger sum</TH>
                  <TH className="text-right">Δ</TH>
                  <TH>Status</TH>
                </tr>
              </THead>
              <TBody>
                {checkedSubTies.map((tie) => (
                  <TR key={tie.name}>
                    <TD className="text-ink-900">{tie.name}</TD>
                    <TD className="font-mono text-xs text-ink-700">
                      {tie.controlAccount?.code} — {tie.controlAccount?.name}
                    </TD>
                    <TD className="amount-cell text-right">
                      {formatMoney(tie.controlBalance)}
                    </TD>
                    <TD className="amount-cell text-right">
                      {formatMoney(tie.subledgerSum)}
                    </TD>
                    <TD className="amount-cell text-right">
                      {formatMoney(tie.delta)}
                    </TD>
                    <TD>
                      <Badge tone={tie.status === "ok" ? "positive" : "negative"}>
                        {tie.status === "ok" ? "ok" : "broken"}
                      </Badge>
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Flux / Variance rollup — BlackLine arc Phase 3 PR 4. Shows
          when a flux statement exists for the period. Deep-links to
          /close/flux/[id] for the controller to work the gaps. */}
      {fluxRollup && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <span>Flux analysis</span>
              <Badge tone={fluxRollup.signedOff ? "positive" : "negative"}>
                {fluxRollup.signedOff
                  ? "Signed off"
                  : fluxRollup.status === "FINALIZED"
                    ? "Finalized"
                    : "Draft"}
              </Badge>
            </CardTitle>
            <span className="text-xs text-ink-500">
              {fluxRollupLine(fluxRollup)} ·{" "}
              <Link
                href={`/close/flux/${fluxRollup.statementId}`}
                className="text-accent-600 hover:underline"
              >
                Open statement
              </Link>
            </span>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
              {[
                { label: "Explained", count: fluxRollup.explained, tone: "positive" as const },
                { label: "Waived", count: fluxRollup.waived, tone: "neutral" as const },
                { label: "Pending", count: fluxRollup.needsComment, tone: "negative" as const },
                { label: "Immaterial", count: fluxRollup.immaterial, tone: "neutral" as const },
              ].map(({ label, count, tone }) => (
                <div key={label} className="flex flex-col gap-1">
                  <div className="text-xs uppercase tracking-wide text-ink-500">
                    {label}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-lg font-semibold text-ink-900">
                      {count}
                    </span>
                    {count > 0 && fluxRollup.total > 0 && (
                      <Badge tone={tone}>
                        {Math.round((count / fluxRollup.total) * 100)}%
                      </Badge>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Income statement */}
      <Card>
        <CardHeader>
          <CardTitle>Income statement</CardTitle>
          <span className="text-xs text-ink-500">
            {formatDate(selectedPeriod.startsOn)} → {formatDate(selectedPeriod.endsOn)}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <tr>
                <TH>Code</TH>
                <TH>Account</TH>
                <TH className="text-right">Amount</TH>
              </tr>
            </THead>
            <TBody>
              {is.revenue.map((r) => (
                <TR key={`rev-${r.code}`}>
                  <TD className="font-mono text-xs text-ink-600">{r.code}</TD>
                  <TD className="text-ink-900">{r.name}</TD>
                  <TD className="text-right font-mono text-ink-900">
                    {formatMoney(r.amount)}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD className="font-mono text-xs text-ink-600"></TD>
                <TD className="text-ink-900 font-semibold">Total revenue</TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(is.totalRevenue)}
                </TD>
              </TR>
              {is.expenses.map((e) => (
                <TR key={`exp-${e.code}`}>
                  <TD className="font-mono text-xs text-ink-600">{e.code}</TD>
                  <TD className="text-ink-900">{e.name}</TD>
                  <TD className="text-right font-mono text-ink-900">
                    {formatMoney(e.amount)}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD className="font-mono text-xs text-ink-600"></TD>
                <TD className="text-ink-900 font-semibold">Total expenses</TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(is.totalExpenses)}
                </TD>
              </TR>
              <TR className="border-t-2 border-ink-300">
                <TD className="font-mono text-xs text-ink-600"></TD>
                <TD className="text-ink-900 font-semibold">Net income</TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(is.netIncome)}
                </TD>
              </TR>
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {/* Balance sheet */}
      <Card>
        <CardHeader>
          <CardTitle>Balance sheet</CardTitle>
          <span className="text-xs text-ink-500">
            As of {formatDate(selectedPeriod.endsOn)}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <tr>
                <TH>Code</TH>
                <TH>Account</TH>
                <TH className="text-right">Balance</TH>
              </tr>
            </THead>
            <TBody>
              {bs.assets.map((a) => (
                <TR key={`a-${a.code}`}>
                  <TD className="font-mono text-xs text-ink-600">{a.code}</TD>
                  <TD className="text-ink-900">{a.name}</TD>
                  <TD className="text-right font-mono text-ink-900">
                    {formatMoney(a.amount)}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD></TD>
                <TD className="text-ink-900 font-semibold">Total assets</TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(bs.totalAssets)}
                </TD>
              </TR>
              {bs.liabilities.map((l) => (
                <TR key={`l-${l.code}`}>
                  <TD className="font-mono text-xs text-ink-600">{l.code}</TD>
                  <TD className="text-ink-900">{l.name}</TD>
                  <TD className="text-right font-mono text-ink-900">
                    {formatMoney(l.amount)}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD></TD>
                <TD className="text-ink-900 font-semibold">Total liabilities</TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(bs.totalLiabilities)}
                </TD>
              </TR>
              {bs.equity.map((e) => (
                <TR key={`e-${e.code}`}>
                  <TD className="font-mono text-xs text-ink-600">{e.code}</TD>
                  <TD className="text-ink-900">{e.name}</TD>
                  <TD className="text-right font-mono text-ink-900">
                    {formatMoney(e.amount)}
                  </TD>
                </TR>
              ))}
              <TR>
                <TD></TD>
                <TD className="text-ink-900 font-semibold">Total equity</TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(bs.totalEquity)}
                </TD>
              </TR>
              <TR className="border-t-2 border-ink-300">
                <TD></TD>
                <TD className="text-ink-900 font-semibold">
                  Liabilities + Equity
                </TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(bs.totalLiabilities.plus(bs.totalEquity))}
                </TD>
              </TR>
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {/* Trial balance */}
      <Card>
        <CardHeader>
          <CardTitle>Trial balance</CardTitle>
          <span className="text-xs text-ink-500">
            As of {formatDate(selectedPeriod.endsOn)} ·{" "}
            <Link
              href={`/reports/trial-balance?asOf=${selectedPeriod.endsOn.toISOString().slice(0, 10)}`}
              className="text-accent-600 hover:underline"
            >
              full report
            </Link>
          </span>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <THead>
              <tr>
                <TH>Code</TH>
                <TH>Account</TH>
                <TH>Type</TH>
                <TH className="text-right">Debit</TH>
                <TH className="text-right">Credit</TH>
                <TH className="text-right">Balance</TH>
              </tr>
            </THead>
            <TBody>
              {tb.rows
                .filter((r) => !r.debit.isZero() || !r.credit.isZero())
                .map((r) => (
                  <TR key={r.accountCode}>
                    <TD className="font-mono text-xs text-ink-600">{r.accountCode}</TD>
                    <TD className="text-ink-900">{r.accountName}</TD>
                    <TD className="text-xs text-ink-500">{r.type}</TD>
                    <TD className="text-right font-mono text-ink-900">
                      {r.debit.isZero() ? "—" : formatMoney(r.debit)}
                    </TD>
                    <TD className="text-right font-mono text-ink-900">
                      {r.credit.isZero() ? "—" : formatMoney(r.credit)}
                    </TD>
                    <TD className="text-right font-mono text-ink-900">
                      {formatMoney(r.balance)}
                    </TD>
                  </TR>
                ))}
              <TR className="border-t-2 border-ink-300">
                <TD></TD>
                <TD className="text-ink-900 font-semibold">Totals</TD>
                <TD></TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(tb.totalDebit)}
                </TD>
                <TD className="text-right font-mono text-ink-900 font-semibold">
                  {formatMoney(tb.totalCredit)}
                </TD>
                <TD></TD>
              </TR>
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
