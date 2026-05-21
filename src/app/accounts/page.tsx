// Chart of accounts list. Grouped by account type, ordered by code.
// Shows the lineage badge so QBO/NS-imported accounts are visible at a
// glance.

import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";

const TYPE_LABEL: Record<string, string> = {
  ASSET: "Assets",
  LIABILITY: "Liabilities",
  EQUITY: "Equity",
  REVENUE: "Revenue",
  EXPENSE: "Expenses",
};

export default async function AccountsPage() {
  const scope = getScope();
  const accounts = await prisma.account.findMany({
    where: {
      active: true,
      OR: [
        { entityId: null },
        { entity: { code: scope.entityCode } },
      ],
    },
    orderBy: [{ type: "asc" }, { code: "asc" }],
    select: {
      code: true,
      name: true,
      type: true,
      normalBalance: true,
      isContra: true,
      isControlAccount: true,
      isBank: true,
      subtype: true,
      sourceSystem: true,
      entityId: true,
    },
  });

  // Group by type for display.
  const groups = new Map<string, typeof accounts>();
  for (const a of accounts) {
    const existing = groups.get(a.type) ?? [];
    existing.push(a);
    groups.set(a.type, existing);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Chart of Accounts</h2>
        <p className="text-sm text-ink-500">
          {accounts.length} active accounts in scope ({scope.entityCode})
        </p>
      </div>

      {(["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const).map((type) => {
        const list = groups.get(type) ?? [];
        if (list.length === 0) return null;
        return (
          <Card key={type}>
            <CardHeader>
              <CardTitle>{TYPE_LABEL[type]}</CardTitle>
              <span className="text-xs text-ink-500">{list.length} accounts</span>
            </CardHeader>
            <CardContent>
              <Table>
                <THead>
                  <tr>
                    <TH>Code</TH>
                    <TH>Name</TH>
                    <TH>Normal balance</TH>
                    <TH>Subtype</TH>
                    <TH>Flags</TH>
                    <TH>Source</TH>
                  </tr>
                </THead>
                <TBody>
                  {list.map((a) => (
                    <TR key={a.code}>
                      <TD className="font-mono text-xs text-ink-700">{a.code}</TD>
                      <TD className="text-ink-900">{a.name}</TD>
                      <TD className="text-ink-500">{a.normalBalance}</TD>
                      <TD className="text-ink-500">{a.subtype ?? "—"}</TD>
                      <TD>
                        <div className="flex flex-wrap gap-1">
                          {a.isContra && <Badge tone="warning">contra</Badge>}
                          {a.isControlAccount && <Badge tone="info">control</Badge>}
                          {a.isBank && <Badge tone="info">bank</Badge>}
                          {!a.isContra && !a.isControlAccount && !a.isBank && <span className="text-ink-400">—</span>}
                        </div>
                      </TD>
                      <TD>
                        {a.sourceSystem ? (
                          <Badge tone="neutral">{a.sourceSystem}</Badge>
                        ) : (
                          <span className="text-ink-400">native</span>
                        )}
                      </TD>
                    </TR>
                  ))}
                </TBody>
              </Table>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
