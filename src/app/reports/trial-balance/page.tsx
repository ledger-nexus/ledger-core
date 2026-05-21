// Trial balance report. As-of date picker via URL search param.

import { Decimal } from "decimal.js";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getTrialBalance } from "@/lib/accounting/reports";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate } from "@/lib/utils/format";

export default async function TrialBalancePage({
  searchParams,
}: {
  searchParams: { asOf?: string };
}) {
  const scope = getScope();
  const asOf = searchParams.asOf ?? "2026-06-30";
  const tb = await getTrialBalance(prisma, scope, new Date(asOf));

  const nonZeroRows = tb.rows.filter(
    (r) => !new Decimal(r.debit.toString()).isZero() || !new Decimal(r.credit.toString()).isZero()
  );
  const balances = tb.totalDebit.equals(tb.totalCredit);

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
          <CardTitle>Trial balance</CardTitle>
          <Badge tone={balances ? "positive" : "negative"}>
            {balances ? "Σ Dr = Σ Cr ✓" : "UNBALANCED — Σ Dr ≠ Σ Cr"}
          </Badge>
        </CardHeader>
        <CardContent>
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
              {nonZeroRows.map((row) => (
                <TR key={row.accountCode}>
                  <TD className="font-mono text-xs text-ink-700">{row.accountCode}</TD>
                  <TD className="text-ink-900">{row.accountName}</TD>
                  <TD className="text-ink-500">{row.type}</TD>
                  <TD className="amount-cell text-right">
                    {new Decimal(row.debit.toString()).isZero() ? "" : formatMoney(row.debit)}
                  </TD>
                  <TD className="amount-cell text-right">
                    {new Decimal(row.credit.toString()).isZero() ? "" : formatMoney(row.credit)}
                  </TD>
                </TR>
              ))}
              <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
                <TD colSpan={3} className="text-ink-700">
                  Totals
                </TD>
                <TD className="amount-cell text-right text-ink-900">{formatMoney(tb.totalDebit)}</TD>
                <TD className="amount-cell text-right text-ink-900">{formatMoney(tb.totalCredit)}</TD>
              </tr>
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
