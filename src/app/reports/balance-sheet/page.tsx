// Balance sheet. As-of date via URL search param. Shows A = L + E
// invariant verification at the bottom.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getBalanceSheet } from "@/lib/accounting/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: { asOf?: string };
}) {
  const scope = getScope();
  const asOf = searchParams.asOf ?? "2026-06-30";
  const bs = await getBalanceSheet(prisma, scope, new Date(asOf));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Balance Sheet</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · as of {formatDate(new Date(asOf))}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form method="GET" className="flex items-end gap-2">
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
            href={`/api/reports/balance-sheet/csv?asOf=${asOf}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BsSection title="Assets" rows={bs.assets} total={bs.totalAssets} />
        <div className="flex flex-col gap-4">
          <BsSection title="Liabilities" rows={bs.liabilities} total={bs.totalLiabilities} />
          <BsSection title="Equity" rows={bs.equity} total={bs.totalEquity} />
        </div>
      </div>

      <Card>
        <CardContent className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Accounting equation
            </div>
            <div className="font-mono text-sm text-ink-700">
              Assets {formatMoney(bs.totalAssets)} = Liabilities {formatMoney(bs.totalLiabilities)} + Equity{" "}
              {formatMoney(bs.totalEquity)}
            </div>
            <div className="mt-1 text-xs text-ink-500">
              Retained earnings (computed): {formatMoney(bs.retainedEarnings)}
            </div>
          </div>
          <Badge tone={bs.balances ? "positive" : "negative"}>
            {bs.balances ? "A = L + E ✓" : "UNBALANCED"}
          </Badge>
        </CardContent>
      </Card>
    </div>
  );
}

function BsSection({
  title,
  rows,
  total,
}: {
  title: string;
  rows: { code: string; name: string; amount: any }[];
  total: any;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <span className="amount-cell text-sm font-semibold text-ink-900">{formatMoney(total)}</span>
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
            {rows.map((r) => (
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
  );
}
