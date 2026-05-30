// Per-account detail + edit page. Code-keyed URL because codes are
// what CPAs say out loud ("Edit 1500"); UUIDs are not.

import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import EditAccountForm from "./edit-account-form";

export default async function AccountDetailPage({
  params,
}: {
  params: { code: string };
}) {
  const scope = await getCurrentScope();
  if (!scope) return notFound();
  const user = await getCurrentUser();
  const canEdit = isAdmin(user);

  // Try entity-specific first, fall back to shared. Mirrors how the
  // chart of accounts dedups in reports.
  const account =
    (await prisma.account.findFirst({
      where: {
        tenantId: scope.tenantId,
        code: params.code,
        entityId: scope.entityId,
      },
      include: {
        parent: { select: { code: true, name: true } },
        children: { orderBy: { code: "asc" }, select: { code: true, name: true } },
        entity: { select: { code: true } },
      },
    })) ??
    (await prisma.account.findFirst({
      where: {
        tenantId: scope.tenantId,
        code: params.code,
        entityId: null,
      },
      include: {
        parent: { select: { code: true, name: true } },
        children: { orderBy: { code: "asc" }, select: { code: true, name: true } },
        entity: { select: { code: true } },
      },
    }));

  if (!account) return notFound();

  // Candidate parents: same scope, same type, not the account itself.
  const candidates = await prisma.account.findMany({
    where: {
      tenantId: scope.tenantId,
      active: true,
      type: account.type,
      id: { not: account.id },
      OR: [{ entityId: null }, { entityId: account.entityId ?? undefined }],
    },
    orderBy: { code: "asc" },
    select: { code: true, name: true },
  });

  // Line count + posted total for a quick stat panel.
  const lineCount = await prisma.journalLine.count({ where: { accountId: account.id } });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <p className="text-sm text-ink-500">
          <Link href="/accounts" className="text-link hover:underline">
            ← Chart of Accounts
          </Link>
        </p>
        <h2 className="mt-2 text-xl font-semibold text-ink-900">
          <span className="font-mono">{account.code}</span> — {account.name}
        </h2>
        <div className="mt-1 flex items-center gap-2 text-xs text-ink-500">
          <Badge tone="info">{account.type}</Badge>
          <Badge tone="neutral">{account.normalBalance}</Badge>
          {account.entityId === null ? (
            <Badge tone="neutral">shared</Badge>
          ) : (
            <Badge tone="neutral">{account.entity?.code ?? "entity"}</Badge>
          )}
          {!account.active && <Badge tone="warning">inactive</Badge>}
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Activity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <Stat label="Posted lines" value={lineCount.toString()} />
            <Stat
              label="Parent"
              value={
                account.parent ? `${account.parent.code} — ${account.parent.name}` : "—"
              }
            />
            <Stat label="Children" value={account.children.length.toString()} />
          </div>
          {account.children.length > 0 && (
            <div className="mt-4 text-xs text-ink-500">
              <span className="uppercase font-medium tracking-wider">Children:</span>{" "}
              {account.children.map((c, i) => (
                <span key={c.code}>
                  <Link href={`/accounts/${c.code}`} className="font-mono text-link hover:underline">
                    {c.code}
                  </Link>
                  {i < account.children.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {canEdit ? (
        <EditAccountForm
          accountId={account.id}
          initialName={account.name}
          initialSubtype={account.subtype ?? ""}
          initialParentCode={account.parent?.code ?? ""}
          initialIsContra={account.isContra}
          initialIsControlAccount={account.isControlAccount}
          initialIsBank={account.isBank}
          initialActive={account.active}
          candidates={candidates}
        />
      ) : (
        <EmptyState
          title="Read-only"
          description="Editing accounts requires admin permission."
        />
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-ink-500">{label}</div>
      <div className="mt-0.5 text-ink-900">{value}</div>
    </div>
  );
}
