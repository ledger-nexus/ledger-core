"use server";

// Pad a balance assertion — post the adjusting entry that makes it true.
//
// The classic use is OPENING BALANCES: you know an account held X on the day
// you started keeping books, but you have no source transactions behind it.
// Assert the balance, then pad it against an equity account, and the ledger
// carries a real, auditable entry instead of a hand-keyed plug.
//
// Deliberate divergence from Beancount, where `pad` silently inserts a
// transaction: here it is an explicit, human-triggered, audited posting that
// flows through postJournalEntry like every other write (CLAUDE.md #2/#3).
// Nothing auto-pads.
//
// Direction is DERIVED, never supplied. The delta (expected − observed) plus
// the account's own normalBalance determine which side moves:
//
//   normal DEBIT  (asset/expense),  short  -> Dr account / Cr pad account
//   normal DEBIT,                   over   -> Cr account / Dr pad account
//   normal CREDIT (liability/equity/revenue), short -> Cr account / Dr pad
//   normal CREDIT,                  over   -> Dr account / Cr pad
//
// Idempotency is enforced by the DATABASE, not by a status flag: the entry
// carries lineage (SUBSTRATE / BalanceAssertion.pad / <assertionId>), and the
// gl_entry_header_lineage_uniq partial unique index means a second pad of the
// same assertion fails with P2002. One assertion, at most one pad.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { Prisma } from "@prisma/client";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { getTrialBalance } from "@/lib/accounting/reports";
import { resolveTolerance, evaluateAssertion } from "@/lib/accounting/balance-assertions";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction, auditAccessDenied } from "@/lib/audit/log";
import { prisma } from "@/lib/db";
import { withTenantContext } from "@/lib/tenant-context";

export interface PadBalanceAssertionInput {
  /** The assertion to satisfy. */
  assertionId: string;
  /** Account the balancing side is booked to — typically an equity account. */
  padAccountCode: string;
  /**
   * Document date for the padding entry. ISO YYYY-MM-DD. Defaults to the
   * assertion's asOf. Must not be AFTER asOf, or the entry falls outside the
   * window the assertion measures and the assertion still fails.
   */
  documentDate?: string;
  memo?: string;
}

export interface PadBalanceAssertionState {
  ok: boolean;
  message?: string;
  entryId?: string;
  entryNumber?: string;
}

export async function padBalanceAssertionAction(
  input: PadBalanceAssertionInput
): Promise<PadBalanceAssertionState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch {
    await auditAccessDenied({
      attemptedAction: "pad-balance-assertion",
      reason: "Not authenticated",
      resource: "BalanceAssertion",
      resourceId: input.assertionId,
    });
    return { ok: false, message: "You must be signed in." };
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant." };
  }

  const padAccountCode = input.padAccountCode?.trim();
  if (!padAccountCode) {
    return { ok: false, message: "A pad (balancing) account code is required." };
  }

  // Tenant-scoped lookup — a forged id from another tenant reads as not found.
  const assertion = await prisma.balanceAssertion.findFirst({
    where: { id: input.assertionId, tenantId: tenant.id },
    include: {
      account: { select: { code: true, normalBalance: true } },
      entity: { select: { code: true } },
      book: { select: { code: true } },
    },
  });
  if (!assertion) {
    return { ok: false, message: "Balance assertion not found in this tenant." };
  }

  if (assertion.account.code === padAccountCode) {
    return { ok: false, message: "The pad account must differ from the asserted account." };
  }

  const documentDate = input.documentDate ? new Date(input.documentDate) : assertion.asOf;
  if (isNaN(documentDate.getTime())) {
    return { ok: false, message: "documentDate must be a valid date (YYYY-MM-DD)." };
  }
  if (documentDate > assertion.asOf) {
    return {
      ok: false,
      message: "The padding entry must be dated on or before the assertion's asOf date.",
    };
  }

  // Recompute the observed balance now — never pad from the cached result,
  // which may predate later postings.
  const tb = await getTrialBalance(
    prisma,
    {
      entityCode: assertion.entity.code,
      bookCode: assertion.book.code,
      tenantId: tenant.id,
    },
    assertion.asOf
  );
  const observed =
    tb.rows.find((r) => r.accountCode === assertion.account.code)?.balance ?? new Decimal(0);

  const currency = await prisma.currency.findUnique({
    where: { code: assertion.currencyId },
    select: { decimals: true },
  });
  const expected = new Decimal(assertion.expectedAmount.toString());
  const tolerance = resolveTolerance(
    assertion.tolerance != null ? new Decimal(assertion.tolerance.toString()) : null,
    currency?.decimals ?? 2
  );
  const { delta, status } = evaluateAssertion(expected, observed, tolerance);

  if (status === "PASS") {
    return {
      ok: false,
      message: `Assertion already holds (${assertion.account.code} = ${observed.toFixed(2)} as of ${assertion.asOf.toISOString().slice(0, 10)}) — nothing to pad.`,
    };
  }

  // delta = observed − expected. A NEGATIVE delta means the account is SHORT
  // of the asserted balance and needs more on its normal side.
  const short = delta.isNegative();
  const amount = delta.abs().toString();
  // Balances (and expectedAmount) are stated on the account's normal side, so
  // an account that is SHORT needs more of its normal side and an account that
  // is OVER needs the mirror. Normal side is a debit for DEBIT-normal accounts
  // and a credit for CREDIT-normal ones — hence the flip on the credit branch.
  const accountIsDebited =
    assertion.account.normalBalance === "DEBIT" ? short : !short;

  const lines = accountIsDebited
    ? [
        { accountCode: assertion.account.code, debit: amount, description: "Balance assertion pad" },
        { accountCode: padAccountCode, credit: amount, description: "Pad offset" },
      ]
    : [
        { accountCode: assertion.account.code, credit: amount, description: "Balance assertion pad" },
        { accountCode: padAccountCode, debit: amount, description: "Pad offset" },
      ];

  let entry: { id: string; entryNumber: string };
  try {
    entry = await withTenantContext(prisma, tenant.id, async (tx) =>
      postJournalEntry(tx, {
        tenantId: tenant.id,
        entityCode: assertion.entity.code,
        bookCode: assertion.book.code,
        currencyCode: assertion.currencyId,
        documentDate,
        postingDate: documentDate,
        memo:
          input.memo?.trim() ||
          `Pad ${assertion.account.code} to ${expected.toFixed(2)} as of ${assertion.asOf.toISOString().slice(0, 10)}`,
        // Engine-composed lines (the human chose the assertion and the pad
        // account; the substrate derived the sides and the amount). Matches
        // reverse / reclassify; the audit row records who triggered it.
        source: "SYSTEM",
        createdBy: user.email,
        ownerUserId: user.id,
        // Lineage doubles as the idempotency key — see the header note.
        sourceSystem: "SUBSTRATE",
        sourceRecordType: "BalanceAssertion.pad",
        sourceRecordId: assertion.id,
        lines,
      })
    );
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, message: "This assertion has already been padded." };
    }
    if (e instanceof NotAuthenticatedError) {
      return { ok: false, message: "You must be signed in." };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Unknown error posting the padding entry.",
    };
  }

  // Best-effort cache refresh so the assertion reads PASS immediately. The
  // entry is the substrate fact; a stale cache is cosmetic, so never fail here.
  try {
    await prisma.balanceAssertion.update({
      where: { id: assertion.id },
      data: {
        lastCheckedAt: new Date(),
        lastObservedAmount: expected.toFixed(4),
        lastStatus: "PASS",
      },
    });
  } catch {
    // Non-fatal: the next checker run recomputes it.
  }

  await auditPrivilegedAction({
    actor: user,
    action: "pad-balance-assertion",
    resource: "BalanceAssertion",
    resourceId: assertion.id,
    tenantId: tenant.id,
    metadata: {
      accountCode: assertion.account.code,
      padAccountCode,
      asOf: assertion.asOf.toISOString().slice(0, 10),
      expected: expected.toFixed(2),
      observed: observed.toFixed(2),
      padAmount: new Decimal(amount).toFixed(2),
      entryNumber: entry.entryNumber,
    },
  });

  revalidatePath("/journal-entries");
  return {
    ok: true,
    entryId: entry.id,
    entryNumber: entry.entryNumber,
    message: `Padded ${assertion.account.code} by ${new Decimal(amount).toFixed(2)} → ${entry.entryNumber}.`,
  };
}
