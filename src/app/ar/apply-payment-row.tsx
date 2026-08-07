"use client";

import { useFormState, useFormStatus } from "react-dom";
import {
  applyArPaymentAction,
  type ApplyArPaymentState,
} from "@/app/actions/apply-ar-payment";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

interface CashAccountOption {
  code: string;
  name: string;
}

const initialState: ApplyArPaymentState = {};

export function ApplyArPaymentRow({
  openItemId,
  defaultAmount,
  cashAccounts,
}: {
  openItemId: string;
  defaultAmount: string;
  cashAccounts: CashAccountOption[];
}) {
  const [state, formAction] = useFormState(applyArPaymentAction, initialState);

  return (
    <form action={formAction} className="flex flex-col gap-1">
      <div className="flex flex-wrap items-end gap-2">
        <input type="hidden" name="openItemId" value={openItemId} />
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-ink-500">Cash account</label>
          <Select name="cashAccountCode" defaultValue={cashAccounts[0]?.code ?? "1000"} className="min-w-[140px]">
            {cashAccounts.map((a) => (
              <option key={a.code} value={a.code}>
                {a.code} — {a.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-ink-500">Amount</label>
          <Input
            type="text"
            name="amount"
            defaultValue={defaultAmount}
            inputMode="decimal"
            className="w-32 text-right font-mono tabular-nums"
          />
        </div>
        <div>
          <label className="block text-[11px] uppercase tracking-wide text-ink-500">Date</label>
          <Input
            type="date"
            name="paymentDate"
            defaultValue={new Date().toISOString().slice(0, 10)}
            className="w-40"
          />
        </div>
        <SubmitButton />
      </div>
      {state?.ok === false && (
        <div className="text-xs text-red-700">{state.error}</div>
      )}
      {state?.ok === true && (
        <div className="text-xs text-positive">Applied. Posted {state.entryNumber}.</div>
      )}
    </form>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" size="sm" disabled={pending}>
      {pending ? "Applying…" : "Apply payment"}
    </Button>
  );
}
