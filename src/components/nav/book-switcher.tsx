// Multi-book / multi-entity switcher. Renders a small <form> that POSTs
// to the setScopeAction Server Action. Selecting a different book or
// entity sets the lc-scope cookie and revalidates the page.

import { prisma } from "@/lib/db";
import { Label, Select } from "@/components/ui/input";
import { setScopeAction } from "@/app/actions/set-scope";
import type { LedgerScope } from "@/lib/scope";

export async function BookSwitcher({ scope }: { scope: LedgerScope }) {
  const [entities, books] = await Promise.all([
    prisma.legalEntity.findMany({
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
