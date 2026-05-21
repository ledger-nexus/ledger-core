// Open AP list with per-item pay-bill inline forms.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { openApBalance } from "@/lib/accounting/sub-ledgers/ap";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";
import { ApplyApPaymentRow } from "./apply-payment-row";

export default async function ApPage() {
  const scope = getScope();
  const [openItems, total, cashAccounts] = await Promise.all([
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
        currencyId: true,
        party: { select: { code: true, displayName: true } },
      },
    }),
    openApBalance(prisma, scope.entityCode, scope.bookCode),
    prisma.account.findMany({
      where: {
        active: true,
        isBank: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Open Accounts Payable</h2>
        <p className="text-sm text-ink-500">
          {scope.entityCode} / {scope.bookCode} · {openItems.length} open bills · total{" "}
          <span className="font-mono">{formatMoney(total)}</span>
        </p>
      </div>

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
                  <TH>Pay</TH>
                </tr>
              </THead>
              <TBody>
                {openItems.map((item) => (
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
                      <ApplyApPaymentRow
                        openItemId={item.id}
                        defaultAmount={new Decimal(item.currentBalance.toString()).toFixed(2)}
                        cashAccounts={cashAccounts}
                      />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
