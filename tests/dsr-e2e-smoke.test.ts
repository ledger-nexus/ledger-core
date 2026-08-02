// End-to-end smoke test for the cross-repo DSR attribution loop
// (harvest of #47).
//
// Every other DSR test injects a fake fetch. This one is the only
// thing that exercises the actual wire: ledger-core POSTing to four
// running companion services and assembling their answers into an
// Art. 15 bundle. Mocked tests prove our parsing; only this proves the
// four services agree on a format.
//
// OPT-IN — skipped unless all three are present:
//   E2E_DSR_TEST=1        the opt-in flag
//   INTERNAL_API_TOKEN    shared by all five services
//   DATABASE_URL          for the ledger-core subject lookup
//
// Skipping is silent and does not fail CI, because CI has no companion
// services to talk to. Running it is a deliberate act before shipping
// anything under src/lib/privacy/ — see docs/runbooks/dsr-e2e-test.md.
//
//   Terminal 1: npm --prefix ledger-core   run dev -- --port 3010
//   Terminal 2: npm --prefix recon         run dev -- --port 3001
//   Terminal 3: npm --prefix revenue-rec   run dev -- --port 3002
//   Terminal 4: npm --prefix integrations  run dev -- --port 3003
//   Terminal 5: npm --prefix fa-amort      run dev -- --port 3004
//   Terminal 6: E2E_DSR_TEST=1 INTERNAL_API_TOKEN=<shared> \
//                 npx vitest run tests/dsr-e2e-smoke.test.ts
//
// The ports are not arbitrary — they are the defaults baked into
// COMPANION_URLS in src/lib/privacy/companion-attribution.ts. Override
// per-service with RECON_URL / REVENUE_REC_URL / INTEGRATIONS_URL /
// FA_AMORT_URL to point at staging.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { buildUserDataExport } from "@/lib/privacy/user-data";

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

const COMPANIONS = ["integrations", "recon", "faAmort", "revenueRec"] as const;

let prisma: PrismaClient;
let subjectId: string;

beforeAll(async () => {
  if (SKIP_REASON) return;
  prisma = new PrismaClient();
  const someUser = await prisma.user.findFirst({ select: { id: true } });
  if (!someUser) {
    throw new Error(
      "No User rows in the database. Seed at least one user (npm run db:seed) " +
        "before running the DSR e2e smoke test."
    );
  }
  subjectId = someUser.id;
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
});

describe.skipIf(SKIP_REASON != null)(
  "DSR attribution loop — live companions",
  () => {
    it("assembles a schemaVersion 2 bundle with every companion reachable", async () => {
      const bundle = await buildUserDataExport(prisma, subjectId, {
        internalApiToken: TOKEN,
      });

      // schemaVersion 2 is the signal that companion attribution was
      // attempted at all. A bundle that silently falls back to v1
      // would look successful while telling a regulator nothing about
      // the other four systems.
      expect(bundle.schemaVersion).toBe(2);
      expect(bundle.companionAttribution).toBeDefined();

      const attribution = bundle.companionAttribution!;
      const unreachable = COMPANIONS.filter(
        (k) => attribution[k].reachable !== true
      );
      expect(
        unreachable.map((k) => {
          const section = attribution[k] as { error?: string };
          return `${k}: ${section.error ?? "unknown error"}`;
        }),
        "every companion must answer; start all four dev servers"
      ).toEqual([]);

      expect(Date.parse(attribution.fetchedAt)).not.toBeNaN();
    });

    it("the bundle carries no credentials and no counterparty contents", async () => {
      // The hard invariant of Art. 15(4): a subject's right of access
      // does not extend to other people's data, and never to secrets.
      // Companions return COUNTS, not contents — this asserts they
      // actually do, across the real wire rather than a mock we wrote.
      const bundle = await buildUserDataExport(prisma, subjectId, {
        internalApiToken: TOKEN,
      });
      const serialized = JSON.stringify(bundle);

      const forbidden = [
        // credential-shaped
        "access_token",
        "refresh_token",
        "client_secret",
        "accessToken",
        "refreshToken",
        "clientSecret",
        "Bearer ",
        // the shared token itself must never be echoed back
        TOKEN!,
        // contents-shaped — counterparty PII from a companion's rows
        "counterpartyName",
        "bankAccountNumber",
        "routingNumber",
      ];

      const leaked = forbidden.filter((needle) => serialized.includes(needle));
      expect(
        leaked,
        "Art. 15(4) violation — the export bundle contains credential- or " +
          "contents-shaped values that must never leave a companion repo"
      ).toEqual([]);
    });

    it("fetchedAt is stamped at export time, not cached from an earlier run", async () => {
      // A stale timestamp would mean a regulator is being shown a
      // snapshot older than the request they're auditing.
      const before = Date.now();
      const bundle = await buildUserDataExport(prisma, subjectId, {
        internalApiToken: TOKEN,
      });
      const after = Date.now();

      const stamped = Date.parse(bundle.companionAttribution!.fetchedAt);
      expect(stamped).toBeGreaterThanOrEqual(before - 1000);
      expect(stamped).toBeLessThanOrEqual(after + 1000);
    });

    it("degrades to schemaVersion 1 when no token is supplied", async () => {
      // The back-compat contract: without a token we do not call the
      // companions at all, and the bundle must SAY so by staying at v1
      // rather than presenting an empty attribution section as if the
      // companions had reported zero.
      const bundle = await buildUserDataExport(prisma, subjectId);
      expect(bundle.schemaVersion).toBe(1);
      expect(bundle.companionAttribution).toBeUndefined();
    });
  }
);

// Always-on guard. Runs in CI even with no companions, so a broken
// skip predicate can't silently disable the whole file forever.
describe("DSR e2e smoke — opt-in wiring", () => {
  it("skips for exactly one stated reason, or runs", () => {
    const reasons = [
      process.env.E2E_DSR_TEST === "1",
      !!process.env.INTERNAL_API_TOKEN,
      !!process.env.DATABASE_URL,
    ];
    if (reasons.every(Boolean)) {
      expect(SKIP_REASON).toBeNull();
    } else {
      expect(SKIP_REASON).toBeTypeOf("string");
    }
  });
});
