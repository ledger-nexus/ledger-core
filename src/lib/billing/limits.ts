// Plan-tier enforcement. One question, answered in one place: what is
// this tenant allowed to add right now?
//
//   getEffectivePlan(tenantId)   — Tenant's Stripe state → a Plan
//   getTenantLimits(tenantId)    — plan + current usage, for the UI
//   assertCanInviteUser(tenantId)   — throws PlanLimitExceededError
//   assertCanCreateEntity(tenantId) — throws PlanLimitExceededError
//
// Call the assert* helpers BEFORE creating the row, and let the error
// surface: its message names the cap and points at /admin/billing.
//
// Two posture decisions worth knowing before you change anything here:
//
// 1. Caps refuse the NEXT write; they never remove existing rows. A
//    tenant that upgrades to Scale, creates 40 entities, then downgrades
//    to Growth keeps all 40 and is refused the 41st. Turning a billing
//    downgrade into silent data loss is not a trade we make.
//
// 2. Enforcement is OFF unless BILLING_ENFORCE_LIMITS=true. In soft mode
//    the checks still run and log what they *would* have blocked, so the
//    operator can see the blast radius before flipping it on. Since no
//    tenant has a subscription yet, flipping it on today would cap every
//    existing workspace at the free tier — which is why the default is
//    off and the flip is a deliberate, separate act.

import { prisma } from "@/lib/db";
import { findPlan, FREE_TIER, type Plan } from "./plans";

export class PlanLimitExceededError extends Error {
  constructor(
    public readonly limit: "users" | "entities",
    public readonly currentUsage: number,
    public readonly cap: number,
    public readonly planKey: string
  ) {
    super(
      `${planLimitLabel(limit)} limit reached on the ${planKey} plan ` +
        `(${currentUsage} of ${cap}). Upgrade at /admin/billing to add more.`
    );
    this.name = "PlanLimitExceededError";
  }
}

function planLimitLabel(limit: PlanLimitExceededError["limit"]): string {
  switch (limit) {
    case "users":
      return "Users";
    case "entities":
      return "Legal entities";
  }
}

function isEnforcementOn(): boolean {
  return process.env.BILLING_ENFORCE_LIMITS === "true";
}

// ─── Plan resolution ──────────────────────────────────────────────────

/**
 * Effective plan for a tenant.
 *
 * Only `active` and `trialing` subscriptions entitle a paid plan.
 * `past_due` deliberately falls back to FREE_TIER: once Stripe has
 * exhausted its retries the card has failed, and continuing to hand out
 * paid capacity is how you accumulate unpaid usage. The Stripe portal
 * lets the customer fix the card, and the resulting webhook flips them
 * straight back.
 *
 * An unrecognized billingPlan (a tier we stopped selling, or a
 * hand-edited row) also resolves to FREE_TIER rather than throwing —
 * a stale catalog key must not take down every page that checks a cap.
 */
export async function getEffectivePlan(tenantId: string): Promise<Plan> {
  const t = await prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { billingPlan: true, subscriptionStatus: true },
  });
  if (!t) return FREE_TIER;
  const status = t.subscriptionStatus;
  if (status !== "active" && status !== "trialing") return FREE_TIER;
  return findPlan(t.billingPlan) ?? FREE_TIER;
}

// ─── Usage counts ─────────────────────────────────────────────────────

export interface TenantUsage {
  userCount: number;
  entityCount: number;
}

export async function getCurrentUsage(tenantId: string): Promise<TenantUsage> {
  const [userCount, entityCount] = await Promise.all([
    prisma.tenantMembership.count({ where: { tenantId } }),
    prisma.legalEntity.count({ where: { tenantId } }),
  ]);
  return { userCount, entityCount };
}

// ─── Resolved view for the billing page ───────────────────────────────

export interface TenantLimitsView {
  plan: Plan;
  usage: TenantUsage;
  users: { current: number; cap: number | null; atLimit: boolean };
  entities: { current: number; cap: number | null; atLimit: boolean };
}

export async function getTenantLimits(
  tenantId: string
): Promise<TenantLimitsView> {
  const [plan, usage] = await Promise.all([
    getEffectivePlan(tenantId),
    getCurrentUsage(tenantId),
  ]);
  return {
    plan,
    usage,
    users: {
      current: usage.userCount,
      cap: plan.maxUsers,
      atLimit: plan.maxUsers != null && usage.userCount >= plan.maxUsers,
    },
    entities: {
      current: usage.entityCount,
      cap: plan.maxEntities,
      atLimit: plan.maxEntities != null && usage.entityCount >= plan.maxEntities,
    },
  };
}

// ─── Write-time checks ────────────────────────────────────────────────

/**
 * Refuse a new seat when the tenant is at its user cap.
 *
 * Counts members PLUS outstanding PENDING invites. Counting only
 * members would let a 1-seat workspace send five invites and end up
 * with six people the moment they all accept — the cap has to bind on
 * committed seats, not occupied ones.
 */
export async function assertCanInviteUser(tenantId: string): Promise<void> {
  const plan = await getEffectivePlan(tenantId);
  if (plan.maxUsers == null) return; // unlimited
  const [memberCount, pendingInvites] = await Promise.all([
    prisma.tenantMembership.count({ where: { tenantId } }),
    prisma.tenantInvite.count({ where: { tenantId, status: "PENDING" } }),
  ]);
  const committed = memberCount + pendingInvites;
  if (committed < plan.maxUsers) return;
  if (!isEnforcementOn()) {
    console.warn(
      `[plan-limit] tenant=${tenantId} would-block user invite ` +
        `(${committed} >= ${plan.maxUsers} on ${plan.key}); soft mode`
    );
    return;
  }
  throw new PlanLimitExceededError("users", committed, plan.maxUsers, plan.key);
}

/**
 * Refuse a new legal entity when the tenant is at its entity cap.
 *
 * Known gap: the NetSuite multi-subsidiary import
 * (src/lib/mappers/netsuite/subsidiaries.ts) creates LegalEntity rows
 * through the mapper layer against the default tenant, not the session
 * tenant, and does not call this. A 30-subsidiary import walks past a
 * cap of 5. Closing that means giving the importer a session-tenant
 * seam, which is its own change — see the PR for the follow-up.
 */
export async function assertCanCreateEntity(tenantId: string): Promise<void> {
  const plan = await getEffectivePlan(tenantId);
  if (plan.maxEntities == null) return;
  const entityCount = await prisma.legalEntity.count({ where: { tenantId } });
  if (entityCount < plan.maxEntities) return;
  if (!isEnforcementOn()) {
    console.warn(
      `[plan-limit] tenant=${tenantId} would-block entity create ` +
        `(${entityCount} >= ${plan.maxEntities} on ${plan.key}); soft mode`
    );
    return;
  }
  throw new PlanLimitExceededError(
    "entities",
    entityCount,
    plan.maxEntities,
    plan.key
  );
}
