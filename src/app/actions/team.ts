"use server";

// Team management Server Actions for /admin/team.
//
// Five primitives:
//   - inviteMemberAction({ email, role }) — create a PENDING invite
//   - revokeInviteAction({ inviteId }) — mark an outstanding invite REVOKED
//   - changeMemberRoleAction({ membershipId, role }) — update role
//   - removeMemberAction({ membershipId }) — delete the membership
//   - resendInviteEmailAction({ inviteId }) — re-fires the email (no-op
//     until the email module is configured)
//
// Authorization: every action requires the current user to be an
// ADMIN+ in the current tenant via the policy module. OWNER protection
// is enforced inline (can't demote / remove the owner — refuse with a
// clear error).
//
// Audit: every privileged action emits an auditPrivilegedAction event
// so SOC 2 CC4 access reviews can see who invited / promoted / kicked
// whom and when.

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import {
  requireCurrentTenant,
  NoTenantSelectedError,
} from "@/lib/auth/tenant";
import {
  canManageMemberships,
  PermissionDeniedError,
  requirePermission,
} from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { emailLookupKeyForTenantInvite } from "@/lib/soc2";
import { sendInviteEmail } from "@/lib/email/templates/invite";
import {
  assertCanInviteUser,
  PlanLimitExceededError,
} from "@/lib/billing/limits";
import type { TenantRole } from "@prisma/client";

// 14-day default invite TTL. Long enough that vacation doesn't lose
// the invite; short enough that a forgotten link doesn't linger
// indefinitely.
const INVITE_TTL_DAYS = 14;

function newInviteToken(): string {
  // 32 bytes → 64 hex chars. Enough entropy that brute-forcing the
  // accept URL is infeasible.
  return randomBytes(32).toString("hex");
}

function inviteExpiry(): Date {
  return new Date(Date.now() + INVITE_TTL_DAYS * 24 * 60 * 60 * 1000);
}

// ─── inviteMember ──────────────────────────────────────────────────────────

export interface InviteMemberInput {
  email: string;
  role: TenantRole; // OWNER not allowed — see validation below
}

export interface InviteMemberState {
  ok: boolean;
  message?: string;
  inviteId?: string;
  /** The accept URL — surfaced in the UI even when email isn't configured. */
  acceptUrl?: string;
  /** Delivery outcome of the invite email ("DELIVERED" / "LOGGED_ONLY" / "FAILED"). */
  emailStatus?: "DELIVERED" | "LOGGED_ONLY" | "FAILED";
}

export async function inviteMemberAction(
  input: InviteMemberInput
): Promise<InviteMemberState> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("manage_memberships", tenant.role, canManageMemberships);

    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return { ok: false, message: "Enter a valid email address." };
    }
    if (!["ADMIN", "MEMBER", "VIEWER"].includes(input.role)) {
      return {
        ok: false,
        message: "Role must be ADMIN, MEMBER, or VIEWER (the OWNER role is reserved for the tenant creator).",
      };
    }

    // Plan-tier check BEFORE other validations: shows the user a
    // direct "upgrade" message rather than a vague "duplicate invite"
    // error if they're spamming at the limit.
    await assertCanInviteUser(tenant.id);

    // If the invitee is already a member of THIS tenant, refuse.
    const existingMembership = await prisma.tenantMembership.findFirst({
      where: { tenantId: tenant.id, user: { email } },
      select: { id: true, user: { select: { email: true } } },
    });
    if (existingMembership) {
      return {
        ok: false,
        message: `${email} is already a member of this workspace.`,
      };
    }

    // If there's an outstanding PENDING invite for this email + tenant,
    // refuse rather than creating a duplicate. The admin can revoke
    // the old one and try again if they want a fresh token.
    // CC6: TenantInvite.email is encrypted at rest (random IV) — match
    // by the deterministic emailHash instead. See
    // docs/design/deterministic-encryption.md (Phase 3).
    const existingInvite = await prisma.tenantInvite.findFirst({
      where: {
        tenantId: tenant.id,
        emailHash: emailLookupKeyForTenantInvite(email),
        status: "PENDING",
      },
      select: { id: true },
    });
    if (existingInvite) {
      return {
        ok: false,
        message: `${email} already has a pending invite. Revoke it first if you want to send a new one.`,
      };
    }

    const token = newInviteToken();
    const invite = await prisma.tenantInvite.create({
      data: {
        tenantId: tenant.id,
        email,
        role: input.role,
        token,
        invitedById: user.id,
        expiresAt: inviteExpiry(),
      },
      select: { id: true },
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "team.invite_member",
      resource: "TenantInvite",
      resourceId: invite.id,
      metadata: { email, role: input.role },
    });

    // Build the accept URL the recipient follows. APP_BASE_URL is set
    // in deploy env; in dev it defaults to empty (the path-only URL
    // still works for same-origin navigation).
    const baseUrl = process.env.APP_BASE_URL || "";
    const acceptUrl = `${baseUrl}/invites/accept?token=${token}`;

    // Fire the email. The send helper isolates its own failures —
    // a Resend outage or missing env doesn't break invite creation.
    const emailResult = await sendInviteEmail({
      to: email,
      tenantName: tenant.name,
      inviterName: user.displayName,
      role: input.role,
      acceptUrl,
      expiresAt: inviteExpiry(),
      tenantId: tenant.id,
      inviteId: invite.id,
    });

    // Build a status message based on whether the email actually got
    // somewhere or just landed in the log. The admin needs to know
    // whether to copy + paste the accept URL manually.
    const messageByStatus: Record<typeof emailResult.status, string> = {
      DELIVERED: `Invite email sent to ${email}.`,
      LOGGED_ONLY: `Invited ${email} as ${input.role}. Email isn't configured (set RESEND_API_KEY + EMAIL_FROM_ADDRESS to enable) — copy the accept URL and send it yourself.`,
      FAILED: `Invite created for ${email}, but the email send failed (${emailResult.errorMessage ?? "unknown error"}). Copy the accept URL and send it manually.`,
    };

    revalidatePath("/admin/team");
    return {
      ok: true,
      inviteId: invite.id,
      acceptUrl,
      emailStatus: emailResult.status,
      message: messageByStatus[emailResult.status],
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── revokeInvite ──────────────────────────────────────────────────────────

export interface RevokeInviteInput {
  inviteId: string;
}

export async function revokeInviteAction(
  input: RevokeInviteInput
): Promise<{ ok: boolean; message?: string }> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("manage_memberships", tenant.role, canManageMemberships);

    // Tenant-scope the lookup so a foreign admin can't revoke another
    // tenant's invite.
    const invite = await prisma.tenantInvite.findFirst({
      where: { id: input.inviteId, tenantId: tenant.id },
      select: { id: true, status: true, email: true },
    });
    if (!invite) {
      return { ok: false, message: "Invite not found." };
    }
    if (invite.status !== "PENDING") {
      return { ok: false, message: `Invite is already ${invite.status}.` };
    }

    await prisma.tenantInvite.update({
      where: { id: invite.id },
      data: { status: "REVOKED", revokedAt: new Date() },
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "team.revoke_invite",
      resource: "TenantInvite",
      resourceId: invite.id,
      metadata: { email: invite.email },
    });

    revalidatePath("/admin/team");
    return { ok: true, message: `Revoked invite for ${invite.email}.` };
  } catch (e) {
    return mapError(e);
  }
}

// ─── changeMemberRole ──────────────────────────────────────────────────────

export interface ChangeMemberRoleInput {
  membershipId: string;
  role: TenantRole;
}

export async function changeMemberRoleAction(
  input: ChangeMemberRoleInput
): Promise<{ ok: boolean; message?: string }> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("manage_memberships", tenant.role, canManageMemberships);

    const membership = await prisma.tenantMembership.findFirst({
      where: { id: input.membershipId, tenantId: tenant.id },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!membership) {
      return { ok: false, message: "Member not found in this workspace." };
    }
    // OWNER protection: the tenant's OWNER cannot be demoted by anyone.
    // Tenant deletion is the only way to remove the owner, and that's
    // gated to OWNER themselves.
    if (membership.role === "OWNER") {
      return {
        ok: false,
        message: "The workspace OWNER cannot be demoted. Transfer ownership first (not yet supported).",
      };
    }
    // Can't promote anyone TO owner via this action either.
    if (input.role === "OWNER") {
      return {
        ok: false,
        message: "OWNER is reserved for the tenant creator. Use the (future) transfer-ownership flow instead.",
      };
    }
    // ADMINs can't change other ADMINs (or OWNERs above). Only the
    // OWNER can demote an ADMIN. This is a v1 safeguard so two ADMINs
    // can't get into an escalation war.
    if (membership.role === "ADMIN" && tenant.role !== "OWNER") {
      return {
        ok: false,
        message: "Only the OWNER can change another ADMIN's role.",
      };
    }
    // Don't accidentally no-op-update — surface as a friendly skip.
    if (membership.role === input.role) {
      return { ok: true, message: `${membership.user.email} is already ${input.role}.` };
    }

    await prisma.tenantMembership.update({
      where: { id: membership.id },
      data: { role: input.role },
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "team.change_member_role",
      resource: "TenantMembership",
      resourceId: membership.id,
      metadata: {
        targetUserId: membership.userId,
        targetEmail: membership.user.email,
        previousRole: membership.role,
        newRole: input.role,
      },
    });

    revalidatePath("/admin/team");
    return {
      ok: true,
      message: `${membership.user.email}: ${membership.role} → ${input.role}.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── removeMember ──────────────────────────────────────────────────────────

export interface RemoveMemberInput {
  membershipId: string;
}

export async function removeMemberAction(
  input: RemoveMemberInput
): Promise<{ ok: boolean; message?: string }> {
  try {
    const user = await requireCurrentUser();
    const tenant = await requireCurrentTenant();
    requirePermission("manage_memberships", tenant.role, canManageMemberships);

    const membership = await prisma.tenantMembership.findFirst({
      where: { id: input.membershipId, tenantId: tenant.id },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!membership) {
      return { ok: false, message: "Member not found in this workspace." };
    }
    if (membership.role === "OWNER") {
      return {
        ok: false,
        message: "The workspace OWNER cannot be removed. Delete the workspace instead (or transfer ownership first).",
      };
    }
    // Don't let admins remove themselves — leaves no admin path back
    // in for THIS user but they may not realize it. Use the (future)
    // "leave workspace" flow for self-removal.
    if (membership.userId === user.id) {
      return {
        ok: false,
        message: "You can't remove yourself. Ask another admin, or use the (future) leave-workspace action.",
      };
    }
    // ADMINs can't remove other ADMINs — same escalation-war safeguard
    // as the role change.
    if (membership.role === "ADMIN" && tenant.role !== "OWNER") {
      return {
        ok: false,
        message: "Only the OWNER can remove another ADMIN.",
      };
    }

    await prisma.tenantMembership.delete({
      where: { id: membership.id },
    });

    await auditPrivilegedAction({
      actor: user,
      tenantId: tenant.id,
      action: "team.remove_member",
      resource: "TenantMembership",
      resourceId: membership.id,
      metadata: {
        targetUserId: membership.userId,
        targetEmail: membership.user.email,
        previousRole: membership.role,
      },
    });

    revalidatePath("/admin/team");
    return {
      ok: true,
      message: `Removed ${membership.user.email} from the workspace.`,
    };
  } catch (e) {
    return mapError(e);
  }
}

// ─── mapError ──────────────────────────────────────────────────────────────

function mapError(e: unknown): { ok: false; message: string } {
  if (e instanceof NotAuthenticatedError)
    return { ok: false, message: "You must be signed in." };
  if (e instanceof NoTenantSelectedError)
    return { ok: false, message: e.message };
  if (e instanceof PermissionDeniedError)
    return { ok: false, message: e.message };
  if (e instanceof PlanLimitExceededError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: e instanceof Error ? e.message : "Unknown error",
  };
}
