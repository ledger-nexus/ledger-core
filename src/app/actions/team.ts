"use server";

// Team management Server Actions for /admin/team.
//
// Four primitives:
//   - inviteMemberAction({ email, role }) — create a PENDING invite +
//     fire the invite email (LOGGED_ONLY when email isn't configured)
//   - revokeInviteAction({ inviteId }) — mark an outstanding invite REVOKED
//   - changeMemberRoleAction({ membershipId, role }) — update role
//   - removeMemberAction({ membershipId }) — delete the membership.
//     THIS is per-tenant removal — it revokes access to one workspace
//     without touching the global User row (contrast user-lifecycle's
//     deactivate, which flips the global isActive switch).
//
// Authorization: every action goes through requirePermitted with
// canManageMemberships (ADMIN+ in the current tenant). OWNER
// protections are enforced inline: the owner can't be demoted or
// removed, nobody can be promoted TO owner here, and an ADMIN can't
// change or remove another ADMIN (only the OWNER can) — the
// escalation-war safeguard.
//
// Confidentiality: TenantInvite.email is encrypted at rest. Call sites
// write the natural `where: { email }` and the encrypted-fields
// extension rewrites equality onto emailHash — NEVER hand-call the
// hash helper here (it throws when the deterministic key is unset;
// the extension degrades). One consequence: relation filters like
// `user: { email }` are NOT rewritten (the rewriter walks AND/OR/NOT,
// not relations), so the already-a-member check resolves the User
// top-level first, then checks membership by userId.
//
// Audit: every action emits auditPrivilegedAction so SOC 2 access
// reviews can see who invited / promoted / removed whom, and when.

import { randomBytes } from "node:crypto";
import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted } from "@/lib/auth/authorize";
import {
  canManageMemberships,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";
import {
  assertCanInviteUser,
  PlanLimitExceededError,
} from "@/lib/billing/limits";
import { sendInviteEmail } from "@/lib/email/templates/invite";
import type { TenantRole } from "@prisma/client";
import { sanitizeActionError } from "@/lib/actions/action-error";

// 14-day default invite TTL. Long enough that vacation doesn't lose
// the invite; short enough that a forgotten link doesn't linger.
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
  /** Delivery outcome of the invite email. */
  emailStatus?: "DELIVERED" | "LOGGED_ONLY" | "FAILED";
}

export async function inviteMemberAction(
  input: InviteMemberInput
): Promise<InviteMemberState> {
  try {
    const { user, tenant } = await requirePermitted(
      "membership.manage",
      canManageMemberships
    );

    const email = input.email.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      return { ok: false, message: "Enter a valid email address." };
    }
    if (!["ADMIN", "MEMBER", "VIEWER"].includes(input.role)) {
      return {
        ok: false,
        message:
          "Role must be ADMIN, MEMBER, or VIEWER (the OWNER role is reserved for the tenant creator).",
      };
    }

    // Plan seat cap (harvest ⑦). Runs BEFORE the duplicate checks so a
    // workspace at its cap gets "you are out of seats" rather than
    // "that person is already a member" — the cap is the real reason.
    // Counts members + outstanding PENDING invites; soft-warns unless
    // BILLING_ENFORCE_LIMITS=true.
    try {
      await assertCanInviteUser(tenant.id);
    } catch (e) {
      if (e instanceof PlanLimitExceededError) {
        return { ok: false, message: e.message };
      }
      throw e;
    }

    // Already a member of THIS tenant? Resolve the user top-level
    // (extension rewrites email → emailHash), then check membership.
    const existingUser = await prisma.user.findUnique({
      where: { email },
      select: { id: true },
    });
    if (existingUser) {
      const existingMembership = await prisma.tenantMembership.findFirst({
        where: { tenantId: tenant.id, userId: existingUser.id },
        select: { id: true },
      });
      if (existingMembership) {
        return {
          ok: false,
          message: `${email} is already a member of this workspace.`,
        };
      }
    }

    // Outstanding PENDING invite for this email + tenant? Refuse rather
    // than mint a duplicate — revoke the old one for a fresh token.
    // Equality on the encrypted column rewrites onto emailHash.
    const existingInvite = await prisma.tenantInvite.findFirst({
      where: { tenantId: tenant.id, email, status: "PENDING" },
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
      select: { id: true, expiresAt: true },
    });

    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      tenantId: tenant.id,
      action: "team.invite_member",
      resource: "TenantInvite",
      resourceId: invite.id,
      metadata: { role: input.role },
    });

    // Accept URL the recipient follows. APP_BASE_URL is deploy env; in
    // dev the path-only URL still works for same-origin navigation.
    const baseUrl = process.env.APP_BASE_URL || "";
    const acceptUrl = `${baseUrl}/invites/accept?token=${token}`;

    // Fire the email. sendEmail isolates its own failures — a Resend
    // outage or missing env never breaks invite creation.
    const emailResult = await sendInviteEmail({
      to: email,
      tenantName: tenant.name,
      inviterName: user.displayName,
      role: input.role,
      acceptUrl,
      expiresAt: invite.expiresAt,
      tenantId: tenant.id,
      inviteId: invite.id,
    });

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
    const { user, tenant } = await requirePermitted(
      "membership.manage",
      canManageMemberships
    );

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
      actor: { id: user.id, email: user.email },
      tenantId: tenant.id,
      action: "team.revoke_invite",
      resource: "TenantInvite",
      resourceId: invite.id,
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
    const { user, tenant } = await requirePermitted(
      "membership.manage",
      canManageMemberships
    );

    if (!["ADMIN", "MEMBER", "VIEWER"].includes(input.role)) {
      return {
        ok: false,
        message: "Role must be ADMIN, MEMBER, or VIEWER.",
      };
    }

    const membership = await prisma.tenantMembership.findFirst({
      where: { id: input.membershipId, tenantId: tenant.id },
      include: { user: { select: { id: true, email: true } } },
    });
    if (!membership) {
      return { ok: false, message: "Member not found in this workspace." };
    }
    // OWNER protection: the tenant's OWNER cannot be demoted by anyone.
    if (membership.role === "OWNER") {
      return {
        ok: false,
        message:
          "The workspace OWNER cannot be demoted. Use the Ownership card below to transfer it.",
      };
    }
    // ADMINs can't change other ADMINs — only the OWNER can. A v1
    // safeguard so two ADMINs can't get into an escalation war.
    if (membership.role === "ADMIN" && tenant.role !== "OWNER") {
      return {
        ok: false,
        message: "Only the OWNER can change another ADMIN's role.",
      };
    }
    if (membership.role === input.role) {
      return {
        ok: true,
        message: `${membership.user.email} is already ${input.role}.`,
      };
    }

    await prisma.tenantMembership.update({
      where: { id: membership.id },
      data: { role: input.role },
    });

    await auditPrivilegedAction({
      actor: { id: user.id, email: user.email },
      tenantId: tenant.id,
      action: "team.change_member_role",
      resource: "TenantMembership",
      resourceId: membership.id,
      metadata: {
        targetUserId: membership.userId,
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
    const { user, tenant } = await requirePermitted(
      "membership.manage",
      canManageMemberships
    );

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
        message:
          "The workspace OWNER cannot be removed. Delete the workspace instead (or transfer ownership first).",
      };
    }
    // Self-removal refused — it may leave THIS user no admin path back
    // in and they might not realize it.
    if (membership.userId === user.id) {
      return {
        ok: false,
        message:
          "You can't remove yourself. Ask another admin to remove you.",
      };
    }
    // Same escalation-war safeguard as the role change.
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
      actor: { id: user.id, email: user.email },
      tenantId: tenant.id,
      action: "team.remove_member",
      resource: "TenantMembership",
      resourceId: membership.id,
      metadata: {
        targetUserId: membership.userId,
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
  if (e instanceof PermissionDeniedError)
    return { ok: false, message: e.message };
  return {
    ok: false,
    message: sanitizeActionError(e, "Unknown error"),
  };
}
