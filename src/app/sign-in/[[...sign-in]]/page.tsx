// Clerk hosted sign-in page. The catch-all route segment [[...sign-in]]
// is Clerk's required convention so the embedded SignIn component can
// handle multi-step flows (password, email verification, MFA, etc.)
// without us defining each subroute.
//
// When Clerk is NOT enabled, this page renders a static notice — the
// dev-cookie stub doesn't have a sign-in flow (users pick from a list
// in the existing UserSwitcher).

import { isClerkEnabled } from "@/lib/auth/clerk";
import Link from "next/link";

export default async function SignInPage() {
  if (!isClerkEnabled()) {
    return (
      <div className="mx-auto max-w-md p-8">
        <h1 className="text-xl font-semibold text-ink-900">Sign-in not configured</h1>
        <p className="mt-3 text-sm text-ink-600">
          This deployment is running with the dev-cookie auth stub. Sign-in
          via Clerk requires <code>CLERK_SECRET_KEY</code> +{" "}
          <code>NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY</code> in the environment.
        </p>
        <p className="mt-3 text-sm text-ink-600">
          For local development, use the user switcher in the top-right of
          the app to pick a seeded test user.
        </p>
        <Link href="/" className="mt-6 inline-block text-sm text-blue-600 underline">
          ← Return to app
        </Link>
      </div>
    );
  }

  // Lazy-import Clerk's UI primitive so the bundle stays clean when
  // Clerk is off. SignIn is a Client Component under the hood, but
  // Clerk handles the boundary internally.
  const { SignIn } = await import("@clerk/nextjs");
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50">
      <SignIn />
    </div>
  );
}
