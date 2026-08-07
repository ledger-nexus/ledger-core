"use client";

// One row in the For-Review inbox. Give it a category and Add (which posts
// the JE and drops the row on refresh), or Exclude it from the feed.
//
// Two independent forms: the category <select> + Add live together so the
// chosen category submits with the click, and Exclude is its own form. Each
// submit button is INSIDE its form, so useFormStatus reports its pending
// state correctly.

import { useFormState, useFormStatus } from "react-dom";
import {
  categorizeBankTransactionAction,
  excludeBankTransactionAction,
  matchBankTransactionAction,
  type ActionState,
} from "@/app/actions/bank-feed";
import { TR, TD } from "@/components/ui/table";
import { Select } from "@/components/ui/input";

const initial: ActionState = {};

function AddButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="whitespace-nowrap rounded-md bg-ink-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-ink-800 disabled:opacity-50"
    >
      {pending ? "Adding…" : "Add"}
    </button>
  );
}

function ExcludeButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium text-ink-500 hover:bg-ink-100 hover:text-ink-800 disabled:opacity-50"
    >
      {pending ? "…" : "Exclude"}
    </button>
  );
}

export default function ReviewRow({
  id,
  postedDate,
  description,
  bankAccountLabel,
  amount,
  categories,
  suggestedCategory,
  matchCandidates,
}: {
  id: string;
  postedDate: string;
  description: string;
  bankAccountLabel: string;
  amount: string; // signed, 2dp
  categories: { code: string; name: string }[];
  /** Category code the learned rules pre-select, or null. */
  suggestedCategory?: string | null;
  /** Existing entries this line could match instead of posting. */
  matchCandidates?: { entryId: string; entryNumber: string; date: string; memo: string }[];
}) {
  const [catState, categorizeAction] = useFormState(categorizeBankTransactionAction, initial);
  const [exState, excludeAction] = useFormState(excludeBankTransactionAction, initial);
  const [matchState, matchAction] = useFormState(matchBankTransactionAction, initial);

  const isMoneyOut = amount.startsWith("-");
  const magnitude = amount.replace("-", "");
  const error =
    catState?.ok === false
      ? catState.error
      : exState?.ok === false
        ? exState.error
        : matchState?.ok === false
          ? matchState.error
          : null;
  const hasMatch = (matchCandidates?.length ?? 0) > 0;

  return (
    <>
      <TR>
        <TD className="whitespace-nowrap text-ink-500">{postedDate}</TD>
        <TD className="text-ink-800">{description}</TD>
        <TD className="whitespace-nowrap text-xs text-ink-500">{bankAccountLabel}</TD>
        <TD className="amount-cell text-right">
          <span className={isMoneyOut ? "text-ink-800" : "text-positive"}>
            {isMoneyOut ? "−" : "+"}
            {magnitude}
          </span>
        </TD>
        <TD>
          <form action={categorizeAction} className="flex items-center gap-2">
            <input type="hidden" name="id" value={id} />
            <Select
              name="categoryAccountCode"
              defaultValue={suggestedCategory ?? ""}
              className="min-w-[13rem]"
            >
              <option value="" disabled>
                Choose a category…
              </option>
              {categories.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code} — {c.name}
                </option>
              ))}
            </Select>
            <AddButton />
          </form>
        </TD>
        <TD className="whitespace-nowrap text-right">
          <form action={excludeAction} className="inline">
            <input type="hidden" name="id" value={id} />
            <ExcludeButton />
          </form>
        </TD>
      </TR>
      {suggestedCategory && (
        <tr>
          <td colSpan={6} className="px-3 pb-1 text-xs text-ink-500">
            Suggested from a past entry — change it if this one is different.
          </td>
        </tr>
      )}
      {hasMatch && (
        <tr>
          <td colSpan={6} className="px-3 pb-2">
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-ink-200 bg-ink-50 px-2 py-1.5 text-xs">
              <span className="font-medium text-ink-700">
                Already in your books?
              </span>
              {matchCandidates!.map((c) => (
                <form key={c.entryId} action={matchAction} className="inline">
                  <input type="hidden" name="id" value={id} />
                  <input type="hidden" name="entryId" value={c.entryId} />
                  <button
                    type="submit"
                    className="rounded-md border border-ink-300 bg-white px-2 py-0.5 font-medium text-accent-600 hover:bg-ink-100"
                  >
                    Match {c.entryNumber}
                    <span className="ml-1 text-ink-500">{c.date}</span>
                  </button>
                </form>
              ))}
            </div>
          </td>
        </tr>
      )}
      {error && (
        <tr>
          <td colSpan={6} className="px-3 pb-2 text-xs text-negative">
            {error}
          </td>
        </tr>
      )}
    </>
  );
}
