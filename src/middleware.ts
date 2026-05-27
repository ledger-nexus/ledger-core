// Next.js middleware — wires Clerk auth at the edge when CLERK_SECRET_KEY
// is set; otherwise a no-op pass-through.
//
// Clerk's middleware intercepts every request to attach session info
// before route handlers + server components run. Without it, currentUser()
// inside the Clerk SDK returns null.
//
// Public routes (no auth required):
//   - /sign-in, /sign-up (Clerk's hosted UI)
//   - /api/internal/* (gated by INTERNAL_API_TOKEN, not session auth)
//   - /api/health (uptime probe)
//
// Everything else: signed-in users only when Clerk is enabled.
//
// When Clerk is NOT enabled (dev / tests), we export a no-op middleware
// so the Next.js build still produces a valid output. The dev cookie
// stub is still used by getCurrentUser in that case.
//
// SECURITY (pen-test pass 4 follow-up): in production, if Clerk env is
// missing we refuse every non-public route with 503. ledger-core's
// fallback auth path is a signed `lc-user` cookie set by
// setCurrentUserAction — an action that lets any caller impersonate
// any user (intentional in dev for the UserSwitcher dropdown). Without
// the prod fail-closed gate, an unset CLERK_SECRET_KEY in prod would
// leave that impersonation surface exposed.

import { NextResponse, type NextRequest } from "next/server";

const isClerkEnabled = () => {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
};

const isProd = () => process.env.NODE_ENV === "production";

// Routes that don't require sign-in even when Clerk is on.
//
// Note: /onboarding IS sign-in-required (you need to be a signed-in
// User to create a Tenant). It's NOT in this list — middleware will
// redirect unauthenticated users to /sign-in first. The page itself
// then handles the "signed-in but no memberships" case.
const PUBLIC_PATH_PATTERNS: RegExp[] = [
  /^\/sign-in(\/.*)?$/,
  /^\/sign-up(\/.*)?$/,
  /^\/api\/internal\//,
  /^\/api\/health$/,
  /^\/_next\//,
  /^\/favicon\.ico$/,
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATH_PATTERNS.some((re) => re.test(pathname));
}

export default async function middleware(req: NextRequest) {
  if (!isClerkEnabled()) {
    // Fail closed in production. Dev / CI without Clerk passes through
    // so local work doesn't require Clerk credentials, but the moment
    // prod is missing CLERK_SECRET_KEY, every non-public request
    // returns 503 — closing the dev-impersonation cookie path that
    // would otherwise be reachable.
    if (isProd() && !isPublic(req.nextUrl.pathname)) {
      return NextResponse.json(
        {
          ok: false,
          error:
            "Auth is not configured in this environment (CLERK_SECRET_KEY missing). Refusing to serve requests.",
        },
        { status: 503 }
      );
    }
    return NextResponse.next();
  }

  // Lazy-import Clerk so we don't pay for it when stub path is active.
  const { clerkMiddleware, createRouteMatcher } = await import(
    "@clerk/nextjs/server"
  );
  const isPublicRoute = createRouteMatcher([
    "/sign-in(.*)",
    "/sign-up(.*)",
    "/api/internal/(.*)",
    "/api/health",
  ]);

  // Wrap the Clerk handler so we can run additional logic (like the
  // public-route bypass) without dropping Clerk's session attachment.
  return clerkMiddleware(async (auth, request) => {
    if (isPublicRoute(request)) return;
    // Protect everything else. Unsigned-in users are redirected to /sign-in.
    await auth.protect();
  })(req, { waitUntil: () => {} } as never);
}

export const config = {
  // Match every route EXCEPT static asset paths. Standard Clerk matcher.
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};

// Re-export the public-path check so unit tests can verify the list
// without instantiating Clerk.
export const _internal = { isPublic, PUBLIC_PATH_PATTERNS };
