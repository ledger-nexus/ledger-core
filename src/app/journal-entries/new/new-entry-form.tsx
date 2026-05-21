"use client";

import { useState, useMemo } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { Decimal } from "decimal.js";
import {
  createJournalEntryAction,
  type CreateJournalEntryState,
  type NewEntryDraftLine,
} from "@/app/actions/create-journal-entry";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/format";

interface AccountOption {
  code: string;
  name: string;
  type: string;
}

interface PartyOption {
  code: string;
  displayName: string;
}

interface DraftLine extends NewEntryDraftLine {
  uid: string;
}

function newLine(side: "DEBIT" | "CREDIT"): DraftLine {
  return {
    uid: crypto.randomUUID(),
    accountCode: "",
    side,
    amount: "",
    partyCode: "",
    description: "",
  };
}

const initialState: CreateJournalEntryState = {};

export function NewEntryForm({
  accounts,
  parties,
  scopeLabel,
}: {
  accounts: AccountOption[];
  parties: PartyOption[];
  scopeLabel: string;
}) {
  const [state, formAction] = useFormState(createJournalEntryAction, initialState);
  const [lines, setLines] = useState<DraftLine[]>([newLine("DEBIT"), newLine("CREDIT")]);

  function updateLine(uid: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  }
  function removeLine(uid: string) {
    setLines((prev) => (prev.length <= 2 ? prev : prev.filter((l) => l.uid !== uid)));
  }
  function addLine(side: "DEBIT" | "CREDIT") {
    setLines((prev) => [...prev, newLine(side)]);
  }

  const { debitTotal, creditTotal, difference, balanced, hasZeroAmount, hasMissingAccount } = useMemo(() => {
    let dr = new Decimal(0);
    let cr = new Decimal(0);
    let zero = false;
    let missingAcct = false;
    for (const l of lines) {
      const amt = l.amount ? new Decimal(l.amount || "0") : new Decimal(0);
      if (amt.isZero()) zero = true;
      if (!l.accountCode) missingAcct = true;
      if (l.side === "DEBIT") dr = dr.plus(amt);
      else cr = cr.plus(amt);
    }
    const diff = dr.minus(cr);
    return {
      debitTotal: dr,
      creditTotal: cr,
      difference: diff,
      balanced: diff.isZero() && !dr.isZero(),
      hasZeroAmount: zero,
      hasMissingAccount: missingAcct,
    };
  }, [lines]);

  const submittable = balanced && !hasZeroAmount && !hasMissingAccount;
  const linesJson = JSON.stringify(
    lines.map((l) => ({
      accountCode: l.accountCode,
      side: l.side,
      amount: l.amount || "0",
      partyCode: l.partyCode || undefined,
      description: l.description || undefined,
    }))
  );

  return (
    <form action={formAction} className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle>Entry header</CardTitle>
          <span className="text-xs text-ink-500">Posting to {scopeLabel}</span>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <Label htmlFor="documentDate">Document date</Label>
            <Input
              type="date"
              name="documentDate"
              id="documentDate"
              required
              defaultValue={new Date().toISOString().slice(0, 10)}
            />
          </div>
          <div>
            <Label htmlFor="source">Source</Label>
            <Select name="source" id="source" defaultValue="MANUAL">
              <option value="MANUAL">MANUAL</option>
              <option value="SYSTEM">SYSTEM</option>
              <option value="AI_APPROVED">AI_APPROVED</option>
            </Select>
          </div>
          <div className="sm:col-span-3">
            <Label htmlFor="memo">Memo</Label>
            <Input name="memo" id="memo" required placeholder="What is this entry for?" />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
          <div className="flex gap-2">
            <Button type="button" variant="outline" size="sm" onClick={() => addLine("DEBIT")}>
              + Add debit line
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={() => addLine("CREDIT")}>
              + Add credit line
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <tr>
                <TH>Side</TH>
                <TH>Account</TH>
                <TH>Party (optional)</TH>
                <TH>Description</TH>
                <TH className="text-right">Amount</TH>
                <TH></TH>
              </tr>
            </THead>
            <TBody>
              {lines.map((line) => (
                <TR key={line.uid}>
                  <TD>
                    <Select
                      value={line.side}
                      onChange={(e) =>
                        updateLine(line.uid, { side: e.target.value as "DEBIT" | "CREDIT" })
                      }
                      className="w-24"
                    >
                      <option value="DEBIT">Dr</option>
                      <option value="CREDIT">Cr</option>
                    </Select>
                  </TD>
                  <TD>
                    <Select
                      value={line.accountCode}
                      onChange={(e) => updateLine(line.uid, { accountCode: e.target.value })}
                      className="min-w-[260px]"
                    >
                      <option value="">— select —</option>
                      {accounts.map((a) => (
                        <option key={a.code} value={a.code}>
                          {a.code} — {a.name}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <Select
                      value={line.partyCode ?? ""}
                      onChange={(e) => updateLine(line.uid, { partyCode: e.target.value })}
                      className="min-w-[180px]"
                    >
                      <option value="">—</option>
                      {parties.map((p) => (
                        <option key={p.code} value={p.code}>
                          {p.code}
                        </option>
                      ))}
                    </Select>
                  </TD>
                  <TD>
                    <Input
                      value={line.description ?? ""}
                      onChange={(e) => updateLine(line.uid, { description: e.target.value })}
                      placeholder="Optional"
                    />
                  </TD>
                  <TD className="text-right">
                    <Input
                      value={line.amount}
                      onChange={(e) => updateLine(line.uid, { amount: e.target.value })}
                      placeholder="0.00"
                      inputMode="decimal"
                      className="text-right font-mono tabular-nums"
                    />
                  </TD>
                  <TD>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={lines.length <= 2}
                      onClick={() => removeLine(line.uid)}
                      aria-label="Remove line"
                    >
                      ×
                    </Button>
                  </TD>
                </TR>
              ))}
              <tr className="border-t-2 border-ink-300 bg-ink-50 font-semibold">
                <TD colSpan={4} className="text-ink-700">
                  Totals
                </TD>
                <TD className="amount-cell text-right text-ink-900">
                  <div>Dr {formatMoney(debitTotal)}</div>
                  <div>Cr {formatMoney(creditTotal)}</div>
                </TD>
                <TD />
              </tr>
              <tr className="bg-ink-50">
                <TD colSpan={4} className="text-ink-700">
                  Δ (Dr − Cr)
                </TD>
                <TD className="text-right">
                  <Badge tone={balanced ? "positive" : "negative"}>
                    {balanced ? "balanced ✓" : `Δ ${formatMoney(difference)}`}
                  </Badge>
                </TD>
                <TD />
              </tr>
            </TBody>
          </Table>
        </CardContent>
      </Card>

      {state?.ok === false && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <span className="font-medium">Posting failed: </span>
          {state.error}
        </div>
      )}

      {/* Hidden inputs so the Server Action receives the lines as JSON. */}
      <input type="hidden" name="linesJson" value={linesJson} />

      <div className="flex items-center justify-between">
        <div className="text-xs text-ink-500">
          {hasMissingAccount && <span>Pick an account for every line. </span>}
          {hasZeroAmount && <span>Every line needs a non-zero amount. </span>}
        </div>
        <SubmitButton disabled={!submittable} />
      </div>
    </form>
  );
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={disabled || pending}>
      {pending ? "Posting…" : "Post entry"}
    </Button>
  );
}
