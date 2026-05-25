// Clerk hosted sign-up page. Mirror of sign-in/page.tsx. After a
// successful sign-up, the user lands in the app with no tenant
// memberships — the layout / onboarding flow routes them to create
// their first Tenant (Phase 7).

import { isClerkEnabled } from "@/lib/auth/clerk";
import Link from "next/link";

export default async function SignUpPage() {
  if (!isClerkEnabled()) {
    return (
      <div className="mx-auto max-w-md p-8">
        <h1 className="text-xl font-semibold text-ink-900">Sign-up not configured</h1>
        <p className="mt-3 text-sm text-ink-600">
          This deployment uses the dev-cookie auth stub and does not have a
          public sign-up flow. New users are seeded via{" "}
          <code>src/lib/seed/</code> and selected from the user switcher.
        </p>
        <Link href="/" className="mt-6 inline-block text-sm text-blue-600 underline">
          ← Return to app
        </Link>
      </div>
    );
  }

  const { SignUp } = await import("@clerk/nextjs");
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50">
      <SignUp />
    </div>
  );
}
