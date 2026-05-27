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
}

function fromEnv(key: string): string | null {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v : null;
}

export const PLANS: Plan[] = [
  {
    key: "starter",
    label: "Starter",
    description:
      "One workspace, one user, full multi-book GL. Best for solo CPAs validating with one client.",
    displayPrice: "$49 / month",
    priceId: fromEnv("STRIPE_PRICE_STARTER"),
    order: 1,
  },
  {
    key: "growth",
    label: "Growth",
    description:
      "Up to 5 users, unlimited entities, includes recon + revenue-rec + fa-amort companion repos.",
    displayPrice: "$199 / month",
    priceId: fromEnv("STRIPE_PRICE_GROWTH"),
    order: 2,
  },
  {
    key: "scale",
    label: "Scale",
    description:
      "Unlimited users, dedicated support, custom AI budget. Contact for SOC 2 attestation copy.",
    displayPrice: "$799 / month",
    priceId: fromEnv("STRIPE_PRICE_SCALE"),
    order: 3,
  },
];

export function findPlan(key: string | null | undefined): Plan | null {
  if (!key) return null;
  return PLANS.find((p) => p.key === key) ?? null;
}

export function findPlanByPriceId(priceId: string): Plan | null {
  return PLANS.find((p) => p.priceId === priceId) ?? null;
}
