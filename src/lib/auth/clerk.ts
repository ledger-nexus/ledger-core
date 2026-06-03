// Clerk-backed implementation of the auth interface.
//
// Activated when CLERK_SECRET_KEY is set in the environment. When unset,
// the dev cookie stub in current-user.ts continues to serve auth requests.
// This env-gated dispatch lets:
//   - Production deploys flip to Clerk by setting two env vars (publishable
//     + secret) without code changes.
//   - Local dev keep using the stub (no Clerk account required).
//   - Tests continue using the HMAC encode helper they were built against.
//
// JIT user provisioning: on first sign-in via Clerk, we upsert an
// app_user row keyed by email (the User table's natural key in this
// substrate). This means existing seed users (controller@northwind.test
// etc.) get linked to their Clerk identity the first time someone signs
// in with that email through Clerk. Clerk owns identity; this substrate
// owns the user → tenant mappings.
//
// See docs/auth-swap.md for the long-form rationale and docs/multi-tenancy.md
// for how tenant membership is resolved after auth.

import type { CurrentUser } from "./current-user";
import { prisma } from "@/lib/db";
import { emailLookupKeyForUser } from "@/lib/soc2";

/**
 * Read the current Clerk session, look up (or JIT-create) the matching
 * app_user row by email, and return the CurrentUser shape. Returns null
 * when no Clerk session is present (signed out) or the user is inactive.
 *
 * Throws only if Clerk's SDK throws an actual error (network, config) —
 * NOT for the signed-out case (returns null).
 */
export async function getCurrentUserFromClerk(): Promise<CurrentUser | null> {
  // Lazy-import @clerk/nextjs so the stub path doesn't pay for it.
  // Also lets the module compile when Clerk isn't installed (during the
  // brief windows when this file ships before the dependency does).
  const clerk = await import("@clerk/nextjs/server").catch(() => null);
  if (!clerk) {
    console.warn(
      "[auth/clerk] @clerk/nextjs/server module not resolvable; " +
        "falling back to null user. Install @clerk/nextjs to enable Clerk auth."
    );
    return null;
  }

  // currentUser() returns null when no session is present (i.e. signed out).
  const clerkUser = await clerk.currentUser();
  if (!clerkUser) return null;

  // Clerk identifies users by Clerk's own ID; our DB User table keys on
  // email. Pull the primary email; if none, treat as unauthenticated.
  const email = clerkUser.primaryEmailAddress?.emailAddress?.toLowerCase();
  if (!email) {
    console.warn(
      `[auth/clerk] Clerk user ${clerkUser.id} has no primaryEmailAddress; ` +
        "treating as signed out."
    );
    return null;
  }

  // Display name: prefer "First Last", fall back to email.
  const displayName =
    [clerkUser.firstName, clerkUser.lastName]
      .filter(Boolean)
      .join(" ")
      .trim() || email;

  // Upsert by emailHash so existing seed users get linked, and new
  // sign-ups get an app_user row. The User.email column is encrypted
  // at rest (random IV — same plaintext → different ciphertext every
  // write), so we can't match by email directly. The deterministic
  // emailHash gives us idempotency. The extension auto-populates the
  // emailHash on write from the email we pass in `create`/`update`.
  const dbUser = await prisma.user.upsert({
    where: { emailHash: emailLookupKeyForUser(email) },
    create: { email, displayName, isActive: true },
    // On re-sign-in, reactivate (a deactivated user re-signing-in via
    // Clerk shouldn't be silently locked out — but we audit-log this
    // implicitly via the auditLogin call sites in the layout).
    update: { isActive: true, displayName },
  });

  if (!dbUser.isActive) return null;

  return {
    id: dbUser.id,
    email: dbUser.email,
    displayName: dbUser.displayName,
  };
}

/**
 * Returns true when Clerk auth is enabled for the current process —
 * i.e. CLERK_SECRET_KEY is set. Callers use this to choose between
 * the stub path and the Clerk path.
 *
 * Single source of truth so we don't drift between "is Clerk on?"
 * checks across the codebase.
 */
export function isClerkEnabled(): boolean {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
}
