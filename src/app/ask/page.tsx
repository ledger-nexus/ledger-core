// Ask your ledger — a plain-English question box over your own books.
//
// The one place you can type "what did I spend on groceries?" instead of
// knowing which report to open. The assistant is strictly read-only: it
// reads through the same deterministic queries the report pages use and
// phrases the answer — it never posts, edits, or invents a number.

import { notFound } from "next/navigation";
import { getCurrentScope } from "@/lib/scope";
import { AskForm } from "./ask-form";

export default async function AskPage() {
  const scope = await getCurrentScope();
  if (!scope) return notFound();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Ask your ledger</h2>
        <p className="text-sm text-ink-500">
          A plain-English question about {scope.entityCode} / {scope.bookCode}.
          Every figure comes straight from your books — the assistant reads,
          it never changes anything.
        </p>
      </div>

      <AskForm />

      <p className="text-xs text-ink-500">
        Answers are grounded in the same balances and reports you see elsewhere
        in the app. This is a read-only assistant; it can&rsquo;t post entries,
        edit accounts, or move money.
      </p>
    </div>
  );
}
