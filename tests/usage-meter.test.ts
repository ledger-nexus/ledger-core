// Stripe usage-meter cron tests.
//
// Substantive guarantees:
//   - computeDailyUsageCents: token totals × per-model price = cents
//     (banker's rounded). Mixed-model + zero-usage paths.
//   - reportDailyUsage: already-reported short-circuit returns the
//     existing row. Free-tier tenants get NO_SUBSCRIPTION. Missing
//     STRIPE_AI_METER_EVENT_NAME → LOGGED_ONLY. Stripe error → FAILED
//     with message preserved.
//   - yesterdayUtcIsoDate: returns YYYY-MM-DD one day before now (UTC).
//
// Pure logic + mocked prisma + mocked Stripe client.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} as never }));

// Mock the Stripe client. We control success / failure per test.
vi.mock("../src/lib/billing/stripe-client", () => ({
  createMeterEvent: vi.fn(),
}));

import {
  computeDailyUsageCents,
  reportDailyUsage,
  yesterdayUtcIsoDate,
} from "../src/lib/billing/usage-meter";
import { prisma } from "@/lib/db";
import { createMeterEvent } from "../src/lib/billing/stripe-client";

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

interface UsageRow {
  modelName: string;
  promptTokens: bigint | null;
  completionTokens: bigint | null;
}

function mockPrismaForCompute(args: {
  recon?: UsageRow[];
  revRec?: UsageRow[];
  faAmort?: UsageRow[];
}): void {
  const queryRaw = vi.fn();
  // Three sequential calls: recon, then revenue-rec, then fa-amort.
  queryRaw.mockResolvedValueOnce(args.recon ?? []);
  queryRaw.mockResolvedValueOnce(args.revRec ?? []);
  queryRaw.mockResolvedValueOnce(args.faAmort ?? []);
  (prisma as unknown as { $queryRaw: typeof queryRaw }).$queryRaw = queryRaw;
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_AI_METER_EVENT_NAME;
});

describe("computeDailyUsageCents", () => {
  it("returns 0 when there's no usage across all 3 tables", async () => {
    mockPrismaForCompute({});
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(0);
  });

  it("computes Opus 4.7 cents (1M input × $5 + 0 output)", async () => {
    // 1,000,000 input tokens × $5/M = $5.00 → 500 cents.
    mockPrismaForCompute({
      revRec: [
        {
          modelName: "claude-opus-4-7",
          promptTokens: 1_000_000n,
          completionTokens: 0n,
        },
      ],
    });
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(500);
  });

  it("computes Haiku 4.5 cents with output (mixed input + output)", async () => {
    // 100k input × $1/M + 50k output × $5/M = $0.10 + $0.25 = $0.35 → 35 cents.
    mockPrismaForCompute({
      recon: [
        {
          modelName: "claude-haiku-4-5",
          promptTokens: 100_000n,
          completionTokens: 50_000n,
        },
      ],
    });
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(35);
  });

  it("sums across all 3 tables", async () => {
    mockPrismaForCompute({
      recon: [
        {
          modelName: "claude-haiku-4-5",
          promptTokens: 100_000n,
          completionTokens: 0n,
        },
      ], // $0.10 = 10 cents
      revRec: [
        {
          modelName: "claude-opus-4-7",
          promptTokens: 100_000n,
          completionTokens: 0n,
        },
      ], // $0.50 = 50 cents
      faAmort: [
        {
          modelName: "claude-opus-4-7",
          promptTokens: 0n,
          completionTokens: 100_000n,
        },
      ], // 100k × $25/M = $2.50 = 250 cents
    });
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(310);
  });

  it("rounds to integer cents (HALF_EVEN)", async () => {
    // 1 input token × $5/M = $0.000005 = 0.0005 cents → rounds to 0.
    mockPrismaForCompute({
      revRec: [
        {
          modelName: "claude-opus-4-7",
          promptTokens: 1n,
          completionTokens: 0n,
        },
      ],
    });
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(0);
  });

  it("silently excludes unknown model names (rather than guessing)", async () => {
    mockPrismaForCompute({
      revRec: [
        {
          modelName: "future-model-not-in-pricing-table",
          promptTokens: 1_000_000n,
          completionTokens: 1_000_000n,
        },
        {
          modelName: "claude-opus-4-7",
          promptTokens: 100_000n,
          completionTokens: 0n,
        }, // 50 cents
      ],
    });
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(50);
  });

  it("handles null token columns (treats as 0)", async () => {
    mockPrismaForCompute({
      recon: [
        {
          modelName: "claude-haiku-4-5",
          promptTokens: null,
          completionTokens: null,
        },
      ],
    });
    const cents = await computeDailyUsageCents(TENANT_ID, "2026-05-15");
    expect(cents).toBe(0);
  });
});

describe("reportDailyUsage: short-circuit + free-tier paths", () => {
  function makePrisma(args: {
    existingReport?: {
      reportedCents: number;
      status: string;
      stripeEventId: string | null;
      errorMessage: string | null;
    } | null;
    tenant: {
      stripeCustomerId: string | null;
      stripeSubscriptionId: string | null;
      subscriptionStatus: string | null;
    } | null;
    recon?: UsageRow[];
    revRec?: UsageRow[];
    faAmort?: UsageRow[];
    createSucceeds?: boolean;
  }): unknown {
    const queryRaw = vi.fn();
    queryRaw.mockResolvedValueOnce(args.recon ?? []);
    queryRaw.mockResolvedValueOnce(args.revRec ?? []);
    queryRaw.mockResolvedValueOnce(args.faAmort ?? []);
    return {
      aiUsageReport: {
        findUnique: vi.fn().mockResolvedValue(args.existingReport ?? null),
        create:
          args.createSucceeds !== false
            ? vi.fn().mockResolvedValue({ id: "row-id" })
            : vi.fn().mockRejectedValue({ code: "P2002" }),
      },
      tenant: {
        findUnique: vi.fn().mockResolvedValue(args.tenant),
      },
      $queryRaw: queryRaw,
    };
  }

  it("returns existing row unchanged when already reported (idempotency)", async () => {
    const prismaMock = makePrisma({
      existingReport: {
        reportedCents: 1234,
        status: "REPORTED",
        stripeEventId: "evt_abc",
        errorMessage: null,
      },
      tenant: null,
    });
    Object.assign(prisma as object, prismaMock);
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("REPORTED");
    expect(r.reportedCents).toBe(1234);
    expect(r.stripeEventId).toBe("evt_abc");
    expect(createMeterEvent).not.toHaveBeenCalled();
  });

  it("FAILED when tenant doesn't exist", async () => {
    Object.assign(prisma as object, makePrisma({ tenant: null }));
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("FAILED");
    expect(r.errorMessage).toMatch(/not found/);
  });

  it("NO_SUBSCRIPTION when stripeSubscriptionId is null (free tier)", async () => {
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          subscriptionStatus: null,
        },
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("NO_SUBSCRIPTION");
    expect(r.reportedCents).toBe(0);
    expect(createMeterEvent).not.toHaveBeenCalled();
  });

  it("NO_SUBSCRIPTION when subscription is canceled", async () => {
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: "cus_X",
          stripeSubscriptionId: "sub_X",
          subscriptionStatus: "canceled",
        },
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("NO_SUBSCRIPTION");
    expect(createMeterEvent).not.toHaveBeenCalled();
  });

  it("NO_USAGE when subscription exists but cents is 0", async () => {
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: "cus_X",
          stripeSubscriptionId: "sub_X",
          subscriptionStatus: "active",
        },
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("NO_USAGE");
    expect(r.reportedCents).toBe(0);
    expect(createMeterEvent).not.toHaveBeenCalled();
  });

  it("LOGGED_ONLY when STRIPE_SECRET_KEY is unset", async () => {
    // No env set in beforeEach.
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: "cus_X",
          stripeSubscriptionId: "sub_X",
          subscriptionStatus: "active",
        },
        revRec: [
          {
            modelName: "claude-opus-4-7",
            promptTokens: 100_000n,
            completionTokens: 0n,
          },
        ],
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("LOGGED_ONLY");
    expect(r.reportedCents).toBe(50);
    expect(createMeterEvent).not.toHaveBeenCalled();
  });

  it("LOGGED_ONLY when STRIPE_AI_METER_EVENT_NAME is unset (even if SECRET_KEY is set)", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: "cus_X",
          stripeSubscriptionId: "sub_X",
          subscriptionStatus: "active",
        },
        revRec: [
          {
            modelName: "claude-opus-4-7",
            promptTokens: 100_000n,
            completionTokens: 0n,
          },
        ],
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("LOGGED_ONLY");
    expect(r.errorMessage).toMatch(/STRIPE_AI_METER_EVENT_NAME/);
  });

  it("REPORTED when Stripe accepts the meter event", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_AI_METER_EVENT_NAME = "ai_token_cents";
    vi.mocked(createMeterEvent).mockResolvedValue({
      identifier: "00000000-0000-0000-0000-000000000001-2026-05-15",
      event_name: "ai_token_cents",
      payload: { stripe_customer_id: "cus_X", value: "50" },
      created: 1234567890,
    });
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: "cus_X",
          stripeSubscriptionId: "sub_X",
          subscriptionStatus: "active",
        },
        revRec: [
          {
            modelName: "claude-opus-4-7",
            promptTokens: 100_000n,
            completionTokens: 0n,
          },
        ],
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("REPORTED");
    expect(r.reportedCents).toBe(50);
    expect(r.stripeEventId).toBeTruthy();
    expect(createMeterEvent).toHaveBeenCalledOnce();
    const callArg = vi.mocked(createMeterEvent).mock.calls[0][0];
    expect(callArg.eventName).toBe("ai_token_cents");
    expect(callArg.value).toBe(50);
    expect(callArg.customerId).toBe("cus_X");
    expect(callArg.identifier).toBe(`${TENANT_ID}-2026-05-15`);
  });

  it("FAILED when Stripe rejects + preserves error message", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_dummy";
    process.env.STRIPE_AI_METER_EVENT_NAME = "ai_token_cents";
    vi.mocked(createMeterEvent).mockRejectedValue(
      new Error("Stripe /billing/meter_events failed: meter not found")
    );
    Object.assign(
      prisma as object,
      makePrisma({
        tenant: {
          stripeCustomerId: "cus_X",
          stripeSubscriptionId: "sub_X",
          subscriptionStatus: "active",
        },
        revRec: [
          {
            modelName: "claude-opus-4-7",
            promptTokens: 100_000n,
            completionTokens: 0n,
          },
        ],
      })
    );
    const r = await reportDailyUsage({
      tenantId: TENANT_ID,
      usageDay: "2026-05-15",
    });
    expect(r.status).toBe("FAILED");
    expect(r.reportedCents).toBe(50);
    expect(r.errorMessage).toMatch(/meter not found/);
  });
});

describe("yesterdayUtcIsoDate", () => {
  it("returns a YYYY-MM-DD string", () => {
    const day = yesterdayUtcIsoDate();
    expect(day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("is exactly 24 hours before now (UTC)", () => {
    const day = yesterdayUtcIsoDate();
    const expected = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(day).toBe(expected);
  });
});
