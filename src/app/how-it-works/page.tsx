// /how-it-works — the product-tour gallery. The one page a prospect
// sees before having an account (public in middleware; everything else
// fails closed when Clerk is on).
//
// Tours are tourkit captures: screenshots of the seeded Northwind demo
// tenant with click hotspots, played by the vendored zero-dependency
// <tour-player> web component (public/vendor/tour-player.js — single
// file, no framework, no network beyond its own assets). Frames are
// PUBLISHED MARKETING ASSETS: captured only against synthetic seed
// data, OCR-scanned for real names before commit, dev chrome hidden
// via HIDE_DEV_CHROME (see flows/ledger/).
//
// DARK until the frames pass review: noindex + no nav entry. The flip
// is deliberately a separate one-line change (drop the robots block,
// add a catalog row).

import { headers } from "next/headers";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "How it works — ledger-core",
  description:
    "A guided tour of the month-end close in ledger-core: close dashboard, task calendar, reconciliation sign-off, and the month-end review packet.",
  // Indexable as of the frame review. This is the only route in the app
  // that should be — see src/app/robots.ts.
  //
  // metadataBase resolves the canonical and OG URLs to absolute. Without
  // it Next emits `<link rel="canonical" href="/how-it-works">`, which is
  // relative and therefore useless to a crawler — a canonical tag that
  // does not name an origin cannot deduplicate anything. Undefined when
  // APP_BASE_URL is unset, which is the same condition that empties the
  // sitemap; both are inert together rather than half-configured.
  metadataBase: process.env.APP_BASE_URL
    ? new URL(process.env.APP_BASE_URL)
    : undefined,
  alternates: { canonical: "/how-it-works" },
  openGraph: {
    title: "See the close, before you sign up",
    description:
      "A two-minute guided walkthrough of a real month-end close in ledger-core.",
    type: "website",
  },
};

export default function HowItWorksPage() {
  // The middleware CSP is nonce + strict-dynamic; an un-nonced script
  // tag would be blocked. The nonce rides in on the x-nonce request
  // header set by src/middleware.ts.
  const nonce = headers().get("x-nonce") ?? undefined;

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-6 py-12">
      <header className="max-w-2xl">
        <h1 className="font-display text-3xl font-bold tracking-tight text-ink-900">
          See the close, before you sign up
        </h1>
        <p className="mt-3 text-base text-ink-600">
          A two-minute guided walkthrough of a real month-end close in
          ledger-core — the close dashboard, the task calendar, reconciliation
          sign-off, and the review packet your reviewer actually reads. Every
          screen is the product, running on demo data.
        </p>
      </header>

      <section aria-label="Guided tour: month-end close">
        <div className="overflow-hidden rounded-xl border border-ink-200 bg-white">
          {/* Web component; attributes are its public API. React renders
              unknown elements verbatim, so no client wrapper is needed. */}
          <tour-player src="/tours/month-end-close/tour.json" />
        </div>
        <p className="mt-2 text-xs text-ink-500">
          Use ←/→ or click the highlighted areas to move through the tour.
        </p>
      </section>

      <script type="module" src="/vendor/tour-player.js" nonce={nonce} />
    </div>
  );
}
