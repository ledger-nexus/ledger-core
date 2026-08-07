// Balance sheet. As-of date via URL search param. Shows A = L + E
// invariant verification at the bottom.
//
// Phase 7: renders hierarchically (parent accounts → indented children →
// recursive sub-totals). `?flat=1` switches to the old code-sorted view.
// On a flat chart of accounts the two views look identical — the helper
// treats every row as a root.

import { Decimal } from "@/lib/utils/decimal";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getBalanceSheet, type FinancialStatementRow } from "@/lib/accounting/reports";
import {
  buildHierarchy,
  flattenForDisplay,
  type FlatAccountRow,
  type HierarchyNode,
} from "@/lib/accounting/account-hierarchy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";

export default async function BalanceSheetPage({
  searchParams,
}: {
  searchParams: { asOf?: string; flat?: string };
}) {
  // Tenant-verified scope (closes the cross-tenant read leak that the
  // raw lc-scope cookie used to enable).
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
  const flat = searchParams.flat === "1";
  const bs = await getBalanceSheet(prisma, scope, new Date(asOf));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Balance Sheet</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · as of {formatDate(new Date(asOf))}
          </p>
        </div>
        <div className="flex items-end gap-2 flex-wrap">
          <form method="GET" className="flex items-end gap-2 flex-wrap">
            <div>
              <Label htmlFor="asOf">As of</Label>
              <Input type="date" name="asOf" id="asOf" defaultValue={asOf} />
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
            href={`/api/reports/balance-sheet/csv?asOf=${asOf}${flat ? "&flat=1" : ""}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      <div className="text-xs text-ink-500 -mt-3">
        {flat ? (
          <Link href={`?asOf=${asOf}`} className="text-link hover:underline">
            Switch to hierarchical view
          </Link>
        ) : (
          <Link href={`?asOf=${asOf}&flat=1`} className="text-link hover:underline">
            Switch to flat view
          </Link>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BsSection title="Assets" rows={bs.assets} total={bs.totalAssets} flat={flat} />
        <div className="flex flex-col gap-4">
          <BsSection
            title="Liabilities"
            rows={bs.liabilities}
            total={bs.totalLiabilities}
            flat={flat}
          />
          <BsSection title="Equity" rows={bs.equity} total={bs.totalEquity} flat={flat} />
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
  flat,
}: {
  title: string;
  rows: FinancialStatementRow[];
  total: Decimal;
  flat: boolean;
}) {
  // For hierarchy: convert each FinancialStatementRow into the helper's
  // FlatAccountRow shape. Single amount → both debit and credit zero
  // (the helper rolls up `balance`, which is what we render in BS).
  const flatRows: FlatAccountRow[] = rows.map((r) => ({
    code: r.code,
    name: r.name,
    type: "ASSET", // not used for rendering here; placeholder
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
  // Groups show the rolled-up subtotal. Leaves show their own value.
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
