"use client";

// Client component for the FX revaluation form. Two-stage flow:
// preview (read-only) then post. The preview surfaces missing rates
// + per-account adjustments + the net gain/loss so the user can
// eyeball before committing.

import { useState, useTransition } from "react";
import {
  previewFxRevaluationAction,
  postFxRevaluationAction,
  type FxRevaluationPreviewState,
  type FxRevaluationPostState,
} from "@/app/actions/fx-revaluation";

interface Props {
  initialEntity: string;
  initialBook: string;
  initialAsOfDate: string;
}

export function FxRevaluationForm({
  initialEntity,
  initialBook,
  initialAsOfDate,
}: Props) {
  const [entityCode, setEntityCode] = useState(initialEntity);
  const [bookCode, setBookCode] = useState(initialBook);
  const [asOfDate, setAsOfDate] = useState(initialAsOfDate);
  const [fxGainAccount, setFxGainAccount] = useState("");
  const [fxLossAccount, setFxLossAccount] = useState("");
  const [pending, startTransition] = useTransition();
  const [state, setState] = useState<
    FxRevaluationPreviewState | FxRevaluationPostState | null
  >(null);
  const [mode, setMode] = useState<"idle" | "previewed" | "posted">("idle");

  function inputPayload() {
    return {
      entityCode,
      bookCode,
      asOfDate,
      fxGainAccountCode: fxGainAccount || undefined,
      fxLossAccountCode: fxLossAccount || undefined,
    };
  }

  function handlePreview(e?: React.FormEvent) {
    e?.preventDefault();
    setState(null);
    startTransition(async () => {
      const r = await previewFxRevaluationAction(inputPayload());
      setState(r);
      if (r.ok) setMode("previewed");
    });
  }

  function handlePost() {
    if (
      !confirm(
        `Post FX revaluation for ${entityCode}/${bookCode} as of ${asOfDate}? This creates a real JE. Re-running on the same date will produce a zero delta (no duplicate JE).`
      )
    )
      return;
    setState(null);
    startTransition(async () => {
      const r = await postFxRevaluationAction(inputPayload());
      setState(r);
      if (r.ok) setMode("posted");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <form onSubmit={handlePreview} className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <div>
          <label className="text-xs font-medium text-ink-700">Entity</label>
          <input
            type="text"
            required
            value={entityCode}
            onChange={(e) => setEntityCode(e.target.value.toUpperCase())}
            placeholder="NORTHWIND"
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-sm font-mono focus:border-accent-500 focus:outline-none"
            disabled={pending}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-ink-700">Book</label>
          <input
            type="text"
            required
            value={bookCode}
            onChange={(e) => setBookCode(e.target.value.toUpperCase())}
            placeholder="US_GAAP"
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-sm font-mono focus:border-accent-500 focus:outline-none"
            disabled={pending}
          />
        </div>
        <div>
          <label className="text-xs font-medium text-ink-700">As of</label>
          <input
            type="date"
            required
            value={asOfDate}
            onChange={(e) => setAsOfDate(e.target.value)}
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none"
            disabled={pending}
          />
        </div>
        <div className="flex items-end gap-2">
          <button
            type="submit"
            disabled={pending}
            className="h-9 inline-flex items-center rounded-md border border-ink-300 bg-white px-4 text-sm font-medium text-ink-900 hover:bg-ink-50 disabled:opacity-50"
          >
            {pending ? "Loading..." : "Preview"}
          </button>
          {mode === "previewed" && state?.ok && (
            <button
              type="button"
              onClick={handlePost}
              disabled={pending}
              className="h-9 inline-flex items-center rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-50"
            >
              {pending ? "Posting..." : "Post"}
            </button>
          )}
        </div>
      </form>

      <details className="text-xs text-ink-600">
        <summary className="cursor-pointer">
          Override default FX gain / loss accounts
        </summary>
        <div className="mt-2 grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-ink-700">
              Gain account (default 7300)
            </label>
            <input
              type="text"
              value={fxGainAccount}
              onChange={(e) => setFxGainAccount(e.target.value)}
              placeholder="7300"
              className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-xs focus:border-accent-500 focus:outline-none"
              disabled={pending}
            />
          </div>
          <div>
            <label className="text-xs text-ink-700">
              Loss account (default 7400)
            </label>
            <input
              type="text"
              value={fxLossAccount}
              onChange={(e) => setFxLossAccount(e.target.value)}
              placeholder="7400"
              className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-xs focus:border-accent-500 focus:outline-none"
              disabled={pending}
            />
          </div>
        </div>
      </details>

      {state && !state.ok && (
        <div className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-900">
          {state.message}
        </div>
      )}

      {state && state.ok && (
        <div className="flex flex-col gap-3">
          {state.message && (
            <div
              className={`rounded-md px-3 py-2 text-sm ${
                mode === "posted"
                  ? "bg-emerald-50 text-emerald-800"
                  : "bg-accent-50 text-accent-800"
              }`}
            >
              {state.message}
            </div>
          )}

          {state.missingRates && state.missingRates.length > 0 && (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">
              <strong>Missing CLOSE rates:</strong>{" "}
              {state.missingRates.join(", ")}. Accounts in those
              currencies were skipped — load FxRate rows of type
              <code className="font-mono"> CLOSE</code> as of{" "}
              {asOfDate} and re-run.
            </div>
          )}

          {state.adjustments && state.adjustments.length === 0 ? (
            <div className="rounded-md bg-ink-50 px-3 py-2 text-xs text-ink-700">
              No revaluation needed. Every foreign-currency balance
              already ties to the period-end CLOSE rate.
            </div>
          ) : state.adjustments && state.adjustments.length > 0 ? (
            <div className="overflow-hidden rounded-md border border-ink-200">
              <table className="w-full text-xs">
                <thead className="bg-ink-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-medium text-ink-700">Account</th>
                    <th className="px-3 py-2 text-left font-medium text-ink-700">Ccy</th>
                    <th className="px-3 py-2 text-right font-medium text-ink-700">FX balance</th>
                    <th className="px-3 py-2 text-right font-medium text-ink-700">Carrying</th>
                    <th className="px-3 py-2 text-right font-medium text-ink-700">Rate</th>
                    <th className="px-3 py-2 text-right font-medium text-ink-700">Revalued</th>
                    <th className="px-3 py-2 text-right font-medium text-ink-700">Delta</th>
                  </tr>
                </thead>
                <tbody>
                  {state.adjustments.map((a) => (
                    <tr key={`${a.accountCode}-${a.transactionCurrencyId}`} className="border-t border-ink-100">
                      <td className="px-3 py-1.5">
                        <span className="font-mono">{a.accountCode}</span>
                        <span className="ml-2 text-ink-500">{a.accountName}</span>
                      </td>
                      <td className="px-3 py-1.5 font-mono">{a.transactionCurrencyId}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{a.transactionCarrying}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">${a.reportingCarrying}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">{a.closeRate}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums">${a.reportingRevalued}</td>
                      <td
                        className={`px-3 py-1.5 text-right tabular-nums font-medium ${
                          Number(a.delta) >= 0
                            ? "text-emerald-700"
                            : "text-red-700"
                        }`}
                      >
                        ${a.delta}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-ink-50">
                  <tr className="border-t border-ink-200">
                    <td colSpan={6} className="px-3 py-2 text-right font-medium text-ink-700">
                      Net unrealized FX{" "}
                      {Number(state.netGainLoss) >= 0 ? "gain" : "loss"}:
                    </td>
                    <td
                      className={`px-3 py-2 text-right font-semibold tabular-nums ${
                        Number(state.netGainLoss) >= 0
                          ? "text-emerald-700"
                          : "text-red-700"
                      }`}
                    >
                      ${state.netGainLoss}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          ) : null}

          {mode === "posted" && (state as FxRevaluationPostState).entryNumber && (
            <div className="text-xs text-ink-600">
              Posted entry:{" "}
              <code className="font-mono">
                {(state as FxRevaluationPostState).entryNumber}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
