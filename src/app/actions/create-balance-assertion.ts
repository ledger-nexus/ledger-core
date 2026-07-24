"use server";

// Record a balance assertion — "this account held exactly this much on this
// date."
//
// This is the missing half of the assertions feature: `checkBalanceAssertions`
// could evaluate assertions and `padBalanceAssertionAction` could satisfy one,
// but nothing could CREATE one, so the tripwire was never armed.
//
// An assertion is a claim about the past, so it is deliberately NOT a ledger
// write — nothing is posted here. It states what you believe the balance was;
// the checker compares that against what the books actually say. Correcting a
// disagreement is a separate, explicit act (pad, or a real correcting entry).
//
// The asOf date means END of day, matching getTrialBalance and the checker.
// Beancount asserts at the START of the date; the divergence is deliberate and
// documented in balance-assertions.ts.

import { revalidatePath } from "next/cache";
import { Decimal } from "decimal.js";
import { Prisma } from "@prisma/client";
import {
  requireCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction, auditAccessDenied } from "@/lib/audit/log";
import { prisma } from "@/lib/db";

export interface CreateBalanceAssertionInput {
  entityCode: string;
  bookCode: string;
  accountCode: string;
  /** ISO YYYY-MM-DD. End of day. */
  asOf: string;
  /** As stated on the account's NORMAL side (a positive asset balance is a debit). */
  expectedAmount: string;
  /** Omit to derive from the currency's precision (USD → 0.01). */
  tolerance?: string;
}

export interface CreateBalanceAssertionState {
  ok: boolean;
  message?: string;
  assertionId?: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function createBalanceAssertionAction(
  input: CreateBalanceAssertionInput
): Promise<CreateBalanceAssertionState> {
  let user;
  try {
    user = await requireCurrentUser();
  } catch (e) {
    if (e instanceof NotAuthenticatedError) {
      await auditAccessDenied({
        attemptedAction: "create-balance-assertion",
        actor: null,
        reason: "Not authenticated",
        resource: "BalanceAssertion",
      });
      return { ok: false, message: "You must be signed in." };
    }
    throw e;
  }

  let tenant;
  try {
    tenant = await requireCurrentTenant();
  } catch {
    return { ok: false, message: "No active tenant." };
  }

  const entityCode = input.entityCode?.trim();
  const bookCode = input.bookCode?.trim();
  const accountCode = input.accountCode?.trim();
  if (!entityCode || !bookCode || !accountCode) {
    return { ok: false, message: "Entity, book, and account are all required." };
  }
  if (!ISO_DATE.test(input.asOf ?? "")) {
    return { ok: false, message: "Date must be YYYY-MM-DD." };
  }

  // Reject unparseable amounts rather than coercing them: `new Decimal("abc")`
  // throws, and a silently-zeroed expectation would assert something the user
  // never claimed.
  let expected: Decimal;
  try {
    expected = new Decimal(input.expectedAmount);
  } catch {
    return { ok: false, message: "Expected amount must be a number." };
  }
  if (!expected.isFinite()) {
    return { ok: false, message: "Expected amount must be a finite number." };
  }

  let tolerance: Decimal | null = null;
  if (input.tolerance != null && input.tolerance.trim() !== "") {
    try {
      tolerance = new Decimal(input.tolerance);
    } catch {
      return { ok: false, message: "Tolerance must be a number." };
    }
    if (!tolerance.isFinite() || tolerance.isNegative()) {
      return { ok: false, message: "Tolerance must be zero or positive." };
    }
  }

  // Tenant-pinned: entity codes are unique only per (tenantId, code), so an
  // unpinned lookup can resolve another tenant's entity and file the assertion
  // against the wrong books.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: entityCode, tenantId: tenant.id },
    select: { id: true, functionalCurrencyId: true },
  });
  if (!entity) return { ok: false, message: `Unknown entity ${entityCode}.` };

  const book = await prisma.book.findUnique({
    where: { code: bookCode },
    select: { id: true, reportingCurrencyId: true },
  });
  if (!book) return { ok: false, message: `Unknown book ${bookCode}.` };

  // Accounts are tenant-scoped; the shared chart carries entityId = null.
  const account = await prisma.account.findFirst({
    where: {
      code: accountCode,
      tenantId: tenant.id,
      OR: [{ entityId: entity.id }, { entityId: null }],
    },
    select: { id: true },
  });
  if (!account) return { ok: false, message: `Unknown account ${accountCode}.` };

  // v1 asserts in the book's reporting currency — the same currency the trial
  // balance the checker reads is expressed in. Asserting in anything else would
  // compare two different units.
  const currencyId = book.reportingCurrencyId;

  const asOf = new Date(`${input.asOf}T00:00:00.000Z`);
  if (Number.isNaN(asOf.getTime())) {
    return { ok: false, message: "Date is not a real calendar date." };
  }

  let assertionId: string;
  try {
    const created = await prisma.balanceAssertion.create({
      data: {
        tenantId: tenant.id,
        entityId: entity.id,
        bookId: book.id,
        accountId: account.id,
        currencyId,
        asOf,
        expectedAmount: expected.toFixed(4),
        tolerance: tolerance != null ? tolerance.toFixed(4) : null,
        createdBy: user.email,
      },
      select: { id: true },
    });
    assertionId = created.id;
  } catch (e) {
    // @@unique([entityId, bookId, accountId, currencyId, asOf]) — one claim per
    // account per date. A second claim would mean two contradictory truths
    // about the same balance.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return {
        ok: false,
        message: `An assertion already exists for ${accountCode} on ${input.asOf}. Delete it first if the figure changed.`,
      };
    }
    throw e;
  }

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    tenantId: tenant.id,
    action: "BALANCE_ASSERTION_CREATED",
    resource: "BalanceAssertion",
    resourceId: assertionId,
    metadata: {
      entityCode,
      bookCode,
      accountCode,
      asOf: input.asOf,
      // The asserted figure IS the point of the audit row — it is the claim
      // whose provenance matters later.
      expectedAmount: expected.toFixed(4),
      tolerance: tolerance != null ? tolerance.toFixed(4) : null,
    },
  });

  revalidatePath("/assertions");
  return { ok: true, assertionId };
}
