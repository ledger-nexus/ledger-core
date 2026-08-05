"use client";

import { useState, useMemo, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Decimal } from "@/lib/utils/decimal";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatMoney } from "@/lib/utils/format";
import { createRecurringEntryAction } from "@/app/actions/recurring-entries";

interface AccountOption {
  code: string;
  name: string;
  type: string;
}
interface BookOption { code: string; name: string; }
interface EntityOption { code: string; name: string; }

interface DraftLine {
  uid: string;
  accountCode: string;
  side: "DEBIT" | "CREDIT";
  amount: string;
  /** ALLOCATION mode: this target's share, 0–100. */
  percent: string;
  description: string;
}

function newLine(side: "DEBIT" | "CREDIT"): DraftLine {
  return {
    uid: crypto.randomUUID(),
    accountCode: "",
    side,
    amount: "",
    percent: "",
    description: "",
  };
}

export default function NewRecurringForm({
  accounts,
  books,
  entities,
  defaultEntityCode,
  defaultBookCode,
}: {
  accounts: AccountOption[];
  books: BookOption[];
  entities: EntityOption[];
  defaultEntityCode: string;
  defaultBookCode: string;
}) {
  const [code, setCode] = useState("");
  const [memo, setMemo] = useState("");
  const [entityCode, setEntityCode] = useState(defaultEntityCode);
  const [bookCode, setBookCode] = useState(defaultBookCode);
  const [cadence, setCadence] = useState<"MONTHLY" | "QUARTERLY" | "ANNUALLY">("MONTHLY");
  // Default startDate = first of next month, the most common case for new templates.
  const defaultStart = useMemo(() => {
    const d = new Date();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  }, []);
  const [kind, setKind] = useState<"STANDARD" | "ALLOCATION">("STANDARD");
  const [sourceAccountCode, setSourceAccountCode] = useState("");
  const [startDate, setStartDate] = useState(defaultStart);
  const [endDate, setEndDate] = useState("");
  const [lines, setLines] = useState<DraftLine[]>([
    newLine("DEBIT"),
    newLine("CREDIT"),
  ]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const totals = useMemo(() => {
    let debit = new Decimal(0);
    let credit = new Decimal(0);
    for (const l of lines) {
      const amt = l.amount && !isNaN(Number(l.amount)) ? new Decimal(l.amount) : new Decimal(0);
      if (l.side === "DEBIT") debit = debit.plus(amt);
      else credit = credit.plus(amt);
    }
    return { debit, credit, diff: debit.minus(credit), balanced: debit.equals(credit) && debit.greaterThan(0) };
  }, [lines]);

  // Allocation lines carry percents, not amounts, so the debit/credit
  // totals above are structurally 0 and "balanced" is never true for
  // them. Their readiness test is the one the engine enforces: every
  // target named, percents summing to exactly 100.
  const allocation = useMemo(() => {
    let percent = new Decimal(0);
    let incomplete = false;
    for (const l of lines) {
      if (!l.accountCode || !l.percent || isNaN(Number(l.percent))) {
        incomplete = true;
        continue;
      }
      percent = percent.plus(new Decimal(l.percent));
    }
    return {
      percent,
      complete: !incomplete && percent.equals(100) && Boolean(sourceAccountCode),
    };
  }, [lines, sourceAccountCode]);

  const canSubmit = kind === "ALLOCATION" ? allocation.complete : totals.balanced;

  function updateLine(uid: string, patch: Partial<DraftLine>) {
    setLines((prev) => prev.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  }
  function addLine(side: "DEBIT" | "CREDIT") {
    setLines((prev) => [...prev, newLine(side)]);
  }
  function removeLine(uid: string) {
    setLines((prev) => (prev.length > 2 ? prev.filter((l) => l.uid !== uid) : prev));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const payload = {
        code,
        memo,
        entityCode,
        bookCode,
        cadence,
        startDate,
        endDate: endDate || undefined,
        kind,
        allocationSourceAccountCode:
          kind === "ALLOCATION" ? sourceAccountCode : undefined,
        lines:
          kind === "ALLOCATION"
            ? lines
                .filter((l) => l.accountCode && l.percent)
                .map((l) => ({
                  accountCode: l.accountCode,
                  allocationPercent: l.percent,
                  description: l.description || undefined,
                }))
            : lines
                .filter((l) => l.accountCode && l.amount)
                .map((l) => ({
                  accountCode: l.accountCode,
                  debit: l.side === "DEBIT" ? l.amount : "0",
                  credit: l.side === "CREDIT" ? l.amount : "0",
                  description: l.description || undefined,
                })),
      };
      const r = await createRecurringEntryAction(payload);
      if (!r.ok) {
        setError(r.message ?? "Create failed");
      } else {
        router.push("/recurring-entries");
        router.refresh();
      }
    });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Header</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="MONTHLY_RENT"
                required
              />
              <p className="text-xs text-ink-500 mt-1">
                Uppercase, 2–40 chars, single _ / - between alphanumerics.
              </p>
            </div>
            <div>
              <Label htmlFor="memo">Memo</Label>
              <Input
                id="memo"
                value={memo}
                onChange={(e) => setMemo(e.target.value)}
                placeholder="Monthly office rent"
                required
              />
            </div>
            <div>
              <Label htmlFor="entity">Entity</Label>
              <Select
                id="entity"
                value={entityCode}
                onChange={(e) => setEntityCode(e.target.value)}
                required
              >
                {entities.map((e) => (
                  <option key={e.code} value={e.code}>
                    {e.code} — {e.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="book">Book</Label>
              <Select
                id="book"
                value={bookCode}
                onChange={(e) => setBookCode(e.target.value)}
                required
              >
                {books.map((b) => (
                  <option key={b.code} value={b.code}>
                    {b.code} — {b.name}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="cadence">Cadence</Label>
              <Select
                id="cadence"
                value={cadence}
                onChange={(e) =>
                  setCadence(e.target.value as "MONTHLY" | "QUARTERLY" | "ANNUALLY")
                }
                required
              >
                <option value="MONTHLY">Monthly</option>
                <option value="QUARTERLY">Quarterly</option>
                <option value="ANNUALLY">Annually</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="kind">Template kind</Label>
              <Select
                id="kind"
                value={kind}
                onChange={(e) => setKind(e.target.value as "STANDARD" | "ALLOCATION")}
              >
                <option value="STANDARD">Standard — post these lines verbatim</option>
                <option value="ALLOCATION">Allocation — split a source account by %</option>
              </Select>
            </div>
            {kind === "ALLOCATION" && (
              <div>
                <Label htmlFor="sourceAccount">Source account (allocated FROM)</Label>
                <Select
                  id="sourceAccount"
                  value={sourceAccountCode}
                  onChange={(e) => setSourceAccountCode(e.target.value)}
                  required
                >
                  <option value="">— select —</option>
                  {accounts.map((a) => (
                    <option key={a.code} value={a.code}>
                      {a.code} — {a.name}
                    </option>
                  ))}
                </Select>
                <p className="text-xs text-ink-500 mt-1">
                  Each run clears this account's month-to-date activity into the
                  target lines below. Anchor the start date to month-end.
                </p>
              </div>
            )}
            <div>
              <Label htmlFor="startDate">Start date</Label>
              <Input
                id="startDate"
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                required
              />
              <p className="text-xs text-ink-500 mt-1">First entry posts on this date.</p>
            </div>
            <div>
              <Label htmlFor="endDate">End date (optional)</Label>
              <Input
                id="endDate"
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
              <p className="text-xs text-ink-500 mt-1">Leave blank for no sunset.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Lines</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                {kind === "STANDARD" && <TH>Side</TH>}
                <TH>{kind === "ALLOCATION" ? "Target account" : "Account"}</TH>
                <TH>Description</TH>
                <TH className="text-right">{kind === "ALLOCATION" ? "Percent" : "Amount"}</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {lines.map((l) => (
                <TR key={l.uid}>
                  {kind === "STANDARD" && (
                    <TD>
                      <Badge tone={l.side === "DEBIT" ? "info" : "neutral"}>
                        {l.side}
                      </Badge>
                    </TD>
                  )}
                  <TD>
                    <Select
                      value={l.accountCode}
                      onChange={(e) => updateLine(l.uid, { accountCode: e.target.value })}
                      required
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
                    <Input
                      value={l.description}
                      onChange={(e) => updateLine(l.uid, { description: e.target.value })}
                      placeholder="Optional"
                    />
                  </TD>
                  <TD>
                    {kind === "ALLOCATION" ? (
                      <Input
                        type="number"
                        step="0.01"
                        min="0.01"
                        max="100"
                        value={l.percent}
                        onChange={(e) => updateLine(l.uid, { percent: e.target.value })}
                        className="text-right tabular-nums"
                        placeholder="%"
                        required
                      />
                    ) : (
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={l.amount}
                        onChange={(e) => updateLine(l.uid, { amount: e.target.value })}
                        className="text-right tabular-nums"
                        required
                      />
                    )}
                  </TD>
                  <TD>
                    {lines.length > (kind === "ALLOCATION" ? 1 : 2) && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => removeLine(l.uid)}
                      >
                        Remove
                      </Button>
                    )}
                  </TD>
                </TR>
              ))}
            </TBody>
          </Table>
          <div className="flex items-center justify-between mt-3">
            <div className="flex gap-2">
              {kind === "ALLOCATION" ? (
                <Button type="button" variant="ghost" size="sm" onClick={() => addLine("DEBIT")}>
                  + Target line
                </Button>
              ) : (
                <>
                  <Button type="button" variant="ghost" size="sm" onClick={() => addLine("DEBIT")}>
                    + Debit line
                  </Button>
                  <Button type="button" variant="ghost" size="sm" onClick={() => addLine("CREDIT")}>
                    + Credit line
                  </Button>
                </>
              )}
            </div>
            <div className="text-sm">
              {kind === "ALLOCATION" ? (
                <>
                  <span className="text-ink-500">Allocated </span>
                  <span className="font-mono">{allocation.percent.toFixed(2)}%</span>
                  <span className="ml-3">
                    {allocation.complete ? (
                      <Badge tone="positive">Fully allocated</Badge>
                    ) : (
                      <Badge tone="warning">Must total 100%</Badge>
                    )}
                  </span>
                </>
              ) : (
                <>
                  <span className="text-ink-500">Debits </span>
                  <span className="font-mono">{formatMoney(totals.debit)}</span>
                  <span className="text-ink-500"> · Credits </span>
                  <span className="font-mono">{formatMoney(totals.credit)}</span>
                  <span className="ml-3">
                    {totals.balanced ? (
                      <Badge tone="positive">Balanced</Badge>
                    ) : (
                      <Badge tone="warning">Δ {formatMoney(totals.diff)}</Badge>
                    )}
                  </span>
                </>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={pending || !canSubmit}>
          {pending ? "Creating…" : "Create template"}
        </Button>
      </div>
    </form>
  );
}
