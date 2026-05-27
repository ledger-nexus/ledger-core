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

export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) {
    return <Forbidden reason={new NotAuthenticatedError().message} />;
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return <Forbidden reason="Pick a workspace via the tenant switcher first." />;
  }
  if (!canManageMemberships(tenant.role)) {
    return (
      <Forbidden reason="Workspace member management requires ADMIN or OWNER role in this workspace." />
    );
  }

  const [members, invites] = await Promise.all([
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
  ]);

  const isOwner = tenant.role === "OWNER";

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
          <CardTitle>Invite a teammate</CardTitle>
          <span className="text-xs text-ink-500">
            They&rsquo;ll receive a single-use accept link valid for 14 days.
            The link is shown here after creation — until email delivery is
            wired up, copy and send it yourself.
          </span>
        </CardHeader>
        <CardContent>
          <InviteForm />
        </CardContent>
      </Card>

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
