// Invite acceptance page.
//
// Flow:
//   1. User receives an invite URL: /invites/accept?token=<token>
//   2. They click through. If not signed in, Clerk middleware bounces
//      them to /sign-in (with a return URL); they sign up or sign in,
//      then come back.
//   3. This page verifies:
//        - the token exists, status is PENDING, not expired
//        - the signed-in user's email matches the invite email
//      Both must hold or the page refuses with a clear error.
//   4. On match: create the TenantMembership (or skip if already exists),
//      mark the invite ACCEPTED, set the lc-tenant cookie to the new
//      tenant, redirect to /.
//
// The whole flow is server-rendered + a Server Action — no client JS
// needed. The token in the URL is single-use by virtue of the invite
// flipping to ACCEPTED.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { TENANT_COOKIE_NAME } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface SearchParams {
  token?: string;
}

export default async function AcceptInvitePage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const token = searchParams.token?.trim() ?? "";
  if (!token) {
    return <Failure title="Missing token" detail="This invite link is malformed." />;
  }

  const user = await getCurrentUser();
  if (!user) {
    // Middleware should bounce to /sign-in before we get here when
    // Clerk is enabled. With the dev stub, render a message because
    // there's no sign-in flow to redirect to.
    return (
      <Failure
        title="Sign in to accept"
        detail="You need to be signed in to accept a workspace invite. Sign in (or sign up with the email the invite was sent to), then revisit this link."
      />
    );
  }

  const invite = await prisma.tenantInvite.findUnique({
    where: { token },
    include: { tenant: { select: { id: true, slug: true, name: true } } },
  });
  if (!invite) {
    return (
      <Failure
        title="Invite not found"
        detail="The link you followed isn't a valid invite. Ask your workspace admin to send you a fresh one."
      />
    );
  }
  if (invite.status === "ACCEPTED") {
    // Already accepted — short-circuit to membership existence check
    // and just route the user to the workspace if applicable.
    const existing = await prisma.tenantMembership.findFirst({
      where: { tenantId: invite.tenantId, userId: user.id },
      select: { id: true },
    });
    if (existing) {
      cookies().set(TENANT_COOKIE_NAME, invite.tenant.slug, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        httpOnly: false,
      });
      redirect("/");
    }
    return (
      <Failure
        title="Invite already used"
        detail="This invite link was already accepted by someone else. Ask your workspace admin for a fresh one."
      />
    );
  }
  if (invite.status === "REVOKED") {
    return (
      <Failure
        title="Invite revoked"
        detail="This invite was revoked before you accepted it. Ask your workspace admin to send a new one."
      />
    );
  }
  if (invite.expiresAt < new Date()) {
    // Lazy-expire: set status to EXPIRED on the way through so the
    // admin's invite list reflects reality without a background job.
    await prisma.tenantInvite.update({
      where: { id: invite.id },
      data: { status: "EXPIRED" },
    });
    return (
      <Failure
        title="Invite expired"
        detail={`This invite expired on ${invite.expiresAt.toISOString().slice(0, 10)}. Ask your workspace admin for a new one.`}
      />
    );
  }

  // Email match check — case-insensitive. The signed-in user MUST be
  // the same person the invite was sent to.
  if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
    return (
      <Failure
        title="Email mismatch"
        detail={`This invite was sent to ${invite.email}, but you're signed in as ${user.email}. Sign in with the right account.`}
      />
    );
  }

  // All checks passed — accept the invite atomically.
  await prisma.$transaction(async (tx) => {
    // Use upsert so a rare race (user double-clicks the link) doesn't
    // throw a unique-constraint violation on (tenantId, userId).
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
    actor: user,
    tenantId: invite.tenantId,
    action: "team.accept_invite",
    resource: "TenantInvite",
    resourceId: invite.id,
    metadata: { role: invite.role },
  });

  // Set the active-tenant cookie so the next page load lands inside
  // the workspace they just joined.
  cookies().set(TENANT_COOKIE_NAME, invite.tenant.slug, {
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
    sameSite: "lax",
    httpOnly: false,
  });

  redirect("/");
}

function Failure({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="mx-auto max-w-md p-8">
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-ink-600">{detail}</p>
        </CardContent>
      </Card>
    </div>
  );
}
