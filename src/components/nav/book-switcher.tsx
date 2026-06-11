// Multi-book / multi-entity switcher. Renders a small <form> that POSTs
// to the setScopeAction Server Action. Selecting a different book or
// entity sets the lc-scope cookie and revalidates the page.

import { prisma } from "@/lib/db";
import { Label, Select } from "@/components/ui/input";
import { setScopeAction } from "@/app/actions/set-scope";
import type { LedgerScope } from "@/lib/scope";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { tenantScopeOrNone } from "@/lib/db-sentinels";

export async function BookSwitcher({ scope }: { scope: LedgerScope }) {
  // Multi-tenancy (Phase 4c): only show entities belonging to the
  // current tenant. When no tenant is selectable (signed-out / multi-
  // tenant user without a chosen tenant), show no entities — the
  // switcher renders empty options and the layout already handles
  // the unsigned-in case elsewhere.
  //
  // BUG FIX: the prior `{ id: "__none__" }` sentinel crashed Prisma's
  // UUID coercion at deserialize time because `LegalEntity.id` is typed
  // `String @db.Uuid`. See `@/lib/db-sentinels` for the full story —
  // `tenantScopeOrNone` is the portable replacement that uses the
  // all-zeros nil UUID so the query runs cleanly and returns no rows
  // for the no-tenant case. Surfaced by runtime verification 2026-06-09.
  const tenant = await getCurrentTenant();

  const [entities, books] = await Promise.all([
    prisma.legalEntity.findMany({
      where: tenantScopeOrNone(tenant?.id),
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
    prisma.book.findMany({
      where: { isActive: true },
      select: { code: true, name: true },
      orderBy: { code: "asc" },
    }),
  ]);

  return (
    <form action={setScopeAction} className="flex flex-col gap-3">
      <div>
        <Label htmlFor="entityCode">Entity</Label>
        <Select id="entityCode" name="entityCode" defaultValue={scope.entityCode}>
          {entities.map((e) => (
            <option key={e.code} value={e.code}>
              {e.code} — {e.name}
            </option>
          ))}
        </Select>
      </div>
      <div>
        <Label htmlFor="bookCode">Book</Label>
        <Select id="bookCode" name="bookCode" defaultValue={scope.bookCode}>
          {books.map((b) => (
            <option key={b.code} value={b.code}>
              {b.code} — {b.name}
            </option>
          ))}
        </Select>
      </div>
      <button
        type="submit"
        className="h-8 rounded-md bg-ink-900 px-3 text-xs font-medium text-white hover:bg-ink-800"
      >
        Switch scope
      </button>
    </form>
  );
}
