// Plan-tier resolution + cap enforcement (#46 harvest slice ⑦).
//
// Pure logic over a mocked Prisma — no DB. What matters here is which
// direction each edge fails in:
//
//   - every not-paying state (no sub, canceled, past_due, unknown tier,
//     missing tenant) must resolve DOWN to the free tier, never up
//   - the seat cap must count outstanding invites, not just members,
//     or a 1-seat workspace can invite its way past the cap
//   - soft mode must warn and pass; enforced mode must throw
//
// The catalog-shape block at the bottom is a regression guard: these
// caps decide who can add a user, so an accidental edit that makes a
// cheaper tier more generous than a dearer one should fail here.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/db", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    tenantMembership: { count: vi.fn() },
    tenantInvite: { count: vi.fn() },
    legalEntity: { count: vi.fn() },
  },
}));

import {
  getEffectivePlan,
  getTenantLimits,
  assertCanInviteUser,
  assertCanCreateEntity,
  PlanLimitExceededError,
} from "@/lib/billing/limits";
import { FREE_TIER, PLANS, findPlan, findPlanByPriceId } from "@/lib/billing/plans";
import { prisma } from "@/lib/db";

const origEnforce = process.env.BILLING_ENFORCE_LIMITS;
const TENANT_ID = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.BILLING_ENFORCE_LIMITS;
});

afterEach(() => {
  if (origEnforce != null) process.env.BILLING_ENFORCE_LIMITS = origEnforce;
  else delete process.env.BILLING_ENFORCE_LIMITS;
});

function setTenant(billingPlan: string | null, subscriptionStatus: string | null) {
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue({
    billingPlan,
    subscriptionStatus,
  } as never);
}

describe("getEffectivePlan — every ambiguous state resolves DOWN", () => {
  it("no subscription → free", async () => {
    setTenant(null, null);
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("free");
  });

  it("canceled → free even though billingPlan still names a tier", async () => {
    setTenant("starter", "canceled");
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("free");
  });

  it("past_due → free (card failed; stop extending paid capacity)", async () => {
    setTenant("growth", "past_due");
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("free");
  });

  it("a tier we no longer sell → free, not a throw", async () => {
    setTenant("deprecated-tier", "active");
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("free");
  });

  it("tenant row missing → free", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null);
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("free");
  });

  it("active → the paid plan", async () => {
    setTenant("growth", "active");
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("growth");
  });

  it("trialing → the paid plan", async () => {
    setTenant("scale", "trialing");
    expect((await getEffectivePlan(TENANT_ID)).key).toBe("scale");
  });
});

describe("assertCanInviteUser", () => {
  function setCounts(members: number, pendingInvites: number) {
    vi.mocked(prisma.tenantMembership.count).mockResolvedValue(members);
    vi.mocked(prisma.tenantInvite.count).mockResolvedValue(pendingInvites);
  }

  it("passes below the cap", async () => {
    setTenant(null, null); // free: 3 seats
    setCounts(2, 0);
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
  });

  it("counts PENDING invites toward the cap", async () => {
    // 2 members + 1 outstanding invite = 3 committed seats on a 3-seat
    // plan. Counting only members here would let the workspace end up
    // with 4 people once the invite is accepted.
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant(null, null);
    setCounts(2, 1);
    await expect(assertCanInviteUser(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("throws at the starter cap of 1", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant("starter", "active");
    setCounts(1, 0);
    await expect(assertCanInviteUser(TENANT_ID)).rejects.toThrow(
      /Users limit reached on the starter plan \(1 of 1\)/
    );
  });

  it("never throws on an unlimited plan", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant("scale", "active");
    setCounts(9999, 0);
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
  });

  it("soft mode warns and passes at the cap", async () => {
    setTenant("starter", "active");
    setCounts(1, 0);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(assertCanInviteUser(TENANT_ID)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("would-block user invite")
    );
    warn.mockRestore();
  });
});

describe("assertCanCreateEntity", () => {
  const setEntities = (n: number) =>
    vi.mocked(prisma.legalEntity.count).mockResolvedValue(n);

  it("passes below the free cap of 5", async () => {
    setTenant(null, null);
    setEntities(4);
    await expect(assertCanCreateEntity(TENANT_ID)).resolves.toBeUndefined();
  });

  it("throws at the free cap of 5", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant(null, null);
    setEntities(5);
    await expect(assertCanCreateEntity(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("growth passes at 24 and throws at 25", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant("growth", "active");
    setEntities(24);
    await expect(assertCanCreateEntity(TENANT_ID)).resolves.toBeUndefined();
    setEntities(25);
    await expect(assertCanCreateEntity(TENANT_ID)).rejects.toThrow(
      PlanLimitExceededError
    );
  });

  it("never throws on an unlimited plan", async () => {
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant("scale", "active");
    setEntities(9999);
    await expect(assertCanCreateEntity(TENANT_ID)).resolves.toBeUndefined();
  });

  it("a tenant already OVER its cap is refused the next add, never trimmed", async () => {
    // The downgrade case: 40 entities on a plan that allows 25. The
    // contract is "refuse the 41st", not "delete 15".
    process.env.BILLING_ENFORCE_LIMITS = "true";
    setTenant("growth", "active");
    setEntities(40);
    await expect(assertCanCreateEntity(TENANT_ID)).rejects.toThrow(
      /Legal entities limit reached/
    );
    // Nothing here deletes; the helper only counts and throws.
    expect(vi.mocked(prisma.legalEntity.count)).toHaveBeenCalled();
  });
});

describe("getTenantLimits", () => {
  it("reports usage against the effective plan and flags at-cap", async () => {
    setTenant("starter", "active");
    vi.mocked(prisma.tenantMembership.count).mockResolvedValue(1);
    vi.mocked(prisma.legalEntity.count).mockResolvedValue(1);

    const view = await getTenantLimits(TENANT_ID);
    expect(view.plan.key).toBe("starter");
    expect(view.users).toEqual({ current: 1, cap: 1, atLimit: true });
    expect(view.entities).toEqual({ current: 1, cap: 3, atLimit: false });
  });

  it("unlimited caps are never at-limit", async () => {
    setTenant("scale", "active");
    vi.mocked(prisma.tenantMembership.count).mockResolvedValue(500);
    vi.mocked(prisma.legalEntity.count).mockResolvedValue(500);

    const view = await getTenantLimits(TENANT_ID);
    expect(view.users.cap).toBeNull();
    expect(view.users.atLimit).toBe(false);
    expect(view.entities.atLimit).toBe(false);
  });
});

describe("plan catalog shape", () => {
  it("free tier is 3 users / 5 entities", () => {
    expect(FREE_TIER.maxUsers).toBe(3);
    expect(FREE_TIER.maxEntities).toBe(5);
  });

  it("caps never shrink as you move up a tier", () => {
    const ordered = [...PLANS].sort((a, b) => a.order - b.order);
    for (let i = 0; i < ordered.length - 1; i++) {
      const here = ordered[i];
      const next = ordered[i + 1];
      for (const field of ["maxUsers", "maxEntities"] as const) {
        const a = here[field];
        const b = next[field];
        if (a == null && b != null) {
          throw new Error(
            `${here.key}.${field} is unlimited but the dearer ${next.key} is finite`
          );
        }
        if (a != null && b != null) {
          expect(a, `${here.key}.${field} <= ${next.key}.${field}`).toBeLessThanOrEqual(b);
        }
      }
    }
  });

  it("findPlan returns null for unknown / empty keys", () => {
    expect(findPlan("nonexistent")).toBeNull();
    expect(findPlan(null)).toBeNull();
    expect(findPlan(undefined)).toBeNull();
  });

  it("findPlanByPriceId never matches an unconfigured plan on a null id", () => {
    // Every plan has priceId null in test (no STRIPE_PRICE_* env). A
    // null/absent price id must not collide with them, or an event
    // carrying no price would entitle whichever tier sorted first.
    expect(PLANS.every((p) => p.priceId === null)).toBe(true);
    expect(findPlanByPriceId(null)).toBeNull();
    expect(findPlanByPriceId(undefined)).toBeNull();
    expect(findPlanByPriceId("price_nope")).toBeNull();
  });
});
