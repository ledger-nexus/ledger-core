// Commodities — the securities master, and the prices used to mark them.
//
// Two things live here because they are two halves of one job: a commodity has
// to exist before a trade can reference it, and a price has to exist before a
// position can be marked. Without either, /holdings can only ever report cost.
//
// Positions themselves are at /holdings. This page is master data.

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import CommodityForms from "./commodity-forms";

export default async function CommoditiesPage() {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No active scope"
        description="Pick an entity and book to manage commodities."
      />
    );
  }

  // Commodities are tenant-level master data (not per entity/book), so this
  // reads by tenant only — the same shape as the chart of accounts.
  const commodities = await prisma.commodity.findMany({
    where: { tenantId: scope.tenantId },
    orderBy: { symbol: "asc" },
    select: {
      id: true,
      symbol: true,
      name: true,
      assetClass: true,
      active: true,
      // Latest price per commodity, whatever currency it was quoted in.
      prices: {
        orderBy: { asOf: "desc" },
        take: 1,
        select: { price: true, currencyId: true, asOf: true },
      },
      _count: { select: { lots: true } },
    },
  });

  const currencies = await prisma.currency.findMany({
    orderBy: { code: "asc" },
    select: { code: true },
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl text-ink-900">Commodities</h2>
        <p className="text-sm text-ink-500">
          Securities you can hold, and the prices used to mark them. Positions
          live on the Holdings page.
        </p>
      </div>

      {commodities.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>
              {commodities.length} commodit{commodities.length === 1 ? "y" : "ies"} on file
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Symbol</TH>
                  <TH>Name</TH>
                  <TH>Class</TH>
                  <TH className="text-right">Latest price</TH>
                  <TH>As of</TH>
                  <TH className="text-right">Lots</TH>
                </TR>
              </THead>
              <TBody>
                {commodities.map((c) => {
                  const latest = c.prices[0];
                  return (
                    <TR key={c.id}>
                      <TD className="font-mono text-xs">{c.symbol}</TD>
                      <TD>{c.name}</TD>
                      <TD>
                        {c.assetClass ? (
                          <Badge tone="neutral">{c.assetClass}</Badge>
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </TD>
                      <TD className="amount-cell text-right">
                        {latest ? (
                          `${latest.price.toString()} ${latest.currencyId}`
                        ) : (
                          // No price on file: holdings will report this
                          // position at cost rather than invent a mark.
                          <span className="text-ink-500">no price</span>
                        )}
                      </TD>
                      <TD>
                        {latest ? (
                          latest.asOf.toISOString().slice(0, 10)
                        ) : (
                          <span className="text-ink-500">—</span>
                        )}
                      </TD>
                      <TD className="text-right">{c._count.lots}</TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </CardContent>
        </Card>
      ) : (
        <EmptyState
          title="No commodities yet"
          description="Add a symbol before recording a trade in it — the ledger will not invent one for you."
        />
      )}

      <CommodityForms
        currencyCodes={currencies.map((c) => c.code)}
        knownSymbols={commodities.map((c) => c.symbol)}
      />
    </div>
  );
}
