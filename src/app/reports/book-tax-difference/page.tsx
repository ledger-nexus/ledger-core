// Book-Tax-Difference report. From-book, to-book, period start/end via
// URL search params. Highlights the timing differences (TEMPORARY) that
// feed ASC 740 deferred-tax calculations.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import { getBookTaxDifference } from "@/lib/accounting/reports/book-tax-difference";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";

export default async function BookTaxDifferencePage({
  searchParams,
}: {
  searchParams: { from?: string; to?: string; bookFrom?: string; bookTo?: string };
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
  const bookFrom = searchParams.bookFrom ?? scope.bookCode;
  const bookTo = searchParams.bookTo ?? (bookFrom === "US_GAAP" ? "US_TAX" : "US_GAAP");

  const books = await prisma.book.findMany({
    where: { isActive: true },
    select: { code: true, name: true },
    orderBy: { code: "asc" },
  });

  const btd = await getBookTaxDifference(prisma, {
    entityCode: scope.entityCode,
    fromBookCode: bookFrom,
    toBookCode: bookTo,
    periodStart: new Date(from),
    periodEnd: new Date(to),
    tenantId: scope.tenantId,
  });

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Book–Tax Difference</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} · {bookFrom} (book) vs {bookTo} (tax) · {formatDate(new Date(from))} → {formatDate(new Date(to))}
          </p>
        </div>
        <div className="flex items-end gap-2">
          <form method="GET" className="flex items-end gap-2">
          <div>
            <Label htmlFor="bookFrom">Book</Label>
            <Select name="bookFrom" id="bookFrom" defaultValue={bookFrom}>
              {books.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.code}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="bookTo">Tax</Label>
            <Select name="bookTo" id="bookTo" defaultValue={bookTo}>
              {books.map((b) => (
                <option key={b.code} value={b.code}>
                  {b.code}
                </option>
              ))}
            </Select>
          </div>
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
            href={`/api/reports/book-tax-difference/csv?bookFrom=${bookFrom}&bookTo=${bookTo}&from=${from}&to=${to}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      {/* Summary KPIs */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Book net income
            </div>
            <div className={`mt-1 amount-cell text-xl font-semibold ${moneyClass(btd.bookNetIncome)}`}>
              {formatMoney(btd.bookNetIncome)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Tax net income
            </div>
            <div className={`mt-1 amount-cell text-xl font-semibold ${moneyClass(btd.taxNetIncome)}`}>
              {formatMoney(btd.taxNetIncome)}
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="px-5 py-4">
            <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
              Δ (book − tax)
            </div>
            <div className={`mt-1 amount-cell text-xl font-semibold ${moneyClass(btd.totalDelta)}`}>
              {formatMoney(btd.totalDelta)}
            </div>
            <div className="mt-1 text-[11px] text-ink-400">Feeds ASC 740 deferred tax</div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>P&L deltas</CardTitle>
          <span className="text-xs text-ink-500">{btd.pnlRows.length} accounts differ</span>
        </CardHeader>
        <CardContent>
          <BtdTable rows={btd.pnlRows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Balance sheet deltas</CardTitle>
          <span className="text-xs text-ink-500">{btd.balanceSheetRows.length} accounts differ</span>
        </CardHeader>
        <CardContent>
          <BtdTable rows={btd.balanceSheetRows} />
        </CardContent>
      </Card>
    </div>
  );
}

function BtdTable({
  rows,
}: {
  rows: {
    accountCode: string;
    accountName: string;
    type: string;
    bookAmount: any;
    taxAmount: any;
    delta: any;
    classification: "PERMANENT" | "TEMPORARY" | "UNCLASSIFIED";
    rationale: string;
  }[];
}) {
  if (rows.length === 0) {
    return <div className="text-sm text-ink-500">No differences in this section.</div>;
  }
  return (
    <Table>
      <THead>
        <tr>
          <TH>Code</TH>
          <TH>Account</TH>
          <TH>Type</TH>
          <TH className="text-right">Book</TH>
          <TH className="text-right">Tax</TH>
          <TH className="text-right">Δ</TH>
          <TH>Classification</TH>
        </tr>
      </THead>
      <TBody>
        {rows.map((r) => (
          <TR key={r.accountCode}>
            <TD className="font-mono text-xs text-ink-700">{r.accountCode}</TD>
            <TD className="text-ink-900">{r.accountName}</TD>
            <TD className="text-ink-500">{r.type}</TD>
            <TD className="amount-cell text-right">{formatMoney(r.bookAmount)}</TD>
            <TD className="amount-cell text-right">{formatMoney(r.taxAmount)}</TD>
            <TD className={`amount-cell text-right ${moneyClass(r.delta)}`}>{formatMoney(r.delta)}</TD>
            <TD>
              <Badge
                tone={
                  r.classification === "TEMPORARY"
                    ? "info"
                    : r.classification === "PERMANENT"
                      ? "warning"
                      : "neutral"
                }
              >
                {r.classification}
              </Badge>
              <div className="mt-0.5 text-[11px] text-ink-400">{r.rationale}</div>
            </TD>
          </TR>
        ))}
      </TBody>
    </Table>
  );
}
