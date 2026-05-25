// Next.js config — common security headers for SOC 2 CC6/CC7.
//
// The headers below are applied to every route by Next's routing layer.
// They cover:
//   - HSTS: forces HTTPS for 1 year, including subdomains. Mitigates
//     SSL stripping / downgrade attacks.
//   - X-Frame-Options: prevents the app from being embedded in an
//     iframe (clickjacking defense). Strict deny because we don't have
//     legitimate cross-frame use cases.
//   - X-Content-Type-Options: prevents MIME-sniffing by browsers,
//     mitigates content-type confusion attacks.
//   - Referrer-Policy: leaks the origin but not the path on cross-origin
//     navigation. Privacy + reduces inadvertent disclosure of internal URLs.
//   - Permissions-Policy: disables browser features we don't use (camera,
//     microphone, geolocation, etc.). Reduces attack surface.
//
// Content-Security-Policy is INTENTIONALLY OMITTED here — getting CSP
// right with Next.js's inline scripts requires nonces or strict-dynamic,
// which is a larger surgery than these flat headers. Track as a v0.2
// follow-up; meanwhile the other headers cover the most-asked
// SOC 2-readiness items.

const securityHeaders = [
  {
    key: "Strict-Transport-Security",
    value: "max-age=31536000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async headers() {
    return [
      { source: "/(.*)", headers: securityHeaders },
    ];
  },
};

module.exports = nextConfig;
