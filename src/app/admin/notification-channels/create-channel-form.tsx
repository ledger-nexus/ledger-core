"use client";

// Create-channel form. Client component because we want inline
// validation feedback + masking the URL input as the operator types.

import { useState, useTransition } from "react";
import { createChannel } from "@/app/actions/notification-channels";
import { Input, Select } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type Severity = "high" | "medium" | "low";
type Mode = "IMMEDIATE" | "DIGEST_DAILY";

export default function CreateChannelForm() {
  const [name, setName] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [mode, setMode] = useState<Mode>("IMMEDIATE");
  const [showUrl, setShowUrl] = useState(false);
  const [type, setType] = useState<"SLACK" | "WEBHOOK_GENERIC">("SLACK");
  const [signingSecret, setSigningSecret] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggleSeverity(s: Severity) {
    setSeverities((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]
    );
  }

  function submit(form: FormData) {
    setError(null);
    const trimmedName = String(form.get("name") ?? "").trim();
    const url = String(form.get("webhookUrl") ?? "").trim();
    if (!trimmedName) {
      setError("Name is required");
      return;
    }
    if (!url) {
      setError("Webhook URL is required");
      return;
    }
    const secret = String(form.get("signingSecret") ?? "").trim();
    if (type === "WEBHOOK_GENERIC" && secret && secret.length < 16) {
      setError("Signing secret must be at least 16 characters");
      return;
    }
    startTransition(async () => {
      const r = await createChannel({
        name: trimmedName,
        type,
        webhookUrl: url,
        signingSecret: type === "WEBHOOK_GENERIC" && secret ? secret : undefined,
        severityFilter: severities,
        mode,
        enabled: true,
      });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setName("");
      setWebhookUrl("");
      setSeverities([]);
      setMode("IMMEDIATE");
    });
  }

  return (
    <form action={submit} className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-600">
            Channel name
          </label>
          <Input
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="#finance close alerts"
            maxLength={120}
            disabled={pending}
            required
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-600" htmlFor="channelType">
            Destination
          </label>
          <Select
            id="channelType"
            value={type}
            onChange={(e) =>
              setType(e.target.value as "SLACK" | "WEBHOOK_GENERIC")
            }
            disabled={pending}
          >
            <option value="SLACK">Slack incoming webhook</option>
            <option value="WEBHOOK_GENERIC">HTTPS endpoint (signed JSON)</option>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-600">
            {type === "SLACK" ? "Slack webhook URL" : "Endpoint URL"}
            <span className="ml-1 text-ink-400 font-normal">(encrypted at rest)</span>
          </label>
          <div className="flex gap-2">
            <Input
              name="webhookUrl"
              type={showUrl ? "text" : "password"}
              value={webhookUrl}
              onChange={(e) => setWebhookUrl(e.target.value)}
              placeholder={
                type === "SLACK"
                  ? "https://hooks.slack.com/services/T.../B.../..."
                  : "https://example.com/hooks/ledger-core"
              }
              maxLength={500}
              disabled={pending}
              required
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => setShowUrl((v) => !v)}
              className="rounded-md border border-ink-200 px-2 text-xs text-ink-700 hover:bg-ink-50"
              tabIndex={-1}
            >
              {showUrl ? "Hide" : "Show"}
            </button>
          </div>
        </div>
        {type === "WEBHOOK_GENERIC" && (
          <div className="flex flex-col gap-1 md:col-span-2">
            <label className="text-xs font-medium text-ink-600">
              Signing secret
              <span className="ml-1 font-normal text-ink-400">
                (optional, encrypted at rest — 16+ chars)
              </span>
            </label>
            <Input
              name="signingSecret"
              type="password"
              value={signingSecret}
              onChange={(e) => setSigningSecret(e.target.value)}
              placeholder="Shared with the receiving endpoint"
              maxLength={200}
              disabled={pending}
            />
            <p className="text-xs text-ink-500">
              We sign each delivery with{" "}
              <code className="font-mono">
                X-LedgerCore-Signature: sha256=HMAC(timestamp.body)
              </code>{" "}
              so your endpoint can prove the request came from us, and reject
              replays using the timestamp. Leave blank only if the endpoint is
              protected some other way — an unsigned webhook will accept
              anything that can reach the URL.
            </p>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-600">
            Severity filter
            <span className="ml-1 text-ink-400 font-normal">
              (leave blank for all severities)
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            {(["high", "medium", "low"] as Severity[]).map((s) => {
              const active = severities.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSeverity(s)}
                  disabled={pending}
                  className={
                    active
                      ? "rounded-full bg-ink-900 px-3 py-0.5 text-xs font-medium text-white"
                      : "rounded-full border border-ink-200 px-3 py-0.5 text-xs text-ink-700 hover:bg-ink-50"
                  }
                >
                  {s}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-ink-600">
            Cadence
            <span className="ml-1 text-ink-400 font-normal">
              (immediate pings every 15m; daily digest batches at 09:00 UTC)
            </span>
          </label>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { value: "IMMEDIATE" as Mode, label: "Immediate" },
                { value: "DIGEST_DAILY" as Mode, label: "Daily digest" },
              ]
            ).map((opt) => {
              const active = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  disabled={pending}
                  className={
                    active
                      ? "rounded-full bg-ink-900 px-3 py-0.5 text-xs font-medium text-white"
                      : "rounded-full border border-ink-200 px-3 py-0.5 text-xs text-ink-700 hover:bg-ink-50"
                  }
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end gap-2">
        <Button type="submit" disabled={pending || !name || !webhookUrl}>
          {pending ? "Adding…" : "Add channel"}
        </Button>
      </div>
    </form>
  );
}
