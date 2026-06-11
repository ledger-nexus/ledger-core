// BlackLine arc — Phase 1 PR 6: auto-instantiate per-period reconciliations.
//
// `openPeriodReconciliations({entityId, bookId, periodId})` walks every
// active balance-sheet account for the scope, snapshots each account's
// GL balance as of the period's last day, resolves the requiresReview +
// tolerance cascade locally, and creates one OPEN Reconciliation row
// per account.
//
// Idempotent on the @@unique([entityId, bookId, periodId, accountId])
// composite — re-running for the same scope creates zero new rows and
// reports the existing count. CPAs can hit "Open recons for period" as
// often as they want without polluting.
//
// CALLED FROM:
//   - List page empty-state "Open recons for this period" button (PR 3
//     placeholder is replaced in this PR).
//   - Periods page (future enhancement — auto-fire on period-open).
//
// SOC 2:
//   CC6.1 every read + write tenant-scoped via tenant.id.
//   CC6.3 requires user + tenant. Wide privilege (creates N rows at
//         once) — bounded by the scope tuple the operator already
//         resolved, no cross-tenant or cross-book leakage possible.
//   CC6.8 Zod on input shape. Period-must-be-open check refuses to
//         instantiate against a CLOSED period (those should be frozen).
//   CC7.2 ONE PRIVILEGED_ACTION audit row per invocation, with the
//         created-account count + scope tuple in metadata. Per-row
//         audit would explode the log for a 50-account close; the
//         aggregate is enough for "who opened recons for which period
//         when" reconstruction.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Decimal } from "decimal.js";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { signFor } from "@/lib/accounting/types";

const Input = z.object({
  entityId: z.string().uuid(),
  bookId: z.string().uuid(),
  periodId: z.string().uuid(),
});

export type AutoOpenResult =
  | {
      ok: true;
      created: number;
      skipped: number; // already existed
      total: number; // total recons for this scope after the call
    }
  | { ok: false; code: string; error: string };

function fail(code: string, error: string): AutoOpenResult {
  return { ok: false, code, error };
}

export async function openPeriodReconciliations(
  input: z.infer<typeof Input>
): Promise<AutoOpenResult> {
  const parsed = Input.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      parsed.error.errors[0]?.message ?? "Invalid input"
    );
  }
  const { entityId, bookId, periodId } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  // Tenant-scope every FK. Cross-tenant attempts collapse to NOT_FOUND.
  const [entity, book, period] = await Promise.all([
    prisma.legalEntity.findFirst({
      where: { id: entityId, tenantId: tenant.id },
      select: { id: true, code: true },
    }),
    prisma.book.findFirst({ where: { id: bookId }, select: { id: true } }),
    prisma.period.findFirst({
      where: { id: periodId, tenantId: tenant.id },
      select: { id: true, code: true, endsOn: true },
    }),
  ]);
  if (!entity || !book || !period) {
    return fail("NOT_FOUND", "Entity, book, or period not found");
  }

  // Refuse to auto-open against a CLOSED period. The substrate's
  // postJournalEntry already blocks writes against closed periods, but
  // creating recon rows for a closed period would surface stale GL
  // balances and confuse the workflow — the close is the operator's
  // "done" signal.
  const close = await prisma.periodClose.findUnique({
    where: {
      entityId_bookId_periodId: {
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
      },
    },
    select: { closedAt: true },
  });
  if (close) {
    return fail(
      "PERIOD_CLOSED",
      "Cannot auto-open reconciliations for a closed period"
    );
  }

  // Pull every active BS account for (tenant, entity). Mirrors the
  // dedup logic in getTrialBalance: an entity-specific row at code X
  // overrides a shared (entityId=null) row at the same code.
  const rawAccounts = await prisma.account.findMany({
    where: {
      tenantId: tenant.id,
      active: true,
      type: { in: ["ASSET", "LIABILITY", "EQUITY"] },
      OR: [{ entityId: null }, { entityId: entity.id }],
    },
    select: {
      id: true,
      code: true,
      type: true,
      isContra: true,
      entityId: true,
      requiresReconReview: true,
      reconTolerance: true,
      lines: {
        where: {
          entry: {
            entityId: entity.id,
            bookId: book.id,
            documentDate: { lte: period.endsOn },
          },
        },
        select: { debit: true, credit: true },
      },
    },
  });

  // Dedup by code — entity-override wins over shared.
  const byCode = new Map<string, (typeof rawAccounts)[number]>();
  for (const a of rawAccounts) {
    const existing = byCode.get(a.code);
    if (!existing || (a.entityId !== null && existing.entityId === null)) {
      byCode.set(a.code, a);
    }
  }
  const accounts = Array.from(byCode.values());

  // One ReconciliationConfig lookup → applied to every account that
  // doesn't have its own Account-level override. Mirrors the per-recon
  // resolver in src/lib/recon/resolve-defaults.ts but batched.
  const config = await prisma.reconciliationConfig.findUnique({
    where: { tenantId: tenant.id },
    select: { defaultRequiresReview: true, defaultTolerance: true },
  });

  function resolveDefaults(acct: {
    requiresReconReview: boolean | null;
    reconTolerance: Prisma.Decimal | null;
  }): { requiresReview: boolean; tolerance: string } {
    let requiresReview: boolean;
    if (acct.requiresReconReview !== null) {
      requiresReview = acct.requiresReconReview;
    } else if (config) {
      requiresReview = config.defaultRequiresReview;
    } else {
      requiresReview = true;
    }
    let tolerance: string;
    if (acct.reconTolerance !== null) {
      tolerance = acct.reconTolerance.toString();
    } else if (config) {
      tolerance = config.defaultTolerance.toString();
    } else {
      tolerance = "0";
    }
    return { requiresReview, tolerance };
  }

  // Build the create payloads. GL balance = signed period-end balance
  // mirroring the trial-balance computation.
  const payloads: Prisma.ReconciliationCreateManyInput[] = accounts.map(
    (acct) => {
      let debit = new Decimal(0);
      let credit = new Decimal(0);
      for (const line of acct.lines) {
        debit = debit.plus(new Decimal(line.debit.toString()));
        credit = credit.plus(new Decimal(line.credit.toString()));
      }
      // signFor returns +1 for accounts whose normal balance is the
      // section's side, -1 for contra. ASSET/EQUITY normalBalance=DEBIT;
      // LIABILITY normalBalance=CREDIT. A contra-asset flips sign.
      const normal = signFor(acct.type, acct.isContra);
      const glBalance =
        normal === 1 ? debit.minus(credit) : credit.minus(debit);
      const defaults = resolveDefaults(acct);
      return {
        tenantId: tenant.id,
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
        accountId: acct.id,
        glBalance: glBalance.toString() as unknown as Prisma.Decimal,
        tolerance: defaults.tolerance as unknown as Prisma.Decimal,
        requiresReview: defaults.requiresReview,
        status: "OPEN" as const,
      };
    }
  );

  // createMany with skipDuplicates gives us O(1) idempotency on the
  // composite @@unique. The DB enforces the dedup; we don't preflight-
  // query existence per account.
  const result = await prisma.reconciliation.createMany({
    data: payloads,
    skipDuplicates: true,
  });

  // Count total recons for the scope after the call so the operator
  // sees "23 recons open" instead of just "5 created."
  const total = await prisma.reconciliation.count({
    where: {
      tenantId: tenant.id,
      entityId: entity.id,
      bookId: book.id,
      periodId: period.id,
    },
  });

  // One audit row for the whole batch. Per-row would balloon the log
  // (50 rows × 1 invocation = 50 audit rows for a single click).
  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.period.auto-open",
    resource: "Reconciliation",
    resourceId: `${entity.code}/${period.code}`,
    tenantId: tenant.id,
    metadata: {
      entityId,
      bookId,
      periodId,
      accountsConsidered: accounts.length,
      created: result.count,
      total,
    },
  });

  revalidatePath(`/close/reconciliations`);

  return {
    ok: true,
    created: result.count,
    skipped: payloads.length - result.count,
    total,
  };
}
