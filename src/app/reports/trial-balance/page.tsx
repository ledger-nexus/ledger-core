// Trial balance report. As-of date picker via URL search param.
//
// Phase 7: renders hierarchically. Group accounts (parents) show their
// recursive subtotal; leaf accounts show their own balance. A ?flat=1
// override toggles back to the flat-code-sorted view for users who want
// the spreadsheet feel.

import { Decimal } from "decimal.js";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getTrialBalance, type TrialBalanceRow } from "@/lib/accounting/reports";
import {
  buildHierarchy,
  flattenForDisplay,
  type FlatAccountRow,
} from "@/lib/accounting/account-hierarchy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate } from "@/lib/utils/format";

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: { asOf?: string; flat?: string };
}) {
  const scope = getScope();
  const asOf = searchParams.asOf ?? "2026-06-30";
  const flat = searchParams.flat === "1";
  const tb = await getTrialBalance(prisma, scope, new Date(asOf));

  const balances = tb.totalDebit.equals(tb.totalCredit);

  // Convert TB rows into the hierarchy helper's input shape. Filter out
  // pure-zero accounts so the tree doesn't render dead-weight nodes.
  const flatRows: FlatAccountRow[] = tb.rows
    .filter((r) => {
      const d = new Decimal(r.debit.toString());
      const c = new Decimal(r.credit.toString());
      return !d.isZero() || !c.isZero();
    })
    .map((r) => ({
      code: r.accountCode,
      name: r.accountName,
      type: r.type,
      parentCode: r.parentCode,
      balance: new Decimal(r.balance.toString()),
      debit: new Decimal(r.debit.toString()),
      credit: new Decimal(r.credit.toString()),
      isContra: r.isContra,
    }));

  const tree = buildHierarchy(flatRows);
  const treeDisplay = flattenForDisplay(tree);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Trial Balance</h2>
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
            {flat && <input type="hidden" name="flat" value="1" />}
            <button
              type="submit"
              className="h-9 rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800"
            >
              Run
            </button>
          </form>
          <Link
            href={`/api/reports/trial-balance/csv?asOf=${asOf}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            Trial balance
            <Badge tone={balances ? "positive" : "negative"}>
              {balances ? "Σ Dr = Σ Cr ✓" : "UNBALANCED — Σ Dr ≠ Σ Cr"}
            </Badge>
          </CardTitle>
          <div className="text-xs text-ink-500">
            {flat ? (
              <Link href={`?asOf=${asOf}`} className="text-link hover:underline">
                Switch to hierarchical view
              </Link>
            ) : (
              <Link
                href={`?asOf=${asOf}&flat=1`}
                className="text-link hover:underline"
              >
                Switch to flat view
              </Link>
            )}
          </div>
        </CardHeader>
        <CardContent>
          {flat ? (
            <FlatTable rows={flatRows} totalDebit={tb.totalDebit} totalCredit={tb.totalCredit} />
          ) : (
            <HierarchicalTable
              displayRows={treeDisplay}
              totalDebit={tb.totalDebit}
              totalCredit={tb.totalCredit}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function HierarchicalTable({
  displayRows,
  totalDebit,
  totalCredit,
}: {
  displayRows: ReturnType<typeof flattenForDisplay>;
  totalDebit: Decimal;
  totalCredit: Decimal;
}) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>Code</TH>
          <TH>Account</TH>
          <TH>Type</TH>
          <TH className="text-right">Debit</TH>
          <TH className="text-right">Credit</TH>
        </tr>
      </THead>
      <TBody>
        {displayRows.map((node) => {
          // Group accounts get rendered with an inline subtotal badge in
          // the amount columns; leaf accounts get their own debit/credit
          // value. The depth-based indent makes the tree shape visible
          // even without explicit drill-down controls.
          const indentPx = node.depth * 16;
          const isGroup = node.hasChildren;
          const debitToShow = isGroup ? node.subtotalDebit : node.ownDebit;
          const creditToShow = isGroup ? node.subtotalCredit : node.ownCredit;
          return (
            <TR
              key={node.code}
              className={
                isGroup ? "bg-ink-50/50 font-medium text-ink-900" : undefined
              }
            >
              <TD className="font-mono text-xs text-ink-700">{node.code}</TD>
              <TD>
                <span style={{ paddingLeft: indentPx }}>{node.name}</span>
                {isGroup && (
                  <span className="ml-2 text-[10px] uppercase tracking-wide text-ink-400">
                    subtotal
                  </span>
                )}
              </TD>
              <TD className="text-ink-500">{node.type}</TD>
              <TD className="amount-cell text-right">
                {debitToShow.isZero() ? "" : formatMoney(debitToShow)}
              </TD>
              <TD className="amount-cell text-right">
                {creditToShow.isZero() ? "" : formatMoney(creditToShow)}
              </TD>
            </TR>
          );
        })}
        <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
          <TD colSpan={3} className="text-ink-700">
            Totals
          </TD>
          <TD className="amount-cell text-right text-ink-900">
            {formatMoney(totalDebit)}
          </TD>
          <TD className="amount-cell text-right text-ink-900">
            {formatMoney(totalCredit)}
          </TD>
        </tr>
      </TBody>
    </Table>
  );
}

function FlatTable({
  rows,
  totalDebit,
  totalCredit,
}: {
  rows: FlatAccountRow[];
  totalDebit: Decimal;
  totalCredit: Decimal;
}) {
  return (
    <Table>
      <THead>
        <tr>
          <TH>Code</TH>
          <TH>Account</TH>
          <TH>Type</TH>
          <TH className="text-right">Debit</TH>
          <TH className="text-right">Credit</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((row) => (
          <TR key={row.code}>
            <TD className="font-mono text-xs text-ink-700">{row.code}</TD>
            <TD className="text-ink-900">{row.name}</TD>
            <TD className="text-ink-500">{row.type}</TD>
            <TD className="amount-cell text-right">
              {row.debit.isZero() ? "" : formatMoney(row.debit)}
            </TD>
            <TD className="amount-cell text-right">
              {row.credit.isZero() ? "" : formatMoney(row.credit)}
            </TD>
          </TR>
        ))}
        <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
          <TD colSpan={3} className="text-ink-700">
            Totals
          </TD>
          <TD className="amount-cell text-right text-ink-900">{formatMoney(totalDebit)}</TD>
          <TD className="amount-cell text-right text-ink-900">{formatMoney(totalCredit)}</TD>
        </tr>
      </TBody>
    </Table>
  );
}
