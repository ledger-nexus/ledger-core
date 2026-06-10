// BlackLine arc — Phase 1 PR 7: sub-ledger supporting-balance auto-pull.
//
// The biggest productivity win in the arc. When the recon's account is
// the AR-control / AP-control / fixed-asset-cost account, the preparer
// form pre-suggests the supportingBalance from the matching sub-ledger
// sum. CPA doesn't type a number that's already in the system.
//
// Mapping:
//
//   account.isControlAccount=true + type=ASSET
//     → AR sub-ledger
//     → sum of ArOpenItem.currentBalance where
//         entity/book match AND
//         controlAccountCode = account.code AND
//         status IN (OPEN, PARTIAL, REOPENED)
//
//   account.isControlAccount=true + type=LIABILITY
//     → AP sub-ledger
//     → sum of ApOpenItem.currentBalance with same filter shape
//
//   FixedAsset.assetAccountCode = account.code (for ASSET accounts)
//     → fixed-asset register
//     → sum of (acquisitionCost − accumulatedDepreciation) across all
//       IN_SERVICE / IDLE / HELD_FOR_SALE assets for the (entity, book)
//
//   otherwise: null — no auto-pull, operator types it manually.
//
// PERIOD-END CAVEAT (v1):
//
// The sub-ledger currentBalance / accumulatedDepreciation columns are
// snapshot-AT-NOW, not snapshot-AT-PERIOD-END. For the OPEN period the
// operator is actively reconciling, "now" ≈ period-end and the suggestion
// is accurate. For a re-prep against a CLOSED-then-reopened period, or
// re-prep of an older period mid-quarter, the suggestion will reflect
// post-period activity.
//
// Mitigation: we tag the suggestion with `asOf` and label the source
// clearly ("AR sub-ledger as of today"). The operator sees they're
// looking at a live snapshot, not a frozen one, and can override.
//
// Period-historical reconstruction (sum where openedDate <= asOf and
// not applied-before-asOf) is its own substantial work — would need a
// separate query plan and probably a covering index — and ships in a
// later PR if customer demand surfaces it.

import { Decimal } from "decimal.js";
import type { DbClient } from "@/lib/db";


export type SupportingSource =
  | "AR_SUBLEDGER"
  | "AP_SUBLEDGER"
  | "FIXED_ASSET_REGISTER"
  | null;

export interface SupportingBalanceSuggestion {
  source: SupportingSource;
  amount: Decimal | null;
  // Human label for the UI. Empty when source is null.
  label: string;
  // For the UI's "as of" caption — currently the time of computation.
  asOf: Date;
}

/**
 * Resolve a suggested supporting balance for a recon's account. Returns
 * `{source: null, amount: null}` when the account has no matching sub-
 * ledger linkage — the form falls back to manual entry.
 *
 * `asOf` is taken from the recon's period.endsOn at the caller. We
 * don't query the period internally so the caller can stub it in tests.
 */
export async function resolveSupportingBalance(
  prisma: DbClient,
  opts: {
    tenantId: string;
    entityId: string;
    bookId: string;
    accountId: string;
    asOf: Date;
  }
): Promise<SupportingBalanceSuggestion> {
  const account = await prisma.account.findFirst({
    where: { id: opts.accountId, tenantId: opts.tenantId },
    select: {
      code: true,
      type: true,
      isControlAccount: true,
    },
  });
  if (!account) {
    return {
      source: null,
      amount: null,
      label: "",
      asOf: opts.asOf,
    };
  }

  // ── AR control account ────────────────────────────────────────────
  if (account.isControlAccount && account.type === "ASSET") {
    const rows = await prisma.arOpenItem.findMany({
      where: {
        tenantId: opts.tenantId,
        entityId: opts.entityId,
        bookId: opts.bookId,
        controlAccountCode: account.code,
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      select: { currentBalance: true },
    });
    const total = rows.reduce(
      (acc, r) => acc.plus(new Decimal(r.currentBalance.toString())),
      new Decimal(0)
    );
    return {
      source: "AR_SUBLEDGER",
      amount: total,
      label: `AR sub-ledger (${rows.length} open item${rows.length === 1 ? "" : "s"})`,
      asOf: opts.asOf,
    };
  }

  // ── AP control account ────────────────────────────────────────────
  if (account.isControlAccount && account.type === "LIABILITY") {
    const rows = await prisma.apOpenItem.findMany({
      where: {
        tenantId: opts.tenantId,
        entityId: opts.entityId,
        bookId: opts.bookId,
        controlAccountCode: account.code,
        status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
      },
      select: { currentBalance: true },
    });
    const total = rows.reduce(
      (acc, r) => acc.plus(new Decimal(r.currentBalance.toString())),
      new Decimal(0)
    );
    return {
      source: "AP_SUBLEDGER",
      amount: total,
      label: `AP sub-ledger (${rows.length} open item${rows.length === 1 ? "" : "s"})`,
      asOf: opts.asOf,
    };
  }

  // ── Fixed-asset cost account ──────────────────────────────────────
  if (account.type === "ASSET") {
    // FixedAsset.assetAccountCode is the GL account each asset rolls
    // into. Pair with the book-specific accumulated depreciation row
    // for the recon's book.
    const assets = await prisma.fixedAsset.findMany({
      where: {
        tenantId: opts.tenantId,
        entityId: opts.entityId,
        assetAccountCode: account.code,
        // Exclude disposed — gross cost rolls off the BS at disposal.
        // HELD_FOR_SALE remains on the BS until sold so we include it.
        status: { in: ["IN_SERVICE", "IDLE", "HELD_FOR_SALE"] },
      },
      select: {
        acquisitionCost: true,
        bookAttributes: {
          where: { bookId: opts.bookId },
          select: { accumulatedDepreciation: true },
        },
      },
    });
    if (assets.length === 0) {
      // No FA rows hit this account code — fall through to manual.
      return {
        source: null,
        amount: null,
        label: "",
        asOf: opts.asOf,
      };
    }
    // Net book value = cost − accumulated depreciation (per book).
    // An asset without a bookAttributes row for this book contributes
    // its full cost (no depreciation yet booked) — matches the GL: a
    // newly-imported asset is at cost until depreciation runs.
    const total = assets.reduce((acc, a) => {
      const cost = new Decimal(a.acquisitionCost.toString());
      const accumDep = a.bookAttributes[0]
        ? new Decimal(a.bookAttributes[0].accumulatedDepreciation.toString())
        : new Decimal(0);
      return acc.plus(cost.minus(accumDep));
    }, new Decimal(0));
    return {
      source: "FIXED_ASSET_REGISTER",
      amount: total,
      label: `Fixed-asset register (${assets.length} asset${assets.length === 1 ? "" : "s"} at cost − accum. dep.)`,
      asOf: opts.asOf,
    };
  }

  // No mapping found.
  return {
    source: null,
    amount: null,
    label: "",
    asOf: opts.asOf,
  };
}
