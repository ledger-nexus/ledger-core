// Open AR list with per-item apply-payment inline forms.
//
// ⚠️ THE WORKLIST IS PAGED, THE TOTALS ARE NOT. `openArBalance` and the item
// count are computed over every open item in scope; only the rows on screen are
// fetched. Those have to stay separate — a collections worklist whose "total"
// silently meant "total of the 50 rows you can see" is a number someone quotes
// to a customer.
//
// Before this, the query had no `take` at all: every OPEN / PARTIAL / REOPENED
// item in the scope, with its party join, on one page. Bounded by how well the
// business collects, which is not a bound.

import type { Prisma } from "@prisma/client";
import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { listEntityBooksWithOpenItems } from "@/lib/accounting/sub-ledgers/cross-book";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { Pagination } from "@/components/ui/pagination";
import { MultiBookBanner } from "@/components/multi-book-banner";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { buildUrl, int, parseUrlState, type RawParams, type SurfaceSpec } from "@/lib/url-state";
import { ApplyArPaymentRow } from "./apply-payment-row";
import { ReassignArRow } from "./reassign-ar-row";

const PAGE_SIZE = 50;

/** The worklist's only parameter. */
const SPEC = { page: int(1, { min: 1 }) } satisfies SurfaceSpec;

export default async function ArPage({
  searchParams,
}: {
  searchParams: RawParams;
}) {
  // Tenant-verified scope — raw getScope() would let a hand-edited cookie
  // name another tenant's entity code. getCurrentScope() resolves it
  // against this tenant and pre-resolves entityId/tenantId.
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing AR."
      />
    );
  }
  const tenantFilter = { tenantId: scope.tenantId };
  // ⚠️ Typed, not `as const` — Prisma's generated filter wants a MUTABLE
  // string[] and rejects a readonly tuple.
  const itemWhere: Prisma.ArOpenItemWhereInput = {
    ...tenantFilter,
    entity: { code: scope.entityCode },
    book: { code: scope.bookCode },
    status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
  };

  // Counted before the page is resolved, so `?page=` beyond the end clamps to
  // the last real page instead of rendering an empty worklist that reads as
  // "nothing outstanding".
  const totalCount = await prisma.arOpenItem.count({ where: itemWhere });
  const totalPages = Math.max(1, Math.ceil(totalCount / PAGE_SIZE));
  const page = Math.min(parseUrlState(SPEC, searchParams).page, totalPages);

  const [openItems, total, cashAccounts, users, queues, entityBooks] = await Promise.all([
    prisma.arOpenItem.findMany({
      where: itemWhere,
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
      orderBy: [{ dueDate: "asc" }, { openedDate: "asc" }],
      select: {
        id: true,
        referenceNumber: true,
        openedDate: true,
        dueDate: true,
        originalAmount: true,
        currentBalance: true,
        status: true,
        currencyId: true,
        ownerId: true,
        ownerType: true,
        reassignmentLockedAt: true,
        party: { select: { code: true, displayName: true } },
      },
    }),
    openArBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
    prisma.account.findMany({
      where: {
        tenantId: scope.tenantId,
        active: true,
        isBank: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
    prisma.user.findMany({
      where: {
        isActive: true,
        tenantMemberships: { some: { tenantId: scope.tenantId } },
      },
      select: { id: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
    prisma.queue.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true, code: true, name: true },
      orderBy: { code: "asc" },
    }),
    // v0.9 Phase 3.5.E — discover other books on this entity that have
    // open AR/AP items, so the banner can surface multi-book reality
    // when the operator is on `(entity, US_GAAP)` while `US_TAX` also
    // has open items.
    listEntityBooksWithOpenItems(prisma, scope.entityCode, scope.tenantId),
  ]);

  // Resolve owner display labels (user displayName or queue name).
  const ownerLabels = new Map<string, { label: string; type: "USER" | "QUEUE" }>();
  for (const u of users) ownerLabels.set(u.id, { label: u.displayName, type: "USER" });
  for (const q of queues) ownerLabels.set(q.id, { label: q.name, type: "QUEUE" });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Open Accounts Receivable</h2>
        <p className="text-sm text-ink-500">
          {scope.entityCode} / {scope.bookCode} · {totalCount} open item
          {totalCount === 1 ? "" : "s"} · total{" "}
          <span className="font-mono">{formatMoney(total)}</span>
        </p>
      </div>

      <MultiBookBanner
        side="AR"
        activeBookCode={scope.bookCode}
        books={entityBooks}
      />

      <Card>
        <CardHeader>
          <CardTitle>Outstanding invoices</CardTitle>
          <span className="text-xs text-ink-500">
            Posting a payment hits Dr cash / Cr AR and applies via applyArPayment.
          </span>
        </CardHeader>
        <CardContent>
          {totalCount === 0 ? (
            <EmptyState
              title="No open AR items"
              description="All invoices in this scope have been collected, written off, or voided."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Reference</TH>
                  <TH>Customer</TH>
                  <TH>Opened</TH>
                  <TH>Due</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Original</TH>
                  <TH className="text-right">Balance</TH>
                  <TH>Owner</TH>
                  <TH>Apply payment</TH>
                </tr>
              </THead>
              <TBody>
                {openItems.map((item) => {
                  const owner = item.ownerId ? ownerLabels.get(item.ownerId) : null;
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
                      <TD>
                        <Badge tone={item.status === "PARTIAL" ? "warning" : "info"}>{item.status}</Badge>
                      </TD>
                      <TD className="amount-cell text-right text-ink-500">
                        {formatMoney(item.originalAmount.toString())}
                      </TD>
                      <TD className="amount-cell text-right font-semibold text-ink-900">
                        {formatMoney(item.currentBalance.toString())}
                      </TD>
                      <TD>
                        <ReassignArRow
                          openItemId={item.id}
                          ownerLabel={owner?.label ?? null}
                          ownerType={owner?.type ?? item.ownerType}
                          lockedAt={item.reassignmentLockedAt}
                          users={users}
                          queues={queues}
                        />
                      </TD>
                      <TD>
                        <ApplyArPaymentRow
                          openItemId={item.id}
                          defaultAmount={new Decimal(item.currentBalance.toString()).toFixed(2)}
                          cashAccounts={cashAccounts}
                        />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
          {totalCount > 0 && (
            <Pagination
              page={page}
              totalPages={totalPages}
              totalCount={totalCount}
              pageSize={PAGE_SIZE}
              hrefFor={(p) => buildUrl("/ar", SPEC, { page: p })}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
