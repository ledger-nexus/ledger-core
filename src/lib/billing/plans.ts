// Plan catalog. Source-of-truth for the plans the app surfaces to
// customers. The `priceId` field maps to a Stripe Price object (one
// per plan, monthly recurring). The mapping is configured in Stripe
// dashboard + mirrored here via env vars so the catalog is data-driven
// for the deploy.
//
// Why env-mapped instead of hardcoded price ids: dev / staging / prod
// each have their own Stripe accounts with different price ids. The
// codebase shouldn't carry production price ids.
//
// Why a TS catalog at all (instead of fetching from Stripe): pricing
// rarely changes, the UI needs the labels + descriptions which Stripe
// doesn't structure, and a code change is the right gating mechanism
// for "are we still selling X tier?".

export interface Plan {
  /** Stable internal key. Matches Stripe Price.lookup_key. */
  key: string;
  /** Display name on the billing page. */
  label: string;
  /** One-line description for the plan card. */
  description: string;
  /** Display price (e.g. "$49 / month"). UI-only — the source of truth is the Stripe Price. */
  displayPrice: string;
  /** Stripe Price id (price_...). Read from env at runtime. */
  priceId: string | null;
  /** UI: order in plan-picker grid. */
  order: number;

  // ─── Enforced limits ──────────────────────────────────────────────
  //
  // The Server Actions read these via getTenantLimits() in limits.ts.
  // null = unlimited. Limits apply at action time — they don't
  // retroactively suspend over-quota tenants; they just refuse the
  // NEXT add. Existing rows above the limit are grandfathered until
  // they're individually removed.

  /** Max active TenantMembership rows. null = unlimited. */
  maxUsers: number | null;
  /** Max LegalEntity rows in the tenant. null = unlimited. */
  maxEntities: number | null;
  /**
   * Default Anthropic spend cap when the tenant has no explicit
   * Tenant.monthlyAiSpendCapUsd override. null = unlimited (no cap).
   */
  defaultAiSpendCapUsd: number | null;
  /**
   * Which companion repos this tier unlocks. The companion repos
   * themselves do not yet enforce this — surface only on /admin/billing
   * for now. Cross-repo enforcement is a follow-up.
   */
  availableRepos: ReadonlyArray<"recon" | "revenue-rec" | "fa-amort" | "integrations">;
}

/**
 * The implicit "no subscription" tier. Every tenant gets these limits
 * when Tenant.billingPlan is null. Generous enough that a CPA can
 * actually evaluate the product, tight enough that a real workspace
 * has a reason to upgrade.
 */
export const FREE_TIER: Plan = {
  key: "free",
  label: "Free",
  description: "Evaluation tier. Limited users / entities / AI spend.",
  displayPrice: "$0 / month",
  priceId: null,
  order: 0,
  maxUsers: 3,
  maxEntities: 5,
  defaultAiSpendCapUsd: 10,
  availableRepos: ["recon"],
};

function fromEnv(key: string): string | null {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v : null;
}

export const PLANS: Plan[] = [
  {
    key: "starter",
    label: "Starter",
    description:
      "One user, three entities, full multi-book GL. Best for solo CPAs validating with one client.",
    displayPrice: "$49 / month",
    priceId: fromEnv("STRIPE_PRICE_STARTER"),
    order: 1,
    maxUsers: 1,
    maxEntities: 3,
    defaultAiSpendCapUsd: 25,
    availableRepos: ["recon"],
  },
  {
    key: "growth",
    label: "Growth",
    description:
      "Up to 5 users, 25 entities, includes recon + revenue-rec + fa-amort companion repos.",
    displayPrice: "$199 / month",
    priceId: fromEnv("STRIPE_PRICE_GROWTH"),
    order: 2,
    maxUsers: 5,
    maxEntities: 25,
    defaultAiSpendCapUsd: 150,
    availableRepos: ["recon", "revenue-rec", "fa-amort"],
  },
  {
    key: "scale",
    label: "Scale",
    description:
      "Unlimited users + entities, all companion repos, dedicated support. Contact for SOC 2 attestation copy.",
    displayPrice: "$799 / month",
    priceId: fromEnv("STRIPE_PRICE_SCALE"),
    order: 3,
    maxUsers: null,
    maxEntities: null,
    defaultAiSpendCapUsd: 500,
    availableRepos: ["recon", "revenue-rec", "fa-amort", "integrations"],
  },
];

export function findPlan(key: string | null | undefined): Plan | null {
  if (!key) return null;
  return PLANS.find((p) => p.key === key) ?? null;
}

export function findPlanByPriceId(priceId: string): Plan | null {
  return PLANS.find((p) => p.priceId === priceId) ?? null;
}
