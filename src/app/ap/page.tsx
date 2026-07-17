// Open AP list with per-item pay-bill inline forms.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { openApBalance } from "@/lib/accounting/sub-ledgers/ap";
import { listEntityBooksWithOpenItems } from "@/lib/accounting/sub-ledgers/cross-book";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { MultiBookBanner } from "@/components/multi-book-banner";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { ApplyApPaymentRow } from "./apply-payment-row";
import { ReassignApRow } from "./reassign-ap-row";

export default async function ApPage() {
  // Tenant-verified scope (see AR page for the rationale).
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant with at least one entity before viewing AP."
      />
    );
  }
  const tenantFilter = { tenantId: scope.tenantId };
  const [openItems, total, cashAccounts, users, queues, entityBooks] = await Promise.all([
    prisma.apOpenItem.findMany({
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
    openApBalance(prisma, scope.entityCode, scope.bookCode, scope.tenantId),
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
    // v0.9 Phase 3.5.E — multi-book entity discovery (mirror of AR).
    listEntityBooksWithOpenItems(prisma, scope.entityCode, scope.tenantId),
  ]);

  // Resolve owner labels.
  const ownerLabels = new Map<string, { label: string; type: "USER" | "QUEUE" }>();
  for (const u of users) ownerLabels.set(u.id, { label: u.displayName, type: "USER" });
  for (const q of queues) ownerLabels.set(q.id, { label: q.name, type: "QUEUE" });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Open Accounts Payable</h2>
        <p className="text-sm text-ink-500">
          {scope.entityCode} / {scope.bookCode} · {openItems.length} open bills · total{" "}
          <span className="font-mono">{formatMoney(total)}</span>
        </p>
      </div>

      <MultiBookBanner
        side="AP"
        activeBookCode={scope.bookCode}
        books={entityBooks}
      />

      <Card>
        <CardHeader>
          <CardTitle>Outstanding bills</CardTitle>
          <span className="text-xs text-ink-500">
            Paying a bill hits Dr AP / Cr cash and applies via applyApPayment.
          </span>
        </CardHeader>
        <CardContent>
          {openItems.length === 0 ? (
            <EmptyState
              title="No open AP items"
              description="All vendor bills in this scope have been paid, written off, or voided."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Reference</TH>
                  <TH>Vendor</TH>
                  <TH>Opened</TH>
                  <TH>Due</TH>
                  <TH>Status</TH>
                  <TH className="text-right">Original</TH>
                  <TH className="text-right">Balance</TH>
                  <TH>Owner</TH>
                  <TH>Pay</TH>
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
                        <ReassignApRow
                          openItemId={item.id}
                          ownerLabel={owner?.label ?? null}
                          ownerType={owner?.type ?? item.ownerType}
                          lockedAt={item.reassignmentLockedAt}
                          users={users}
                          queues={queues}
                        />
                      </TD>
                      <TD>
                        <ApplyApPaymentRow
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
