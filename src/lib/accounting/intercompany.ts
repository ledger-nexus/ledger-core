// Intercompany mirror preparation.
//
// An intercompany entry has TWO halves that live in different entities:
// the entity that records "Due from B" must be matched by B recording
// "Due to A" (and IC revenue by IC expense), or the consolidated trial
// balance carries a net IC imbalance and the eliminations don't zero.
// Until now the second half was typed by hand; this module derives it.
//
// The derivation is deliberately mechanical — pair the subtype, flip
// the side, keep the amount:
//
//   DUE_FROM_AFFILIATE ↔ DUE_TO_AFFILIATE
//   INTERCOMPANY_REV   ↔ INTERCOMPANY_EXP
//
// Deterministic-or-refuse: if any source line has no IC subtype, or the
// counterparty entity has zero or multiple candidate accounts for a
// paired subtype, we refuse with named blockers instead of guessing.
// Guessed accounts in a GL are worse than no automation.
//
// The mirror is a REAL journal entry through postJournalEntry — same
// approval routing as if the same user typed it in the counterparty
// entity (approvers post directly; non-approvers queue per tenant
// policy). Lineage is the link AND the idempotency lock:
//
//   sourceSystem      "INTERCOMPANY"
//   sourceRecordType  "gl_entry_mirror"
//   sourceRecordId    <source JournalEntry id>
//
// The partial unique index on (tenantId, bookId, triple) makes a second
// preparation a structural impossibility, not a best-effort check.

import { Decimal } from "@/lib/utils/decimal";
import type { PrismaClient, Prisma } from "@prisma/client";

import { postJournalEntry } from "./post-journal";
import { entityScopedPool } from "./entity-scope";
import {
  findEntryBySourceLineage,
  sourceLineage,
  IC_MIRROR_SOURCE_SYSTEM,
  IC_MIRROR_RECORD_TYPE,
} from "./source-lineage";

type DbClient = PrismaClient | Prisma.TransactionClient;

// Re-exported: the JE detail page and the automation registry read
// these, and the canonical definition now lives with the other triples.
export { IC_MIRROR_SOURCE_SYSTEM, IC_MIRROR_RECORD_TYPE };

/** Subtype pairing — the accounting identity of the two halves. */
export const IC_SUBTYPE_PAIR: Record<string, string> = {
  DUE_FROM_AFFILIATE: "DUE_TO_AFFILIATE",
  DUE_TO_AFFILIATE: "DUE_FROM_AFFILIATE",
  INTERCOMPANY_REV: "INTERCOMPANY_EXP",
  INTERCOMPANY_EXP: "INTERCOMPANY_REV",
};

export interface SourceLineForMirror {
  lineNo: number;
  accountCode: string;
  accountName: string;
  subtype: string | null;
  debit: Decimal;
  credit: Decimal;
  description: string | null;
}

export interface CounterpartyAccountCandidate {
  code: string;
  name: string;
  subtype: string | null;
  /** null = shared (tenant-wide) account; otherwise the owning entity id. */
  entityId: string | null;
}

export interface MirrorLinePlan {
  accountCode: string;
  accountName: string;
  /** Side-flipped from the source line. */
  debit: Decimal;
  credit: Decimal;
  description: string;
}

export type MirrorPlan =
  | { ok: true; lines: MirrorLinePlan[] }
  | { ok: false; blockers: string[] };

/**
 * Pure derivation of the mirror's lines. No I/O — callers fetch the
 * source lines and the counterparty's candidate accounts, this decides.
 *
 * `counterpartyEntityId` disambiguates account candidates: an account
 * scoped to the counterparty entity beats a shared (entityId null) one
 * of the same subtype; two candidates at the same specificity is a
 * refusal, not a coin flip.
 */
export function deriveMirrorPlan(
  sourceLines: SourceLineForMirror[],
  candidates: CounterpartyAccountCandidate[],
  counterpartyEntityId: string
): MirrorPlan {
  const blockers: string[] = [];
  const lines: MirrorLinePlan[] = [];

  for (const line of sourceLines) {
    const paired = line.subtype ? IC_SUBTYPE_PAIR[line.subtype] : undefined;
    if (!paired) {
      blockers.push(
        `Line ${line.lineNo} (${line.accountCode} ${line.accountName}) has no intercompany subtype — ` +
          `only entries whose every line is DUE_FROM/DUE_TO_AFFILIATE or INTERCOMPANY_REV/EXP can be mirrored.`
      );
      continue;
    }

    // Entity-scoped beats shared; ties within a tier are ambiguous, so
    // this takes the whole winning tier rather than a single winner.
    const matches = candidates.filter((c) => c.subtype === paired);
    const pool = entityScopedPool(matches, counterpartyEntityId);

    if (pool.length === 0) {
      blockers.push(
        `Counterparty has no active account with subtype ${paired} ` +
          `(needed to mirror line ${line.lineNo}, ${line.accountCode}).`
      );
      continue;
    }
    if (pool.length > 1) {
      blockers.push(
        `Counterparty has ${pool.length} candidate accounts with subtype ${paired} ` +
          `(${pool.map((c) => c.code).join(", ")}) — ambiguous; mirror line ${line.lineNo} manually.`
      );
      continue;
    }

    const account = pool[0];
    lines.push({
      accountCode: account.code,
      accountName: account.name,
      // The side flip IS the mirror: A's receivable is B's payable,
      // A's IC income is B's IC expense.
      debit: line.credit,
      credit: line.debit,
      description: line.description ?? "",
    });
  }

  if (blockers.length > 0) return { ok: false, blockers };
  return { ok: true, lines };
}

export class IntercompanyMirrorError extends Error {
  constructor(
    public readonly code:
      | "SOURCE_NOT_FOUND"
      | "SOURCE_NOT_POSTED"
      | "SOURCE_IS_MIRROR"
      | "COUNTERPARTY_NOT_FOUND"
      | "COUNTERPARTY_IS_SOURCE_ENTITY"
      | "CROSS_CURRENCY"
      | "NOT_MIRRORABLE"
      | "ALREADY_MIRRORED",
    message: string,
    public readonly blockers: string[] = [],
    /** Set on ALREADY_MIRRORED — the existing mirror's id. */
    public readonly existingMirrorId?: string
  ) {
    super(message);
    this.name = "IntercompanyMirrorError";
  }
}

export interface PrepareMirrorInput {
  tenantId: string;
  sourceEntryId: string;
  /** Resolved within the tenant — never an id from the client. */
  counterpartyEntityCode: string;
  /** "POSTED" | "PENDING_APPROVAL" from resolveApprovalRoute — parity
   *  with what the same actor typing the entry by hand would get. */
  route: "POSTED" | "PENDING_APPROVAL";
  actor: { id: string; email: string };
}

export interface PrepareMirrorResult {
  mirrorEntryId: string;
  entryNumber: string;
  status: "POSTED" | "PENDING_APPROVAL";
  counterpartyEntityCode: string;
}

/**
 * Create the counterparty mirror of a posted intercompany entry.
 * Throws IntercompanyMirrorError with a machine-readable code on every
 * refusal path; the Server Action turns those into card copy.
 */
export async function prepareIntercompanyMirror(
  prisma: DbClient,
  input: PrepareMirrorInput
): Promise<PrepareMirrorResult> {
  const source = await prisma.journalEntry.findFirst({
    where: { id: input.sourceEntryId, tenantId: input.tenantId },
    include: {
      entity: { select: { id: true, code: true } },
      book: { select: { id: true, code: true } },
      currency: { select: { code: true } },
      lines: {
        include: { account: { select: { code: true, name: true, subtype: true } } },
        orderBy: { lineNo: "asc" },
      },
    },
  });
  if (!source) {
    throw new IntercompanyMirrorError("SOURCE_NOT_FOUND", "Source entry not found.");
  }
  // Only a POSTED source is mirrorable: mirroring a pending entry could
  // post the mirror while the source is later rejected; REVERSED means
  // the economics were undone — mirror the reversal instead.
  if (source.status !== "POSTED") {
    throw new IntercompanyMirrorError(
      "SOURCE_NOT_POSTED",
      `Only a POSTED entry can be mirrored (this one is ${source.status}).`
    );
  }
  // A mirror of a mirror would ping-pong balances between the entities.
  if (source.sourceSystem === IC_MIRROR_SOURCE_SYSTEM) {
    throw new IntercompanyMirrorError(
      "SOURCE_IS_MIRROR",
      "This entry is itself an intercompany mirror — mirror chains are refused."
    );
  }

  const counterparty = await prisma.legalEntity.findFirst({
    where: { tenantId: input.tenantId, code: input.counterpartyEntityCode },
    include: { functionalCurrency: { select: { code: true } } },
  });
  if (!counterparty) {
    throw new IntercompanyMirrorError(
      "COUNTERPARTY_NOT_FOUND",
      `No entity ${input.counterpartyEntityCode} in this tenant.`
    );
  }
  if (counterparty.id === source.entity.id) {
    throw new IntercompanyMirrorError(
      "COUNTERPARTY_IS_SOURCE_ENTITY",
      "An entry cannot be mirrored into its own entity."
    );
  }
  // v1 scope: the mirror posts in the source's transaction currency, so
  // the counterparty must book in that currency too. A cross-currency
  // mirror needs an FX-rate decision a mechanical derivation shouldn't
  // make — post it manually (or via the FX-revaluation path).
  if (
    counterparty.functionalCurrency &&
    source.currency.code !== counterparty.functionalCurrency.code
  ) {
    throw new IntercompanyMirrorError(
      "CROSS_CURRENCY",
      `Source is ${source.currency.code} but ${counterparty.code}'s functional currency is ` +
        `${counterparty.functionalCurrency.code} — cross-currency mirrors are not automated; post manually.`
    );
  }

  // Idempotency pre-check for a friendly error; the lineage unique index
  // on (tenantId, bookId, sourceSystem, sourceRecordType, sourceRecordId)
  // is the structural backstop under a true race.
  const mirrorLineage = sourceLineage.icMirror(source.id);
  const existing = await findEntryBySourceLineage(prisma, {
    tenantId: input.tenantId,
    bookId: source.book.id,
    lineage: mirrorLineage,
  });
  if (existing) {
    throw new IntercompanyMirrorError(
      "ALREADY_MIRRORED",
      `Mirror already prepared as ${existing.entryNumber} (${existing.status}).`,
      [],
      existing.id
    );
  }

  const neededSubtypes = Array.from(
    new Set(
      source.lines
        .map((l) => (l.account.subtype ? IC_SUBTYPE_PAIR[l.account.subtype] : undefined))
        .filter((s): s is string => Boolean(s))
    )
  );
  const candidates = await prisma.account.findMany({
    where: {
      tenantId: input.tenantId,
      active: true,
      subtype: { in: neededSubtypes.length > 0 ? neededSubtypes : ["__none__"] },
      OR: [{ entityId: null }, { entityId: counterparty.id }],
    },
    select: { code: true, name: true, subtype: true, entityId: true },
  });

  const plan = deriveMirrorPlan(
    source.lines.map((l) => ({
      lineNo: l.lineNo,
      accountCode: l.account.code,
      accountName: l.account.name,
      subtype: l.account.subtype,
      debit: new Decimal(l.debit.toString()),
      credit: new Decimal(l.credit.toString()),
      description: l.description,
    })),
    candidates,
    counterparty.id
  );
  if (!plan.ok) {
    throw new IntercompanyMirrorError(
      "NOT_MIRRORABLE",
      "This entry cannot be mirrored mechanically.",
      plan.blockers
    );
  }

  const posted = await postJournalEntry(prisma, {
    tenantId: input.tenantId,
    entityCode: counterparty.code,
    bookCode: source.book.code,
    currencyCode: source.currency.code,
    documentDate: source.documentDate,
    memo: `IC mirror of ${source.entryNumber} (${source.entity.code}): ${source.memo}`.slice(0, 500),
    // SYSTEM, not MANUAL: the lines are machine-derived. Not AI_APPROVED:
    // the derivation is deterministic, no model involved.
    source: "SYSTEM",
    createdBy: input.actor.email,
    ownerUserId: input.actor.id,
    initialStatus: input.route,
    submittedByUserId: input.route === "PENDING_APPROVAL" ? input.actor.id : undefined,
    ...mirrorLineage,
    extensions: {
      intercompany: {
        role: "mirror",
        sourceEntryId: source.id,
        sourceEntryNumber: source.entryNumber,
        sourceEntityCode: source.entity.code,
      },
    },
    lines: plan.lines.map((l) => ({
      accountCode: l.accountCode,
      debit: l.debit,
      credit: l.credit,
      description: l.description || undefined,
    })),
  });

  return {
    mirrorEntryId: posted.id,
    entryNumber: posted.entryNumber,
    status: input.route,
    counterpartyEntityCode: counterparty.code,
  };
}

/** The mirror prepared from `entryId`, if any (any status — a VOID
 *  mirror records a rejected pairing decision and blocks re-preparation). */
export async function findMirrorOfEntry(
  prisma: DbClient,
  args: { tenantId: string; entryId: string }
): Promise<{ id: string; entryNumber: string; status: string; entityCode: string } | null> {
  const mirror = await prisma.journalEntry.findFirst({
    where: {
      tenantId: args.tenantId,
      sourceSystem: IC_MIRROR_SOURCE_SYSTEM,
      sourceRecordType: IC_MIRROR_RECORD_TYPE,
      sourceRecordId: args.entryId,
    },
    select: {
      id: true,
      entryNumber: true,
      status: true,
      entity: { select: { code: true } },
    },
  });
  return mirror
    ? {
        id: mirror.id,
        entryNumber: mirror.entryNumber,
        status: mirror.status,
        entityCode: mirror.entity.code,
      }
    : null;
}
