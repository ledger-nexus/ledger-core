// End-to-end smoke test for the DSR attribution loop.
//
// Exercises `buildUserDataExport({ internalApiToken })` against ALL
// FOUR running companion repos. Asserts:
//   1. The bundle comes back at schemaVersion 2.
//   2. Every companion section is `reachable: true` with a snapshotAt.
//   3. The serialized bundle contains no credentials-shaped or
//      contents-shaped strings (HARD INVARIANTS — Art. 15(4)
//      rights-of-others + counterparty PII carve-outs).
//
// This is an OPT-IN test. It's skipped unless:
//   - process.env.E2E_DSR_TEST === "1"        (the opt-in flag)
//   - process.env.INTERNAL_API_TOKEN          (the shared token)
//   - process.env.DATABASE_URL                (for ledger-core prisma)
//
// When skipped it doesn't fail CI. The intended runtime environment:
//
//   Terminal 1: cd ledger-core && pnpm dev                  # :3000
//   Terminal 2: cd recon && pnpm dev                        # :3001
//   Terminal 3: cd revenue-rec && pnpm dev                  # :3002
//   Terminal 4: cd integrations && pnpm dev                 # :3003
//   Terminal 5: cd fa-amort && pnpm dev                     # :3004
//   Terminal 6: cd ledger-core && \
//                 E2E_DSR_TEST=1 \
//                 INTERNAL_API_TOKEN=<the-shared-token> \
//                 pnpm vitest run tests/dsr-e2e-smoke.test.ts
//
// All five services must share the SAME INTERNAL_API_TOKEN env value.
// In production this is set once in the deployment env; in dev each
// repo's .env carries the same value.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildUserDataExport } from "../src/lib/privacy/user-data";

const OPT_IN = process.env.E2E_DSR_TEST === "1";
const TOKEN = process.env.INTERNAL_API_TOKEN;
const HAS_DB = !!process.env.DATABASE_URL;

const SKIP_REASON = !OPT_IN
  ? "E2E_DSR_TEST is not set to 1"
  : !TOKEN
  ? "INTERNAL_API_TOKEN is not set"
  : !HAS_DB
  ? "DATABASE_URL is not set"
  : null;

// Use the same defaults as companion-attribution.ts so the test
// matches what production code does. Override-able via env so a
// staging run can target real hostnames.
const COMPANION_URLS = {
  integrations:
    process.env.INTEGRATIONS_URL ?? "http://localhost:3003",
  recon: process.env.RECON_URL ?? "http://localhost:3001",
  faAmort: process.env.FA_AMORT_URL ?? "http://localhost:3004",
  revenueRec: process.env.REVENUE_REC_URL ?? "http://localhost:3002",
};

// Use any existing User from the shared DB so the bundle has a real
// subject. The test asserts nothing about the user's specific data —
// only the shape of the assembled bundle.
let prisma: PrismaClient;
let realUserId: string | null = null;

beforeAll(async () => {
  if (SKIP_REASON) return;
  prisma = new PrismaClient();
  const someUser = await prisma.user.findFirst({ select: { id: true } });
  if (!someUser) {
    throw new Error(
      "No User in DB. Seed at least one user before running this test."
    );
  }
  realUserId = someUser.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

describe.skipIf(SKIP_REASON !== null)(
  "DSR e2e smoke — buildUserDataExport against real companions",
  () => {
    it(
      `(skip reason if any: ${SKIP_REASON ?? "none"}) returns schemaVersion 2 bundle with all four companions reachable`,
      async () => {
        if (!realUserId || !TOKEN) {
          // skipIf already handled this; defensive guard for tsc.
          return;
        }

        const bundle = await buildUserDataExport(prisma, realUserId, {
          internalApiToken: TOKEN,
        });

        expect(bundle.schemaVersion).toBe(2);
        expect(bundle.companionAttribution).toBeDefined();

        const ca = bundle.companionAttribution!;
        // Every companion must be reachable. If one isn't, the test
        // FAILS — operator needs to look at logs.
        for (const [name, section] of Object.entries(ca).filter(
          ([k]) => k !== "fetchedAt"
        )) {
          if (typeof section === "string") continue; // fetchedAt
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const s = section as any;
          if (!s.reachable) {
            throw new Error(
              `companion "${name}" was unreachable: ${s.error ?? "unknown error"}\n` +
                `URL configured: ${COMPANION_URLS[name as keyof typeof COMPANION_URLS]}\n` +
                "Make sure the dev server is running on that port and " +
                "INTERNAL_API_TOKEN matches across all repos."
            );
          }
          expect(s.data).toHaveProperty("snapshotAt");
          expect(typeof s.data.snapshotAt).toBe("string");
        }
      },
      15_000 // generous timeout for 4 cold dev servers
    );

    it(
      "HARD INVARIANT: serialized bundle contains no credentials- or contents-shaped strings",
      async () => {
        if (!realUserId || !TOKEN) return;

        const bundle = await buildUserDataExport(prisma, realUserId, {
          internalApiToken: TOKEN,
        });
        const serialized = JSON.stringify(bundle).toLowerCase();

        // Art. 15(4) rights-of-others carve-out — never include
        // credentials data in DSR exports.
        expect(serialized).not.toContain("accesstoken");
        expect(serialized).not.toContain("refreshtoken");
        expect(serialized).not.toContain("credentialsjson");
        expect(serialized).not.toContain("credentials\":");

        // Counterparty PII carve-out from revenue-rec — rawText is the
        // highest-sensitivity column in the portfolio.
        expect(serialized).not.toContain("rawtext");
        expect(serialized).not.toContain("rawpayload");
      },
      15_000
    );

    it(
      "fetchedAt is a valid ISO 8601 timestamp from this run",
      async () => {
        if (!realUserId || !TOKEN) return;

        const before = Date.now();
        const bundle = await buildUserDataExport(prisma, realUserId, {
          internalApiToken: TOKEN,
        });
        const after = Date.now();

        const fetchedAt = bundle.companionAttribution?.fetchedAt;
        expect(fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        const t = new Date(fetchedAt!).getTime();
        // Allow a generous skew window (some test runners pause between
        // `before` and the fetch).
        expect(t).toBeGreaterThanOrEqual(before - 1_000);
        expect(t).toBeLessThanOrEqual(after + 1_000);
      },
      15_000
    );
  }
);

// When the suite is skipped we still want one passing test so the
// file shows up in the test report (instead of a confusing zero-test
// noise). Vitest counts describe.skipIf as 0 if everything inside is
// skipped, so add a sentinel.
describe("DSR e2e smoke — opt-in metadata", () => {
  it(`reports its skip status (skipped: ${SKIP_REASON !== null}, reason: ${SKIP_REASON ?? "running live"})`, () => {
    expect(typeof OPT_IN).toBe("boolean");
  });
});
