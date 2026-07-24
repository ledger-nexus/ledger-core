"use client";

// Invite-by-email form. Calls inviteMemberAction and surfaces the
// returned accept URL in a copy-friendly box.

import { useState, useTransition } from "react";
import { inviteMemberAction } from "@/app/actions/team";
import type { TenantRole } from "@prisma/client";

type InvitableRole = "ADMIN" | "MEMBER" | "VIEWER";

export function InviteForm() {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitableRole>("MEMBER");
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<{
    ok: boolean;
    message?: string;
    acceptUrl?: string;
  } | null>(null);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setResult(null);
    startTransition(async () => {
      const r = await inviteMemberAction({
        email,
        role: role as TenantRole,
      });
      setResult(r);
      if (r.ok) setEmail(""); // clear on success
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex-1 min-w-[240px]">
          <label className="text-xs font-medium text-ink-700">
            Email
          </label>
          <input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@example.com"
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none"
            disabled={pending}
          />
        </div>
        <div className="w-32">
          <label className="text-xs font-medium text-ink-700">Role</label>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as InvitableRole)}
            className="mt-1 w-full rounded-md border border-ink-300 px-3 py-1.5 text-sm focus:border-accent-500 focus:outline-none"
            disabled={pending}
          >
            <option value="ADMIN">ADMIN</option>
            <option value="MEMBER">MEMBER</option>
            <option value="VIEWER">VIEWER</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={pending || !email}
          className="h-9 inline-flex items-center rounded-md bg-ink-900 px-4 text-sm font-medium text-white hover:bg-ink-800 disabled:opacity-50"
        >
          {pending ? "Sending..." : "Send invite"}
        </button>
      </div>
      {result && (
        <div
          className={`rounded-md px-3 py-2 text-xs ${
            result.ok
              ? "bg-emerald-50 text-emerald-800"
              : "bg-red-50 text-red-800"
          }`}
        >
          <div>{result.message}</div>
          {result.ok && result.acceptUrl && (
            <div className="mt-2">
              <div className="text-[11px] font-medium text-ink-600">
                Accept URL (send to recipient):
              </div>
              <code className="mt-0.5 block break-all rounded bg-white px-2 py-1 font-mono text-[11px] text-ink-900">
                {result.acceptUrl}
              </code>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
