// Tests for GDPR right-to-access + right-to-erasure helpers.
// Uses mocked Prisma — the Server Action layer's auth gates are
// exercised separately in integration tests.

import { describe, it, expect, vi } from "vitest";
import {
  buildUserDataExport,
  eraseUserPii,
} from "../src/lib/privacy/user-data";

const COMPANION_TOKEN = "test-internal-api-token-min-32-chars-long";

const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const USER_EMAIL = "alice@example.com";

function mockPrismaWith(args: {
  user?: {
    id: string;
    email: string;
    displayName: string;
    isActive: boolean;
    deactivatedAt: Date | null;
    createdAt: Date;
  };
  memberships?: Array<{
    tenantId: string;
    role: string;
    createdAt: Date;
    tenant: { slug: string; name: string };
  }>;
  invitesSent?: unknown[];
  notifications?: unknown[];
  emailDeliveries?: unknown[];
  counts?: number[];
}): unknown {
  const counts = args.counts ?? [0, 0, 0, 0, 0, 0, 0];
  const tx = {
    user: {
      update: vi.fn().mockResolvedValue({}),
    },
    emailDelivery: {
      updateMany: vi.fn().mockResolvedValue({ count: 2 }),
    },
  };
  return {
    user: {
      findUniqueOrThrow: vi.fn().mockResolvedValue(args.user),
    },
    tenantMembership: {
      findMany: vi.fn().mockResolvedValue(args.memberships ?? []),
    },
    tenantInvite: {
      findMany: vi.fn().mockResolvedValue(args.invitesSent ?? []),
    },
    notification: {
      findMany: vi.fn().mockResolvedValue(args.notifications ?? []),
    },
    emailDelivery: {
      findMany: vi.fn().mockResolvedValue(args.emailDeliveries ?? []),
    },
    journalEntry: {
      count: vi
        .fn()
        .mockResolvedValueOnce(counts[0])
        .mockResolvedValueOnce(counts[1])
        .mockResolvedValueOnce(counts[2])
        .mockResolvedValueOnce(counts[3]),
    },
    auditLog: { count: vi.fn().mockResolvedValue(counts[4]) },
    recordEvent: { count: vi.fn().mockResolvedValue(counts[5]) },
    journalEntryNote: { count: vi.fn().mockResolvedValue(counts[6]) },
    $transaction: vi.fn().mockImplementation(async (cb: (t: unknown) => unknown) => cb(tx)),
  };
}

describe("buildUserDataExport (GDPR Art. 15 — right of access)", () => {
  it("assembles a complete bundle with attribution counts", async () => {
    const prisma = mockPrismaWith({
      user: {
        id: USER_ID,
        email: USER_EMAIL,
        displayName: "Alice Example",
        isActive: true,
        deactivatedAt: null,
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
      memberships: [
        {
          tenantId: "t-1",
          role: "ADMIN",
          createdAt: new Date("2026-01-05"),
          tenant: { slug: "acme", name: "Acme Co" },
        },
      ],
      counts: [3, 0, 5, 0, 12, 8, 2],
    });

    const bundle = await buildUserDataExport(prisma as never, USER_ID);

    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.subject.email).toBe(USER_EMAIL);
    expect(bundle.subject.displayName).toBe("Alice Example");
    expect(bundle.memberships).toHaveLength(1);
    expect(bundle.memberships[0].tenantSlug).toBe("acme");
    expect(bundle.attributionCounts.journalEntriesCreated).toBe(3);
    expect(bundle.attributionCounts.journalEntriesApproved).toBe(5);
    expect(bundle.attributionCounts.auditLogEntries).toBe(12);
    expect(bundle.attributionCounts.recordEventsCreated).toBe(8);
    expect(bundle.attributionCounts.journalEntryNotesAuthored).toBe(2);
  });

  it("ISO-formats every date so the JSON bundle is portable", async () => {
    const prisma = mockPrismaWith({
      user: {
        id: USER_ID,
        email: USER_EMAIL,
        displayName: "x",
        isActive: false,
        deactivatedAt: new Date("2026-03-01T12:00:00Z"),
        createdAt: new Date("2026-01-01T00:00:00Z"),
      },
    });
    const bundle = await buildUserDataExport(prisma as never, USER_ID);
    expect(bundle.subject.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(bundle.subject.deactivatedAt).toBe("2026-03-01T12:00:00.000Z");
    expect(bundle.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("eraseUserPii (GDPR Art. 17 — right to erasure)", () => {
  it("redacts the User row + email deliveries atomically", async () => {
    const prisma = mockPrismaWith({
      user: {
        id: USER_ID,
        email: USER_EMAIL,
        displayName: "Alice",
        isActive: true,
        deactivatedAt: null,
        createdAt: new Date(),
      },
    });

    const summary = await eraseUserPii(prisma as never, USER_ID);

    expect(summary.userId).toBe(USER_ID);
    expect(summary.originalEmail).toBe(USER_EMAIL);
    expect(summary.redactedEmail).toBe(`redacted-${USER_ID}@deleted.local`);
    expect(summary.emailDeliveriesRedacted).toBe(2);
    // $transaction was called (atomicity).
    expect((prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction).toHaveBeenCalledOnce();
  });

  it("is idempotent — re-running on an already-redacted user is a no-op", async () => {
    const ALREADY_REDACTED = `redacted-${USER_ID}@deleted.local`;
    const prisma = mockPrismaWith({
      user: {
        id: USER_ID,
        email: ALREADY_REDACTED,
        displayName: "[Redacted User]",
        isActive: false,
        deactivatedAt: new Date(),
        createdAt: new Date(),
      },
    });
    const summary = await eraseUserPii(prisma as never, USER_ID);
    expect(summary.redactedEmail).toBe(ALREADY_REDACTED);
    expect(summary.emailDeliveriesRedacted).toBe(0);
    // $transaction was NOT called (idempotent shortcut).
    expect((prisma as unknown as { $transaction: ReturnType<typeof vi.fn> }).$transaction).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// schemaVersion 2 — bundle with companion attribution
// ─────────────────────────────────────────────────────────────────────────────

describe("buildUserDataExport — schemaVersion 2 (companion attribution)", () => {
  function baseUser() {
    return {
      id: USER_ID,
      email: USER_EMAIL,
      displayName: "Alice Example",
      isActive: true,
      deactivatedAt: null,
      createdAt: new Date("2026-01-01"),
    };
  }

  it("stays at schemaVersion 1 when no internalApiToken supplied", async () => {
    const prisma = mockPrismaWith({ user: baseUser() });
    const bundle = await buildUserDataExport(prisma as never, USER_ID);
    expect(bundle.schemaVersion).toBe(1);
    expect(bundle.companionAttribution).toBeUndefined();
  });

  it("bumps to schemaVersion 2 + populates companionAttribution when token supplied", async () => {
    const prisma = mockPrismaWith({ user: baseUser() });

    // Stub fetch to return all four companions OK with distinct shapes.
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":3003")) {
        return new Response(
          JSON.stringify({
            connectionsCreated: 1,
            connectionsByStatus: { ACTIVE: 1, PAUSED: 0, REVOKED: 0, ERROR: 0 },
            syncRunsInitiated: 0,
            connectionsBySystem: { plaid: 1 },
            snapshotAt: "2026-06-04T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (url.includes(":3001")) {
        return new Response(
          JSON.stringify({
            bankStatementsUploaded: 2,
            reconciliationMatchesApproved: 0,
            aiSuggestionsAccepted: 0,
            aiSuggestionsRejected: 0,
            snapshotAt: "2026-06-04T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      // fa-amort and revenue-rec: empty-but-valid
      return new Response(
        JSON.stringify({ snapshotAt: "2026-06-04T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const bundle = await buildUserDataExport(prisma as never, USER_ID, {
      internalApiToken: COMPANION_TOKEN,
      fetchImpl,
    });

    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.companionAttribution).toBeDefined();
    expect(bundle.companionAttribution!.integrations.reachable).toBe(true);
    if (bundle.companionAttribution!.integrations.reachable) {
      expect(bundle.companionAttribution!.integrations.data.connectionsCreated).toBe(1);
    }
    expect(bundle.companionAttribution!.recon.reachable).toBe(true);
    expect(bundle.companionAttribution!.faAmort.reachable).toBe(true);
    expect(bundle.companionAttribution!.revenueRec.reachable).toBe(true);
  });

  it("still assembles the bundle when a companion is down (graceful degradation)", async () => {
    const prisma = mockPrismaWith({ user: baseUser() });

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes(":3001")) {
        // recon is down
        throw new Error("ECONNREFUSED");
      }
      return new Response(
        JSON.stringify({ snapshotAt: "2026-06-04T00:00:00.000Z" }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }) as typeof fetch;

    const bundle = await buildUserDataExport(prisma as never, USER_ID, {
      internalApiToken: COMPANION_TOKEN,
      fetchImpl,
    });

    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.companionAttribution!.recon.reachable).toBe(false);
    expect(bundle.companionAttribution!.integrations.reachable).toBe(true);
    // The substrate attribution still works.
    expect(bundle.attributionCounts).toBeDefined();
    expect(bundle.subject.email).toBe(USER_EMAIL);
  });
});
