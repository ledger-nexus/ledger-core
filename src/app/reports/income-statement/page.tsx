// Income statement. Period start + end via URL search params.
//
// Phase 7: hierarchical rendering with sub-totals (parent accounts roll
// up their children). ?flat=1 swaps to the old code-sorted view.

import { Decimal } from "@/lib/utils/decimal";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import { getIncomeStatement, type FinancialStatementRow } from "@/lib/accounting/reports";
import {
  buildHierarchy,
  flattenForDisplay,
  type FlatAccountRow,
  type HierarchyNode,
} from "@/lib/accounting/account-hierarchy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";

export default async function IncomeStatementPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; flat?: string };
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
  const from = searchParams.from ?? "2026-01-01";
  const to = searchParams.to ?? "2026-06-30";
  const flat = searchParams.flat === "1";
  const pnl = await getIncomeStatement(prisma, scope, new Date(from), new Date(to));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Income Statement</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · {formatDate(new Date(from))} → {formatDate(new Date(to))}
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <form method="GET" className="flex items-end gap-2 flex-wrap">
            <div>
              <Label htmlFor="from">From</Label>
              <Input type="date" name="from" id="from" defaultValue={from} />
            </div>
            <div>
              <Label htmlFor="to">To</Label>
              <Input type="date" name="to" id="to" defaultValue={to} />
            </div>
            {flat && <input type="hidden" name="flat" value="1" />}
            <button
              type="submit"
              className="h-9 rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
            >
              Run
            </button>
          </form>
          <Link
            href={`/api/reports/income-statement/csv?from=${from}&to=${to}${flat ? "&flat=1" : ""}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      <div className="text-xs text-ink-500 -mt-3">
        {flat ? (
          <Link href={`?from=${from}&to=${to}`} className="text-link hover:underline">
            Switch to hierarchical view
          </Link>
        ) : (
          <Link href={`?from=${from}&to=${to}&flat=1`} className="text-link hover:underline">
            Switch to flat view
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <IsSection title="Revenue" rows={pnl.revenue} total={pnl.totalRevenue} flat={flat} />
        <IsSection
          title="Expenses"
          rows={pnl.expenses}
          total={pnl.totalExpenses}
          flat={flat}
        />
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

function IsSection({
  title,
  rows,
  total,
  flat,
}: {
  title: string;
  rows: FinancialStatementRow[];
  total: Decimal;
  flat: boolean;
}) {
  const flatRows: FlatAccountRow[] = rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: "REVENUE", // placeholder — type not used by the hierarchy helper
    parentCode: r.parentCode,
    balance: new Decimal(r.amount.toString()),
    debit: new Decimal(0),
    credit: new Decimal(0),
    isContra: r.isContra,
  }));
  const tree = buildHierarchy(flatRows);
  const treeDisplay = flattenForDisplay(tree);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <span className="amount-cell text-sm font-semibold text-ink-900">
          {formatMoney(total)}
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
            {flat
              ? rows.map((r) => (
                  <TR key={r.code}>
                    <TD className="font-mono text-xs text-ink-700">{r.code}</TD>
                    <TD className="text-ink-900">{r.name}</TD>
                    <TD className={`amount-cell text-right ${moneyClass(r.amount)}`}>
                      {formatMoney(r.amount)}
                    </TD>
                  </TR>
                ))
              : treeDisplay.map((node) => (
                  <HierarchyTR key={node.code} node={node} />
                ))}
          </TBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function HierarchyTR({ node }: { node: HierarchyNode }) {
  const indentPx = node.depth * 16;
  const isGroup = node.hasChildren;
  const valueToShow = isGroup ? node.subtotalBalance : node.ownBalance;
  return (
    <TR className={isGroup ? "bg-ink-50/50 font-medium text-ink-900" : undefined}>
      <TD className="font-mono text-xs text-ink-700">{node.code}</TD>
      <TD>
        <span style={{ paddingLeft: indentPx }}>{node.name}</span>
        {isGroup && (
          <span className="ml-2 text-[11px] uppercase tracking-wide text-ink-500">
            subtotal
          </span>
        )}
      </TD>
      <TD className={`amount-cell text-right ${moneyClass(valueToShow)}`}>
        {formatMoney(valueToShow)}
      </TD>
    </TR>
  );
}
