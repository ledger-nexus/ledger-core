// M-1 / M-3 detail report — Form 1120 Schedule M-3 style grouping of
// book-tax differences. Each M-3 line shows the deltas that roll into it,
// totaled with classification badges.

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { EmptyState } from "@/components/ui/empty-state";
import { getM3Detail } from "@/lib/accounting/reports/m3-detail";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatDate, formatMoney, moneyClass } from "@/lib/utils/format";

export default async function M3DetailPage({
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
  const bookFrom = searchParams.bookFrom ?? "US_GAAP";
  const bookTo = searchParams.bookTo ?? "US_TAX";

  const books = await prisma.book.findMany({
    where: { isActive: true },
    select: { code: true, name: true },
    orderBy: { code: "asc" },
  });

  const report = await getM3Detail(prisma, {
    entityCode: scope.entityCode,
    fromBookCode: bookFrom,
    toBookCode: bookTo,
    periodStart: new Date(from),
    periodEnd: new Date(to),
    tenantId: scope.tenantId,
  });

  const csvUrl = `/api/reports/m3-detail/csv?bookFrom=${bookFrom}&bookTo=${bookTo}&from=${from}&to=${to}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">M-1 / M-3 Detail</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} · {bookFrom} (book) vs {bookTo} (tax) · {formatDate(new Date(from))} →{" "}
            {formatDate(new Date(to))}
          </p>
          <p className="mt-1 text-xs text-ink-500">
            Groups book-tax differences by IRS Form 1120 Schedule M-3 line for tax-provision input.
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
            href={csvUrl}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
        <SummaryCard label="Book net income" value={report.bookNetIncome} />
        <SummaryCard label="Tax net income" value={report.taxNetIncome} />
        <SummaryCard
          label="Δ Temporary"
          value={report.temporaryTotal}
          hint="Reverse over time (feeds deferred tax)"
        />
        <SummaryCard label="Δ Permanent" value={report.permanentTotal} hint="Never reverse" />
      </div>

      {/* M-3 line groups */}
      {report.groups.map((group) => (
        <Card key={group.m3Line}>
          <CardHeader>
            <CardTitle>{group.m3Line}</CardTitle>
            <div className="flex items-center gap-3">
              <Badge
                tone={
                  group.classification === "TEMPORARY"
                    ? "info"
                    : group.classification === "PERMANENT"
                      ? "warning"
                      : group.classification === "MIXED"
                        ? "neutral"
                        : "neutral"
                }
              >
                {group.classification}
              </Badge>
              <span className={`amount-cell text-sm font-semibold ${moneyClass(group.totalDelta)}`}>
                Δ {formatMoney(group.totalDelta)}
              </span>
            </div>
          </CardHeader>
          <CardContent>
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
                {group.rows.map((r) => (
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
                    </TD>
                  </TR>
                ))}
                <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
                  <TD colSpan={5} className="text-ink-700">
                    Total · {group.m3Line}
                  </TD>
                  <TD className={`amount-cell text-right ${moneyClass(group.totalDelta)}`}>
                    {formatMoney(group.totalDelta)}
                  </TD>
                  <TD />
                </tr>
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
}: {
  label: string;
  value: { toNumber: () => number };
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="px-5 py-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
        <div className={`mt-1 amount-cell text-xl font-semibold ${moneyClass(value as any)}`}>
          {formatMoney(value as any)}
        </div>
        {hint && <div className="mt-1 text-[11px] text-ink-500">{hint}</div>}
      </CardContent>
    </Card>
  );
}
