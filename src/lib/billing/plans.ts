// Plan catalog — the source of truth for what each tier is allowed to
// do. Two things live here and nothing else: the marketing copy the
// billing page renders, and the caps that limits.ts enforces.
//
// Why a TS catalog instead of fetching from Stripe: the caps are the
// interesting part and Stripe doesn't model them. Pricing changes are
// rare, and "are we still selling this tier?" is exactly the kind of
// question that deserves a code change and a PR rather than a dashboard
// click nobody reviews.
//
// Why price ids come from env: dev / staging / prod each have their own
// Stripe account with different price ids, and production price ids do
// not belong in a public repo. A plan with no configured price id
// renders as "not configured" and its Subscribe button never appears —
// which is the state this whole module ships in until someone sets the
// env vars.
//
// Deliberately NOT here (they were on the #46 branch and came out):
// per-plan AI spend caps and companion-repo entitlements. ledger-core
// has no AI-budget surface and no cross-repo enforcement, so both would
// have been claims on a billing page that nothing could back up.

export interface Plan {
  /** Stable internal key. Mirror this into the Stripe Price's lookup_key. */
  key: string;
  /** Display name on the billing page. */
  label: string;
  /** One-line description for the plan card. */
  description: string;
  /** Display price, e.g. "$49 / month". UI-only — Stripe's Price is authoritative. */
  displayPrice: string;
  /** Stripe Price id (price_...), read from env at module load. */
  priceId: string | null;
  /** Sort order in the plan picker. */
  order: number;

  // ─── Enforced caps ────────────────────────────────────────────────
  //
  // null = unlimited. These bite at write time only: a tenant over its
  // cap (because it downgraded) keeps every row it has and is simply
  // refused the NEXT one. A plan cap must never become a data-loss
  // event. See limits.ts.

  /** Max TenantMembership rows, counting outstanding PENDING invites. */
  maxUsers: number | null;
  /** Max LegalEntity rows in the tenant. */
  maxEntities: number | null;
}

/**
 * The implicit "no subscription" tier. Every tenant resolves here when
 * billingPlan is null, when the subscription is canceled or past_due,
 * or when billingPlan names a tier that no longer exists in this
 * catalog. Generous enough to actually evaluate the product on a real
 * set of books.
 */
export const FREE_TIER: Plan = {
  key: "free",
  label: "Free",
  description: "Evaluation tier. Limited users and legal entities.",
  displayPrice: "$0 / month",
  priceId: null,
  order: 0,
  maxUsers: 3,
  maxEntities: 5,
};

function fromEnv(key: string): string | null {
  const v = process.env[key];
  return v && v.trim().length > 0 ? v : null;
}

// NOTE: the dollar figures below are placeholders carried over from the
// #46 branch. They are display-only strings — nothing charges from them,
// and the Stripe Price is what a customer would actually be billed. Set
// real numbers here at the same time you create the Stripe Prices.
export const PLANS: Plan[] = [
  {
    key: "starter",
    label: "Starter",
    description:
      "One user, three entities, full multi-book GL. For a solo practitioner running one client's books.",
    displayPrice: "$49 / month",
    priceId: fromEnv("STRIPE_PRICE_STARTER"),
    order: 1,
    maxUsers: 1,
    maxEntities: 3,
  },
  {
    key: "growth",
    label: "Growth",
    description:
      "Up to 5 users and 25 entities. For a small firm with a team on the close.",
    displayPrice: "$199 / month",
    priceId: fromEnv("STRIPE_PRICE_GROWTH"),
    order: 2,
    maxUsers: 5,
    maxEntities: 25,
  },
  {
    key: "scale",
    label: "Scale",
    description:
      "Unlimited users and entities. For firms consolidating many books.",
    displayPrice: "$799 / month",
    priceId: fromEnv("STRIPE_PRICE_SCALE"),
    order: 3,
    maxUsers: null,
    maxEntities: null,
  },
];

export function findPlan(key: string | null | undefined): Plan | null {
  if (!key) return null;
  return PLANS.find((p) => p.key === key) ?? null;
}

/**
 * Reverse-map a Stripe Price id back to a plan. Only matches plans whose
 * price id is actually configured — an unconfigured plan has priceId
 * null and must never match a null/absent lookup.
 */
export function findPlanByPriceId(priceId: string | null | undefined): Plan | null {
  if (!priceId) return null;
  return PLANS.find((p) => p.priceId === priceId) ?? null;
}
