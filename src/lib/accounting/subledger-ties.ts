// Sub-ledger reconciliation enforcement.
//
// Every month a CPA manually verifies "does the AR control account
// balance on the trial balance match the sum of open AR items in the
// sub-ledger?" Same for AP. If they don't tie, something is wrong —
// either the sub-ledger missed a write, or a JE was posted directly to
// the control account without flowing through the sub-ledger boundary.
//
// We compute BOTH sides already — `openArBalance` / `openApBalance` for
// the sub-ledger side, and `getTrialBalance` / `getBalanceSheet` for the
// control-account side. This module compares them and surfaces drift.
//
// Why this matters: a system that AUTO-CHECKS its sub-ledger ties is
// rare. Most GLs ask you to run a "reconciliation report" at month-end;
// we run it on every dashboard load.
//
// Scope of v1: AR (control account: isControlAccount && type=ASSET &&
// subtype="AR_TRADE") + AP (isControlAccount && type=LIABILITY &&
// subtype="AP_TRADE"). Fixed-asset ties (gross cost ↔ FA acquisition
// total, accum dep ↔ FA book-attrs sum) are a natural next step but
// require more careful handling because there's no single "FA control
// account" — each book-attribute carries its own asset / contra codes.

import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { openArBalance } from "./sub-ledgers/ar";
import { openApBalance } from "./sub-ledgers/ap";

export interface SubledgerTie {
  /** Human-readable name for the tie ("AR control", "AP control"). */
  name: string;
  /**
   * The control account in the GL, if one was found. Null when no
   * matching account exists (custom chart, or sub-ledger not in use).
   */
  controlAccount: { code: string; name: string } | null;
  /**
   * The control account's balance in its NATURAL sign — positive for an
   * asset with debit balance, positive for a liability with credit
   * balance. Matches the convention reports use.
   */
  controlBalance: Decimal;
  /** Sum of open sub-ledger items, in the same sign convention. */
  subledgerSum: Decimal;
  /** controlBalance - subledgerSum. Zero (or near-zero) = ties. */
  delta: Decimal;
  /**
   * "ok"                  — delta is zero (or below tolerance).
   * "broken"              — delta exceeds tolerance.
   * "no_control_account"  — no control account in this chart; tie
   *                         doesn't apply (not an error).
   */
  status: "ok" | "broken" | "no_control_account";
  /** Where the user clicks to investigate. */
  investigateHref: string;
}

// Half-penny tolerance — Decimals are exact in normal operation, but
// fixed-point rounding artifacts from a few sub-cent FX-revalued
// transactions could leave a tiny non-zero delta that doesn't represent
// a real break. CPAs round to pennies; anything below that is noise.
const TOLERANCE = new Decimal("0.005");

export interface CheckSubledgerTiesInput {
  entityCode: string;
  bookCode: string;
  /** As-of date for the control-account balance computation. */
  asOf: Date;
}

export async function checkSubledgerTies(
  prisma: PrismaClient,
  input: CheckSubledgerTiesInput
): Promise<SubledgerTie[]> {
  const [arTie, apTie] = await Promise.all([
    checkArTie(prisma, input),
    checkApTie(prisma, input),
  ]);
  return [arTie, apTie];
}

// ─── AR tie ────────────────────────────────────────────────────────────────

async function checkArTie(
  prisma: PrismaClient,
  { entityCode, bookCode, asOf }: CheckSubledgerTiesInput
): Promise<SubledgerTie> {
  const controlAccount = await findControlAccount(prisma, {
    entityCode,
    type: "ASSET",
    subtype: "AR_TRADE",
  });
  if (!controlAccount) {
    return zeroTie({
      name: "AR control",
      status: "no_control_account",
      investigateHref: "/ar",
    });
  }

  const [controlBalance, subledgerSum] = await Promise.all([
    sumControlAccountBalance(prisma, {
      accountId: controlAccount.id,
      entityCode,
      bookCode,
      asOf,
      // ASSET → debit-normal → balance = debit - credit
      sign: 1,
    }),
    openArBalance(prisma, entityCode, bookCode),
  ]);

  return finalize({
    name: "AR control",
    controlAccount: { code: controlAccount.code, name: controlAccount.name },
    controlBalance,
    subledgerSum,
    investigateHref: "/ar",
  });
}

// ─── AP tie ────────────────────────────────────────────────────────────────

async function checkApTie(
  prisma: PrismaClient,
  { entityCode, bookCode, asOf }: CheckSubledgerTiesInput
): Promise<SubledgerTie> {
  const controlAccount = await findControlAccount(prisma, {
    entityCode,
    type: "LIABILITY",
    subtype: "AP_TRADE",
  });
  if (!controlAccount) {
    return zeroTie({
      name: "AP control",
      status: "no_control_account",
      investigateHref: "/ap",
    });
  }

  const [controlBalance, subledgerSum] = await Promise.all([
    sumControlAccountBalance(prisma, {
      accountId: controlAccount.id,
      entityCode,
      bookCode,
      asOf,
      // LIABILITY → credit-normal → balance = credit - debit
      sign: -1,
    }),
    openApBalance(prisma, entityCode, bookCode),
  ]);

  return finalize({
    name: "AP control",
    controlAccount: { code: controlAccount.code, name: controlAccount.name },
    controlBalance,
    subledgerSum,
    investigateHref: "/ap",
  });
}

// ─── helpers ───────────────────────────────────────────────────────────────

async function findControlAccount(
  prisma: PrismaClient,
  args: { entityCode: string; type: "ASSET" | "LIABILITY"; subtype: string }
): Promise<{ id: string; code: string; name: string } | null> {
  // First resolve the entity's tenant so we can scope BOTH the entity-
  // specific and shared fallback queries to that tenant. Without the
  // tenant filter, a tenant lacking its own AR control account would
  // inherit one from ANOTHER tenant — a real cross-tenant leak.
  const entity = await prisma.legalEntity.findFirst({
    where: { code: args.entityCode },
    select: { id: true, tenantId: true },
  });
  if (!entity) return null;

  // Prefer entity-specific control account; fall back to shared
  // (entityId=null) WITHIN THE SAME TENANT — same precedence as
  // report dedup but tenant-scoped.
  const entitySpecific = await prisma.account.findFirst({
    where: {
      tenantId: entity.tenantId,
      active: true,
      isControlAccount: true,
      type: args.type,
      subtype: args.subtype,
      entityId: entity.id,
    },
    select: { id: true, code: true, name: true },
  });
  if (entitySpecific) return entitySpecific;
  return await prisma.account.findFirst({
    where: {
      tenantId: entity.tenantId,
      active: true,
      isControlAccount: true,
      type: args.type,
      subtype: args.subtype,
      entityId: null,
    },
    select: { id: true, code: true, name: true },
  });
}

async function sumControlAccountBalance(
  prisma: PrismaClient,
  args: {
    accountId: string;
    entityCode: string;
    bookCode: string;
    asOf: Date;
    /** +1 for asset (debit-normal), -1 for liability/equity (credit-normal). */
    sign: 1 | -1;
  }
): Promise<Decimal> {
  // Aggregate via Prisma's groupBy / aggregate. Filtering by accountId
  // is the narrow path; ensure the journal entry is in scope.
  const agg = await prisma.journalLine.aggregate({
    where: {
      accountId: args.accountId,
      entry: {
        entity: { code: args.entityCode },
        book: { code: args.bookCode },
        documentDate: { lte: args.asOf },
      },
    },
    _sum: { debit: true, credit: true },
  });
  const debit = new Decimal((agg._sum.debit ?? 0).toString());
  const credit = new Decimal((agg._sum.credit ?? 0).toString());
  return args.sign === 1 ? debit.minus(credit) : credit.minus(debit);
}

function zeroTie(args: {
  name: string;
  status: SubledgerTie["status"];
  investigateHref: string;
}): SubledgerTie {
  return {
    name: args.name,
    controlAccount: null,
    controlBalance: new Decimal(0),
    subledgerSum: new Decimal(0),
    delta: new Decimal(0),
    status: args.status,
    investigateHref: args.investigateHref,
  };
}

function finalize(args: {
  name: string;
  controlAccount: { code: string; name: string };
  controlBalance: Decimal;
  subledgerSum: Decimal;
  investigateHref: string;
}): SubledgerTie {
  const delta = args.controlBalance.minus(args.subledgerSum);
  const status: SubledgerTie["status"] = delta.abs().lte(TOLERANCE)
    ? "ok"
    : "broken";
  return {
    name: args.name,
    controlAccount: args.controlAccount,
    controlBalance: args.controlBalance,
    subledgerSum: args.subledgerSum,
    delta,
    status,
    investigateHref: args.investigateHref,
  };
}
