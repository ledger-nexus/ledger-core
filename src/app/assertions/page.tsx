// Balance assertions — the machine tripwire, armed.
//
// Each row is a claim ("this account held exactly this much on this date")
// checked against what the books actually say right now. A FAIL means drift
// appeared that no single write would have rejected: a double-posted import, a
// missed reversal, a mapper regression.
//
// Results are computed live on every load rather than read from the cached
// lastStatus columns. A stale PASS is worse than a slow page — the whole point
// is to reflect the ledger as it stands, and the checker shares one trial
// balance per distinct date, so N assertions on a date cost one scan.

import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { checkBalanceAssertions } from "@/lib/accounting/balance-assertions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { EmptyState } from "@/components/ui/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/format";
import AssertionForm from "./assertion-form";

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default async function AssertionsPage() {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No active scope"
        description="Pick an entity and book to see balance assertions."
      />
    );
  }

  const results = await checkBalanceAssertions(prisma, {
    tenantId: scope.tenantId,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
  });

  const failing = results.filter((r) => r.status === "FAIL");

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl text-ink-900">Balance assertions</h2>
        <p className="text-sm text-ink-500">
          What you say each account held, checked against what{" "}
          {scope.entityCode} · {scope.bookCode} actually shows.
        </p>
      </div>

      {results.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>
              {failing.length === 0
                ? `All ${results.length} assertion${results.length === 1 ? "" : "s"} hold`
                : `${failing.length} of ${results.length} disagree with the ledger`}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <THead>
                <TR>
                  <TH>Account</TH>
                  <TH>As of</TH>
                  <TH className="text-right">You say</TH>
                  <TH className="text-right">Books say</TH>
                  <TH className="text-right">Difference</TH>
                  <TH>Status</TH>
                </TR>
              </THead>
              <TBody>
                {results.map((r) => {
                  const failed = r.status === "FAIL";
                  return (
                    <TR key={r.assertionId}>
                      <TD className="font-mono text-xs">{r.accountCode}</TD>
                      <TD>{isoDate(r.asOf)}</TD>
                      <TD className="text-right">{formatMoney(r.expected)}</TD>
                      <TD className="text-right">{formatMoney(r.observed)}</TD>
                      <TD className="text-right">
                        {/* Zero difference reads as a dash — a signed 0.00
                            invites a second look that isn't warranted. */}
                        {r.delta.isZero() ? "—" : formatMoney(r.delta)}
                      </TD>
                      <TD>
                        <Badge tone={failed ? "negative" : "positive"}>
                          {failed ? "Off" : "Holds"}
                        </Badge>
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
            {failing.length > 0 && (
              <p className="mt-4 text-sm text-ink-500">
                A difference means the ledger moved in a way you did not expect.
                Investigate before adjusting — if the assertion is right and the
                books are simply missing history (opening balances, for
                instance), padding posts the entry that closes the gap.
              </p>
            )}
          </CardContent>
        </Card>
      )}

      {results.length === 0 && (
        <EmptyState
          title="No assertions yet"
          description="Assert what an account held on a date, and every load re-checks it against the books."
        />
      )}

      <AssertionForm
        entityCode={scope.entityCode}
        bookCode={scope.bookCode}
      />
    </div>
  );
}
