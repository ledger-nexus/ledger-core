// Tests for src/app/api/cron/retention/route.ts (Vercel Cron entry).
//
// What this proves:
//   1. Missing CRON_SECRET → 503 (fail-closed).
//   2. Missing/wrong Authorization header → 401.
//   3. Correct token → 200 + audit row written via logAuditEvent.
//   4. The audit row uses CONFIG_CHANGE (the closest existing
//      AuditEventType for system-initiated config-class events; the
//      enum has no SYSTEM_ACTION tier).
//   5. Outcome is ANOMALOUS when any policy errored, SUCCESS otherwise
//      (the auditor wants to see failed runs distinguished from clean
//      ones in the metadata).

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock the two collaborators the route imports. We don't need a real
// DB for this — the policy execution path is covered by
// tests/retention.test.ts; here we're testing the auth gate + the
// audit-log emission, which are independent concerns.

const mockRunRetentionPurge = vi.fn();
const mockLogAuditEvent = vi.fn();

vi.mock("@/lib/retention/purge", () => ({
  runRetentionPurge: (...args: unknown[]) => mockRunRetentionPurge(...args),
}));

vi.mock("@/lib/audit/log", () => ({
  logAuditEvent: (...args: unknown[]) => mockLogAuditEvent(...args),
}));

vi.mock("@/lib/db", () => ({
  prisma: { __sentinel: "fake-prisma" },
}));

import { NextRequest } from "next/server";
import { GET } from "../src/app/api/cron/retention/route";

function makeRequest(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("https://example.test/api/cron/retention", {
    method: "GET",
    headers,
  });
}

const SAVED_SECRET = process.env.CRON_SECRET;

beforeEach(() => {
  mockRunRetentionPurge.mockReset();
  mockLogAuditEvent.mockReset();
  delete process.env.CRON_SECRET;
});

describe("/api/cron/retention — CRON_SECRET gating", () => {
  it("returns 503 when CRON_SECRET is not set (fail-closed)", async () => {
    const res = await GET(makeRequest({ authorization: "Bearer anything" }));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/CRON_SECRET/);
    // Critically: the purge MUST NOT run when fail-closed.
    expect(mockRunRetentionPurge).not.toHaveBeenCalled();
    expect(mockLogAuditEvent).not.toHaveBeenCalled();
  });

  it("returns 401 with no authorization header", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    const res = await GET(makeRequest());
    expect(res.status).toBe(401);
    expect(mockRunRetentionPurge).not.toHaveBeenCalled();
  });

  it("returns 401 with wrong token", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    const res = await GET(makeRequest({ authorization: "Bearer wrong" }));
    expect(res.status).toBe(401);
    expect(mockRunRetentionPurge).not.toHaveBeenCalled();
  });

  it("returns 401 with token missing the Bearer prefix", async () => {
    process.env.CRON_SECRET = "secret-xyz";
    const res = await GET(makeRequest({ authorization: "secret-xyz" }));
    expect(res.status).toBe(401);
  });
});

describe("/api/cron/retention — happy path", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "secret-xyz";
  });

  it("with valid token, runs the purge and writes an audit row", async () => {
    mockRunRetentionPurge.mockResolvedValue({
      ranAt: new Date("2026-06-02T03:00:00.000Z"),
      results: [
        { policyId: "notification.seen", rowsDeleted: 4, durationMs: 12 },
        { policyId: "tenant_invite.terminal", rowsDeleted: 2, durationMs: 5 },
      ],
      totalRowsDeleted: 6,
      totalErrors: 0,
    });

    const res = await GET(makeRequest({ authorization: "Bearer secret-xyz" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.totalRowsDeleted).toBe(6);

    expect(mockRunRetentionPurge).toHaveBeenCalledOnce();
    expect(mockLogAuditEvent).toHaveBeenCalledOnce();

    const auditCall = mockLogAuditEvent.mock.calls[0]![0] as {
      eventType: string;
      action: string;
      outcome: string;
      actorEmail: string;
      metadata: { totalRowsDeleted: number; totalErrors: number };
    };
    expect(auditCall.eventType).toBe("CONFIG_CHANGE");
    expect(auditCall.action).toBe("retention.purge");
    expect(auditCall.outcome).toBe("SUCCESS");
    expect(auditCall.actorEmail).toBe("system@cron");
    expect(auditCall.metadata.totalRowsDeleted).toBe(6);
    expect(auditCall.metadata.totalErrors).toBe(0);
  });

  it("marks outcome ANOMALOUS when any policy errored", async () => {
    mockRunRetentionPurge.mockResolvedValue({
      ranAt: new Date("2026-06-02T03:00:00.000Z"),
      results: [
        {
          policyId: "notification.seen",
          rowsDeleted: 0,
          durationMs: 3,
          error: "db timeout",
        },
        { policyId: "tenant_invite.terminal", rowsDeleted: 2, durationMs: 5 },
      ],
      totalRowsDeleted: 2,
      totalErrors: 1,
    });

    const res = await GET(makeRequest({ authorization: "Bearer secret-xyz" }));
    // Still 200 — the cron RAN. The auditor's signal is the audit row,
    // not the HTTP status.
    expect(res.status).toBe(200);

    const auditCall = mockLogAuditEvent.mock.calls[0]![0] as {
      outcome: string;
      metadata: { totalErrors: number };
    };
    expect(auditCall.outcome).toBe("ANOMALOUS");
    expect(auditCall.metadata.totalErrors).toBe(1);
  });
});

// Restore env for any siblings.
afterEach(() => {
  if (SAVED_SECRET === undefined) delete process.env.CRON_SECRET;
  else process.env.CRON_SECRET = SAVED_SECRET;
});
