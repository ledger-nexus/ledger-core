"use server";

// Bank-feed Server Actions: import a CSV into the For-Review inbox,
// categorize a reviewed line (which posts a balanced JE), or exclude it.
//
// Every action authenticates, resolves the actor's tenant-verified scope
// (never trusts a client-supplied tenant/entity), validates its input with
// Zod, and writes an audit row. Categorize posts through postJournalEntry
// inside withTenantContext, exactly like the manual JE form — the bank feed
// is a staging area, and the ONLY way a line reaches the ledger is a
// balanced, scoped, audited JE.

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { Decimal } from "decimal.js";
import { prisma } from "@/lib/db";
import { requireCurrentUser, NotAuthenticatedError } from "@/lib/auth/current-user";
import { requireCurrentScope, NoScopeError } from "@/lib/scope";
import { withTenantContext } from "@/lib/tenant-context";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { logAuditEvent } from "@/lib/audit/log";
import { parseBankCsv, computeDedupeHash, BankCsvError } from "@/lib/banking/import";
import { deriveCategorizationLines } from "@/lib/banking/post";
import { normalizeMerchant, computeMatchHash } from "@/lib/banking/rules";
import { lineMovementOnNormalSide } from "@/lib/banking/match";

export type ActionState =
  | { ok?: undefined; error?: undefined }
  | { ok: true; message: string }
  | { ok: false; error: string };

/**
 * Thrown inside the posting transaction when a concurrent request already
 * claimed the FOR_REVIEW row (the conditional claim matched 0 rows). It
 * rolls the transaction back — nothing is posted — and the caller turns it
 * into a friendly "already handled" message rather than a 500.
 */
class AlreadyHandledError extends Error {
  constructor() {
    super("This transaction was already handled by another request.");
    this.name = "AlreadyHandledError";
  }
}

// ── Import ───────────────────────────────────────────────────────────────

const importSchema = z.object({
  bankAccountCode: z.string().min(1, "Pick the account this file is for."),
  csv: z.string().min(1, "The file is empty."),
});

export async function importBankCsvAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();

    const file = formData.get("csvFile");
    const csv =
      file instanceof File ? await file.text() : String(formData.get("csv") ?? "");
    const parsed = importSchema.safeParse({
      bankAccountCode: String(formData.get("bankAccountCode") ?? ""),
      csv,
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }

    // The bank account must exist in this tenant + scope.
    const bankAccount = await prisma.account.findFirst({
      where: {
        tenantId: scope.tenantId,
        code: parsed.data.bankAccountCode,
        OR: [{ entityId: null }, { entityId: scope.entityId }],
      },
      select: { id: true, code: true },
    });
    if (!bankAccount) {
      return { ok: false, error: `Account ${parsed.data.bankAccountCode} not found in this scope.` };
    }

    let rows;
    try {
      rows = parseBankCsv(parsed.data.csv).rows;
    } catch (e) {
      if (e instanceof BankCsvError) return { ok: false, error: e.message };
      throw e;
    }

    // Resolve book once for the scope.
    const book = await prisma.book.findUnique({
      where: { code: scope.bookCode },
      select: { id: true },
    });
    if (!book) return { ok: false, error: `Book ${scope.bookCode} not found.` };

    // Idempotent insert: dedupeHash (on plaintext) collides on the unique
    // index, so a re-imported file adds only genuinely new lines. createMany
    // + skipDuplicates does the whole batch in one round-trip.
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
      createdBy: user.email,
    }));
    const result = await prisma.bankTransaction.createMany({
      data,
      skipDuplicates: true,
    });

    await logAuditEvent({
      eventType: "PRIVILEGED_ACTION",
      action: "bank-feed.import",
      outcome: "SUCCESS",
      actorUserId: user.id,
      actorEmail: user.email,
      resource: "BankTransaction",
      resourceId: bankAccount.code,
      tenantId: scope.tenantId,
      metadata: { parsed: rows.length, imported: result.count, bankAccount: bankAccount.code },
    });

    revalidatePath("/banking");
    const dupes = rows.length - result.count;
    return {
      ok: true,
      message:
        `Imported ${result.count} transaction${result.count === 1 ? "" : "s"} to review` +
        (dupes > 0 ? ` (${dupes} already imported, skipped).` : "."),
    };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, error: "You must be signed in." };
    if (e instanceof NoScopeError) return { ok: false, error: "Pick an entity + book first." };
    return { ok: false, error: e instanceof Error ? e.message : "Import failed." };
  }
}

// ── Categorize (posts the JE) ────────────────────────────────────────────

const categorizeSchema = z.object({
  id: z.string().uuid(),
  categoryAccountCode: z.string().min(1, "Pick a category."),
});

export async function categorizeBankTransactionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const parsed = categorizeSchema.safeParse({
      id: String(formData.get("id") ?? ""),
      categoryAccountCode: String(formData.get("categoryAccountCode") ?? ""),
    });
    if (!parsed.success) {
      return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input." };
    }

    // Scoped load — the line must belong to the caller's tenant AND the
    // currently-selected (entity, book), not just the tenant. Without the
    // entity/book pin a forged id from a SIBLING entity in the same tenant
    // would load, and the categorize would post its JE into the caller's
    // scope using the foreign line's bank account (cross-entity contamination).
    const txn = await prisma.bankTransaction.findFirst({
      where: {
        id: parsed.data.id,
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

    const category = await prisma.account.findFirst({
      where: {
        tenantId: scope.tenantId,
        code: parsed.data.categoryAccountCode,
        active: true,
        OR: [{ entityId: null }, { entityId: scope.entityId }],
      },
      select: { id: true, code: true },
    });
    if (!category) {
      return { ok: false, error: `Category ${parsed.data.categoryAccountCode} not found.` };
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
    const entryNumber = await withTenantContext(prisma, scope.tenantId, async (tx) => {
      // Claim the row FIRST, conditionally on it still being FOR_REVIEW in
      // this exact scope. Only the request whose updateMany flips exactly
      // one row proceeds to post — a concurrent categorize (double-submit,
      // retry, two tabs) sees count 0 and aborts, so the line posts EXACTLY
      // once. postJournalEntry carries no source lineage here, so its
      // idempotency key wouldn't dedupe a second post; this claim is the
      // guard. A throw below rolls back the claim with the post.
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
        // Provenance is server-stamped, never client input (see the JE
        // form fix): a bank-feed categorization is a manual coding decision.
        source: "MANUAL",
        createdBy: user.email,
        ownerUserId: user.id,
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

    // Learn the merchant→category pairing (best-effort — a learning
    // failure must never fail the categorize the user just watched
    // succeed). Next import of this merchant pre-selects the category.
    try {
      const norm = normalizeMerchant(txn.description);
      if (norm.length >= 3) {
        const matchHash = computeMatchHash(norm);
        await prisma.bankRule.upsert({
          where: { tenantId_matchHash: { tenantId: scope.tenantId, matchHash } },
          create: {
            tenantId: scope.tenantId,
            matchText: norm,
            matchHash,
            categoryAccountId: category.id,
            createdBy: user.email,
          },
          update: {
            // The latest human decision wins: re-point the category and
            // bump the confirmation count.
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
      actorUserId: user.id,
      actorEmail: user.email,
      resource: "BankTransaction",
      resourceId: txn.id,
      tenantId: scope.tenantId,
      metadata: { category: category.code, bankAccount: txn.bankAccount.code, entryNumber },
    });

    revalidatePath("/banking");
    return { ok: true, message: `Added — posted ${entryNumber}.` };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, error: "You must be signed in." };
    if (e instanceof NoScopeError) return { ok: false, error: "Pick an entity + book first." };
    if (e instanceof AlreadyHandledError)
      return { ok: false, error: "This transaction was already categorized." };
    return { ok: false, error: e instanceof Error ? e.message : "Categorize failed." };
  }
}

// ── Exclude ──────────────────────────────────────────────────────────────

const excludeSchema = z.object({
  id: z.string().uuid(),
  reason: z.string().max(200).optional(),
});

export async function excludeBankTransactionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const parsed = excludeSchema.safeParse({
      id: String(formData.get("id") ?? ""),
      reason: String(formData.get("reason") ?? "") || undefined,
    });
    if (!parsed.success) return { ok: false, error: "Invalid input." };

    const txn = await prisma.bankTransaction.findFirst({
      where: {
        id: parsed.data.id,
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

    // Conditional claim so a concurrent categorize can't lose to (or race
    // with) an exclude: only a still-FOR_REVIEW row in this scope flips.
    const claimed = await prisma.bankTransaction.updateMany({
      where: {
        id: txn.id,
        tenantId: scope.tenantId,
        entityId: scope.entityId,
        book: { code: scope.bookCode },
        status: "FOR_REVIEW",
      },
      data: { status: "EXCLUDED", excludedBy: user.email, excludeReason: parsed.data.reason ?? null },
    });
    if (claimed.count !== 1) {
      return { ok: false, error: "This transaction was already handled." };
    }

    await logAuditEvent({
      eventType: "PRIVILEGED_ACTION",
      action: "bank-feed.exclude",
      outcome: "SUCCESS",
      actorUserId: user.id,
      actorEmail: user.email,
      resource: "BankTransaction",
      resourceId: txn.id,
      tenantId: scope.tenantId,
      metadata: { reason: parsed.data.reason ?? null },
    });

    revalidatePath("/banking");
    return { ok: true, message: "Excluded from the feed." };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, error: "You must be signed in." };
    if (e instanceof NoScopeError) return { ok: false, error: "Pick an entity + book first." };
    return { ok: false, error: e instanceof Error ? e.message : "Exclude failed." };
  }
}

// ── Match to an existing entry (no posting) ─────────────────────────────

const matchSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
});

export async function matchBankTransactionAction(
  _prev: ActionState,
  formData: FormData
): Promise<ActionState> {
  try {
    const user = await requireCurrentUser();
    const scope = await requireCurrentScope();
    const parsed = matchSchema.safeParse({
      id: String(formData.get("id") ?? ""),
      entryId: String(formData.get("entryId") ?? ""),
    });
    if (!parsed.success) return { ok: false, error: "Invalid input." };

    const txn = await prisma.bankTransaction.findFirst({
      where: {
        id: parsed.data.id,
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
    // convenience, not an authorization. The entry must be in this tenant
    // + scope, carry a line on the SAME bank account whose signed movement
    // EXACTLY equals the feed amount, and not already be claimed by
    // another feed line.
    const entry = await prisma.journalEntry.findFirst({
      where: {
        id: parsed.data.entryId,
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
    // two feed lines racing to match the SAME entry both pass this read,
    // but only one updateMany succeeds; the loser hits P2002.
    const alreadyClaimed = await prisma.bankTransaction.findFirst({
      where: { tenantId: scope.tenantId, postedEntryId: entry.id },
      select: { id: true },
    });
    if (alreadyClaimed) {
      return { ok: false, error: "Another bank line already matched that entry." };
    }

    try {
      // Atomic claim: only a still-FOR_REVIEW line in this scope flips, and
      // the unique postedEntryId index rejects a second line pointing at the
      // same entry. Both race outcomes resolve to "already handled".
      const claimed = await prisma.bankTransaction.updateMany({
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
      actorUserId: user.id,
      actorEmail: user.email,
      resource: "BankTransaction",
      resourceId: txn.id,
      tenantId: scope.tenantId,
      metadata: { matchedEntry: entry.entryNumber },
    });

    revalidatePath("/banking");
    return { ok: true, message: `Matched to ${entry.entryNumber} — nothing new posted.` };
  } catch (e) {
    if (e instanceof NotAuthenticatedError) return { ok: false, error: "You must be signed in." };
    if (e instanceof NoScopeError) return { ok: false, error: "Pick an entity + book first." };
    return { ok: false, error: e instanceof Error ? e.message : "Match failed." };
  }
}
