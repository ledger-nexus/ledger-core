"use client";

// CSV import form for the bank feed. Reads the file client-side into a
// string and posts it with the chosen bank account; the action parses,
// dedupes, and stages the rows.

import { useFormState, useFormStatus } from "react-dom";
import { importBankCsvAction, type ActionState } from "@/app/actions/bank-feed";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label, Select, Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

const initial: ActionState = {};

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending}>
      {pending ? "Importing…" : "Import"}
    </Button>
  );
}

export default function ImportForm({
  bankAccounts,
}: {
  bankAccounts: { code: string; name: string }[];
}) {
  const [state, formAction] = useFormState(importBankCsvAction, initial);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Import transactions</CardTitle>
        <span className="text-xs text-ink-500">
          A CSV with a date, a description, and an amount. Deposits positive,
          money out negative — re-importing the same file is safe.
        </span>
      </CardHeader>
      <CardContent>
        <form action={formAction} className="flex flex-wrap items-end gap-4">
          <div>
            <Label htmlFor="bankAccountCode">Account</Label>
            <Select id="bankAccountCode" name="bankAccountCode" defaultValue="">
              <option value="" disabled>
                Pick an account…
              </option>
              {bankAccounts.map((a) => (
                <option key={a.code} value={a.code}>
                  {a.code} — {a.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label htmlFor="csvFile">CSV file</Label>
            <Input id="csvFile" name="csvFile" type="file" accept=".csv,text/csv" required />
          </div>
          <SubmitButton />
        </form>
        {state?.ok === true && (
          <p className="mt-3 text-sm text-positive">{state.message}</p>
        )}
        {state?.ok === false && (
          <p className="mt-3 text-sm text-negative">{state.error}</p>
        )}
      </CardContent>
    </Card>
  );
}
