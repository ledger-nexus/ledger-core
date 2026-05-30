// Team management — invite + manage workspace members.
//
// Three sections:
//   - Invite form (top): admin enters email + role, gets back the
//     accept URL. Email delivery is wired in a follow-up; for now
//     the admin sends the URL manually.
//   - Pending invites: table with revoke buttons.
//   - Members: table with role-change + remove buttons. Per-row UI
//     is disabled for actions that are forbidden by the policy
//     (e.g. demoting the OWNER, removing yourself).
//
// Authorization: ADMIN+ via the policy. The page itself uses
// canManageMemberships; the underlying Server Actions re-check.

import * as React from "react";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canManageMemberships } from "@/lib/auth/policy";
import { getTenantLimits } from "@/lib/billing/limits";
import { prisma } from "@/lib/db";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { InviteForm } from "./invite-form";
import { MemberActions, InviteActions } from "./row-actions";
import { ApprovalToggle } from "./approval-toggle";
import { OwnerTransferCard } from "./owner-transfer-card";

export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) {
    return <Forbidden reason={new NotAuthenticatedError().message} />;
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return <Forbidden reason="Pick a workspace via the tenant switcher first." />;
  }

  // Two gating regimes:
  //   - ADMIN+ sees the full team-admin surface (invite, manage roles,
  //     workspace policy, ownership card if they're the OWNER).
  //   - A non-admin MEMBER who is the PENDING TARGET of an ownership
  //     transfer is allowed in too — but they only see the
  //     "Ownership offered to you" card. Everything else is hidden.
  //     Without this carve-out the notification link from
  //     owner-transfer would 403 for the very user being asked to act.
  // The transfer-target check requires loading the tenant config
  // up-front (before the wider data fetch) to decide whether to
  // proceed or refuse.
  const isAdminSurface = canManageMemberships(tenant.role);
  const targetCheck = await prisma.tenant.findUnique({
    where: { id: tenant.id },
    select: { pendingOwnerTransferToUserId: true },
  });
  const isPendingTransferTargetEarly =
    targetCheck?.pendingOwnerTransferToUserId === user.id;
  if (!isAdminSurface && !isPendingTransferTargetEarly) {
    return (
      <Forbidden reason="Workspace member management requires ADMIN or OWNER role in this workspace." />
    );
  }

  // Non-admin transfer-target: minimal page surface, just the offer
  // card. Skip the broad member/invite/limits fetch they can't see
  // anyway.
  if (!isAdminSurface && isPendingTransferTargetEarly) {
    const initiatedAt = await prisma.tenant
      .findUnique({
        where: { id: tenant.id },
        select: { pendingOwnerTransferInitiatedAt: true },
      })
      .then((t) => t?.pendingOwnerTransferInitiatedAt ?? null);
    return (
      <div className="flex flex-col gap-6">
        <div>
          <h2 className="text-xl font-semibold text-ink-900">Ownership</h2>
          <p className="text-xs text-ink-500">
            The OWNER of <span className="font-mono">{tenant.slug}</span> has
            offered to transfer ownership to you.
          </p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Ownership transfer</CardTitle>
          </CardHeader>
          <CardContent>
            <OwnerTransferCard mode="TARGET_PENDING" initiatedAt={initiatedAt} />
          </CardContent>
        </Card>
      </div>
    );
  }

  const [members, invites, limits, tenantConfig] = await Promise.all([
    prisma.tenantMembership.findMany({
      where: { tenantId: tenant.id },
      include: {
        user: {
          select: { id: true, email: true, displayName: true, isActive: true },
        },
      },
      orderBy: [
        // Sort: OWNER first, then ADMIN, then MEMBER, then VIEWER,
        // tie-break on email asc. Achieved by ordering on role enum
        // descending (Prisma orders enums by declaration order).
        { role: "asc" },
        { user: { email: "asc" } },
      ],
    }),
    prisma.tenantInvite.findMany({
      where: { tenantId: tenant.id, status: "PENDING" },
      include: {
        invitedBy: { select: { email: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    getTenantLimits(tenant.id),
    prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: {
        requireJeApproval: true,
        jeApprovalMinAmount: true,
        ownerUserId: true,
        pendingOwnerTransferToUserId: true,
        pendingOwnerTransferInitiatedAt: true,
      },
    }),
  ]);

  const isOwner = tenant.role === "OWNER";
  const pendingTransferTargetId =
    tenantConfig?.pendingOwnerTransferToUserId ?? null;
  const pendingTransferTargetMember = pendingTransferTargetId
    ? members.find((m) => m.user.id === pendingTransferTargetId) ?? null
    : null;
  const isPendingTransferTarget =
    pendingTransferTargetId !== null &&
    pendingTransferTargetId === user.id;
  const pendingTransferInitiatedAt =
    tenantConfig?.pendingOwnerTransferInitiatedAt ?? null;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Team</h2>
        <p className="text-xs text-ink-500">
          Manage workspace members for <span className="font-mono">{tenant.slug}</span>.
          Invite by email, change roles, or remove members. Every action
          is recorded in the audit log.
        </p>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle>Invite a teammate</CardTitle>
              <span className="text-xs text-ink-500">
                They&rsquo;ll receive a single-use accept link valid for 14 days.
                When email is configured the link is delivered automatically;
                otherwise copy it from the success message after inviting.
              </span>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
                Users
              </div>
              <div className="text-sm tabular-nums text-ink-900">
                {limits.users.current}
                <span className="text-ink-500">
                  {" "}/ {limits.users.cap == null ? "∞" : limits.users.cap}
                </span>
              </div>
              <div className="text-[11px] text-ink-500">
                <span className="font-mono">{limits.plan.key}</span> plan
              </div>
              {limits.users.atLimit && (
                <Badge tone="negative" className="mt-1">
                  AT LIMIT
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {limits.users.atLimit ? (
            <div className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
              You&rsquo;ve reached the user limit on the{" "}
              <span className="font-mono">{limits.plan.key}</span> plan. Upgrade
              at <code className="font-mono">/admin/billing</code> to invite more
              teammates, or remove a member first.
            </div>
          ) : (
            <InviteForm />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace policy</CardTitle>
          <span className="text-xs text-ink-500">
            Approval workflow + other tenant-level controls.
          </span>
        </CardHeader>
        <CardContent>
          <ApprovalToggle
            initialEnabled={tenantConfig?.requireJeApproval ?? false}
            initialThreshold={
              tenantConfig?.jeApprovalMinAmount
                ? tenantConfig.jeApprovalMinAmount.toString()
                : null
            }
          />
        </CardContent>
      </Card>

      {/* Ownership transfer card. Three render conditions:
            1. Current OWNER, no pending transfer → "Offer transfer" UI
            2. Current OWNER, pending transfer → "Cancel transfer" UI
            3. Pending target → "Accept / Decline" UI
          Other members see nothing here (they can't act on a transfer
          they're not party to). */}
      {isOwner && !pendingTransferTargetId && (
        <Card>
          <CardHeader>
            <CardTitle>Ownership</CardTitle>
            <span className="text-xs text-ink-500">
              Hand off this workspace to another member. Two-step opt-in:
              you offer, they accept.
            </span>
          </CardHeader>
          <CardContent>
            <OwnerTransferCard
              mode="OWNER_NO_PENDING"
              candidates={members
                .filter((m) => m.user.isActive && m.user.id !== user.id)
                .map((m) => ({
                  id: m.user.id,
                  email: m.user.email,
                  displayName: m.user.displayName,
                }))}
            />
          </CardContent>
        </Card>
      )}
      {isOwner && pendingTransferTargetId && (
        <Card>
          <CardHeader>
            <CardTitle>Ownership</CardTitle>
          </CardHeader>
          <CardContent>
            <OwnerTransferCard
              mode="OWNER_PENDING"
              targetEmail={pendingTransferTargetMember?.user.email}
              targetDisplayName={pendingTransferTargetMember?.user.displayName}
              initiatedAt={pendingTransferInitiatedAt}
            />
          </CardContent>
        </Card>
      )}
      {isPendingTransferTarget && (
        <Card>
          <CardHeader>
            <CardTitle>Ownership</CardTitle>
          </CardHeader>
          <CardContent>
            <OwnerTransferCard
              mode="TARGET_PENDING"
              initiatedAt={pendingTransferInitiatedAt}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>
            Pending invites ({invites.length})
          </CardTitle>
          <span className="text-xs text-ink-500">
            Outstanding invites that haven&rsquo;t been accepted yet. Revoke
            cancels the accept link.
          </span>
        </CardHeader>
        <CardContent className={invites.length === 0 ? "" : "p-0"}>
          {invites.length === 0 ? (
            <EmptyState
              title="No pending invites"
              description="Once you invite someone, they'll show up here until they accept or you revoke."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Invited by</TH>
                  <TH>Sent</TH>
                  <TH>Expires</TH>
                  <TH>Action</TH>
                </tr>
              </THead>
              <TBody>
                {invites.map((inv) => (
                  <TR key={inv.id}>
                    <TD className="font-mono text-xs text-ink-900">
                      {inv.email}
                    </TD>
                    <TD>
                      <Badge tone="info">{inv.role}</Badge>
                    </TD>
                    <TD className="text-xs text-ink-600">
                      {inv.invitedBy.email}
                    </TD>
                    <TD className="text-xs text-ink-500">
                      {inv.createdAt.toISOString().slice(0, 10)}
                    </TD>
                    <TD className="text-xs text-ink-500">
                      {inv.expiresAt.toISOString().slice(0, 10)}
                    </TD>
                    <TD>
                      <InviteActions inviteId={inv.id} />
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members ({members.length})</CardTitle>
          <span className="text-xs text-ink-500">
            Sorted by role (OWNER first). The OWNER cannot be demoted or
            removed; ownership transfer is a future flow.
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {members.length === 0 ? (
            <EmptyState
              title="No members"
              description="This shouldn't happen — every tenant has at least an OWNER. Reseed?"
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>Name</TH>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Joined</TH>
                  <TH>Action</TH>
                </tr>
              </THead>
              <TBody>
                {members.map((m) => {
                  const isSelf = m.userId === user.id;
                  const isMemberOwner = m.role === "OWNER";
                  const isMemberAdmin = m.role === "ADMIN";
                  // Disable actions when the policy refuses:
                  //   - Owner row: always disabled (can't demote/remove owner)
                  //   - Self row: can't remove self via this UI
                  //   - Admin row when caller is not OWNER: disabled
                  const canEdit =
                    !isMemberOwner &&
                    (!isMemberAdmin || isOwner);
                  const canRemove = canEdit && !isSelf;
                  return (
                    <TR key={m.id}>
                      <TD>
                        <div className="text-sm font-medium text-ink-900">
                          {m.user.displayName}
                          {isSelf && (
                            <span className="ml-2 text-[11px] font-normal text-ink-400">
                              (you)
                            </span>
                          )}
                        </div>
                      </TD>
                      <TD className="text-xs font-mono text-ink-700">
                        {m.user.email}
                      </TD>
                      <TD>
                        <Badge
                          tone={
                            m.role === "OWNER"
                              ? "positive"
                              : m.role === "ADMIN"
                                ? "info"
                                : m.role === "VIEWER"
                                  ? "neutral"
                                  : "neutral"
                          }
                        >
                          {m.role}
                        </Badge>
                        {!m.user.isActive && (
                          <Badge tone="warning" className="ml-2">
                            INACTIVE
                          </Badge>
                        )}
                      </TD>
                      <TD className="text-xs text-ink-500">
                        {m.createdAt.toISOString().slice(0, 10)}
                      </TD>
                      <TD>
                        <MemberActions
                          membershipId={m.id}
                          currentRole={m.role}
                          canEdit={canEdit}
                          canRemove={canRemove}
                          callerIsOwner={isOwner}
                        />
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Forbidden({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-ink-900">Team management</h2>
        <p className="mt-1 text-sm text-ink-500">{reason}</p>
      </CardContent>
    </Card>
  );
}
