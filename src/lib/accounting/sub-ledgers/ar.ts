// Accounts Receivable sub-ledger.
//
// Per the spec: "A bill creates an AP open item; it is not itself AP."
// The mirror rule for AR: an invoice creates an AR open item. The invoice
// itself is a JournalEntry that debits AR control + credits revenue. The
// open-item is a separate record with its own lifecycle (open → partial
// → applied / written off / reopened).
//
// Invariant: sum of currentBalance for status IN (OPEN, PARTIAL) per
// (entity, book) === AR control account balance (Dr). See tests.

import type { Prisma } from "@prisma/client";
import { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import { postJournalEntry } from "../post-journal";
import { toDecimal } from "../../utils/decimal";
import { isUuid } from "../../utils/uuid";
import { CrossBookApplicationError } from "../types";
import { fireInsertRules, type FireRulesResult } from "../../rules/integration";


export interface OpenArItemInput {
  entityCode: string;
  bookCode: string;
  partyCode: string;
  openedByEntryId: string;
  referenceNumber?: string;
  openedDate: Date;
  dueDate?: Date;
  amount: Decimal | string | number;
  currencyCode: string;
  controlAccountCode: string; // typically "1200"
  /**
   * Acting user. Threaded through into createdBy + the default ownerId.
   * Use "system" for engine-generated AR items (e.g. ERP-import paths
   * that don't have a human actor). When auth lands, the Server Action
   * layer pulls this from the session.
   */
  actorUserId?: string;
  sourceSystem?: string;
  sourceRecordType?: string;
  sourceRecordId?: string;
  sourcePayload?: unknown;
}

export interface OpenArItemResult {
  id: string;
  /**
   * Result of the ON_INSERT rules fire. The AR item exists regardless of
   * whether rules fired or reassigned — rule failures are non-fatal and
   * surface here for the caller to log + handle.
   */
  rulesResult?: FireRulesResult;
}

export async function openArItem(
  prisma: PrismaClient,
  input: OpenArItemInput
): Promise<OpenArItemResult> {
  // Resolve entity first so the party lookup can scope by tenantId.
  // Cross-tenant party leakage is otherwise possible when both tenants
  // have a shared party (entityId=null) with the same code — Postgres
  // treats NULL != NULL in the [entityId, code] unique. Found by
  // tests/tenant-party-resolution.test.ts.
  // Phase 4b: entity code is unique per [tenantId, code]. Single-tenant
  // world today, so findFirst by code alone is deterministic. Multi-tenant
  // callers should ensure they only pass codes they own.
  const entity = await prisma.legalEntity.findFirstOrThrow({
    where: { code: input.entityCode },
    select: { id: true, tenantId: true },
  });
  const [book, party] = await Promise.all([
    prisma.book.findUniqueOrThrow({
      where: { code: input.bookCode },
      select: { id: true },
    }),
    prisma.party.findFirstOrThrow({
      where: {
        tenantId: entity.tenantId,
        code: input.partyCode,
        OR: [{ entityId: null }, { entityId: entity.id }],
      },
      select: { id: true },
    }),
  ]);

  const amount = toDecimal(input.amount).toFixed(4);
  const actor = input.actorUserId ?? "system";
  // Default owner = creating actor (when they're a real user). When the
  // actor is "system" (e.g. ERP-import paths with no human actor), leave
  // ownerId null — the ON_INSERT rules engine fires below and may assign
  // it to a queue. If no rule matches, the item lands in the dashboard's
  // unassigned-queue view.
  const isHumanActor = actor !== "system" && isUuid(actor);

  const item = await prisma.arOpenItem.create({
    data: {
      tenantId: entity.tenantId,
      entityId: entity.id,
      bookId: book.id,
      partyId: party.id,
      openedByEntryId: input.openedByEntryId,
      referenceNumber: input.referenceNumber,
      openedDate: input.openedDate,
      dueDate: input.dueDate,
      originalAmount: amount,
      currentBalance: amount,
      currencyId: input.currencyCode,
      controlAccountCode: input.controlAccountCode,
      status: "OPEN",
      ownerId: isHumanActor ? actor : null,
      ownerType: "USER",
      createdBy: actor,
      updatedBy: actor,
      sourceSystem: input.sourceSystem,
      sourceRecordType: input.sourceRecordType,
      sourceRecordId: input.sourceRecordId,
      sourcePayload: (input.sourcePayload as any) ?? undefined,
    },
    select: {
      id: true,
      status: true,
      originalAmount: true,
      currentBalance: true,
      dueDate: true,
      openedDate: true,
      controlAccountCode: true,
      entityId: true,
      bookId: true,
      partyId: true,
      party: { select: { code: true, displayName: true } },
    },
  });

  // Fire ON_INSERT rules. The rules engine sees the just-created record
  // (including joined party data) and may reassign to a queue based on
  // criteria like "small-balance items → SELF_SERVICE_QUEUE" or
  // "new-customer items → ONBOARDING_QUEUE". Rules see what the human
  // would see — same DB filter (no privilege escalation through rules).
  const rulesResult = await fireInsertRules(
    prisma,
    "ArOpenItem",
    item.id,
    item as unknown as Record<string, unknown>,
    actor
  );

  return { id: item.id, rulesResult };
}


export interface ApplyArPaymentInput {
  openItemId: string;
  appliedByEntryId: string;
  appliedAmount: Decimal | string | number;
  appliedDate: Date;
}

// Class T (RLS Phase 2b): transactional body exported separately so
// Server Actions can run it inside withTenantContext's transaction.
export async function applyArPaymentInTx(
  tx: Prisma.TransactionClient,
  input: ApplyArPaymentInput
): Promise<{ applicationId: string; remainingBalance: Decimal; status: string }> {
  {
    const item = await tx.arOpenItem.findUniqueOrThrow({
      where: { id: input.openItemId },
      // tenantId pulled so the application row inherits the same scope.
      // bookId pulled for the Phase 3.5.D cross-book guard below.
      select: {
        currentBalance: true,
        originalAmount: true,
        status: true,
        tenantId: true,
        bookId: true,
        book: { select: { code: true } },
      },
    });
    if (item.status === "APPLIED" || item.status === "WRITTEN_OFF" || item.status === "VOID") {
      throw new Error(`Cannot apply payment to AR item in ${item.status} state`);
    }

    // v0.9 NS Books Phase 3.5.D — cross-book application guard. The
    // payment-side JE must post on the SAME book as the OpenItem; an
    // application across books would corrupt per-book trial balance
    // invariants (the AR Cr line on the payment JE balances the AR Dr
    // line on the invoice JE; cross-book pairing leaves both sides
    // imbalanced). Pattern 2 multi-book demands one book per posting.
    const appliedByEntry = await tx.journalEntry.findUniqueOrThrow({
      where: { id: input.appliedByEntryId },
      select: { bookId: true, book: { select: { code: true } } },
    });
    if (appliedByEntry.bookId !== item.bookId) {
      throw new CrossBookApplicationError(
        input.openItemId,
        item.book.code,
        input.appliedByEntryId,
        appliedByEntry.book.code
      );
    }

    const applied = toDecimal(input.appliedAmount);
    const current = toDecimal(item.currentBalance);
    if (applied.greaterThan(current)) {
      throw new Error(
        `Application amount ${applied} exceeds open balance ${current.toFixed(4)}`
      );
    }

    const newBalance = current.minus(applied);
    const nextStatus = newBalance.isZero() ? "APPLIED" : "PARTIAL";

    // SECURITY (TOCTOU race fix): the SELECT above + the UPDATE below
    // is the classic time-of-check / time-of-use window. Under Postgres
    // READ COMMITTED (Prisma's default), two concurrent transactions
    // could both observe currentBalance = N, both pass the
    // "applied <= current" check, and both UPDATE — over-applying.
    // Optimistic-concurrency guard: the UPDATE only succeeds when the
    // currentBalance still matches what we read. updateMany returns
    // count=0 if another transaction already raced past us; we throw
    // and the surrounding $transaction rolls back the arApplication
    // INSERT atomically. The caller retries.
    const application = await tx.arApplication.create({
      data: {
        tenantId: item.tenantId,
        openItemId: input.openItemId,
        appliedByEntryId: input.appliedByEntryId,
        appliedAmount: applied.toFixed(4),
        appliedDate: input.appliedDate,
      },
      select: { id: true },
    });

    const updated = await tx.arOpenItem.updateMany({
      where: {
        id: input.openItemId,
        // Guard: only update if the balance hasn't changed since we
        // read it. Decimal-precise comparison via toFixed(4) — same
        // precision the DB column uses.
        currentBalance: current.toFixed(4),
      },
      data: {
        currentBalance: newBalance.toFixed(4),
        status: nextStatus,
      },
    });
    if (updated.count === 0) {
      throw new Error(
        `Concurrent update on AR item ${input.openItemId} — payment was applied to a stale balance. Retry the request.`
      );
    }

    return { applicationId: application.id, remainingBalance: newBalance, status: nextStatus };
  }
}

export async function applyArPayment(
  prisma: PrismaClient,
  input: ApplyArPaymentInput
): Promise<{ applicationId: string; remainingBalance: Decimal; status: string }> {
  return prisma.$transaction((tx) => applyArPaymentInTx(tx, input));
}

// Write-off of an AR open item. Two methods supported:
//
//   DIRECT (the default): Dr Bad Debt Expense, Cr AR.
//     Simple but mismatches expense recognition with revenue period. Fine
//     for small businesses; not GAAP-conforming for any material amount.
//
//   ALLOWANCE: Dr Allowance for Doubtful Accounts, Cr AR.
//     Uses a previously-estimated allowance built up via
//     estimateBadDebtAllowance (Dr Bad Debt Expense, Cr Allowance). The
//     write-off itself doesn't hit the expense account because the expense
//     was already recognized when the allowance was estimated. This is the
//     GAAP / IFRS preferred method for material AR.
//
// Either way, the paired GL entry posts first (so a failure leaves the
// open item untouched), then the open item transitions to WRITTEN_OFF.
export interface WriteOffArInput {
  openItemId: string;
  writeOffDate: Date;
  method?: "DIRECT" | "ALLOWANCE";    // default DIRECT
  badDebtAccountCode?: string;        // default "7500" (used by DIRECT)
  allowanceAccountCode?: string;      // default "1210" (used by ALLOWANCE)
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
}

export async function writeOffArItem(
  prisma: PrismaClient,
  input: WriteOffArInput
): Promise<{ entryNumber: string; amount: Decimal; method: "DIRECT" | "ALLOWANCE" }> {
  const item = await prisma.arOpenItem.findUniqueOrThrow({
    where: { id: input.openItemId },
    include: {
      entity: { select: { code: true } },
      book: { select: { code: true } },
      party: { select: { code: true } },
    },
  });
  if (item.status === "APPLIED" || item.status === "WRITTEN_OFF" || item.status === "VOID") {
    throw new Error(`Cannot write off AR item in ${item.status} state`);
  }

  const amount = toDecimal(item.currentBalance);
  const method = input.method ?? "DIRECT";
  const debitAccountCode =
    method === "ALLOWANCE"
      ? input.allowanceAccountCode ?? "1210"
      : input.badDebtAccountCode ?? "7500";

  const entry = await postJournalEntry(prisma, {
    entityCode: item.entity.code,
    bookCode: item.book.code,
    currencyCode: item.currencyId,
    documentDate: input.writeOffDate,
    memo: `Bad debt write-off (${method}) — ${item.referenceNumber ?? item.id}`,
    source: input.source ?? "SYSTEM",
    sourceRecordType: "BadDebtWriteOff",
    sourceRecordId: item.id,
    extensions: {
      openItemId: item.id,
      partyCode: item.party.code,
      writeOffAmount: amount.toFixed(2),
      method,
    },
    lines: [
      {
        accountCode: debitAccountCode,
        debit: amount.toFixed(4),
        description: method === "ALLOWANCE"
          ? `Apply allowance — ${item.party.code}`
          : `Bad debt — ${item.party.code}`,
      },
      {
        accountCode: item.controlAccountCode,
        credit: amount.toFixed(4),
        partyCode: item.party.code,
        description: `Write off AR — ${item.referenceNumber ?? item.id}`,
      },
    ],
  });

  await prisma.$transaction([
    prisma.arApplication.create({
      data: {
        tenantId: item.tenantId,
        openItemId: item.id,
        appliedByEntryId: entry.id,
        appliedAmount: amount.toFixed(4),
        appliedDate: input.writeOffDate,
      },
    }),
    prisma.arOpenItem.update({
      where: { id: item.id },
      data: { currentBalance: "0.0000", status: "WRITTEN_OFF" },
    }),
  ]);

  return { entryNumber: entry.entryNumber, amount, method };
}

// Estimate (build up) the allowance for doubtful accounts. Typically run
// each month-end or quarter-end based on an aging-bucket percentage or a
// percent-of-revenue method. Posts:
//   Dr Bad Debt Expense
//   Cr Allowance for Doubtful Accounts
//
// The amount is a judgment call; this function just books what the caller
// computed. To reduce an over-built allowance, the caller should post a
// manual reversal entry — adding two-way support is a v0.6 task.
export interface EstimateAllowanceInput {
  entityCode: string;
  bookCode: string;
  asOfDate: Date;
  amount: Decimal | string | number;
  badDebtAccountCode?: string;      // default "7500"
  allowanceAccountCode?: string;    // default "1210"
  source?: "MANUAL" | "SEED" | "SYSTEM" | "AI_APPROVED" | "IMPORT";
}

export async function estimateBadDebtAllowance(
  prisma: PrismaClient,
  input: EstimateAllowanceInput
): Promise<{ entryNumber: string; amount: Decimal }> {
  const amount = toDecimal(input.amount);
  if (amount.lessThanOrEqualTo(0)) {
    throw new Error(`Allowance estimate must be positive (got ${amount})`);
  }
  const badDebtAccount = input.badDebtAccountCode ?? "7500";
  const allowanceAccount = input.allowanceAccountCode ?? "1210";

  const entry = await postJournalEntry(prisma, {
    entityCode: input.entityCode,
    bookCode: input.bookCode,
    documentDate: input.asOfDate,
    memo: `Bad debt allowance estimate — ${input.asOfDate.toISOString().slice(0, 10)}`,
    source: input.source ?? "SYSTEM",
    sourceRecordType: "AllowanceEstimate",
    extensions: { estimateAmount: amount.toFixed(2) },
    lines: [
      {
        accountCode: badDebtAccount,
        debit: amount.toFixed(4),
        description: `Bad debt expense — period estimate`,
      },
      {
        accountCode: allowanceAccount,
        credit: amount.toFixed(4),
        description: `Build allowance for doubtful accounts`,
      },
    ],
  });
  return { entryNumber: entry.entryNumber, amount };
}

// Sum of open + partial item balances for a (entity, book). Should equal
// the AR control account balance — the headline AR invariant.
export async function openArBalance(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string,
  // Tenant pin — entity codes are only unique per tenant; UI/API callers
  // MUST pass this (deficiency #16 pattern, closed for reports, was still
  // open here). Optional for legacy substrate scripts.
  tenantId?: string
): Promise<Decimal> {
  const rows = await prisma.arOpenItem.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      entity: { code: entityCode },
      book: { code: bookCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    select: { currentBalance: true },
  });
  return rows.reduce((acc, r) => acc.plus(toDecimal(r.currentBalance)), new Decimal(0));
}

// Aging buckets — useful for the recon project + portfolio demo.
export interface ArAgingBucket {
  bucket: "CURRENT" | "1_30" | "31_60" | "61_90" | "OVER_90";
  totalBalance: Decimal;
  itemCount: number;
}

export async function arAging(
  prisma: PrismaClient,
  entityCode: string,
  bookCode: string,
  asOf: Date,
  // Tenant pin — see openArBalance. Same cross-tenant same-code hole.
  tenantId?: string
): Promise<ArAgingBucket[]> {
  const items = await prisma.arOpenItem.findMany({
    where: {
      ...(tenantId ? { tenantId } : {}),
      entity: { code: entityCode },
      book: { code: bookCode },
      status: { in: ["OPEN", "PARTIAL", "REOPENED"] },
    },
    select: { currentBalance: true, dueDate: true, openedDate: true },
  });

  const buckets = {
    CURRENT: { total: new Decimal(0), count: 0 },
    "1_30": { total: new Decimal(0), count: 0 },
    "31_60": { total: new Decimal(0), count: 0 },
    "61_90": { total: new Decimal(0), count: 0 },
    OVER_90: { total: new Decimal(0), count: 0 },
  };
  for (const item of items) {
    const refDate = item.dueDate ?? item.openedDate;
    const daysOverdue = Math.floor(
      (asOf.getTime() - refDate.getTime()) / (1000 * 60 * 60 * 24)
    );
    const bal = toDecimal(item.currentBalance);
    let key: keyof typeof buckets;
    if (daysOverdue <= 0) key = "CURRENT";
    else if (daysOverdue <= 30) key = "1_30";
    else if (daysOverdue <= 60) key = "31_60";
    else if (daysOverdue <= 90) key = "61_90";
    else key = "OVER_90";
    buckets[key].total = buckets[key].total.plus(bal);
    buckets[key].count += 1;
  }
  return (Object.keys(buckets) as (keyof typeof buckets)[]).map((k) => ({
    bucket: k,
    totalBalance: buckets[k].total,
    itemCount: buckets[k].count,
  }));
}
