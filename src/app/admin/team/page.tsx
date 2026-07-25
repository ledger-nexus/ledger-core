// Team management — invite + manage workspace members.
//
// Three sections:
//   - Invite form: admin enters email + role, gets the accept URL back
//     (and the invite email fires — LOGGED_ONLY until Resend is
//     configured, in which case the admin sends the URL manually).
//   - Pending invites: table with revoke buttons.
//   - Members: table with role-change + remove controls. Per-row UI is
//     disabled where the policy forbids the action (demoting the
//     OWNER, an ADMIN touching another ADMIN, removing yourself) —
//     the Server Actions re-check everything server-side.
//
// Contrast with /admin/users: that page manages GLOBAL user lifecycle
// (deactivate/reactivate the login itself); this page manages THIS
// workspace's memberships and roles. Removing someone here revokes one
// workspace, not their account.
//
// Authorization: canManageMemberships (ADMIN+). The page gates the
// render; every underlying Server Action re-checks.

import { getCurrentUser } from "@/lib/auth/current-user";
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
import { ApprovalToggle } from "./approval-toggle";

export const dynamic = "force-dynamic";

export default async function TeamPage() {
  const user = await getCurrentUser();
  if (!user) {
    return <Forbidden reason="Sign in first." />;
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

  const [members, invites, tenantConfig] = await Promise.all([
    prisma.tenantMembership.findMany({
      where: { tenantId: tenant.id },
      include: {
        user: {
          select: { id: true, email: true, displayName: true, isActive: true },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.tenantInvite.findMany({
      where: { tenantId: tenant.id, status: "PENDING" },
      select: {
        id: true,
        email: true,
        role: true,
        expiresAt: true,
        createdAt: true,
        invitedBy: { select: { displayName: true } },
      },
      orderBy: { createdAt: "desc" },
    }),
    prisma.tenant.findUnique({
      where: { id: tenant.id },
      select: { requireJeApproval: true, jeApprovalMinAmount: true },
    }),
  ]);

  const callerIsOwner = tenant.role === "OWNER";

  return (
    <div className="flex flex-col gap-6 p-6">
      <div>
        <h1 className="text-lg font-semibold text-ink-900">Team</h1>
        <p className="text-sm text-ink-600">
          Members and invites for <strong>{tenant.name}</strong>. Global
          account lifecycle (deactivating a login everywhere) lives at{" "}
          <code className="font-mono text-xs">/admin/users</code>.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Invite someone</CardTitle>
        </CardHeader>
        <CardContent>
          <InviteForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspace policy — journal-entry approval</CardTitle>
        </CardHeader>
        <CardContent>
          <ApprovalToggle
            initialEnabled={tenantConfig?.requireJeApproval ?? false}
            initialThreshold={
              tenantConfig?.jeApprovalMinAmount?.toString() ?? null
            }
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Pending invites</CardTitle>
        </CardHeader>
        <CardContent>
          {invites.length === 0 ? (
            <EmptyState
              title="No pending invites"
              description="Invites you send appear here until they're accepted, revoked, or expire."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Email</TH>
                  <TH>Role</TH>
                  <TH>Invited by</TH>
                  <TH>Expires</TH>
                  <TH></TH>
                </TR>
              </THead>
              <TBody>
                {invites.map((inv) => (
                  <TR key={inv.id}>
                    <TD className="font-mono text-xs">{inv.email}</TD>
                    <TD>
                      <Badge>{inv.role}</Badge>
                    </TD>
                    <TD className="text-xs">{inv.invitedBy.displayName}</TD>
                    <TD className="text-xs">
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
          <CardTitle>Members</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <THead>
              <TR>
                <TH>Name</TH>
                <TH>Email</TH>
                <TH>Role</TH>
                <TH>Status</TH>
                <TH></TH>
              </TR>
            </THead>
            <TBody>
              {members.map((m) => {
                // ADMIN rows are owner-only to edit; everyone else is
                // fair game for any ADMIN+. The OWNER row renders a
                // label instead of controls.
                const canEdit = m.role !== "ADMIN" || callerIsOwner;
                const canRemove = canEdit && m.userId !== user.id;
                return (
                  <TR key={m.id}>
                    <TD>{m.user.displayName}</TD>
                    <TD className="font-mono text-xs">{m.user.email}</TD>
                    <TD>
                      <Badge>{m.role}</Badge>
                    </TD>
                    <TD className="text-xs">
                      {m.user.isActive ? "active" : "deactivated"}
                    </TD>
                    <TD>
                      <MemberActions
                        membershipId={m.id}
                        currentRole={m.role}
                        canEdit={canEdit}
                        canRemove={canRemove}
                        callerIsOwner={callerIsOwner}
                      />
                    </TD>
                  </TR>
                );
              })}
            </TBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Forbidden({ reason }: { reason: string }) {
  return (
    <div className="mx-auto max-w-md p-8">
      <Card>
        <CardHeader>
          <CardTitle>Team management</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-600">{reason}</p>
        </CardContent>
      </Card>
    </div>
  );
}
