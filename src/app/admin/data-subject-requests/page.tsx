// GDPR data-subject-request console.
//
// Privacy TSC + risk-register item #16. OWNER-only surface for
// handling Art. 15 (access) and Art. 17 (erasure) requests. Members
// of the tenant can self-export from /admin/data-subject-requests
// without OWNER assistance; erasure always requires OWNER.

import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { prisma } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { DataSubjectActions } from "./data-subject-actions";

export const dynamic = "force-dynamic";

export default async function DataSubjectRequestsPage() {
  const user = await getCurrentUser();
  if (!user) return <Forbidden reason={new NotAuthenticatedError().message} />;
  const tenant = await getCurrentTenant();
  if (!tenant)
    return <Forbidden reason="Pick a workspace via the tenant switcher first." />;

  // The page itself is visible to any tenant member (so a user can
  // self-export). Erasure UI is gated to OWNER inside the actions
  // component.
  const members = await prisma.tenantMembership.findMany({
    where: { tenantId: tenant.id },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          isActive: true,
          deactivatedAt: true,
        },
      },
    },
    orderBy: [{ role: "asc" }, { user: { email: "asc" } }],
  });

  const isOwner = tenant.role === "OWNER";

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">
          Data subject requests
        </h2>
        <p className="text-xs text-ink-500 max-w-prose">
          GDPR Art. 15 (right of access) and Art. 17 (right to erasure)
          handling for{" "}
          <span className="font-mono">{tenant.slug}</span>. Self-export
          is available to any member; erasure requires the OWNER. Financial
          records (journal entries, audit log entries) are NOT deleted —
          legal-retention exemption applies. Only PII fields on the User
          row and email-delivery records get redacted.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Quick self-export</CardTitle>
          <span className="text-xs text-ink-500">
            Download a JSON bundle of everything attributable to your account.
          </span>
        </CardHeader>
        <CardContent>
          <DataSubjectActions
            subjectUserId={user.id}
            subjectEmail={user.email}
            subjectDisplayName={user.displayName}
            isSelf
            canErase={false}
            isOwnerRole={isOwner}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Members ({members.length})</CardTitle>
          <span className="text-xs text-ink-500">
            {isOwner
              ? "As OWNER you can export or erase any member. Erasure is irreversible."
              : "ADMIN+ can export other members' data. Erasure requires OWNER."}
          </span>
        </CardHeader>
        <CardContent>
          {members.length === 0 ? (
            <EmptyState title="No members yet" />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>User</TH>
                  <TH>Role</TH>
                  <TH>Status</TH>
                  <TH className="w-72">Actions</TH>
                </TR>
              </THead>
              <TBody>
                {members.map((m) => {
                  const redacted = m.user.email.startsWith("redacted-");
                  return (
                    <TR key={m.id}>
                      <TD>
                        <div className="text-sm text-ink-900">
                          {redacted ? (
                            <span className="text-ink-500 italic">
                              [Redacted user]
                            </span>
                          ) : (
                            m.user.displayName
                          )}
                        </div>
                        <div className="text-[11px] text-ink-500 font-mono">
                          {redacted ? "—" : m.user.email}
                        </div>
                      </TD>
                      <TD>
                        <Badge tone="neutral">{m.role}</Badge>
                      </TD>
                      <TD>
                        {redacted ? (
                          <Badge tone="negative">Erased</Badge>
                        ) : m.user.isActive ? (
                          <Badge tone="positive">Active</Badge>
                        ) : (
                          <Badge tone="warning">Inactive</Badge>
                        )}
                      </TD>
                      <TD>
                        {redacted ? (
                          <span className="text-[11px] text-ink-500">
                            PII already removed
                          </span>
                        ) : (
                          <DataSubjectActions
                            subjectUserId={m.user.id}
                            subjectEmail={m.user.email}
                            subjectDisplayName={m.user.displayName}
                            isSelf={m.user.id === user.id}
                            canErase={isOwner && m.user.id !== user.id}
                            isOwnerRole={isOwner}
                          />
                        )}
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
    <div className="flex flex-col gap-4">
      <h2 className="text-xl font-semibold text-ink-900">
        Data subject requests
      </h2>
      <EmptyState title="Not available" description={reason} />
    </div>
  );
}
