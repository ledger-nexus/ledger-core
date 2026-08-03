import type { MetadataRoute } from "next";

// Sitemap — public routes only.
//
// Almost every route in this app is auth-gated and returns 503 in
// production without Clerk (see src/middleware.ts), so listing them
// would advertise URLs a crawler can never fetch. The tour gallery is
// the one page meant to be found.
//
// /sitemap.xml is not matched by the middleware (config.matcher excludes
// any path containing a dot), so it is served without the fail-closed
// gate — which is what makes it reachable by a crawler at all.

export default function sitemap(): MetadataRoute.Sitemap {
  const base = process.env.APP_BASE_URL?.replace(/\/+$/, "");
  // Without an absolute origin a sitemap is meaningless — relative URLs
  // are invalid in the protocol. Emit nothing rather than something a
  // crawler will reject.
  if (!base) return [];

  return [
    {
      url: `${base}/how-it-works`,
      lastModified: new Date(),
      changeFrequency: "monthly",
      priority: 1,
    },
  ];
}
