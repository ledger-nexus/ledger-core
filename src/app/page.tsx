// Dashboard — first thing a recruiter sees. Shows that the substrate is
// alive: cash, AR open, AP open, fixed-asset NBV for the current scope,
// plus a cross-book P&L delta if there's a Tax book to diff against, and
// the most recent journal entries.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { listMyTenants } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatMoney, formatDate, moneyClass } from "@/lib/utils/format";
import { getBalanceSheet, getIncomeStatement } from "@/lib/accounting/reports";
import { openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { openApBalance } from "@/lib/accounting/sub-ledgers/ap";
import { netBookValue } from "@/lib/accounting/sub-ledgers/fixed-assets";
import { getBookTaxDifference } from "@/lib/accounting/reports/book-tax-difference";

const ASOF = new Date("2026-06-30"); // demo cutoff matching the seed
const YEAR_START = new Date("2026-01-01");

export default async function DashboardPage() {
  const scope = getScope();

  // Onboarding gate: signed-in user with zero TenantMemberships sees
  // a workspace-creation prompt instead of the empty dashboard. Once
  // they create their first tenant the layout's getCurrentTenant
  // resolves and the regular dashboard renders.
  const user = await getCurrentUser();
  if (user) {
    const tenants = await listMyTenants();
    if (tenants.length === 0) {
      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-ink-900">Welcome</h2>
          <EmptyState
            title="Create your first workspace to get started"
            description="A workspace owns one or more legal entities, their books, and journal entries. You can invite teammates after the first workspace is created."
            action={{ href: "/onboarding", label: "Create workspace" }}
          />
        </div>
      );
    }
  }

  // Bail early with an empty state if the seed hasn't been run.
  const entryCount = await prisma.journalEntry.count({
    where: { entity: { code: scope.entityCode }, book: { code: scope.bookCode } },
  });
  if (entryCount === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <EmptyState
          title="No journal entries in this scope yet"
          description="Run `pnpm db:seed` to load the Northwind Cloud demo, or import a QBO/NetSuite export."
        />
      </div>
    );
  }

  // Parallel data fetches for the KPI cards.
  const [bs, pnl, arOpen, apOpen, nbv, recent] = await Promise.all([
    getBalanceSheet(prisma, scope, ASOF),
    getIncomeStatement(prisma, scope, YEAR_START, ASOF),
    openArBalance(prisma, scope.entityCode, scope.bookCode),
    openApBalance(prisma, scope.entityCode, scope.bookCode),
    netBookValue(prisma, scope.entityCode, scope.bookCode),
    prisma.journalEntry.findMany({
      where: {
        entity: { code: scope.entityCode },
        book: { code: scope.bookCode },
      },
      orderBy: [{ documentDate: "desc" }, { createdAt: "desc" }],
      take: 10,
      select: {
        id: true,
        entryNumber: true,
        documentDate: true,
        memo: true,
        source: true,
        sourceSystem: true,
        sourceRecordType: true,
        lines: { select: { debit: true } },
      },
    }),
  ]);

  // Aggregate cash from bank-flagged accounts on the BS.
  const cash = bs.assets
    .filter((a) => /^10\d{2}$|^Q1$|^NS1000$/.test(a.code))
    .reduce((acc, a) => acc.plus(a.amount), new Decimal(0));

  // Cross-book BTD vs US_TAX, only if scope is US_GAAP (the obvious pairing).
  let btdSummary: { delta: Decimal; otherBook: string } | null = null;
  if (scope.bookCode === "US_GAAP") {
    const otherBook = "US_TAX";
    const hasTaxBook = await prisma.book.findUnique({
      where: { code: otherBook },
      select: { id: true },
    });
    const taxEntries = hasTaxBook
      ? await prisma.journalEntry.count({
          where: { entity: { code: scope.entityCode }, book: { code: otherBook } },
        })
      : 0;
    if (taxEntries > 0) {
      const btd = await getBookTaxDifference(prisma, {
        entityCode: scope.entityCode,
        fromBookCode: scope.bookCode,
        toBookCode: otherBook,
        periodStart: YEAR_START,
        periodEnd: ASOF,
      });
      btdSummary = { delta: btd.totalDelta, otherBook };
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <p className="text-sm text-ink-500">
          As of {formatDate(ASOF)} · {entryCount} journal entries posted to this book
        </p>
      </div>

      {/* KPI grid */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Cash" value={cash} />
        <Kpi label="Accounts receivable (open)" value={arOpen} />
        <Kpi label="Accounts payable (open)" value={apOpen} />
        <Kpi label="Fixed-asset NBV" value={nbv.nbv} />
        <Kpi label="Revenue YTD" value={pnl.totalRevenue} />
        <Kpi label="Expenses YTD" value={pnl.totalExpenses} />
        <Kpi label="Net income YTD" value={pnl.netIncome} tone={pnl.netIncome.isNegative() ? "negative" : "positive"} />
        {btdSummary && (
          <Kpi
            label={`BTD vs ${btdSummary.otherBook} (book − tax)`}
            value={btdSummary.delta}
            hint="ASC 740 timing differences"
          />
        )}
      </div>

      {/* Recent entries */}
      <Card>
        <CardHeader>
          <CardTitle>Recent journal entries</CardTitle>
          <Link href="/journal-entries" className="text-xs font-medium text-accent-600 hover:underline">
            View all →
          </Link>
        </CardHeader>
        <CardContent>
          {recent.length === 0 ? (
            <EmptyState title="No journal entries in this scope" />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Entry #</TH>
                  <TH>Date</TH>
                  <TH>Memo</TH>
                  <TH>Source</TH>
                  <TH className="text-right">Total</TH>
                </tr>
              </THead>
              <TBody>
                {recent.map((entry) => {
                  const total = entry.lines.reduce(
                    (acc, l) => acc.plus(new Decimal(l.debit.toString())),
                    new Decimal(0)
                  );
                  return (
                    <TR key={entry.id}>
                      <TD className="font-mono text-xs">
                        <Link href={`/journal-entries/${entry.id}`} className="hover:underline">
                          {entry.entryNumber}
                        </Link>
                      </TD>
                      <TD className="text-ink-500">{formatDate(entry.documentDate)}</TD>
                      <TD className="text-ink-800">{entry.memo}</TD>
                      <TD>
                        <Badge tone={entry.sourceSystem ? "info" : "neutral"}>
                          {entry.sourceSystem ?? entry.source}
                        </Badge>
                      </TD>
                      <TD className="amount-cell text-right">{formatMoney(total)}</TD>
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

function Kpi({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: Decimal;
  hint?: string;
  tone?: "positive" | "negative" | "neutral";
}) {
  const num = value.toNumber();
  const accent =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : num < 0
          ? "text-negative"
          : "text-ink-900";
  return (
    <Card>
      <CardContent className="px-5 py-4">
        <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">{label}</div>
        <div className={`mt-1 font-mono text-xl font-semibold tabular-nums ${accent}`}>
          {formatMoney(value)}
        </div>
        {hint && <div className="mt-1 text-[11px] text-ink-400">{hint}</div>}
      </CardContent>
    </Card>
  );
}
