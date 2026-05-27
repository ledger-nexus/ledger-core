"use client";

import { useState, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { createAccountAction } from "@/app/actions/accounts";

interface CandidateAccount {
  code: string;
  name: string;
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
}

const TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;

// Sensible normal-balance default per type. Users can override (e.g.
// for a contra-asset like Accumulated Depreciation, which is ASSET +
// CREDIT-normal).
const DEFAULT_NORMAL_BALANCE: Record<(typeof TYPES)[number], "DEBIT" | "CREDIT"> = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  EXPENSE: "DEBIT",
};

export default function NewAccountForm({
  candidates,
  defaultEntityCode,
}: {
  candidates: CandidateAccount[];
  defaultEntityCode: string;
}) {
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [type, setType] = useState<(typeof TYPES)[number]>("ASSET");
  const [normalBalance, setNormalBalance] = useState<"DEBIT" | "CREDIT">("DEBIT");
  const [parentCode, setParentCode] = useState("");
  const [scope, setScope] = useState<"shared" | "entity">("entity");
  const [subtype, setSubtype] = useState("");
  const [isContra, setIsContra] = useState(false);
  const [isControlAccount, setIsControlAccount] = useState(false);
  const [isBank, setIsBank] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  // Parent candidates are typed-filtered for ergonomic dropdowns: when
  // a user is creating an ASSET, only show ASSET parents. Empty filter
  // when type changes is fine — the user can also leave parent empty.
  const filteredParents = useMemo(
    () => candidates.filter((c) => c.type === type),
    [candidates, type]
  );

  function handleTypeChange(next: (typeof TYPES)[number]) {
    setType(next);
    setNormalBalance(DEFAULT_NORMAL_BALANCE[next]);
    // Clear parent if it no longer matches the new type.
    if (parentCode && !candidates.find((c) => c.code === parentCode && c.type === next)) {
      setParentCode("");
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const r = await createAccountAction({
        code,
        name,
        type,
        normalBalance,
        parentCode: parentCode || undefined,
        entityCode: scope === "entity" ? defaultEntityCode : undefined,
        subtype: subtype || undefined,
        isContra,
        isControlAccount,
        isBank,
      });
      if (!r.ok) {
        setError(r.message ?? "Create failed");
        return;
      }
      router.push("/accounts");
      router.refresh();
    });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Identity</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="code">Code</Label>
              <Input
                id="code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="1000"
                required
                maxLength={15}
              />
              <p className="text-xs text-ink-500 mt-1">
                2–15 chars: uppercase letters / digits / single - or _.
              </p>
            </div>
            <div>
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cash — Operating"
                required
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="scope">Scope</Label>
              <Select
                id="scope"
                value={scope}
                onChange={(e) => setScope(e.target.value as "shared" | "entity")}
              >
                <option value="entity">Entity-specific ({defaultEntityCode})</option>
                <option value="shared">Shared (all entities)</option>
              </Select>
              <p className="text-xs text-ink-500 mt-1">
                Entity-specific overrides shared at the same code.
              </p>
            </div>
            <div>
              <Label htmlFor="parent">Parent (optional)</Label>
              <Select
                id="parent"
                value={parentCode}
                onChange={(e) => setParentCode(e.target.value)}
              >
                <option value="">— no parent (root) —</option>
                {filteredParents.map((p) => (
                  <option key={p.code} value={p.code}>
                    {p.code} — {p.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-ink-500 mt-1">
                Filtered to {type.toLowerCase()} accounts only.
              </p>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Classification</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <Label htmlFor="type">Type</Label>
              <Select
                id="type"
                value={type}
                onChange={(e) => handleTypeChange(e.target.value as (typeof TYPES)[number])}
                required
              >
                {TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="normalBalance">Normal balance</Label>
              <Select
                id="normalBalance"
                value={normalBalance}
                onChange={(e) => setNormalBalance(e.target.value as "DEBIT" | "CREDIT")}
                required
              >
                <option value="DEBIT">Debit</option>
                <option value="CREDIT">Credit</option>
              </Select>
              <p className="text-xs text-ink-500 mt-1">
                Defaults from type. Override for contra accounts.
              </p>
            </div>
            <div className="md:col-span-2">
              <Label htmlFor="subtype">Subtype (optional)</Label>
              <Input
                id="subtype"
                value={subtype}
                onChange={(e) => setSubtype(e.target.value)}
                placeholder="CASH · AR_TRADE · INVENTORY_RAW"
                maxLength={50}
              />
              <p className="text-xs text-ink-500 mt-1">
                Used by mappers + sub-ledgers for routing. Free-text;
                conventionally uppercase.
              </p>
            </div>
            <div className="md:col-span-2 grid grid-cols-3 gap-3">
              <FlagCheckbox label="Contra" checked={isContra} onChange={setIsContra} hint="reverses normal sign" />
              <FlagCheckbox
                label="Control account"
                checked={isControlAccount}
                onChange={setIsControlAccount}
                hint="AR / AP rollup"
              />
              <FlagCheckbox label="Bank" checked={isBank} onChange={setIsBank} hint="for recon" />
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-negative">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={pending}>
          {pending ? "Creating…" : "Create account"}
        </Button>
      </div>
    </form>
  );
}

function FlagCheckbox({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-start gap-2 rounded-md border border-ink-200 p-3 cursor-pointer hover:bg-ink-50">
      <input
        type="checkbox"
        className="mt-0.5"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <div>
        <div className="text-sm font-medium text-ink-900">{label}</div>
        <div className="text-xs text-ink-500">{hint}</div>
      </div>
    </label>
  );
}
