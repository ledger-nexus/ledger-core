// Dashboard — first thing a recruiter sees. Shows that the substrate is
// alive: cash, AR open, AP open, fixed-asset NBV for the current scope,
// plus a cross-book P&L delta if there's a Tax book to diff against, and
// the most recent journal entries.

import Link from "next/link";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
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
import { enumerateDueDates } from "@/lib/accounting/recurring";
import { checkSubledgerTies } from "@/lib/accounting/subledger-ties";

const ASOF = new Date("2026-06-30"); // demo cutoff matching the seed
const YEAR_START = new Date("2026-01-01");

export default async function DashboardPage() {
  // Onboarding gate: three states the signed-in user can be in.
  //
  //   1. Zero TenantMemberships → /onboarding (create workspace)
  //   2. Has a tenant but the tenant has zero LegalEntity rows →
  //      /onboarding/setup (set up first entity)
  //   3. Has a tenant + at least one entity → normal dashboard
  //
  // Without (2) the user lands on a dashboard scoped to the seed-default
  // entityCode (NORTHWIND), sees data that isn't theirs, and gets confused.
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
    // Check current tenant's entity count; route to /onboarding/setup
    // if the tenant exists but no entity has been provisioned yet.
    // listMyTenants already filtered to active memberships, so we only
    // need the count call (cheap).
    const entityCount = await prisma.legalEntity.count({
      where: { tenantId: { in: tenants.map((t) => t.id) } },
    });
    if (entityCount === 0) {
      return (
        <div className="flex flex-col gap-4">
          <h2 className="text-xl font-semibold text-ink-900">
            Almost there
          </h2>
          <EmptyState
            title="Set up your first entity to start using the workspace"
            description="A workspace needs at least one legal entity (company / subsidiary / client) with its books and chart of accounts. Takes about 30 seconds."
            action={{ href: "/onboarding/setup", label: "Set up entity" }}
          />
        </div>
      );
    }
  }

  // Tenant-verified scope. getCurrentScope() resolves the lc-scope
  // cookie against the actual tenant memberships and falls back to the
  // tenant's first entity if the cookie names one we don't own —
  // closes the cookie-edit cross-tenant read leak getScope() left
  // open. Returns null only when the user has no tenant + entity yet,
  // which the onboarding gate above already handled.
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <EmptyState
          title="No scope available"
          description="Sign in and select a tenant to view the dashboard."
        />
      </div>
    );
  }

  // Bail early with an empty state if the seed hasn't been run.
  const entryCount = await prisma.journalEntry.count({
    where: { entityId: scope.entityId, book: { code: scope.bookCode } },
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

  // Parallel data fetches: KPIs + activity-surfaces ("what needs my
  // attention") for the dashboard's secondary panels.
  const [
    bs,
    pnl,
    arOpen,
    apOpen,
    nbv,
    recent,
    openNoteCount,
    recurringTemplates,
    lastClose,
    openPeriodCount,
    subledgerTies,
  ] = await Promise.all([
    getBalanceSheet(prisma, scope, ASOF),
    getIncomeStatement(prisma, scope, YEAR_START, ASOF),
    openArBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    openApBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    netBookValue(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    prisma.journalEntry.findMany({
      where: {
        entityId: scope.entityId,
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
    // Open review notes attached to JEs in the active scope. A pure
    // count is enough for the badge; the user clicks through to find
    // them in /journal-entries (filtered list shows the "N open" badge).
    prisma.journalEntryNote.count({
      where: {
        resolvedAt: null,
        entry: {
          entityId: scope.entityId,
          book: { code: scope.bookCode },
        },
      },
    }),
    // Active recurring templates for this (entity, book). We compute
    // "due today" client-side via enumerateDueDates so the cadence
    // math stays in one place.
    prisma.recurringEntry.findMany({
      where: {
        isActive: true,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
      select: {
        cadence: true,
        startDate: true,
        endDate: true,
        lastPostedDate: true,
      },
    }),
    // Most recent period close for this (entity, book). Lets the
    // dashboard show "May 2026 closed 4 days ago by …".
    prisma.periodClose.findFirst({
      where: {
        entityId: scope.entityId,
        book: { code: scope.bookCode },
      },
      orderBy: { closedAt: "desc" },
      select: {
        closedAt: true,
        closedBy: true,
        period: { select: { code: true } },
      },
    }),
    // Count of periods on the entity's calendar that don't have a
    // close row for this book. "Open periods" = posting still allowed
    // there. Useful at month-end: "you have 3 open periods — close
    // April before you close May."
    prisma.period.count({
      where: {
        calendar: { entityId: scope.entityId },
        tenantId: scope.tenantId,
        // No close row for THIS book.
        NOT: {
          closes: {
            some: {
              book: { code: scope.bookCode },
            },
          },
        },
      },
    }),
    // Sub-ledger ties: AR control vs sum-of-open-AR, AP control vs
    // sum-of-open-AP. Broken ties point at a real bug — either a JE
    // posted to a control account without flowing through the sub-
    // ledger, or a sub-ledger write that drifted from the JE total.
    checkSubledgerTies(prisma, {
      entityCode: scope.entityCode,
      bookCode: scope.bookCode,
      asOf: ASOF,
    }),
  ]);

  // Count of broken ties for the dashboard badge.
  const brokenTies = subledgerTies.filter((t) => t.status === "broken").length;

  // Compute "due today" count from the active recurring templates.
  // Pure client-side math — the runner uses the same helper.
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const recurringDueCount = recurringTemplates.reduce((sum, t) => {
    const due = enumerateDueDates({
      cadence: t.cadence,
      startDate: t.startDate,
      lastPostedDate: t.lastPostedDate,
      endDate: t.endDate,
      throughDate: today,
    });
    return sum + due.length;
  }, 0);

  // Days since last close (for the "closed N days ago" tooltip).
  const daysSinceClose =
    lastClose != null
      ? Math.floor(
          (Date.now() - lastClose.closedAt.getTime()) / (1000 * 60 * 60 * 24)
        )
      : null;

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
          where: { entityId: scope.entityId, book: { code: otherBook } },
        })
      : 0;
    if (taxEntries > 0) {
      const btd = await getBookTaxDifference(prisma, {
        entityCode: scope.entityCode,
        fromBookCode: scope.bookCode,
        toBookCode: otherBook,
        periodStart: YEAR_START,
        periodEnd: ASOF,
        tenantId: scope.tenantId,
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

      {/* Action items + Close status — surfaces the activity panels for
          features shipped this session (notes, recurring entries, period
          close). At-a-glance "what needs my attention" alongside the
          KPI numbers. */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Action items</CardTitle>
            <span className="text-xs text-ink-500">
              What needs attention in {scope.entityCode} / {scope.bookCode}
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ActionRow
              label="Open review notes"
              count={openNoteCount}
              href="/journal-entries?q="
              urgentAt={1}
              urgentLabel="needs review"
              emptyLabel="no open notes"
            />
            <ActionRow
              label="Recurring entries due"
              count={recurringDueCount}
              href="/recurring-entries"
              urgentAt={1}
              urgentLabel="ready to post"
              emptyLabel="nothing due"
            />
            {/* Sub-ledger ties: one row per checked tie. Broken ties are
                URGENT — they indicate the books don't reconcile, which
                is a real CPA concern. When everything ties we show a
                compact "all 2 ties ok ✓" affordance instead of two
                green rows so the panel stays scannable. */}
            {brokenTies === 0 ? (
              <div className="flex items-center justify-between gap-3">
                <div className="flex flex-col">
                  <span className="text-sm text-ink-900">Sub-ledger ties</span>
                  <span className="text-xs text-ink-500">
                    {subledgerTies.length === 0
                      ? "—"
                      : `${
                          subledgerTies.filter((t) => t.status === "ok").length
                        } of ${
                          subledgerTies.filter(
                            (t) => t.status !== "no_control_account"
                          ).length
                        } tie OK`}
                  </span>
                </div>
                <Badge tone="positive">✓</Badge>
              </div>
            ) : (
              <>
                {subledgerTies
                  .filter((t) => t.status === "broken")
                  .map((tie) => (
                    <div
                      key={tie.name}
                      className="flex items-start justify-between gap-3 rounded-md border border-amber-200 bg-amber-50 p-2"
                    >
                      <div className="flex flex-col">
                        <span className="text-sm text-ink-900">
                          {tie.name} drift
                        </span>
                        <span className="text-xs text-ink-500">
                          {tie.controlAccount?.code} {formatMoney(tie.controlBalance)} ≠ sub-ledger {formatMoney(tie.subledgerSum)} (Δ {formatMoney(tie.delta)})
                        </span>
                      </div>
                      <Link
                        href={tie.investigateHref}
                        className="text-xs font-medium text-accent-600 hover:underline"
                      >
                        Open →
                      </Link>
                    </div>
                  ))}
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Close status</CardTitle>
            <span className="text-xs text-ink-500">
              Period-close state for {scope.bookCode}
            </span>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {lastClose ? (
              <div>
                <div className="text-[11px] uppercase tracking-wider text-ink-500">
                  Last closed
                </div>
                <div className="mt-0.5 text-sm">
                  <span className="font-mono text-ink-900">
                    {lastClose.period.code}
                  </span>{" "}
                  <span className="text-ink-500">
                    {daysSinceClose === 0
                      ? "(today)"
                      : `(${daysSinceClose} day${daysSinceClose === 1 ? "" : "s"} ago)`}
                  </span>
                </div>
                {lastClose.closedBy && (
                  <div className="mt-0.5 text-xs text-ink-500">
                    by {lastClose.closedBy}
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-ink-500">
                No periods closed yet on this book.
              </div>
            )}
            <ActionRow
              label="Open periods"
              count={openPeriodCount}
              href="/periods"
              urgentAt={4}
              urgentLabel="behind on closes"
              emptyLabel="everything closed"
            />
          </CardContent>
        </Card>
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

/**
 * One row in the "Action items" card. Renders as a flex row with the
 * label, a count badge (amber when > urgentAt, neutral otherwise),
 * and a click-through link. When count is 0, shows `emptyLabel` muted.
 */
function ActionRow({
  label,
  count,
  href,
  urgentAt,
  urgentLabel,
  emptyLabel,
}: {
  label: string;
  count: number;
  href: string;
  /** count >= urgentAt → amber tone (default 1). */
  urgentAt: number;
  /** Caption shown next to the count when urgent. */
  urgentLabel: string;
  /** Replacement caption when count === 0. */
  emptyLabel: string;
}) {
  const urgent = count >= urgentAt;
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex flex-col">
        <span className="text-sm text-ink-900">{label}</span>
        <span className="text-xs text-ink-500">
          {count === 0 ? emptyLabel : urgentLabel}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {count > 0 ? (
          <Badge tone={urgent ? "warning" : "info"}>{count}</Badge>
        ) : (
          <Badge tone="neutral">{count}</Badge>
        )}
        <Link
          href={href}
          className="text-xs font-medium text-accent-600 hover:underline"
        >
          Open →
        </Link>
      </div>
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
