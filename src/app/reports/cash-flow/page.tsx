// Cash Flow Statement (indirect method).
//
// Surfaces Operating / Investing / Financing sections with the
// reconciliation against actual Δ cash from the BS. The "Uncategorized"
// panel (when present) is the v0.9 self-audit: any BS account whose
// subtype the classification heuristic couldn't place shows up there.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import {
  getCashFlowStatement,
  type CashFlowLine,
} from "@/lib/accounting/reports/cash-flow";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";

export default async function CashFlowPage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string };
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
  const cf = await getCashFlowStatement(prisma, scope, new Date(from), new Date(to));

  const csvUrl = `/api/reports/cash-flow/csv?from=${from}&to=${to}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Cash Flow Statement</h2>
          <p className="text-sm text-ink-500">
            Indirect method · {scope.entityCode} / {scope.bookCode} · {formatDate(new Date(from))} → {formatDate(new Date(to))}
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
            href={csvUrl}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      {/* Reconciliation header */}
      <Card>
        <CardContent className="flex items-center justify-between px-5 py-4">
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Reconciliation
            </div>
            <div className="font-mono text-sm text-ink-700">
              Net cash flow (computed) {formatMoney(cf.netCashFlow)} = Actual Δ cash{" "}
              {formatMoney(cf.actualCashChange)}
              {cf.reconciles ? "" : ` (Δ ${formatMoney(cf.reconcilingDifference)})`}
            </div>
            <div className="mt-1 text-xs text-ink-500">
              Beginning cash {formatMoney(cf.beginningCash)} → ending cash {formatMoney(cf.endingCash)}
            </div>
          </div>
          <Badge tone={cf.reconciles ? "positive" : "warning"}>
            {cf.reconciles ? "Reconciles ✓" : "Discrepancy — see Uncategorized"}
          </Badge>
        </CardContent>
      </Card>

      {/* Operating activities */}
      <Card>
        <CardHeader>
          <CardTitle>Operating activities</CardTitle>
          <span className="amount-cell text-sm font-semibold text-ink-900">
            {formatMoney(cf.operatingCashFlow)}
          </span>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <tr>
                <TH>Item</TH>
                <TH>Rationale</TH>
                <TH className="text-right">Cash impact</TH>
              </tr>
            </THead>
            <TBody>
              <TR>
                <TD className="text-ink-900">Net income</TD>
                <TD className="text-ink-500">From income statement</TD>
                <TD className={`amount-cell text-right ${moneyClass(cf.netIncome)}`}>
                  {formatMoney(cf.netIncome)}
                </TD>
              </TR>
              {cf.nonCashAddBacks.map((l) => (
                <CfLineRow key={l.accountCode} line={l} />
              ))}
              {cf.workingCapitalChanges.map((l) => (
                <CfLineRow key={l.accountCode} line={l} />
              ))}
              <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
                <TD className="text-ink-700">Cash from operations</TD>
                <TD />
                <TD className="amount-cell text-right text-ink-900">
                  {formatMoney(cf.operatingCashFlow)}
                </TD>
              </tr>
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {/* Investing activities */}
      <Card>
        <CardHeader>
          <CardTitle>Investing activities</CardTitle>
          <span className="amount-cell text-sm font-semibold text-ink-900">
            {formatMoney(cf.investingCashFlow)}
          </span>
        </CardHeader>
        <CardContent>
          {cf.investingItems.length === 0 ? (
            <div className="text-sm text-ink-500">No investing activity in the period.</div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Account</TH>
                  <TH>Rationale</TH>
                  <TH className="text-right">Cash impact</TH>
                </tr>
              </THead>
              <TBody>
                {cf.investingItems.map((l) => (
                  <CfLineRow key={l.accountCode} line={l} showCode />
                ))}
                <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
                  <TD colSpan={3} className="text-ink-700">
                    Cash from investing
                  </TD>
                  <TD className="amount-cell text-right text-ink-900">
                    {formatMoney(cf.investingCashFlow)}
                  </TD>
                </tr>
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Financing activities */}
      <Card>
        <CardHeader>
          <CardTitle>Financing activities</CardTitle>
          <span className="amount-cell text-sm font-semibold text-ink-900">
            {formatMoney(cf.financingCashFlow)}
          </span>
        </CardHeader>
        <CardContent>
          {cf.financingItems.length === 0 ? (
            <div className="text-sm text-ink-500">No financing activity in the period.</div>
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Account</TH>
                  <TH>Rationale</TH>
                  <TH className="text-right">Cash impact</TH>
                </tr>
              </THead>
              <TBody>
                {cf.financingItems.map((l) => (
                  <CfLineRow key={l.accountCode} line={l} showCode />
                ))}
                <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
                  <TD colSpan={3} className="text-ink-700">
                    Cash from financing
                  </TD>
                  <TD className="amount-cell text-right text-ink-900">
                    {formatMoney(cf.financingCashFlow)}
                  </TD>
                </tr>
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Uncategorized accounts — surfaces classification gaps */}
      {cf.uncategorized.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Uncategorized BS changes</CardTitle>
            <Badge tone="warning">{cf.uncategorized.length} accounts not classified</Badge>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-ink-500">
              These accounts had a non-zero balance change but the v0.9 classification heuristic couldn't
              place them in Operating / Investing / Financing. Add the missing subtype mappings in{" "}
              <code className="font-mono">src/lib/accounting/reports/cash-flow.ts</code>.
            </p>
            <Table>
              <THead>
                <tr>
                  <TH>Code</TH>
                  <TH>Account</TH>
                  <TH className="text-right">Δ Amount</TH>
                </tr>
              </THead>
              <TBody>
                {cf.uncategorized.map((l) => (
                  <TR key={l.accountCode}>
                    <TD className="font-mono text-xs text-ink-700">{l.accountCode}</TD>
                    <TD className="text-ink-900">{l.accountName}</TD>
                    <TD className={`amount-cell text-right ${moneyClass(l.deltaAmount)}`}>
                      {formatMoney(l.deltaAmount)}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function CfLineRow({ line, showCode }: { line: CashFlowLine; showCode?: boolean }) {
  return (
    <TR>
      {showCode && <TD className="font-mono text-xs text-ink-700">{line.accountCode}</TD>}
      <TD className="text-ink-900">{showCode ? line.accountName : `Δ ${line.accountName}`}</TD>
      <TD className="text-ink-500">{line.rationale}</TD>
      <TD className={`amount-cell text-right ${moneyClass(line.cashImpact)}`}>
        {formatMoney(line.cashImpact)}
      </TD>
    </TR>
  );
}
