import type { Metadata } from "next";
import { Sidebar } from "@/components/nav/sidebar";
import { BookSwitcher } from "@/components/nav/book-switcher";
import { getScope } from "@/lib/scope";
import { Card, CardContent } from "@/components/ui/card";
import "./globals.css";

export const metadata: Metadata = {
  title: "ledger-core",
  description: "Universal accounting substrate — multi-book general ledger demo",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const scope = getScope();
  return (
    <html lang="en">
      <body>
        <div className="grid min-h-screen grid-cols-[260px_1fr] bg-ink-50">
          <aside className="border-r border-ink-200 bg-white">
            <Sidebar />
          </aside>
          <main className="flex flex-col">
            <header className="flex items-center justify-between border-b border-ink-200 bg-white px-8 py-3">
              <div>
                <h1 className="text-lg font-semibold text-ink-900">
                  {scope.entityCode} <span className="text-ink-400">/</span>{" "}
                  <span className="text-ink-700">{scope.bookCode}</span>
                </h1>
                <p className="text-xs text-ink-500">
                  Scope: every report on this page is computed for the (entity, book) above.
                </p>
              </div>
              <div className="w-64">
                <Card className="shadow-none">
                  <CardContent className="px-3 py-3">
                    <BookSwitcher scope={scope} />
                  </CardContent>
                </Card>
              </div>
            </header>
            <div className="flex-1 overflow-y-auto px-8 py-6">{children}</div>
          </main>
        </div>
      </body>
    </html>
  );
}
