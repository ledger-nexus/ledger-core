// Dashboard — the current financial position for the active (entity, book):
// cash, net assets, YTD P&L, plus a cross-book delta if there's a Tax book
// to diff against, and the most recent journal entries.
//
// KPI tiles are relevance-gated (Selective Attention): a wall of identical
// 0.00 tiles hides the numbers that matter, so sub-ledger tiles only render
// for books that actually use that sub-ledger. Nothing is removed — a book
// with AR shows AR.

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
import { getDashboardSnapshot } from "@/lib/dashboard/snapshot";

export default async function DashboardPage() {
  // As-of is *now*, resolved per request.
  //
  // This was previously a module-level `new Date("2026-06-30")` — the demo
  // seed's cutoff. Every balance below is computed as-of this date, so the
  // hardcoded value silently hid every entry posted after it: a real book
  // reported 0.00 across the board while its entries sat there, dated later.
  // Module scope would also freeze the value at server start, so it's
  // computed inside the request.
  const now = new Date();
  const ASOF = now;

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
    const currentTenantId = tenants[0].id; // single-tenant user fallback
    // For a multi-tenant user we'd resolve current via getCurrentTenant,
    // but at this point they have memberships → layout's getCurrentTenant
    // already resolved; using listMyTenants[0] for single is fine and
    // we only block when EVERY accessible tenant has zero entities.
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

  // Tenant-verified scope for every read below.
  //
  // This page previously read `getScope()` — the RAW lc-scope cookie —
  // and fed scope.entityCode straight into report calls and Prisma
  // queries. A signed-in user could hand-edit the cookie to ANOTHER
  // tenant's entity code and have the dashboard render that entity's
  // balances, JE metadata, and activity (a cross-tenant read leak).
  // getCurrentScope() resolves the cookie against THIS tenant's entities
  // and pre-resolves entityId + tenantId, so every query below is pinned
  // to a (tenantId, entityId) the caller actually owns. Fail closed when
  // it can't resolve (not signed in, or the tenant has no entity).
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <EmptyState
          title="Sign in to view your dashboard"
          description="Your financial position appears here once you're signed in to a workspace with at least one entity."
        />
      </div>
    );
  }

  // Bail early with an empty state if the seed hasn't been run.
  const entryCount = await prisma.journalEntry.count({
    where: {
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      book: { code: scope.bookCode },
    },
  });
  if (entryCount === 0) {
    return (
      <div className="flex flex-col gap-4">
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <EmptyState
          title="No journal entries in this scope yet"
          description="Post your first journal entry to get started — most books open with an entry recording your opening balances."
        />
      </div>
    );
  }

  // Every tenant-scoped read the dashboard renders lives behind one
  // boundary: getDashboardSnapshot takes the AuthorizedLedgerScope and
  // returns already-scoped figures, so this component stays presentation.
  const {
    pnl,
    arOpen,
    apOpen,
    nbv,
    recent,
    openNoteCount,
    lastClose,
    openPeriodCount,
    subledgerTies,
    brokenTies,
    arItemCount,
    apItemCount,
    fixedAssetCount,
    forReviewCount,
    closeProgress,
    recurringDueCount,
    daysSinceClose,
    cash,
    netAssets,
    btdSummary,
  } = await getDashboardSnapshot(prisma, scope, now);


  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Dashboard</h2>
        <p className="text-sm text-ink-500">
          As of {formatDate(ASOF)} · {entryCount} journal entries posted to this book
        </p>
      </div>

      {/* KPI grid. Cash and net assets lead: they answer "what do I have"
          and "what am I worth", which is what the page is opened for
          (Serial Position). Sub-ledger tiles render only for books that
          use those sub-ledgers. */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Kpi label="Cash" value={cash} />
        <Kpi
          label="Net assets"
          value={netAssets}
          hint="assets − liabilities"
          tone={netAssets.isNegative() ? "negative" : "positive"}
        />
        {arItemCount > 0 && <Kpi label="Accounts receivable (open)" value={arOpen} />}
        {apItemCount > 0 && <Kpi label="Accounts payable (open)" value={apOpen} />}
        {fixedAssetCount > 0 && <Kpi label="Fixed-asset NBV" value={nbv.nbv} />}
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
              label="Bank lines to review"
              count={forReviewCount}
              href="/banking"
              urgentAt={1}
              urgentLabel="waiting in the feed"
              emptyLabel="inbox zero"
            />
            {closeProgress && (
              <Link
                href="/close/tasks"
                className="group flex items-center justify-between gap-3"
              >
                <div className="flex min-w-0 flex-col">
                  <span className="text-sm text-ink-900 group-hover:underline">
                    Close {closeProgress.periodCode}
                  </span>
                  <span className="text-xs text-ink-500">
                    {closeProgress.done} of {closeProgress.total} tasks done
                  </span>
                </div>
                {/* Goal-gradient: the bar itself, not just the fraction. */}
                <div className="h-1.5 w-24 shrink-0 rounded-full bg-ink-100">
                  <div
                    className="h-1.5 rounded-full bg-ink-900"
                    style={{
                      width: `${Math.round((closeProgress.done / closeProgress.total) * 100)}%`,
                    }}
                  />
                </div>
              </Link>
            )}
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
  // Sign check stays in Decimal — never round-trip money through a JS
  // number just to read its sign (precision loss on large balances).
  const accent =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : value.isNegative()
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
