// AP aging report — mirror of /reports/ar-aging. Wraps apAging().

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { apAging, openApBalance } from "@/lib/accounting/sub-ledgers/ap";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

const BUCKET_LABEL: Record<string, string> = {
  CURRENT: "Current",
  "1_30": "1–30 days",
  "31_60": "31–60 days",
  "61_90": "61–90 days",
  OVER_90: "Over 90 days",
};

// v0.10 ergonomics: sortable columns via URL params — same shape as
// /reports/ar-aging. SSR-only, deep-linkable, no client JS.
const SORTABLE_KEYS = [
  "reference",
  "vendor",
  "opened",
  "due",
  "daysOverdue",
  "status",
  "original",
  "balance",
] as const;
type SortKey = (typeof SORTABLE_KEYS)[number];
type SortDir = "asc" | "desc";

function isSortKey(s: string | undefined): s is SortKey {
  return !!s && (SORTABLE_KEYS as readonly string[]).includes(s);
}

export default async function ApAgingPage({
  searchParams,
}: {
  searchParams: { asOf?: string; sortKey?: string; sortDir?: string };
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
  const asOf = searchParams.asOf ?? "2026-06-30";
  const asOfDate = new Date(asOf);
  const sortKey: SortKey = isSortKey(searchParams.sortKey)
    ? searchParams.sortKey
    : "due";
  const sortDir: SortDir = searchParams.sortDir === "desc" ? "desc" : "asc";

  const [buckets, total, items] = await Promise.all([
    apAging(prisma, scope.entityCode, scope.bookCode, asOfDate),
    openApBalance(prisma, scope.entityCode, scope.bookCode),
    prisma.apOpenItem.findMany({
      where: {
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      orderBy: [{ dueDate: "asc" }, { openedDate: "asc" }],
      select: {
        id: true,
        referenceNumber: true,
        openedDate: true,
        dueDate: true,
        originalAmount: true,
        currentBalance: true,
        status: true,
        party: { select: { code: true, displayName: true } },
      },
    }),
  ]);

  function daysOverdue(item: { dueDate: Date | null; openedDate: Date }): number | null {
    const ref = item.dueDate ?? item.openedDate;
    if (!ref) return null;
    return Math.floor((asOfDate.getTime() - ref.getTime()) / 86400000);
  }
  function bucketFor(item: { dueDate: Date | null; openedDate: Date }): string {
    const d = daysOverdue(item);
    if (d === null || d <= 0) return "CURRENT";
    if (d <= 30) return "1_30";
    if (d <= 60) return "31_60";
    if (d <= 90) return "61_90";
    return "OVER_90";
  }

  // In-mem sort — same shape as /reports/ar-aging.
  const sortedItems = [...items].sort((a, b) => {
    const mul = sortDir === "desc" ? -1 : 1;
    let cmp = 0;
    switch (sortKey) {
      case "reference":
        cmp = (a.referenceNumber ?? "").localeCompare(b.referenceNumber ?? "");
        break;
      case "vendor":
        cmp = a.party.displayName.localeCompare(b.party.displayName);
        break;
      case "opened":
        cmp = a.openedDate.getTime() - b.openedDate.getTime();
        break;
      case "due":
        if (a.dueDate === null && b.dueDate === null) cmp = 0;
        else if (a.dueDate === null) cmp = 1;
        else if (b.dueDate === null) cmp = -1;
        else cmp = a.dueDate.getTime() - b.dueDate.getTime();
        break;
      case "daysOverdue": {
        const da = daysOverdue(a) ?? -Infinity;
        const db = daysOverdue(b) ?? -Infinity;
        cmp = da - db;
        break;
      }
      case "status":
        cmp = a.status.localeCompare(b.status);
        break;
      case "original":
        cmp = new Decimal(a.originalAmount.toString())
          .minus(new Decimal(b.originalAmount.toString()))
          .toNumber();
        break;
      case "balance":
        cmp = new Decimal(a.currentBalance.toString())
          .minus(new Decimal(b.currentBalance.toString()))
          .toNumber();
        break;
    }
    return cmp * mul;
  });

  function sortHref(key: SortKey): string {
    const nextDir: SortDir = key === sortKey && sortDir === "asc" ? "desc" : "asc";
    return `?asOf=${encodeURIComponent(asOf)}&sortKey=${key}&sortDir=${nextDir}`;
  }
  function sortIndicator(key: SortKey): string {
    if (key !== sortKey) return "";
    return sortDir === "asc" ? " ↑" : " ↓";
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">AP Aging</h2>
          <p className="text-sm text-ink-500">
            {scope.entityCode} / {scope.bookCode} · as of {formatDate(asOfDate)} · {items.length} open
            bills · total <span className="font-mono">{formatMoney(total)}</span>
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
            href={`/api/reports/ap-aging/csv?asOf=${asOf}`}
            className="h-9 rounded-md border border-ink-200 bg-white px-3 py-2 text-xs font-medium text-ink-700 hover:bg-ink-50"
          >
            Download CSV
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
        {buckets.map((b) => (
          <Card key={b.bucket}>
            <CardContent className="px-4 py-3">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
                {BUCKET_LABEL[b.bucket]}
              </div>
              <div className="amount-cell mt-1 text-lg font-semibold text-ink-900">
                {formatMoney(b.totalBalance)}
              </div>
              <div className="text-[11px] text-ink-400">
                {b.itemCount} item{b.itemCount === 1 ? "" : "s"}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Open AP detail</CardTitle>
          <Link href="/ap" className="text-xs font-medium text-accent-600 hover:underline">
            Pay bills →
          </Link>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState title="No open AP items" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>
                    <Link href={sortHref("reference")} className="text-ink-700 hover:underline">
                      Reference{sortIndicator("reference")}
                    </Link>
                  </TH>
                  <TH>
                    <Link href={sortHref("vendor")} className="text-ink-700 hover:underline">
                      Vendor{sortIndicator("vendor")}
                    </Link>
                  </TH>
                  <TH>
                    <Link href={sortHref("opened")} className="text-ink-700 hover:underline">
                      Opened{sortIndicator("opened")}
                    </Link>
                  </TH>
                  <TH>
                    <Link href={sortHref("due")} className="text-ink-700 hover:underline">
                      Due{sortIndicator("due")}
                    </Link>
                  </TH>
                  <TH>
                    <Link href={sortHref("daysOverdue")} className="text-ink-700 hover:underline">
                      Days overdue{sortIndicator("daysOverdue")}
                    </Link>
                  </TH>
                  <TH>Bucket</TH>
                  <TH>
                    <Link href={sortHref("status")} className="text-ink-700 hover:underline">
                      Status{sortIndicator("status")}
                    </Link>
                  </TH>
                  <TH className="text-right">
                    <Link href={sortHref("original")} className="text-ink-700 hover:underline">
                      Original{sortIndicator("original")}
                    </Link>
                  </TH>
                  <TH className="text-right">
                    <Link href={sortHref("balance")} className="text-ink-700 hover:underline">
                      Balance{sortIndicator("balance")}
                    </Link>
                  </TH>
                </tr>
              </THead>
              <TBody>
                {sortedItems.map((item) => {
                  const d = daysOverdue(item);
                  return (
                    <TR key={item.id}>
                      <TD className="font-mono text-xs text-ink-700">
                        {item.referenceNumber ?? item.id.slice(0, 8)}
                      </TD>
                      <TD>
                        <div className="text-ink-900">{item.party.displayName}</div>
                        <div className="text-[11px] text-ink-500">{item.party.code}</div>
                      </TD>
                      <TD className="text-ink-500">{formatDate(item.openedDate)}</TD>
                      <TD className="text-ink-500">{formatDate(item.dueDate)}</TD>
                      <TD className={d !== null && d > 30 ? "text-negative" : "text-ink-500"}>
                        {d === null ? "—" : d > 0 ? `${d}d` : "—"}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            bucketFor(item) === "CURRENT"
                              ? "neutral"
                              : bucketFor(item) === "1_30"
                                ? "info"
                                : bucketFor(item) === "31_60"
                                  ? "warning"
                                  : "negative"
                          }
                        >
                          {BUCKET_LABEL[bucketFor(item)]}
                        </Badge>
                      </TD>
                      <TD>
                        <Badge tone={item.status === "PARTIAL" ? "warning" : "info"}>{item.status}</Badge>
                      </TD>
                      <TD className="amount-cell text-right text-ink-500">
                        {formatMoney(item.originalAmount.toString())}
                      </TD>
                      <TD className="amount-cell text-right font-semibold text-ink-900">
                        {formatMoney(item.currentBalance.toString())}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
