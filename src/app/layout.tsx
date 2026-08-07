import type { Metadata } from "next";
import { Outfit } from "next/font/google";
import { headers } from "next/headers";
import Link from "next/link";
import { CommandPalette, CommandPaletteHint } from "@/components/nav/command-palette";
import { Sidebar } from "@/components/nav/sidebar";
import { BookSwitcher } from "@/components/nav/book-switcher";
import { UserSwitcher } from "@/components/nav/user-switcher";
import { NotificationBell } from "@/components/nav/notification-bell";
import { TenantSwitcher } from "@/components/nav/tenant-switcher";
import { getCurrentScope, DEFAULT_SCOPE } from "@/lib/scope";
import { getCurrentUser } from "@/lib/auth/current-user";
import { canViewAdminPages } from "@/lib/auth/policy";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { isClerkEnabled } from "@/lib/auth/clerk";
import { getRecentNotifications } from "@/lib/notifications";
import { prisma } from "@/lib/db";
import { Card, CardContent } from "@/components/ui/card";
import "./globals.css";

// Display face — headings only (see tailwind fontFamily.display). Body
// text stays on the system stack for speed and data density. next/font
// self-hosts at build time; the CSS variable scopes it to font-display
// utilities with graceful system-ui fallback.
const outfit = Outfit({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "ledger-core",
  description: "Universal accounting substrate — multi-book general ledger demo",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // The user switcher is the LOCAL-DEV auth stub (impersonate any seeded
  // user). Under Clerk (production auth) it must not exist — and we must
  // NOT fetch the global user list at all, or every tenant's user ids,
  // names, and emails would be serialized into the client bundle. Only
  // query it in dev-stub mode.
  const clerkOn = isClerkEnabled();
  const [currentUser, currentTenant, users, resolvedScope] = await Promise.all([
    getCurrentUser(),
    getCurrentTenant(),
    clerkOn
      ? Promise.resolve<{ id: string; email: string; displayName: string }[]>([])
      : prisma.user.findMany({
          where: { isActive: true },
          select: { id: true, email: true, displayName: true },
          orderBy: { displayName: "asc" },
        }),
    getCurrentScope(),
  ]);
  // Chrome (header label + book switcher) falls back to the seed default
  // when there's no resolved scope (signed out / mid-onboarding). This
  // replaces the raw getScope() cookie read — display only; every data
  // read is tenant-pinned on resolvedScope below.
  const scope = resolvedScope ?? DEFAULT_SCOPE;
  // Notifications are user-scoped — empty when there's no logged-in user.
  const notifications = currentUser
    ? await getRecentNotifications(prisma, currentUser.id)
    : { unread: [], recentRead: [], unreadCount: 0 };
  // Bank-feed pull for the sidebar badge — the one number worth ambient
  // chrome space (the daily loop). Cheap: leading columns of the
  // (tenantId, entityId, bookId, bankAccountId, status) index.
  const reviewCount = resolvedScope
    ? await prisma.bankTransaction.count({
        where: {
          tenantId: resolvedScope.tenantId,
          entityId: resolvedScope.entityId,
          book: { code: resolvedScope.bookCode },
          status: "FOR_REVIEW",
        },
      })
    : 0;
  // The public tour gallery renders WITHOUT the app shell: a signed-out
  // prospect must not see the sidebar, switchers, or notification chrome
  // wrapped around marketing content. Middleware stamps x-pathname
  // (overwriting any client-supplied value) for exactly this branch.
  // A full route-group restructure would be the textbook shape, but it
  // moves every route file for the sake of one public page.
  const pathname = headers().get("x-pathname") ?? "";
  if (pathname === "/how-it-works") {
    return (
      <html lang="en" className={outfit.variable}>
        <body className="bg-ink-50">{children}</body>
      </html>
    );
  }

  // Conditionally wrap the app in ClerkProvider. We can't statically
  // import ClerkProvider at module scope because Clerk would try to
  // evaluate publishable key from env at build time even when unused.
  // The lazy import below is rendered once per request — Next.js
  // dedupes at the React level.
  const tree = (
    <html lang="en" className={outfit.variable}>
      <body>
        <div className="grid min-h-screen grid-cols-[260px_1fr] bg-ink-50">
          <aside className="border-r border-ink-200 bg-white">
            <Sidebar isAdmin={canViewAdminPages(currentTenant?.role)} reviewCount={reviewCount} />
          </aside>
          <main className="flex flex-col">
            <header className="flex items-center justify-between border-b border-ink-200 bg-white px-8 py-3">
              {/* Context line, not a title — page h1s own the hierarchy now.
                  Single line, truncates instead of wrapping into the controls. */}
              <div className="min-w-0">
                <h1 className="truncate whitespace-nowrap text-sm font-medium text-ink-900">
                  {currentTenant && (
                    <>
                      <span className="text-ink-500">{currentTenant.name}</span>
                      <span className="mx-2 text-ink-300">·</span>
                    </>
                  )}
                  {scope.entityCode} <span className="text-ink-500">/</span>{" "}
                  <span className="text-ink-700">{scope.bookCode}</span>
                </h1>
              </div>
              <div className="flex items-center gap-2">
                <CommandPaletteHint />
                <Link
                  href="/ask"
                  title="Ask your ledger — plain-English questions, read-only"
                  className="flex h-9 items-center gap-1.5 rounded-full border border-ink-300 bg-white px-3.5 text-sm font-medium text-ink-900 hover:border-ink-900 hover:bg-ink-50"
                >
                  <span aria-hidden="true">✦</span>
                  <span>Ask</span>
                </Link>
                {currentUser && (
                  <NotificationBell
                    unread={notifications.unread}
                    recentRead={notifications.recentRead}
                    unreadCount={notifications.unreadCount}
                  />
                )}
                {/* Each switcher owns its own Card so it can render
                    nothing at all when there's nothing to switch. */}
                <TenantSwitcher />
                {/* Dev-stub user switcher only — hidden entirely under Clerk,
                    where impersonating another account is not a thing and the
                    user list isn't fetched. Also hidden under HIDE_DEV_CHROME:
                    tour frames are published marketing assets, and a card
                    labeled DEV AUTH STUB baked into every screenshot is the
                    ledger-core equivalent of the dev N-badge that forced a
                    full RevRec recapture. Set HIDE_DEV_CHROME=1 in .env only
                    for a capture run. */}
                {!clerkOn && process.env.HIDE_DEV_CHROME !== "1" && (
                  <div className="w-56">
                    <Card className="shadow-none">
                      <CardContent className="px-3 py-2">
                        <UserSwitcher currentUserId={currentUser?.id ?? null} options={users} />
                      </CardContent>
                    </Card>
                  </div>
                )}
                <BookSwitcher scope={scope} />
              </div>
            </header>
            <div className="flex-1 overflow-y-auto px-8 py-6">{children}</div>
          </main>
          {/* Global ⌘K palette — mounted once, reachable from every page. */}
          <CommandPalette isAdmin={canViewAdminPages(currentTenant?.role)} reviewCount={reviewCount} />
        </div>
      </body>
    </html>
  );

  if (isClerkEnabled()) {
    // Dynamic import so the Clerk package is only loaded when configured.
    const { ClerkProvider } = await import("@clerk/nextjs");
    return <ClerkProvider>{tree}</ClerkProvider>;
  }
  return tree;
}
