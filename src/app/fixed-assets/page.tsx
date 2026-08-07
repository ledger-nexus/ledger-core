// Fixed-asset register — the list an accountant could not see.
//
// The asset model, the depreciation engine, and the posting routes have
// all existed for a while; there was no page. Read-only for now:
// acquisition, disposal, and depreciation runs all post through gated
// paths already, and a register you can look at is worth more than a
// register you can edit badly.
//
// Everything except cost is per book, because useful life and method
// are book attributes — the same laptop is a 3-year asset for GAAP and
// a 5-year one for tax.

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getFixedAssetRegister } from "@/lib/accounting/sub-ledgers/fixed-asset-register";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate, formatMoney } from "@/lib/utils/format";

export const metadata = { title: "Fixed assets" };

export default async function FixedAssetsPage() {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No active scope"
        description="Pick an entity and book to see the fixed-asset register."
      />
    );
  }

  const register = await getFixedAssetRegister(prisma, {
    tenantId: scope.tenantId,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
  });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl text-ink-900">Fixed assets</h2>
        <p className="text-sm text-ink-500">
          Assets on the books for {scope.entityCode} · {scope.bookCode}. Useful
          life, method and accumulated depreciation are per book; cost is the
          only figure every book agrees on.
        </p>
      </div>

      {register.rows.length === 0 ? (
        <EmptyState
          title="No assets on the books"
          description={
            register.disposedCount > 0
              ? `Every asset for this entity has been disposed (${register.disposedCount}).`
              : "Assets appear here once they are acquired for this entity."
          }
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Register ({register.rows.length})</CardTitle>
            <span className="text-xs text-ink-500">
              Cost {formatMoney(register.totals.cost)} · Accumulated
              depreciation {formatMoney(register.totals.accumulatedDepreciation)}{" "}
              · Net book value {formatMoney(register.totals.netBookValue)}
              {register.disposedCount > 0
                ? ` · ${register.disposedCount} disposed, excluded`
                : ""}
            </span>
          </CardHeader>
          <CardContent>
            {register.notConfiguredForBook > 0 && (
              // Not a warning about the page — a real finding about the
              // data. An asset with no attributes for this book will
              // never depreciate here, and sits at full cost forever.
              <p className="text-sm text-warning mb-3">
                {register.notConfiguredForBook} asset
                {register.notConfiguredForBook === 1 ? " is" : "s are"} not set
                up for {scope.bookCode} — shown at cost, and depreciation will
                never run for {register.notConfiguredForBook === 1 ? "it" : "them"}{" "}
                in this book.
              </p>
            )}
            <Table>
              <THead>
                <TR>
                  <TH>Tag</TH>
                  <TH>Description</TH>
                  <TH>Account</TH>
                  <TH>In service</TH>
                  <TH>Life / method</TH>
                  <TH className="text-right">Cost</TH>
                  <TH className="text-right">Accum. dep.</TH>
                  <TH className="text-right">Net book value</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {register.rows.map((r) => (
                  <TR key={r.id}>
                    <TD className="font-mono text-xs">{r.code}</TD>
                    <TD>
                      {r.description}
                      {r.category ? (
                        <span className="text-ink-500 text-xs"> · {r.category}</span>
                      ) : null}
                    </TD>
                    <TD className="font-mono text-xs">{r.assetAccountCode}</TD>
                    <TD className="text-xs">
                      {r.inServiceDate ? formatDate(r.inServiceDate) : "—"}
                    </TD>
                    <TD className="text-xs">
                      {r.usefulLifeMonths
                        ? `${r.usefulLifeMonths} mo · ${r.depreciationMethod}`
                        : `not set up for ${scope.bookCode}`}
                    </TD>
                    <TD className="text-right font-mono">{formatMoney(r.cost)}</TD>
                    <TD className="text-right font-mono">
                      {formatMoney(r.accumulatedDepreciation)}
                    </TD>
                    <TD className="text-right font-mono">
                      {formatMoney(r.netBookValue)}
                    </TD>
                    <TD>
                      <Badge tone={r.status === "IN_SERVICE" ? "positive" : "neutral"}>
                        {r.status.replace(/_/g, " ").toLowerCase()}
                      </Badge>
                    </TD>
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
