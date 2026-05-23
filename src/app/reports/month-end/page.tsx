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
import { getScope } from "@/lib/scope";
import {
  getTrialBalance,
  getIncomeStatement,
  getBalanceSheet,
} from "@/lib/accounting/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate } from "@/lib/utils/format";

interface SearchParams {
  period?: string;
}

export default async function MonthEndPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const scope = getScope();

  const entity = await prisma.legalEntity.findUnique({
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

  // Run the three reports in parallel — they're independent SQL queries.
  const [tb, is, bs] = await Promise.all([
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
  ]);

  const tbTies = tb.totalDebit.equals(tb.totalCredit);
  const bsTies = bs.totalAssets.equals(bs.totalLiabilities.plus(bs.totalEquity));

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
          </span>
        </CardHeader>
        <CardContent>
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <form className="flex items-end gap-3" method="get">
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
                href={`/api/reports/month-end/csv?period=${selectedPeriod.code}`}
                className="rounded border border-ink-200 px-3 py-1.5 font-medium text-ink-700 hover:bg-ink-50"
                download
              >
                Download CSV
              </a>
              <a
                href={`/api/reports/month-end/pdf?period=${selectedPeriod.code}`}
                className="rounded bg-ink-900 px-3 py-1.5 font-medium text-white hover:bg-ink-800"
                download
              >
                Download PDF
              </a>
            </div>
          </div>
        </CardContent>
      </Card>

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
