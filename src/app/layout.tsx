import type { Metadata } from "next";
import Link from "next/link";
import { Sidebar } from "@/components/nav/sidebar";
import { BookSwitcher } from "@/components/nav/book-switcher";
import { UserSwitcher } from "@/components/nav/user-switcher";
import { NotificationBell } from "@/components/nav/notification-bell";
import { TenantSwitcher } from "@/components/nav/tenant-switcher";
import { getScope } from "@/lib/scope";
import { getCurrentUser, isAdmin } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { isClerkEnabled } from "@/lib/auth/clerk";
import { getRecentNotifications } from "@/lib/notifications";
import { prisma } from "@/lib/db";
import { Card, CardContent } from "@/components/ui/card";
import "./globals.css";

export const metadata: Metadata = {
  title: "ledger-core",
  description: "Universal accounting substrate — multi-book general ledger demo",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const scope = getScope();
  const [currentUser, currentTenant, users] = await Promise.all([
    getCurrentUser(),
    getCurrentTenant(),
    prisma.user.findMany({
      where: { isActive: true },
      select: { id: true, email: true, displayName: true },
      orderBy: { displayName: "asc" },
    }),
  ]);
  // Notifications are user-scoped — empty when there's no logged-in user.
  const notifications = currentUser
    ? await getRecentNotifications(prisma, currentUser.id)
    : { unread: [], recentRead: [], unreadCount: 0 };
  // Bank-feed pull for the sidebar badge — the one number worth ambient
  // chrome space (the daily loop). Cheap: leading columns of the
  // (tenantId, entityId, bookId, bankAccountId, status) index.
  const reviewCount = currentTenant
    ? await prisma.bankTransaction.count({
        where: {
          tenantId: currentTenant.id,
          entity: { code: scope.entityCode },
          book: { code: scope.bookCode },
          status: "FOR_REVIEW",
        },
      })
    : 0;
  // Conditionally wrap the app in ClerkProvider. We can't statically
  // import ClerkProvider at module scope because Clerk would try to
  // evaluate publishable key from env at build time even when unused.
  // The lazy import below is rendered once per request — Next.js
  // dedupes at the React level.
  const tree = (
    <html lang="en">
      <body>
        <div className="grid min-h-screen grid-cols-[260px_1fr] bg-ink-50">
          <aside className="border-r border-ink-200 bg-white">
            <Sidebar isAdmin={isAdmin(currentUser)} reviewCount={reviewCount} />
          </aside>
          <main className="flex flex-col">
            <header className="flex items-center justify-between border-b border-ink-200 bg-white px-8 py-3">
              <div>
                <h1 className="text-lg font-semibold text-ink-900">
                  {currentTenant && (
                    <>
                      <span className="text-ink-500">{currentTenant.name}</span>
                      <span className="mx-2 text-ink-300">·</span>
                    </>
                  )}
                  {scope.entityCode} <span className="text-ink-400">/</span>{" "}
                  <span className="text-ink-700">{scope.bookCode}</span>
                </h1>
              </div>
              <div className="flex items-start gap-3">
                <Link
                  href="/ask"
                  title="Ask your ledger — plain-English questions, read-only"
                  className="flex h-9 items-center gap-1.5 rounded-md border border-ink-300 bg-white px-3 text-sm font-medium text-ink-900 transition-colors hover:border-ink-900 hover:bg-ink-50"
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
                <div className="w-56">
                  <Card className="shadow-none">
                    <CardContent className="px-3 py-2">
                      <UserSwitcher currentUserId={currentUser?.id ?? null} options={users} />
                    </CardContent>
                  </Card>
                </div>
                <BookSwitcher scope={scope} />
              </div>
            </header>
            <div className="flex-1 overflow-y-auto px-8 py-6">{children}</div>
          </main>
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
