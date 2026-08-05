// BlackLine arc — Phase 1 PR 2: resolve per-recon defaults via 3-level
// cascade.
//
// When a new Reconciliation is created, two fields need a starting value:
//
//   requiresReview  — single sign-off OR preparer→reviewer chain
//   tolerance       — $ diff allowed before status flips to EXCEPTION
//
// Resolution order (most specific wins):
//
//   1. Account.requiresReconReview / Account.reconTolerance
//      (set by the operator on individual accounts where the default
//      doesn't fit, e.g. "petty cash is always single sign-off"
//      or "cash always allows $1 rounding")
//   2. ReconciliationConfig.defaultRequiresReview / defaultTolerance
//      (per-tenant default)
//   3. BlackLine standard fallback: requiresReview=true, tolerance=0
//      (preparer→reviewer chain, must tie out exactly)
//
// The resolved value is FROZEN onto the Reconciliation row at create
// time. Changing the tenant default later doesn't retroactively flip
// in-flight or signed-off recons. Documented in
// docs/blackline-arc-design.md § "Sign-off resolution".

import { Decimal } from "@/lib/utils/decimal";
import type { DbClient } from "@/lib/db";


export interface ResolvedReconDefaults {
  requiresReview: boolean;
  tolerance: Decimal;
}

/**
 * Resolve the (requiresReview, tolerance) pair for a recon being opened
 * against a given (tenantId, accountId). Pure function with respect to
 * its inputs — but reads the Account row and the ReconciliationConfig
 * row to apply the cascade.
 */
export async function resolveReconDefaults(
  prisma: DbClient,
  tenantId: string,
  accountId: string
): Promise<ResolvedReconDefaults> {
  const [account, config] = await Promise.all([
    prisma.account.findFirst({
      where: { id: accountId, tenantId },
      select: { requiresReconReview: true, reconTolerance: true },
    }),
    prisma.reconciliationConfig.findUnique({
      where: { tenantId },
      select: { defaultRequiresReview: true, defaultTolerance: true },
    }),
  ]);

  if (!account) {
    throw new Error(`Account ${accountId} not found in tenant ${tenantId}`);
  }

  // requiresReview cascade.
  let requiresReview: boolean;
  if (account.requiresReconReview !== null) {
    requiresReview = account.requiresReconReview;
  } else if (config) {
    requiresReview = config.defaultRequiresReview;
  } else {
    requiresReview = true; // BlackLine standard.
  }

  // tolerance cascade. Stored as decimal.js for the math layer; the
  // Server Action persists it back to the Reconciliation row as a
  // Prisma Decimal.
  let tolerance: Decimal;
  if (account.reconTolerance !== null) {
    tolerance = new Decimal(account.reconTolerance.toString());
  } else if (config) {
    tolerance = new Decimal(config.defaultTolerance.toString());
  } else {
    tolerance = new Decimal(0); // BlackLine standard.
  }

  return { requiresReview, tolerance };
}
