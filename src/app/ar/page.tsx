// Open AR list with per-item apply-payment inline forms.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { openArBalance } from "@/lib/accounting/sub-ledgers/ar";
import { listEntityBooksWithOpenItems } from "@/lib/accounting/sub-ledgers/cross-book";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { MultiBookBanner } from "@/components/multi-book-banner";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { ApplyArPaymentRow } from "./apply-payment-row";
import { ReassignArRow } from "./reassign-ar-row";

export default async function ArPage() {
  const scope = getScope();
  // Tenant scope (Phase 4c) — defense in depth against cross-tenant reads.
  const tenant = await getCurrentTenant();
  const tenantFilter = tenant ? { tenantId: tenant.id } : { tenantId: "__none__" };
  const [openItems, total, cashAccounts, users, queues, entityBooks] = await Promise.all([
    prisma.arOpenItem.findMany({
      where: {
        ...tenantFilter,
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
        currencyId: true,
        ownerId: true,
        ownerType: true,
        reassignmentLockedAt: true,
        party: { select: { code: true, displayName: true } },
      },
    }),
    openArBalance(prisma, scope.entityCode, scope.bookCode),
    prisma.account.findMany({
      where: {
        active: true,
        isBank: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
    prisma.user.findMany({
      where: { isActive: true },
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
    listEntityBooksWithOpenItems(prisma, scope.entityCode),
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
          {scope.entityCode} / {scope.bookCode} · {openItems.length} open items · total{" "}
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
          {openItems.length === 0 ? (
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
        </CardContent>
      </Card>
    </div>
  );
}
