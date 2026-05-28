// Plan-tier limit enforcement.
//
// One source of truth for "what can this tenant do?". Wraps the plan
// catalog with a friendly API:
//
//   - getTenantLimits(tenantId) — resolves the plan + returns its limits
//   - getCurrentUsage(tenantId) — counts users / entities / spend
//   - assertCanInviteUser(tenantId) — throws PlanLimitExceededError
//   - assertCanCreateEntity(tenantId) — throws PlanLimitExceededError
//
// Server Actions call the assert* helpers BEFORE creating the row.
// The PlanLimitExceededError surfaces with a message that names the
// limit + suggests upgrading.
//
// Enforcement posture:
//
//   - The first time a tenant hits a limit, we refuse the NEW write.
//   - Existing rows above the limit are NEVER retroactively removed —
//     a tenant that upgrades and then downgrades keeps their existing
//     entities; we just stop accepting new ones until they delete
//     enough to fit. This matches Stripe's metered-billing convention
//     and avoids weaponizing the cap into a data-loss event.
//
//   - The "ENFORCE" env flag lets you stage the rollout. With
//     BILLING_ENFORCE_LIMITS=false (default in dev), the checks run
//     and surface as warnings but never throw. With =true (recommended
//     in production), they throw. The flip from soft → hard is the
//     point where existing free-tier dev tenants would be impacted.

import { prisma } from "@/lib/db";
import { findPlan, FREE_TIER, type Plan } from "./plans";

export class PlanLimitExceededError extends Error {
  constructor(
    public readonly limit:
      | "users"
      | "entities"
      | "ai_spend"
      | "companion_repo",
    public readonly currentUsage: number | string,
    public readonly cap: number | string,
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
    case "users": return "Users";
    case "entities": return "Legal entities";
    case "ai_spend": return "Monthly AI spend";
    case "companion_repo": return "Companion repo access";
  }
}

function isEnforcementOn(): boolean {
  // Default OFF in dev so existing seeded tenants don't break. Flip
  // to ON in production via env. Staging can run with either depending
  // on what you're testing.
  return process.env.BILLING_ENFORCE_LIMITS === "true";
}

// ─── Plan resolution ─────────────────────────────────────────────────────

/**
 * Effective plan for a tenant. Tenants with a `billingPlan` set + an
 * `active` / `trialing` Stripe subscription get the paid plan.
 * Everyone else (no subscription, canceled, past_due) falls to FREE_TIER.
 *
 * past_due is a deliberate downgrade — once Stripe marks the
 * subscription past_due (payment failed N times), we refuse new
 * resource creation as if they were unsubscribed. The Stripe portal
 * lets them update their card and webhook flips them back.
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

// ─── Usage counts ────────────────────────────────────────────────────────

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

// ─── Resolved limits for the UI ──────────────────────────────────────────

export interface TenantLimitsView {
  plan: Plan;
  usage: TenantUsage;
  users: { current: number; cap: number | null; atLimit: boolean };
  entities: { current: number; cap: number | null; atLimit: boolean };
  aiSpendCapUsd: number | null;
  availableRepos: Plan["availableRepos"];
}

export async function getTenantLimits(tenantId: string): Promise<TenantLimitsView> {
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
    aiSpendCapUsd: plan.defaultAiSpendCapUsd,
    availableRepos: plan.availableRepos,
  };
}

// ─── Action-side checks ──────────────────────────────────────────────────

/**
 * Refuse new TenantMembership creation when the user count is at the
 * plan's cap. Counts both existing members AND outstanding PENDING
 * invites — otherwise you could blow the cap by sending five invites
 * to a 1-user plan and having them all accept simultaneously.
 */
export async function assertCanInviteUser(tenantId: string): Promise<void> {
  const plan = await getEffectivePlan(tenantId);
  if (plan.maxUsers == null) return; // unlimited
  const [memberCount, pendingInvites] = await Promise.all([
    prisma.tenantMembership.count({ where: { tenantId } }),
    prisma.tenantInvite.count({
      where: { tenantId, status: "PENDING" },
    }),
  ]);
  const committed = memberCount + pendingInvites;
  if (committed < plan.maxUsers) return;
  if (!isEnforcementOn()) {
    // Soft mode: log but don't throw. Lets dev see the limit fire
    // without breaking flows that pre-date enforcement.
    console.warn(
      `[plan-limit] tenant=${tenantId} would-block user invite ` +
        `(${committed} >= ${plan.maxUsers} on ${plan.key}); soft mode`
    );
    return;
  }
  throw new PlanLimitExceededError("users", committed, plan.maxUsers, plan.key);
}

/**
 * Refuse new LegalEntity creation when the entity count is at the
 * plan's cap.
 */
export async function assertCanCreateEntity(tenantId: string): Promise<void> {
  const plan = await getEffectivePlan(tenantId);
  if (plan.maxEntities == null) return;
  const entityCount = await prisma.legalEntity.count({
    where: { tenantId },
  });
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

/**
 * Refuse companion-repo access for plans that don't include it.
 * Today only used by the UI to hide unavailable surfaces — the
 * companion repos themselves don't yet check the plan. Cross-repo
 * enforcement is a follow-up: the companion repo's session helper
 * could call this through ledger-core's internal API.
 */
export async function assertRepoIncluded(
  tenantId: string,
  repo: Plan["availableRepos"][number]
): Promise<void> {
  const plan = await getEffectivePlan(tenantId);
  if (plan.availableRepos.includes(repo)) return;
  if (!isEnforcementOn()) {
    console.warn(
      `[plan-limit] tenant=${tenantId} would-block ${repo} access on ${plan.key}; soft mode`
    );
    return;
  }
  throw new PlanLimitExceededError(
    "companion_repo",
    repo,
    plan.availableRepos.join(", ") || "none",
    plan.key
  );
}
