// Bank-feed domain commands.
//
// The Server Actions in src/app/actions/bank-feed.ts are thin: authenticate,
// validate input (Zod), resolve the authorized scope, invoke one of these
// commands, and map the result. The domain logic — scoped loads, atomic
// FOR_REVIEW claims, posting through postJournalEntry, the unique-index
// backstop, audit rows — lives here, decoupled from FormData / Next.js.
//
// Every state transition is database-enforced (a conditional updateMany that
// requires status FOR_REVIEW in the caller's exact scope, plus the unique
// postedEntryId index), so concurrent duplicate requests can't double-post or
// double-link — the guarantee holds regardless of which surface calls in.

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";
import { Decimal } from "decimal.js";
import type { CurrentScope } from "@/lib/scope";
import { withTenantContext } from "@/lib/tenant-context";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { logAuditEvent } from "@/lib/audit/log";
import { parseBankCsv, computeDedupeHash, BankCsvError } from "@/lib/banking/import";
import { deriveCategorizationLines } from "@/lib/banking/post";
import { normalizeMerchant, computeMatchHash } from "@/lib/banking/rules";
import { lineMovementOnNormalSide } from "@/lib/banking/match";

/** The authenticated actor a command records against (createdBy / audit). */
export interface CommandActor {
  id: string;
  email: string;
}

/** A command's outcome, ready for the Server Action to return as-is. */
export type CommandResult =
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Thrown inside the posting transaction when a concurrent request already
 * claimed the FOR_REVIEW row (the conditional claim matched 0 rows). Rolls
 * the transaction back — nothing is posted — and is mapped to a friendly
 * "already handled" message. Module-private: it never escapes a command.
 */
class AlreadyHandledError extends Error {
  constructor() {
    super("This transaction was already handled by another request.");
    this.name = "AlreadyHandledError";
  }
}

// ── Import ───────────────────────────────────────────────────────────────

export async function importBankCsvCommand(
  db: PrismaClient,
  scope: CurrentScope,
  actor: CommandActor,
  input: { bankAccountCode: string; csv: string }
): Promise<CommandResult> {
  // The bank account must exist in this tenant + scope.
  const bankAccount = await db.account.findFirst({
    where: {
      tenantId: scope.tenantId,
      code: input.bankAccountCode,
      OR: [{ entityId: null }, { entityId: scope.entityId }],
    },
    select: { id: true, code: true },
  });
  if (!bankAccount) {
    return { ok: false, error: `Account ${input.bankAccountCode} not found in this scope.` };
  }

  let rows;
  try {
    rows = parseBankCsv(input.csv).rows;
  } catch (e) {
    if (e instanceof BankCsvError) return { ok: false, error: e.message };
    throw e;
  }

  // Resolve book once for the scope.
  const book = await db.book.findUnique({
    where: { code: scope.bookCode },
    select: { id: true },
  });
  if (!book) return { ok: false, error: `Book ${scope.bookCode} not found.` };

  // Idempotent insert: dedupeHash (on plaintext) collides on the unique
  // index, so a re-imported file adds only genuinely new lines.
  const data = rows.map((r) => ({
    tenantId: scope.tenantId,
    entityId: scope.entityId,
    bookId: book.id,
    bankAccountId: bankAccount.id,
    postedDate: r.postedDate,
    description: r.description,
    amount: r.amount.toFixed(4),
    externalRef: r.externalRef ?? null,
    dedupeHash: computeDedupeHash({
      bankAccountId: bankAccount.id,
      postedDate: r.postedDate,
      amount: r.amount,
      description: r.description,
      externalRef: r.externalRef,
    }),
    status: "FOR_REVIEW" as const,
    createdBy: actor.email,
  }));
  const result = await db.bankTransaction.createMany({ data, skipDuplicates: true });

  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "bank-feed.import",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    actorEmail: actor.email,
    resource: "BankTransaction",
    resourceId: bankAccount.code,
    tenantId: scope.tenantId,
    metadata: { parsed: rows.length, imported: result.count, bankAccount: bankAccount.code },
  });

  const dupes = rows.length - result.count;
  return {
    ok: true,
    message:
      `Imported ${result.count} transaction${result.count === 1 ? "" : "s"} to review` +
      (dupes > 0 ? ` (${dupes} already imported, skipped).` : "."),
  };
}

// ── Categorize (posts the JE) ────────────────────────────────────────────

export async function categorizeBankTransactionCommand(
  db: PrismaClient,
  scope: CurrentScope,
  actor: CommandActor,
  input: { id: string; categoryAccountCode: string }
): Promise<CommandResult> {
  // Scoped load — the line must belong to the caller's tenant AND the
  // currently-selected (entity, book). Without the entity/book pin a forged
  // id from a SIBLING entity in the same tenant would load, and the
  // categorize would post its JE into the caller's scope using the foreign
  // line's bank account (cross-entity contamination).
  const txn = await db.bankTransaction.findFirst({
    where: {
      id: input.id,
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      book: { code: scope.bookCode },
    },
    select: {
      id: true,
      status: true,
      amount: true,
      description: true,
      postedDate: true,
      bankAccount: { select: { code: true, normalBalance: true } },
    },
  });
  if (!txn) return { ok: false, error: "Transaction not found." };
  if (txn.status !== "FOR_REVIEW") {
    return { ok: false, error: `This transaction is already ${txn.status.toLowerCase()}.` };
  }

  const category = await db.account.findFirst({
    where: {
      tenantId: scope.tenantId,
      code: input.categoryAccountCode,
      active: true,
      OR: [{ entityId: null }, { entityId: scope.entityId }],
    },
    select: { id: true, code: true },
  });
  if (!category) {
    return { ok: false, error: `Category ${input.categoryAccountCode} not found.` };
  }

  const [bankLine, categoryLine] = deriveCategorizationLines({
    bankAccountCode: txn.bankAccount.code,
    bankNormalIsDebit: txn.bankAccount.normalBalance === "DEBIT",
    categoryAccountCode: category.code,
    amount: new Decimal(txn.amount.toString()),
    description: txn.description,
  });

  // Post + mark categorized atomically: same transaction, same tenant GUC,
  // so a failed post never leaves the line marked done.
  let entryNumber: string;
  try {
    entryNumber = await withTenantContext(db, scope.tenantId, async (tx) => {
      // Claim the row FIRST, conditionally on it still being FOR_REVIEW in
      // this exact scope. Only the request whose updateMany flips exactly one
      // row proceeds to post — a concurrent categorize sees count 0 and
      // aborts, so the line posts EXACTLY once. A throw rolls the claim back
      // with the post.
      const claim = await tx.bankTransaction.updateMany({
        where: {
          id: txn.id,
          tenantId: scope.tenantId,
          entityId: scope.entityId,
          book: { code: scope.bookCode },
          status: "FOR_REVIEW",
        },
        data: { status: "CATEGORIZED" },
      });
      if (claim.count !== 1) throw new AlreadyHandledError();

      const je = await postJournalEntry(tx, {
        tenantId: scope.tenantId,
        entityCode: scope.entityCode,
        bookCode: scope.bookCode,
        documentDate: txn.postedDate,
        memo: txn.description,
        // Provenance is server-stamped, never client input: a bank-feed
        // categorization is a manual coding decision.
        source: "MANUAL",
        createdBy: actor.email,
        ownerUserId: actor.id,
        lines: [bankLine, categoryLine],
      });
      await tx.bankTransaction.update({
        where: { id: txn.id },
        data: {
          categoryAccount: { connect: { id: category.id } },
          postedEntry: { connect: { id: je.id } },
        },
      });
      return je.entryNumber;
    });
  } catch (e) {
    if (e instanceof AlreadyHandledError) {
      return { ok: false, error: "This transaction was already categorized." };
    }
    throw e;
  }

  // Learn the merchant→category pairing (best-effort — a learning failure
  // must never fail the categorize the user just watched succeed).
  try {
    const norm = normalizeMerchant(txn.description);
    if (norm.length >= 3) {
      const matchHash = computeMatchHash(norm);
      await db.bankRule.upsert({
        where: { tenantId_matchHash: { tenantId: scope.tenantId, matchHash } },
        create: {
          tenantId: scope.tenantId,
          matchText: norm,
          matchHash,
          categoryAccountId: category.id,
          createdBy: actor.email,
        },
        update: {
          categoryAccountId: category.id,
          timesUsed: { increment: 1 },
          lastUsedAt: new Date(),
        },
      });
    }
  } catch (learnErr) {
    console.warn("bank-feed rule learning skipped:", {
      error: learnErr instanceof Error ? learnErr.message : String(learnErr),
    });
  }

  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "bank-feed.categorize",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    actorEmail: actor.email,
    resource: "BankTransaction",
    resourceId: txn.id,
    tenantId: scope.tenantId,
    metadata: { category: category.code, bankAccount: txn.bankAccount.code, entryNumber },
  });

  return { ok: true, message: `Added — posted ${entryNumber}.` };
}

// ── Exclude ──────────────────────────────────────────────────────────────

export async function excludeBankTransactionCommand(
  db: PrismaClient,
  scope: CurrentScope,
  actor: CommandActor,
  input: { id: string; reason?: string }
): Promise<CommandResult> {
  const txn = await db.bankTransaction.findFirst({
    where: {
      id: input.id,
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      book: { code: scope.bookCode },
    },
    select: { id: true, status: true },
  });
  if (!txn) return { ok: false, error: "Transaction not found." };
  if (txn.status !== "FOR_REVIEW") {
    return { ok: false, error: `This transaction is already ${txn.status.toLowerCase()}.` };
  }

  // Conditional claim so a concurrent categorize can't lose to (or race with)
  // an exclude: only a still-FOR_REVIEW row in this scope flips.
  const claimed = await db.bankTransaction.updateMany({
    where: {
      id: txn.id,
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      book: { code: scope.bookCode },
      status: "FOR_REVIEW",
    },
    data: { status: "EXCLUDED", excludedBy: actor.email, excludeReason: input.reason ?? null },
  });
  if (claimed.count !== 1) {
    return { ok: false, error: "This transaction was already handled." };
  }

  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "bank-feed.exclude",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    actorEmail: actor.email,
    resource: "BankTransaction",
    resourceId: txn.id,
    tenantId: scope.tenantId,
    metadata: { reason: input.reason ?? null },
  });

  return { ok: true, message: "Excluded from the feed." };
}

// ── Match to an existing entry (no posting) ─────────────────────────────

export async function matchBankTransactionCommand(
  db: PrismaClient,
  scope: CurrentScope,
  actor: CommandActor,
  input: { id: string; entryId: string }
): Promise<CommandResult> {
  const txn = await db.bankTransaction.findFirst({
    where: {
      id: input.id,
      tenantId: scope.tenantId,
      entityId: scope.entityId,
      book: { code: scope.bookCode },
    },
    select: {
      id: true,
      status: true,
      amount: true,
      bankAccountId: true,
      bankAccount: { select: { normalBalance: true } },
    },
  });
  if (!txn) return { ok: false, error: "Transaction not found." };
  if (txn.status !== "FOR_REVIEW") {
    return { ok: false, error: `This transaction is already ${txn.status.toLowerCase()}.` };
  }

  // Server-side re-verification — the client's candidate list is a
  // convenience, not an authorization. The entry must be in this tenant +
  // scope, carry a line on the SAME bank account whose signed movement
  // EXACTLY equals the feed amount, and not already be claimed.
  const entry = await db.journalEntry.findFirst({
    where: {
      id: input.entryId,
      tenantId: scope.tenantId,
      entity: { code: scope.entityCode },
      book: { code: scope.bookCode },
    },
    select: {
      id: true,
      entryNumber: true,
      lines: {
        where: { accountId: txn.bankAccountId },
        select: { debit: true, credit: true },
      },
    },
  });
  if (!entry) return { ok: false, error: "Entry not found." };

  const amount = new Decimal(txn.amount.toString());
  const normalIsDebit = txn.bankAccount.normalBalance === "DEBIT";
  const hasEqualLine = entry.lines.some((l) =>
    lineMovementOnNormalSide(
      new Decimal(l.debit.toString()),
      new Decimal(l.credit.toString()),
      normalIsDebit
    ).equals(amount)
  );
  if (!hasEqualLine) {
    return {
      ok: false,
      error: "That entry doesn't move this account by the same amount — not a match.",
    };
  }

  // Fast-path friendly check — a read-before-write, so it can't be the
  // guarantee. The DB unique index on postedEntryId is the real backstop:
  // two feed lines racing to match the SAME entry both pass this read, but
  // only one updateMany succeeds; the loser hits P2002.
  const alreadyClaimed = await db.bankTransaction.findFirst({
    where: { tenantId: scope.tenantId, postedEntryId: entry.id },
    select: { id: true },
  });
  if (alreadyClaimed) {
    return { ok: false, error: "Another bank line already matched that entry." };
  }

  try {
    // Atomic claim: only a still-FOR_REVIEW line in this scope flips, and the
    // unique postedEntryId index rejects a second line pointing at the same
    // entry. Both race outcomes resolve to "already handled".
    const claimed = await db.bankTransaction.updateMany({
      where: {
        id: txn.id,
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
        status: "FOR_REVIEW",
      },
      data: { status: "MATCHED", postedEntryId: entry.id },
    });
    if (claimed.count !== 1) {
      return { ok: false, error: "This transaction was already handled." };
    }
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === "P2002"
    ) {
      return { ok: false, error: "Another bank line already matched that entry." };
    }
    throw err;
  }

  await logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: "bank-feed.match",
    outcome: "SUCCESS",
    actorUserId: actor.id,
    actorEmail: actor.email,
    resource: "BankTransaction",
    resourceId: txn.id,
    tenantId: scope.tenantId,
    metadata: { matchedEntry: entry.entryNumber },
  });

  return { ok: true, message: `Matched to ${entry.entryNumber} — nothing new posted.` };
}
