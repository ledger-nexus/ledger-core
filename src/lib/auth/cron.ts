// Cron-route authentication.
//
// Cron routes run unattended and need their own auth path — no
// cookie session, no Clerk JWT. We accept a shared secret in either:
//   - `Authorization: Bearer <CRON_SECRET>` (Vercel cron default)
//   - `?cron_secret=<CRON_SECRET>` (manual triggering / smoke tests)
//
// The check is timing-safe (constant-time equality). The fail mode
// is "return false" — the caller writes the 403 + audit row so the
// authentication signal is consistent across routes.

import { timingSafeEqual } from "crypto";

/**
 * Validates the cron secret on an incoming Request. Returns true on
 * match, false on mismatch or missing CRON_SECRET env. Never throws —
 * cron routes are unattended and an exception would surface as a 500
 * instead of an auditable 403.
 *
 * Missing CRON_SECRET env returns false (fail-closed). Operators
 * who haven't set the secret get a clear permission-denied response
 * rather than accidental unauthenticated access.
 */
export function isAuthorizedCronRequest(req: Request): boolean {
  const expected = process.env.CRON_SECRET;
  if (!expected || expected.length < 16) return false;

  // Header takes precedence over query string — Vercel injects the
  // header automatically when the cron job fires.
  const authHeader = req.headers.get("authorization");
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match && timingSafeEqualString(match[1].trim(), expected)) {
      return true;
    }
  }

  const url = new URL(req.url);
  const fromQuery = url.searchParams.get("cron_secret");
  if (fromQuery && timingSafeEqualString(fromQuery, expected)) {
    return true;
  }

  return false;
}

/**
 * Constant-time string comparison. Length-aware so mismatched-length
 * inputs return false without throwing (timingSafeEqual itself
 * throws when buffer lengths differ).
 */
function timingSafeEqualString(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
