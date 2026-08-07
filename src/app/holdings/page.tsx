// Holdings — what you own, rolled up from the open cost-basis lots.
//
// Read-only. Cost basis comes from the lots (what was actually paid, parcel by
// parcel); market value only appears when a price is on file for that commodity
// — an unpriced holding is shown at cost rather than marked with a guess.
//
// Recording trades goes through recordCommodityTradeAction (gated + audited);
// the data-entry form is a separate follow-up.

import { Decimal } from "@/lib/utils/decimal";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getHoldings } from "@/lib/accounting/holdings";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { formatMoney } from "@/lib/utils/format";
import TradeForm from "./trade-form";

export default async function HoldingsPage() {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No active scope"
        description="Pick an entity and book to see holdings."
      />
    );
  }

  const holdings = await getHoldings(prisma, {
    tenantId: scope.tenantId,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
  });

  const totalCost = holdings.reduce((acc, h) => acc.plus(h.totalCost), new Decimal(0));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl text-ink-900">Holdings</h2>
        <p className="text-sm text-ink-500">
          Open positions for {scope.entityCode} · {scope.bookCode}, valued at cost basis.
        </p>
      </div>

      <TradeForm />

      {holdings.length === 0 ? (
        <EmptyState
          title="No open positions"
          description="Holdings appear here once a purchase opens a cost-basis lot."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Positions ({holdings.length})</CardTitle>
            <span className="text-xs text-ink-500">
              Total cost basis {formatMoney(totalCost)}
            </span>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <tr>
                  <TH>Commodity</TH>
                  <TH>Account</TH>
                  <TH className="text-right">Units</TH>
                  <TH className="text-right">Avg cost</TH>
                  <TH className="text-right">Cost basis</TH>
                  <TH className="text-right">Market</TH>
                  <TH className="text-right">Unrealized</TH>
                  <TH className="text-right">Lots</TH>
                </tr>
              </THead>
              <TBody>
                {holdings.map((h) => (
                  <TR key={`${h.commoditySymbol}-${h.accountCode}`}>
                    <TD>
                      <span className="font-mono text-xs text-ink-700">{h.commoditySymbol}</span>
                      <span className="ml-2 text-ink-500">{h.commodityName}</span>
                    </TD>
                    <TD className="font-mono text-xs text-ink-700">{h.accountCode}</TD>
                    <TD className="amount-cell text-right">{h.units.toString()}</TD>
                    <TD className="amount-cell text-right">{formatMoney(h.averageCost)}</TD>
                    <TD className="amount-cell text-right">{formatMoney(h.totalCost)}</TD>
                    <TD className="amount-cell text-right">
                      {h.marketValue ? formatMoney(h.marketValue) : <span className="text-ink-500">—</span>}
                    </TD>
                    <TD className="amount-cell text-right">
                      {h.unrealizedGain ? formatMoney(h.unrealizedGain) : <span className="text-ink-500">—</span>}
                    </TD>
                    <TD className="text-right text-ink-500">{h.lotCount}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
