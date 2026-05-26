import type { Metadata } from "next";
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
            <Sidebar isAdmin={isAdmin(currentUser)} />
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
                <p className="text-xs text-ink-500">
                  Scope: every report on this page is computed for the (entity, book) above.
                </p>
              </div>
              <div className="flex items-start gap-3">
                {currentUser && (
                  <NotificationBell
                    unread={notifications.unread}
                    recentRead={notifications.recentRead}
                    unreadCount={notifications.unreadCount}
                  />
                )}
                <div className="w-48">
                  <Card className="shadow-none">
                    <CardContent className="px-3 py-2">
                      {/* Renders nothing for single-tenant users. */}
                      <TenantSwitcher />
                    </CardContent>
                  </Card>
                </div>
                <div className="w-56">
                  <Card className="shadow-none">
                    <CardContent className="px-3 py-2">
                      <UserSwitcher currentUserId={currentUser?.id ?? null} options={users} />
                    </CardContent>
                  </Card>
                </div>
                <div className="w-64">
                  <Card className="shadow-none">
                    <CardContent className="px-3 py-3">
                      <BookSwitcher scope={scope} />
                    </CardContent>
                  </Card>
                </div>
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
