import type { MetadataRoute } from "next";

// robots.txt — allow the tour gallery, disallow everything else.
//
// The app is already fail-closed for crawlers (every other route 503s in
// production without Clerk), so this is belt-and-braces rather than the
// control. It exists to state intent explicitly: one page is public, the
// ledger is not.
//
// Like /sitemap.xml, /robots.txt bypasses the middleware because
// config.matcher excludes paths containing a dot.

export default function robots(): MetadataRoute.Robots {
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");

  return {
    rules: {
      userAgent: "*",
      allow: "/how-it-works",
      disallow: "/",
    },
    ...(base ? { sitemap: `${base}/sitemap.xml` } : {}),
  };
}
