"use client";

// Per-row client actions for the team page. Two components: one for
// invite rows (revoke button), one for member rows (role dropdown +
// remove button). Both use useTransition so the server roundtrip
// shows a pending state.

import { useState, useTransition } from "react";
import {
  revokeInviteAction,
  changeMemberRoleAction,
  removeMemberAction,
} from "@/app/actions/team";
import type { TenantRole } from "@prisma/client";

type ChangeableRole = "ADMIN" | "MEMBER" | "VIEWER";

export function InviteActions({ inviteId }: { inviteId: string }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function handleRevoke() {
    if (!confirm("Revoke this invite? The accept link will stop working.")) return;
    setError(null);
    startTransition(async () => {
      const r = await revokeInviteAction({ inviteId });
      if (!r.ok) setError(r.message ?? "Failed");
    });
  }

  return (
    <div className="flex flex-col gap-1">
      <button
        onClick={handleRevoke}
        disabled={pending}
        className="text-xs font-medium text-negative hover:underline disabled:opacity-50"
      >
        {pending ? "Revoking..." : "Revoke"}
      </button>
      {error && <div className="text-[11px] text-negative">{error}</div>}
    </div>
  );
}

interface MemberActionsProps {
  membershipId: string;
  currentRole: TenantRole;
  canEdit: boolean;
  canRemove: boolean;
  callerIsOwner: boolean;
}

export function MemberActions({
  membershipId,
  currentRole,
  canEdit,
  canRemove,
  callerIsOwner,
}: MemberActionsProps) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // Local optimistic state for the dropdown — if the action fails,
  // we restore the old value on next render via key reset.
  const [roleSelection, setRoleSelection] = useState<TenantRole>(currentRole);

  function handleRoleChange(newRole: TenantRole) {
    if (newRole === currentRole) return;
    setError(null);
    setRoleSelection(newRole);
    startTransition(async () => {
      const r = await changeMemberRoleAction({
        membershipId,
        role: newRole,
      });
      if (!r.ok) {
        setError(r.message ?? "Failed");
        setRoleSelection(currentRole); // revert
      }
    });
  }

  function handleRemove() {
    if (!confirm("Remove this member from the workspace?")) return;
    setError(null);
    startTransition(async () => {
      const r = await removeMemberAction({ membershipId });
      if (!r.ok) setError(r.message ?? "Failed");
    });
  }

  if (currentRole === "OWNER") {
    return <span className="text-[11px] text-ink-400">workspace owner</span>;
  }

  if (!canEdit) {
    // ADMIN can't manage another ADMIN unless caller is OWNER.
    return (
      <span className="text-[11px] text-ink-400">
        {callerIsOwner ? "—" : "owner-only"}
      </span>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <select
          value={roleSelection}
          onChange={(e) => handleRoleChange(e.target.value as TenantRole)}
          disabled={pending}
          className="rounded-md border border-ink-300 px-2 py-0.5 text-xs focus:border-accent-500 focus:outline-none disabled:opacity-50"
        >
          {(["ADMIN", "MEMBER", "VIEWER"] as ChangeableRole[]).map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        {canRemove && (
          <button
            onClick={handleRemove}
            disabled={pending}
            className="text-xs font-medium text-negative hover:underline disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
      {error && <div className="text-[11px] text-negative">{error}</div>}
    </div>
  );
}
