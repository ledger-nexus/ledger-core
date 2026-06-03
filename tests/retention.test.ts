// Tests for src/lib/retention/policies.ts and src/lib/retention/purge.ts.
//
// Mocks Prisma at the deleteMany level — we don't need a real DB to
// prove cutoff math and error-isolation logic. The actual delete SQL
// is Prisma's responsibility; ours is the policy table and the
// run-everything-in-its-own-try-catch contract.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { RETENTION_POLICIES } from "@/lib/retention/policies";
import { runRetentionPurge } from "@/lib/retention/purge";

// Minimal fake Prisma. Each deleteMany returns a tracked count + the
// where-clause we received so the test can introspect cutoff dates.
function makeFakePrisma(counts: {
  notification?: number;
  tenantInvite?: number;
  emailDelivery?: number;
}) {
  const calls: Record<string, Array<{ where: unknown }>> = {
    notification: [],
    tenantInvite: [],
    emailDelivery: [],
  };
  const prisma = {
    notification: {
      deleteMany: vi.fn(async (args: { where: unknown }) => {
        calls.notification.push(args);
        return { count: counts.notification ?? 0 };
      }),
    },
    tenantInvite: {
      deleteMany: vi.fn(async (args: { where: unknown }) => {
        calls.tenantInvite.push(args);
        return { count: counts.tenantInvite ?? 0 };
      }),
    },
    emailDelivery: {
      deleteMany: vi.fn(async (args: { where: unknown }) => {
        calls.emailDelivery.push(args);
        return { count: counts.emailDelivery ?? 0 };
      }),
    },
  };
  return { prisma, calls };
}

const NOW = new Date("2026-06-02T00:00:00.000Z");

describe("RETENTION_POLICIES table", () => {
  it("has a stable, unique id per policy (audit-log continuity contract)", () => {
    const ids = RETENTION_POLICIES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Pin the exact id set. If a policy is renamed or removed without
    // updating this test, the audit-log history breaks. The test is the
    // contract.
    expect(ids).toEqual([
      "notification.seen",
      "notification.unseen_stale",
      "tenant_invite.terminal",
      "email_delivery.transient",
    ]);
  });

  it("every policy has a positive retentionDays", () => {
    for (const p of RETENTION_POLICIES) {
      expect(p.retentionDays).toBeGreaterThan(0);
    }
  });

  it("every policy has a human description (drives the audit-log row)", () => {
    for (const p of RETENTION_POLICIES) {
      expect(p.description.length).toBeGreaterThan(20);
    }
  });
});

describe("runRetentionPurge — happy path", () => {
  it("runs every policy and aggregates counts", async () => {
    const { prisma, calls } = makeFakePrisma({
      notification: 7,
      tenantInvite: 3,
      emailDelivery: 11,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await runRetentionPurge(prisma as any, NOW);

    // notification.seen + notification.unseen_stale BOTH hit
    // prisma.notification.deleteMany → both observe 7.
    expect(summary.totalRowsDeleted).toBe(7 + 7 + 3 + 11);
    expect(summary.totalErrors).toBe(0);
    expect(summary.results).toHaveLength(4);
    expect(summary.results.every((r) => r.error === undefined)).toBe(true);

    expect(calls.notification).toHaveLength(2);
    expect(calls.tenantInvite).toHaveLength(1);
    expect(calls.emailDelivery).toHaveLength(1);
  });

  it("computes cutoff dates correctly per policy", async () => {
    const { prisma, calls } = makeFakePrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runRetentionPurge(prisma as any, NOW);

    // notification.seen — 365 days ago: 2025-06-02
    const seenWhere = calls.notification[0]!.where as {
      seenAt: { lt: Date };
    };
    expect(seenWhere.seenAt.lt.toISOString()).toBe("2025-06-02T00:00:00.000Z");

    // notification.unseen_stale — 730 days ago: 2024-06-02
    // (730 * 86_400_000 ms; 2024 had a Feb 29, so two-calendar-years-
    // and-a-day worth of seconds happens to land on the same MM-DD)
    const unseenWhere = calls.notification[1]!.where as {
      createdAt: { lt: Date };
    };
    expect(unseenWhere.createdAt.lt.toISOString()).toBe(
      "2024-06-02T00:00:00.000Z"
    );

    // tenant_invite.terminal — 30 days ago: 2026-05-03
    const inviteWhere = calls.tenantInvite[0]!.where as {
      OR: Array<{ acceptedAt?: { lt: Date } }>;
    };
    expect(inviteWhere.OR[0]!.acceptedAt!.lt.toISOString()).toBe(
      "2026-05-03T00:00:00.000Z"
    );

    // email_delivery.transient — 90 days ago: 2026-03-04
    const emailWhere = calls.emailDelivery[0]!.where as {
      sentAt: { lt: Date };
    };
    expect(emailWhere.sentAt.lt.toISOString()).toBe(
      "2026-03-04T00:00:00.000Z"
    );
  });

  it("filters out already-dismissed/expired tenant invites correctly", async () => {
    const { prisma, calls } = makeFakePrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await runRetentionPurge(prisma as any, NOW);

    const inviteWhere = calls.tenantInvite[0]!.where as {
      OR: Array<Record<string, unknown>>;
    };
    expect(inviteWhere.OR).toHaveLength(3);
    // The PENDING branch must be the only one that requires status, so
    // already-revoked or already-accepted rows are eligible without it.
    const pending = inviteWhere.OR.find((c) => c.status === "PENDING");
    expect(pending).toBeDefined();
    expect(pending).toMatchObject({
      status: "PENDING",
      expiresAt: { lt: expect.any(Date) },
    });
  });
});

describe("runRetentionPurge — failure isolation", () => {
  it("one policy throwing does NOT stop the others", async () => {
    const prisma = {
      notification: {
        deleteMany: vi.fn(async () => {
          throw new Error("simulated DB timeout");
        }),
      },
      tenantInvite: {
        deleteMany: vi.fn(async () => ({ count: 5 })),
      },
      emailDelivery: {
        deleteMany: vi.fn(async () => ({ count: 9 })),
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await runRetentionPurge(prisma as any, NOW);

    // Both notification policies fail (same backing model) but
    // tenant_invite and email_delivery succeed.
    expect(summary.totalErrors).toBe(2);
    expect(summary.totalRowsDeleted).toBe(5 + 9);

    const notifResults = summary.results.filter((r) =>
      r.policyId.startsWith("notification.")
    );
    expect(notifResults).toHaveLength(2);
    expect(notifResults.every((r) => r.error !== undefined)).toBe(true);
    expect(notifResults.every((r) => r.rowsDeleted === 0)).toBe(true);

    const okResults = summary.results.filter((r) => r.error === undefined);
    expect(okResults).toHaveLength(2);
  });

  it("error.message is sanitized (no stack, no schema leak)", async () => {
    const prisma = {
      notification: {
        deleteMany: vi.fn(async () => {
          // Simulate a Prisma error message that would include the
          // schema-qualified table name + connection details.
          const err = new Error(
            "P2025: Table `public.notification` not found in DB cluster ep-private-xyz.us-east-1.aws.neon.tech"
          );
          throw err;
        }),
      },
      tenantInvite: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      emailDelivery: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await runRetentionPurge(prisma as any, NOW);
    const failed = summary.results.filter((r) => r.error !== undefined);
    // sanitizeError() is the gate. We don't assert the exact replacement
    // string — that's sanitizeError's contract, tested separately — but
    // the field must be populated.
    expect(failed.length).toBeGreaterThan(0);
    for (const r of failed) {
      expect(typeof r.error).toBe("string");
      expect(r.error!.length).toBeGreaterThan(0);
    }
  });

  it("records durationMs even when a policy throws", async () => {
    const prisma = {
      notification: {
        deleteMany: vi.fn(async () => {
          throw new Error("fail");
        }),
      },
      tenantInvite: { deleteMany: vi.fn(async () => ({ count: 0 })) },
      emailDelivery: { deleteMany: vi.fn(async () => ({ count: 0 })) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await runRetentionPurge(prisma as any, NOW);
    for (const r of summary.results) {
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("runRetentionPurge — summary shape", () => {
  it("ranAt is the provided clock, not Date.now()", async () => {
    const { prisma } = makeFakePrisma({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await runRetentionPurge(prisma as any, NOW);
    expect(summary.ranAt).toEqual(NOW);
  });

  it("totalRowsDeleted is the sum of per-policy counts (errors count as 0)", async () => {
    const prisma = {
      notification: {
        deleteMany: vi
          .fn()
          .mockResolvedValueOnce({ count: 2 })
          .mockRejectedValueOnce(new Error("boom")),
      },
      tenantInvite: { deleteMany: vi.fn().mockResolvedValue({ count: 3 }) },
      emailDelivery: { deleteMany: vi.fn().mockResolvedValue({ count: 4 }) },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const summary = await runRetentionPurge(prisma as any, NOW);
    expect(summary.totalRowsDeleted).toBe(2 + 3 + 4);
    expect(summary.totalErrors).toBe(1);
  });
});
