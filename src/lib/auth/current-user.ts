// Dev-only auth stub.
//
// ⚠️  This is NOT production authentication. It's a thin scaffolding that
// lets the ownership + rules-engine UI work realistically in dev without
// requiring a full NextAuth / WorkOS / Clerk integration. The cookie is
// HTTP-only and signed with an HMAC so it can't be trivially forged from
// the browser, but it's a SHARED-SECRET signature, not session-token-based
// auth. Real auth is a separate multi-week project.
//
// What's here:
//   - getCurrentUser(): Promise<CurrentUser | null> — read the cookie,
//     verify the HMAC, query the User table, return the user
//   - setCurrentUser(userId): Server Action writes the cookie
//   - clearCurrentUser(): Server Action wipes it
//
// Cookie shape: "<userId>.<hmac>" — userId is plaintext (it's a UUID, not
// sensitive); HMAC prevents tampering. Set via Server Actions only;
// HTTP-only so JS can't read it.
//
// When real auth lands:
//   - Replace this module's body, NOT its exports
//   - Server Actions that import `getCurrentUser` keep working
//   - Test users in the seed become real users (or get removed)

import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db";

const COOKIE_NAME = "lc-user";

export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
}

// HMAC secret — pulled from env. In dev defaults to a deterministic but
// non-trivial value so the cookie survives server restarts. In production
// MUST be set explicitly.
function getSecret(): string {
  const s = process.env.AUTH_STUB_SECRET;
  if (s && s.length >= 16) return s;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "AUTH_STUB_SECRET env var is required in production (min 16 chars)"
    );
  }
  // Dev fallback — predictable but not trivially guessable.
  return "dev-only-stub-secret-replace-with-real-auth";
}

function sign(userId: string): string {
  const h = createHmac("sha256", getSecret());
  h.update(userId);
  return h.digest("hex").slice(0, 16); // 16 hex chars = 64 bits of integrity
}

function verify(userId: string, mac: string): boolean {
  const expected = sign(userId);
  if (expected.length !== mac.length) return false;
  try {
    return timingSafeEqual(Buffer.from(expected), Buffer.from(mac));
  } catch {
    return false;
  }
}

function parseCookie(raw: string | undefined): string | null {
  if (!raw) return null;
  const dot = raw.indexOf(".");
  if (dot < 0) return null;
  const userId = raw.slice(0, dot);
  const mac = raw.slice(dot + 1);
  if (!userId || !mac) return null;
  if (!verify(userId, mac)) return null;
  return userId;
}

/**
 * Read the current user. Two implementations, selected at runtime:
 *
 *   - When CLERK_SECRET_KEY is set: delegate to the Clerk-backed
 *     implementation in ./clerk.ts. Identity comes from Clerk; the
 *     User row is upserted by email on first contact.
 *
 *   - Otherwise: the HMAC-signed dev cookie path below. Used in tests,
 *     local dev without Clerk credentials, and during the migration
 *     window before Clerk is provisioned for a given environment.
 *
 * The interface (CurrentUser shape, null-when-signed-out contract) is
 * identical across both paths. Callers shouldn't care which is active.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  // Lazy-evaluate the env check on every call (not module-load) so a
  // test that swaps the env mid-suite picks up the new path.
  const { isClerkEnabled, getCurrentUserFromClerk } = await import("./clerk");
  if (isClerkEnabled()) {
    return getCurrentUserFromClerk();
  }

  // Dev-cookie stub path.
  const raw = cookies().get(COOKIE_NAME)?.value;
  const userId = parseCookie(raw);
  if (!userId) return null;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, email: true, displayName: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return { id: user.id, email: user.email, displayName: user.displayName };
}

/**
 * Server-Action helper for routes that REQUIRE a logged-in user. Throws
 * a structured error the caller's Server Action surfaces as ok:false.
 */
export class NotAuthenticatedError extends Error {
  constructor() {
    super("Not authenticated — sign in (or pick a test user) first");
    this.name = "NotAuthenticatedError";
  }
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const u = await getCurrentUser();
  if (!u) throw new NotAuthenticatedError();
  return u;
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin authorization moved to per-tenant RBAC.
// ─────────────────────────────────────────────────────────────────────────────
//
// The email-allowlist isAdmin()/requireAdmin() that used to live here is
// retired. Admin is a fact about your TenantMembership.role in the current
// tenant, not about your email:
//
//   - Server Actions / routes: `requirePermitted(permission, canX)` from
//     ./authorize.ts — resolves session + tenant, audits denials, throws.
//   - Server Components: `getViewerRole()` from ./authorize.ts, fed to the
//     named `can*` helpers in ./policy.ts.

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers shared with the set-user Server Action.
// ─────────────────────────────────────────────────────────────────────────────

export const _internal = {
  cookieName: COOKIE_NAME,
  encode: (userId: string): string => `${userId}.${sign(userId)}`,
  parseCookie,
  sign,
  verify,
};
