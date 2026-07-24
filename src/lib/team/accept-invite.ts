// Invite acceptance — the decision logic behind /invites/accept.
//
// Extracted from the page so the state machine is testable without
// rendering a server component. The page maps each outcome to UI; this
// module owns the rules:
//
//   - token must resolve to an invite; status PENDING; not expired
//     (expiry lazy-flips the row to EXPIRED on the way through, so the
//     admin's invite list reflects reality without a background job)
//   - the signed-in user's email must equal the invite email
//     (case-insensitively) — an invite can't be hijacked by whoever
//     finds the link
//   - acceptance is atomic: membership upsert (double-click race safe)
//     + invite → ACCEPTED in one transaction, then the audit row
//
// A re-followed ACCEPTED link by the very user who accepted resolves
// to "already-member" so the page can just route them in.

import { prisma } from "@/lib/db";
import type { TenantRole } from "@prisma/client";
import type { CurrentUser } from "@/lib/auth/current-user";
import { auditPrivilegedAction } from "@/lib/audit/log";

export type AcceptInviteOutcome =
  | { kind: "accepted"; tenantSlug: string; role: TenantRole }
  | { kind: "already-member"; tenantSlug: string }
  | { kind: "not-found" }
  | { kind: "already-used" }
  | { kind: "revoked" }
  | { kind: "expired"; expiredOn: string }
  | { kind: "email-mismatch"; inviteEmail: string };

export async function acceptInvite(
  token: string,
  user: CurrentUser
): Promise<AcceptInviteOutcome> {
  const invite = await prisma.tenantInvite.findUnique({
    where: { token },
    include: { tenant: { select: { id: true, slug: true } } },
  });
  if (!invite) return { kind: "not-found" };

  if (invite.status === "ACCEPTED") {
    const existing = await prisma.tenantMembership.findFirst({
      where: { tenantId: invite.tenantId, userId: user.id },
      select: { id: true },
    });
    if (existing) {
      return { kind: "already-member", tenantSlug: invite.tenant.slug };
    }
    return { kind: "already-used" };
  }
  if (invite.status === "REVOKED") return { kind: "revoked" };

  if (invite.status === "EXPIRED" || invite.expiresAt < new Date()) {
    if (invite.status !== "EXPIRED") {
      await prisma.tenantInvite.update({
        where: { id: invite.id },
        data: { status: "EXPIRED" },
      });
    }
    return {
      kind: "expired",
      expiredOn: invite.expiresAt.toISOString().slice(0, 10),
    };
  }

  // The signed-in user MUST be the person the invite was sent to.
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return { kind: "email-mismatch", inviteEmail: invite.email };
  }

  await prisma.$transaction(async (tx) => {
    // Upsert so a double-clicked link doesn't throw on the
    // (tenantId, userId) unique.
    await tx.tenantMembership.upsert({
      where: {
        tenantId_userId: { tenantId: invite.tenantId, userId: user.id },
      },
      create: {
        tenantId: invite.tenantId,
        userId: user.id,
        role: invite.role,
      },
      update: {}, // already a member somehow — leave their role alone
    });
    await tx.tenantInvite.update({
      where: { id: invite.id },
      data: { status: "ACCEPTED", acceptedAt: new Date() },
    });
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    tenantId: invite.tenantId,
    action: "team.accept_invite",
    resource: "TenantInvite",
    resourceId: invite.id,
    metadata: { role: invite.role },
  });

  return {
    kind: "accepted",
    tenantSlug: invite.tenant.slug,
    role: invite.role,
  };
}
