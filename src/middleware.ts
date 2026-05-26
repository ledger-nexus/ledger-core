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

import { NextResponse, type NextRequest } from "next/server";

const isClerkEnabled = () => {
  const k = process.env.CLERK_SECRET_KEY;
  return k != null && k.length > 0;
};

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
