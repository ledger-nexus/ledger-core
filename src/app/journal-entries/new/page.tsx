// New journal entry — Server Component fetches the account + party
// dropdowns; the interactive form is the client component
// new-entry-form.tsx.

import { prisma } from "@/lib/db";
import { getScope } from "@/lib/scope";
import { NewEntryForm } from "./new-entry-form";

export default async function NewEntryPage() {
  const scope = getScope();
  const [accounts, parties] = await Promise.all([
    prisma.account.findMany({
      where: {
        active: true,
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, name: true, type: true },
    }),
    prisma.party.findMany({
      where: {
        OR: [{ entityId: null }, { entity: { code: scope.entityCode } }],
      },
      orderBy: { code: "asc" },
      select: { code: true, displayName: true },
    }),
  ]);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">New journal entry</h2>
        <p className="text-sm text-ink-500">
          Manual posting via <code className="font-mono">postJournalEntry</code> — the same code path the seed and
          ERP importers use.
        </p>
      </div>
      <NewEntryForm
        accounts={accounts}
        parties={parties}
        scopeLabel={`${scope.entityCode} / ${scope.bookCode}`}
      />
    </div>
  );
}
