"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  updateAccountAction,
  deactivateAccountAction,
} from "@/app/actions/accounts";

interface CandidateAccount {
  code: string;
  name: string;
}

export default function EditAccountForm({
  accountId,
  initialName,
  initialSubtype,
  initialParentCode,
  initialIsContra,
  initialIsControlAccount,
  initialIsBank,
  initialActive,
  candidates,
}: {
  accountId: string;
  initialName: string;
  initialSubtype: string;
  initialParentCode: string;
  initialIsContra: boolean;
  initialIsControlAccount: boolean;
  initialIsBank: boolean;
  initialActive: boolean;
  candidates: CandidateAccount[];
}) {
  const [name, setName] = useState(initialName);
  const [subtype, setSubtype] = useState(initialSubtype);
  const [parentCode, setParentCode] = useState(initialParentCode);
  const [isContra, setIsContra] = useState(initialIsContra);
  const [isControlAccount, setIsControlAccount] = useState(initialIsControlAccount);
  const [isBank, setIsBank] = useState(initialIsBank);
  const [active, setActive] = useState(initialActive);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    startTransition(async () => {
      const r = await updateAccountAction({
        id: accountId,
        name,
        subtype: subtype || null,
        parentCode: parentCode || null,
        isContra,
        isControlAccount,
        isBank,
        active,
      });
      if (!r.ok) setError(r.message ?? "Update failed");
      else {
        setSuccess(r.message ?? "Saved.");
        router.refresh();
      }
    });
  }

  function handleDeactivate() {
    const ok = window.confirm(
      "Deactivate this account?\n\nIt'll be hidden from new posting but every existing journal-entry line still references it. Reversible: just un-check Active above and save."
    );
    if (!ok) return;
    setError(null);
    startTransition(async () => {
      const r = await deactivateAccountAction({ id: accountId });
      if (!r.ok) setError(r.message ?? "Deactivate failed");
      else router.refresh();
    });
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
      <Card>
        <CardHeader>
          <CardTitle>Edit</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <Label htmlFor="name">Name</Label>
              <Input
                id="name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                maxLength={200}
              />
            </div>
            <div>
              <Label htmlFor="parent">Parent</Label>
              <Select
                id="parent"
                value={parentCode}
                onChange={(e) => setParentCode(e.target.value)}
              >
                <option value="">— no parent (root) —</option>
                {candidates.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.name}
                  </option>
                ))}
              </Select>
              <p className="text-xs text-ink-500 mt-1">
                Cycles are prevented server-side.
              </p>
            </div>
            <div>
              <Label htmlFor="subtype">Subtype</Label>
              <Input
                id="subtype"
                value={subtype}
                onChange={(e) => setSubtype(e.target.value)}
                placeholder="CASH · AR_TRADE · …"
                maxLength={50}
              />
            </div>
            <div className="md:col-span-2 grid grid-cols-2 lg:grid-cols-4 gap-3">
              <FlagCheckbox label="Contra" checked={isContra} onChange={setIsContra} />
              <FlagCheckbox
                label="Control account"
                checked={isControlAccount}
                onChange={setIsControlAccount}
              />
              <FlagCheckbox label="Bank" checked={isBank} onChange={setIsBank} />
              <FlagCheckbox label="Active" checked={active} onChange={setActive} />
            </div>
          </div>
        </CardContent>
      </Card>

      {error && <p className="text-sm text-negative">{error}</p>}
      {success && <p className="text-sm text-positive">{success}</p>}
      <div className="flex items-center justify-between">
        <Button
          type="button"
          variant="ghost"
          disabled={pending || !active}
          onClick={handleDeactivate}
          className="text-negative"
        >
          Deactivate
        </Button>
        <Button type="submit" disabled={pending}>
          {pending ? "Saving…" : "Save changes"}
        </Button>
      </div>
    </form>
  );
}

function FlagCheckbox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 rounded-md border border-ink-200 px-3 py-2 cursor-pointer hover:bg-ink-50">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="text-sm font-medium text-ink-900">{label}</span>
    </label>
  );
}
