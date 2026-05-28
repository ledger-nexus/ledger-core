// Plan-tier limit tests. Pure logic + mocked prisma — no DB needed.
//
// Two surfaces to test:
//   1. getEffectivePlan resolves the right plan from Tenant state
//      (subscriptionStatus + billingPlan).
//   2. assertCanInviteUser / assertCanCreateEntity enforce limits
//      when BILLING_ENFORCE_LIMITS=true, soft-warn otherwise.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the prisma client before importing the module under test.
vi.mock("@/lib/db", () => ({
  prisma: {
    tenant: {
      findUnique: vi.fn(),
    },
    tenantMembership: {
      count: vi.fn(),
    },
    tenantInvite: {
      count: vi.fn(),
    },
    legalEntity: {
      count: vi.fn(),
    },
  },
}));

import {
  getEffectivePlan,
  assertCanInviteUser,
  assertCanCreateEntity,
  PlanLimitExceededError,
} from "../src/lib/billing/limits";
import { FREE_TIER, PLANS, findPlan } from "../src/lib/billing/plans";
import { prisma } from "@/lib/db";

const origEnforce = process.env.BILLING_ENFORCE_LIMITS;

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BILLING_ENFORCE_LIMITS;
});

afterEach(() => {
  if (origEnforce != null) process.env.BILLING_ENFORCE_LIMITS = origEnforce;
  else delete process.env.BILLING_ENFORCE_LIMITS;
});

const TENANT_ID = "00000000-0000-0000-0000-000000000001";

describe("getEffectivePlan", () => {
  it("returns FREE_TIER when tenant has no subscription", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: null,
      subscriptionStatus: null,
    } as never);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("free");
  });

  it("returns FREE_TIER when subscription is canceled", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: "starter",
      subscriptionStatus: "canceled",
    } as never);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("free");
  });

  it("returns FREE_TIER when subscription is past_due", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: "growth",
      subscriptionStatus: "past_due",
    } as never);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("free");
  });

  it("returns the paid plan when subscription is active", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: "growth",
      subscriptionStatus: "active",
    } as never);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("growth");
  });

  it("returns the paid plan when subscription is trialing", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: "scale",
      subscriptionStatus: "trialing",
    } as never);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("scale");
  });

  it("falls back to FREE_TIER when billingPlan key is unknown", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: "deprecated-tier",
      subscriptionStatus: "active",
    } as never);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("free");
  });

  it("returns FREE_TIER when tenant does not exist", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null);
    const plan = await getEffectivePlan(TENANT_ID);
    expect(plan.key).toBe("free");
  });
});

describe("assertCanInviteUser", () => {
  function setPlan(planKey: string | null, status: string | null = "active") {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: planKey,
      subscriptionStatus: status,
    } as never);
  }
  function setCounts(memberCount: number, pendingInvites: number) {
    vi.mocked(prisma.tenantMembership.count).mockResolvedValue(memberCount);
    vi.mocked(prisma.tenantInvite.count).mockResolvedValue(pendingInvites);
  }

  it("passes when below cap (free tier, 0 members)", async () => {
    setPlan(null, null);
    setCounts(0, 0);
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
  });

  it("passes when below cap (free tier, 2 members + 0 pending, cap 3)", async () => {
    setPlan(null, null);
    setCounts(2, 0);
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
  });

  it("counts pending invites toward the cap (free tier, 2 members + 1 pending = 3, blocks at cap 3)", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan(null, null);
    setCounts(2, 1);
    await expect(assertCanInviteUser(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("throws on starter plan at 1 member (cap 1)", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan("starter");
    setCounts(1, 0);
    await expect(assertCanInviteUser(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("scale plan never throws (cap=null)", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan("scale");
    setCounts(9999, 0);
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
  });

  it("soft mode: at cap but warning-only when enforcement off", async () => {
    // No BILLING_ENFORCE_LIMITS env var = soft mode.
    setPlan("starter");
    setCounts(1, 0);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("assertCanCreateEntity", () => {
  function setPlan(planKey: string | null, status: string | null = "active") {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
      billingPlan: planKey,
      subscriptionStatus: status,
    } as never);
  }
  function setEntities(count: number) {
    vi.mocked(prisma.legalEntity.count).mockResolvedValue(count);
  }

  it("passes on free tier with 0 entities (cap 5)", async () => {
    setPlan(null, null);
    setEntities(0);
    await expect(assertCanCreateEntity(TENANT_ID)).resolves.toBeUndefined();
  });

  it("throws on free tier with 5 entities (at cap)", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan(null, null);
    setEntities(5);
    await expect(assertCanCreateEntity(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("throws on starter with 3 entities (cap 3)", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan("starter");
    setEntities(3);
    await expect(assertCanCreateEntity(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("growth plan blocks at 25 entities", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan("growth");
    setEntities(25);
    await expect(assertCanCreateEntity(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("growth plan passes at 24", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan("growth");
    setEntities(24);
    await expect(assertCanCreateEntity(TENANT_ID)).resolves.toBeUndefined();
  });

  it("scale plan never throws", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setPlan("scale");
    setEntities(9999);
    await expect(assertCanCreateEntity(TENANT_ID)).resolves.toBeUndefined();
  });
});

describe("plan catalog shape (regression — these limits power real revenue)", () => {
  it("FREE_TIER caps are 3 users / 5 entities / $10 AI / recon-only", () => {
    expect(FREE_TIER.maxUsers).toBe(3);
    expect(FREE_TIER.maxEntities).toBe(5);
    expect(FREE_TIER.defaultAiSpendCapUsd).toBe(10);
    expect(FREE_TIER.availableRepos).toEqual(["recon"]);
  });

  it("each PLAN has stricter (or equal) limits than the next tier up", () => {
    // Stricter = smaller cap, or "unlimited" if both are unlimited.
    // We rely on plans being ordered by .order ascending.
    const ordered = [...PLANS].sort((a, b) => a.order - b.order);
    for (let i = 0; i < ordered.length - 1; i++) {
      const here = ordered[i];
      const next = ordered[i + 1];
      // Users: cap is monotonically non-decreasing across tiers
      if (here.maxUsers != null && next.maxUsers != null) {
        expect(here.maxUsers, `${here.key}.maxUsers <= ${next.key}.maxUsers`)
          .toBeLessThanOrEqual(next.maxUsers);
      } else if (here.maxUsers == null && next.maxUsers != null) {
        // here is unlimited but next is finite — illegal ordering.
        throw new Error(`${here.key} is unlimited but ${next.key} is finite`);
      }
      // Entities: same monotonic invariant.
      if (here.maxEntities != null && next.maxEntities != null) {
        expect(here.maxEntities).toBeLessThanOrEqual(next.maxEntities);
      }
    }
  });

  it("findPlan returns null for unknown keys", () => {
    expect(findPlan("nonexistent")).toBeNull();
    expect(findPlan(null)).toBeNull();
    expect(findPlan(undefined)).toBeNull();
  });
});
