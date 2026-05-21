// Income statement. Period start + end via URL search params.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getIncomeStatement } from "@/lib/accounting/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
}) {
  const scope = getScope();
  const from = searchParams.from ?? "2026-01-01";
  const to = searchParams.to ?? "2026-06-30";
  const pnl = await getIncomeStatement(prisma, scope, new Date(from), new Date(to));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Income Statement</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · {formatDate(new Date(from))} → {formatDate(new Date(to))}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form method="GET" className="flex items-end gap-2">
            <div>
              <Label htmlFor="from">From</Label>
              <Input type="date" name="from" id="from" defaultValue={from} />
            </div>
            <div>
              <Label htmlFor="to">To</Label>
              <Input type="date" name="to" id="to" defaultValue={to} />
            </div>
            <button
              type="submit"
              className="h-9 rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
            >
              Run
            </button>
          </form>
          <Link
            href={`/api/reports/income-statement/csv?from=${from}&to=${to}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Revenue</CardTitle>
            <span className="amount-cell text-sm font-semibold text-ink-900">
              {formatMoney(pnl.totalRevenue)}
            </span>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Account</TH>
                  <TH className="text-right">Amount</TH>
                </tr>
              </THead>
              <TBody>
                {pnl.revenue.map((r) => (
                  <TR key={r.code}>
                    <TD className="font-mono text-xs text-ink-700">{r.code}</TD>
                    <TD className="text-ink-900">{r.name}</TD>
                    <TD className={`amount-cell text-right ${moneyClass(r.amount)}`}>
                      {formatMoney(r.amount)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Expenses</CardTitle>
            <span className="amount-cell text-sm font-semibold text-ink-900">
              {formatMoney(pnl.totalExpenses)}
            </span>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Account</TH>
                  <TH className="text-right">Amount</TH>
                </tr>
              </THead>
              <TBody>
                {pnl.expenses.map((e) => (
                  <TR key={e.code}>
                    <TD className="font-mono text-xs text-ink-700">{e.code}</TD>
                    <TD className="text-ink-900">{e.name}</TD>
                    <TD className={`amount-cell text-right ${moneyClass(e.amount)}`}>
                      {formatMoney(e.amount)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Net income
            </div>
            <div className="text-xs text-ink-500">Revenue − Expenses</div>
          </div>
          <div
            className={`amount-cell text-2xl font-semibold ${
              pnl.netIncome.isNegative() ? "text-negative" : "text-positive"
            }`}
          >
            {formatMoney(pnl.netIncome)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
