// Invite acceptance page.
//
// Flow:
//   1. Recipient follows /invites/accept?token=<token> from the email
//      (or a URL the admin pasted to them).
//   2. If not signed in, they're told to sign in with the invited
//      address first (Clerk middleware handles the bounce when Clerk
//      is enabled; the dev stub renders the message).
//   3. acceptInvite() (src/lib/team/accept-invite.ts) runs the state
//      machine — this page just maps outcomes to UI.
//   4. On acceptance: set the lc-tenant cookie to the new workspace
//      and land the user inside it.
//
// Server-rendered end to end; the token is single-use by virtue of the
// invite flipping to ACCEPTED.

import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { getCurrentUser } from "@/lib/auth/current-user";
import { TENANT_COOKIE_NAME } from "@/lib/auth/tenant";
import { acceptInvite } from "@/lib/team/accept-invite";
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
    return (
      <Failure
        title="Sign in to accept"
        detail="You need to be signed in to accept a workspace invite. Sign in (or sign up with the email the invite was sent to), then revisit this link."
      />
    );
  }

  const outcome = await acceptInvite(token, user);

  switch (outcome.kind) {
    case "accepted":
    case "already-member": {
      cookies().set(TENANT_COOKIE_NAME, outcome.tenantSlug, {
        path: "/",
        maxAge: 60 * 60 * 24 * 30,
        sameSite: "lax",
        httpOnly: false,
      });
      redirect("/");
    }
    // eslint-disable-next-line no-fallthrough -- redirect() never returns
    case "not-found":
      return (
        <Failure
          title="Invite not found"
          detail="The link you followed isn't a valid invite. Ask your workspace admin to send you a fresh one."
        />
      );
    case "already-used":
      return (
        <Failure
          title="Invite already used"
          detail="This invite link was already accepted by someone else. Ask your workspace admin for a fresh one."
        />
      );
    case "revoked":
      return (
        <Failure
          title="Invite revoked"
          detail="This invite was revoked before you accepted it. Ask your workspace admin to send a new one."
        />
      );
    case "expired":
      return (
        <Failure
          title="Invite expired"
          detail={`This invite expired on ${outcome.expiredOn}. Ask your workspace admin for a new one.`}
        />
      );
    case "email-mismatch":
      return (
        <Failure
          title="Email mismatch"
          detail={`This invite was sent to ${outcome.inviteEmail}, but you're signed in as ${user.email}. Sign in with the account the invite was addressed to.`}
        />
      );
  }
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
