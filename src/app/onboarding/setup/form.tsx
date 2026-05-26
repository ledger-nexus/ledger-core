"use client";

// Onboarding setup form — name + code + chart picker. Client-side so
// we can:
//   - Auto-derive the entity code from the name (uppercased)
//   - Render an inline preview of the standard chart
//   - Surface validation errors without a round-trip
//
// On submit: setupFirstEntityAction runs in a single transaction
// (entity + calendar + 12 periods + chart), then router.push("/").

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  setupFirstEntityAction,
  type ChartChoice,
} from "@/app/actions/setup-first-entity";
import { Input, Label, Select } from "@/components/ui/input";

function suggestCode(name: string): string {
  return name
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30);
}

// Mirror of STANDARD_CHART in the Server Action — preview only.
const STANDARD_CHART_PREVIEW = [
  { code: "1000", name: "Cash — Operating" },
  { code: "1200", name: "Accounts Receivable" },
  { code: "1500", name: "Equipment" },
  { code: "1510", name: "Accumulated Depreciation — Equipment" },
  { code: "2000", name: "Accounts Payable" },
  { code: "2200", name: "Deferred Revenue" },
  { code: "3000", name: "Common Stock" },
  { code: "3100", name: "Retained Earnings" },
  { code: "4000", name: "Revenue" },
  { code: "5000", name: "Cost of Revenue" },
  { code: "6000", name: "Operating Expenses" },
  { code: "8000", name: "Depreciation Expense" },
];

export function SetupForm({
  suggestedName,
  suggestedCode,
}: {
  suggestedName: string;
  suggestedCode: string;
}) {
  const router = useRouter();
  const [name, setName] = useState(suggestedName);
  const [code, setCode] = useState(suggestedCode);
  const [codeTouched, setCodeTouched] = useState(false);
  const [chartType, setChartType] = useState<ChartChoice>("standard");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onNameChange(next: string) {
    setName(next);
    if (!codeTouched) setCode(suggestCode(next));
  }

  function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      const result = await setupFirstEntityAction({
        entityName: name.trim(),
        entityCode: code.trim().toUpperCase(),
        chartType,
      });
      if (!result.ok) {
        setError(result.message ?? "Setup failed");
        return;
      }
      router.refresh();
      router.push("/");
    });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <div>
        <Label htmlFor="entityName">Entity name</Label>
        <Input
          id="entityName"
          name="entityName"
          required
          autoFocus
          maxLength={100}
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder="Acme, Inc."
        />
        <p className="mt-1 text-[11px] text-ink-500">
          Usually the legal name. Shown in reports + audit log.
        </p>
      </div>
      <div>
        <Label htmlFor="entityCode">Entity code</Label>
        <Input
          id="entityCode"
          name="entityCode"
          required
          minLength={2}
          maxLength={30}
          value={code}
          onChange={(e) => {
            setCodeTouched(true);
            setCode(e.target.value.toUpperCase());
          }}
          pattern="[A-Z0-9](?:[A-Z0-9]|[-_])*"
          placeholder="ACME"
        />
        <p className="mt-1 text-[11px] text-ink-500">
          Short identifier used in URLs and journal-entry numbering
          (e.g. ACME-US_GAAP-00001). 2-30 chars: uppercase letters,
          digits, single hyphens/underscores.
        </p>
      </div>

      <div>
        <Label htmlFor="chartType">Starting chart of accounts</Label>
        <Select
          id="chartType"
          name="chartType"
          value={chartType}
          onChange={(e) => setChartType(e.target.value as ChartChoice)}
        >
          <option value="standard">Standard chart (12 accounts) — recommended</option>
          <option value="empty">Empty — I'll build my own</option>
        </Select>
      </div>

      {chartType === "standard" && (
        <details className="rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-xs">
          <summary className="cursor-pointer text-ink-700 font-medium">
            Preview the standard chart
          </summary>
          <table className="mt-2 w-full text-left font-mono">
            <tbody>
              {STANDARD_CHART_PREVIEW.map((a) => (
                <tr key={a.code} className="border-t border-ink-100">
                  <td className="py-1 pr-2 text-ink-500">{a.code}</td>
                  <td className="py-1 text-ink-700">{a.name}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-2 text-ink-500">
            You can rename, delete, or add accounts after setup. The standard
            chart picks safe defaults that mirror our demo data so cross-
            referencing is natural.
          </p>
        </details>
      )}

      {error && (
        <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <button
          type="submit"
          disabled={pending || !name || !code}
          className="h-9 rounded-md bg-ink-900 px-3 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-40"
        >
          {pending ? "Setting up…" : "Create entity & continue"}
        </button>
      </div>
    </form>
  );
}
