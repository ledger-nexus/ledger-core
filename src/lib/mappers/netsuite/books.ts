// NetSuite AccountingBook → ledger-core Book mapping (v0.8 Phase 1).
//
// NS multi-book support. Each NS AccountingBook maps to an existing
// ledger-core Book row (US_GAAP, US_TAX, IFRS, etc.). The orchestrator
// uses this map at per-transaction post time to call postJournalEntry
// once per (transaction, book) pair — Pattern 2 multi-book.
//
// Design: docs/netsuite-accounting-books-design.md
//
// Phase 1 (this commit): types + pure mapper + orchestrator step +
// unit tests. Per-transaction routing wires through in Phase 3.
//
// Idempotent: setupBooks validates every NS book maps to an existing
// ledger-core Book row. Doesn't create new Book rows on its own
// because Book metadata (basis, reportingCurrencyId) is operator-
// configurable and the importer shouldn't pick defaults.

import type { PrismaClient } from "@prisma/client";

import type { NsAccountingBook } from "./types";

// ─── Book resolution ───────────────────────────────────────────────────
//
// How the orchestrator decides which ledger-core book each NS
// transaction posts to. Two modes:
//
//   - "single": every transaction posts to ONE named ledger-core book.
//     This is the v0.6/v0.7 backward-compat path — `bookCode: "US_GAAP"`.
//   - "multi":  each NS AccountingBook maps to a ledger-core book via
//     `bookMapping`. Per-transaction routing posts to every mapped book.

export type BookResolution =
  | { mode: "single"; bookCode: string }
  | { mode: "multi"; bookMapping: Record<string, string> };
//                              ^ NS internalid → ledger-core book code

/**
 * Compute the ledger-core book code(s) for a given NS book under
 * the chosen resolution. Single mode returns `[bookCode]` always.
 * Multi mode looks up the NS book in the mapping; throws when not
 * found (the operator must declare every book they want imported).
 */
export function resolveBookCodes(
  nsBookInternalIds: string[],
  resolution: BookResolution
): string[] {
  if (resolution.mode === "single") {
    return [resolution.bookCode];
  }
  const codes: string[] = [];
  for (const id of nsBookInternalIds) {
    const code = resolution.bookMapping[id];
    if (!code) {
      throw new BookNotMappedError(id, Object.keys(resolution.bookMapping));
    }
    codes.push(code);
  }
  // De-duplicate. If multiple NS books map to the same ledger-core
  // book (the operator's choice — e.g. NS adjustment book folded into
  // a single ledger-core book), we don't want to double-post.
  return Array.from(new Set(codes));
}

/**
 * Thrown when an NS book has no entry in `bookMapping`. The error
 * includes the unmapped id + the available mapping keys so the
 * operator can see what they declared.
 */
export class BookNotMappedError extends Error {
  nsBookInternalId: string;
  availableKeys: string[];
  constructor(nsBookInternalId: string, availableKeys: string[]) {
    super(
      `NS AccountingBook "${nsBookInternalId}" has no entry in bookMapping. ` +
        `Declared mappings: [${availableKeys.join(", ") || "(none)"}]. ` +
        `Add an entry like \`bookMapping: { "${nsBookInternalId}": "US_TAX" }\`.`
    );
    this.name = "BookNotMappedError";
    this.nsBookInternalId = nsBookInternalId;
    this.availableKeys = availableKeys;
  }
}

// ─── Pure mapper ───────────────────────────────────────────────────────

export interface MappedBook {
  /** The original NS internalid (preserved for lineage). */
  internalid: string;
  /** Resolved ledger-core book code (e.g. "US_GAAP"). */
  bookCode: string;
  /** The NS book name (e.g. "US GAAP"). */
  name: string;
  /** Adjustment-only flag — passed through to extensions. */
  isAdjustment: boolean;
  /**
   * The frozen original NsAccountingBook for the reverse exporter
   * to replay without re-deriving. Same lineage-replay pattern that
   * subsidiaries.ts established in v0.7.
   */
  sourcePayload: NsAccountingBook;
}

export function mapNsBook(
  ns: NsAccountingBook,
  resolution: BookResolution
): MappedBook {
  const codes = resolveBookCodes([ns.internalid], resolution);
  // resolveBookCodes returns at least one code (single mode always,
  // multi mode after passing one id).
  return {
    internalid: ns.internalid,
    bookCode: codes[0]!,
    name: ns.name,
    isAdjustment: ns.isadjustment ?? false,
    sourcePayload: ns,
  };
}

// ─── Orchestrator step ────────────────────────────────────────────────

export interface SetupBooksInput {
  books: NsAccountingBook[];
  resolution: BookResolution;
}

export interface SetupBooksResult {
  /** Map of NS book internalid → ledger-core book code (resolved). */
  bookCodeByInternalid: Map<string, string>;
  /** Count of NS books processed (1+ in multi mode; 0 in single mode). */
  booksProcessed: number;
  /** Non-fatal warnings the operator should see. */
  warnings: string[];
}

/**
 * Validate that every NS AccountingBook maps to an existing ledger-
 * core Book row. Doesn't create Book rows on its own — Book metadata
 * (basis, reportingCurrencyId) is operator-configurable and the
 * importer shouldn't pick defaults.
 *
 * Throws BookNotMappedError when multi mode + an NS book has no
 * mapping. Throws Error("ledger-core book X does not exist") when
 * the mapping target doesn't exist (operator must create the Book
 * row first).
 */
export async function setupBooks(
  prisma: PrismaClient,
  input: SetupBooksInput
): Promise<SetupBooksResult> {
  const warnings: string[] = [];
  const bookCodeByInternalid = new Map<string, string>();

  // Single mode: every NS book (if any) maps to the one named ledger-
  // core book. Phase 1 doesn't bother walking the array in single mode.
  if (input.resolution.mode === "single") {
    if (input.books.length > 1) {
      warnings.push(
        `Single-book mode with ${input.books.length} NS books in the export — ` +
          `all transactions will post to "${input.resolution.bookCode}". ` +
          `Use multi mode + bookMapping to preserve per-book divergence.`
      );
    }
    // Even in single mode, populate the map so per-tx code can do a
    // uniform `bookCodeByInternalid.get(nsBookId) ?? singleBookCode`
    // lookup later.
    for (const ns of input.books) {
      bookCodeByInternalid.set(ns.internalid, input.resolution.bookCode);
    }
    return {
      bookCodeByInternalid,
      booksProcessed: input.books.length,
      warnings,
    };
  }

  // Multi mode: walk the NS book array, resolve each to a ledger-core
  // book code, verify the Book row exists.
  if (input.books.length === 0) {
    warnings.push(
      "Multi-book mode but NS export has no AccountingBook array. " +
        "Multi mode is only useful when the NS export declares its books."
    );
    return { bookCodeByInternalid, booksProcessed: 0, warnings };
  }

  // De-duplicate the target ledger-core book codes — the operator
  // may map multiple NS books to the same ledger-core book (e.g. an
  // NS adjustment-book folded into the parent). Verify each distinct
  // target exists.
  const distinctTargetCodes = new Set<string>();
  for (const ns of input.books) {
    const target = input.resolution.bookMapping[ns.internalid];
    if (!target) {
      throw new BookNotMappedError(
        ns.internalid,
        Object.keys(input.resolution.bookMapping)
      );
    }
    distinctTargetCodes.add(target);
    bookCodeByInternalid.set(ns.internalid, target);
  }

  const existingBooks = await prisma.book.findMany({
    where: { code: { in: Array.from(distinctTargetCodes) } },
    select: { code: true },
  });
  const existingCodes = new Set(existingBooks.map((b) => b.code));
  for (const target of distinctTargetCodes) {
    if (!existingCodes.has(target)) {
      // Operator-actionable error: they declared a mapping target
      // that doesn't exist in ledger-core. Better to fail loudly than
      // silently skip half the books.
      throw new Error(
        `ledger-core Book "${target}" does not exist. ` +
          `Create the Book row first (via seed or admin UI) before importing ` +
          `NS books that map to it.`
      );
    }
  }

  return {
    bookCodeByInternalid,
    booksProcessed: input.books.length,
    warnings,
  };
}

// ─── Resolution helper from ImportFromNsInput ────────────────────────

/**
 * Backward-compat shape fold. Legacy callers pass `bookCode`
 * (single-book mode). New callers pass `bookResolution`. This
 * helper normalizes either into a canonical BookResolution. Mirrors
 * resolveEntityResolution from subsidiaries.ts.
 */
export function resolveBookResolution(input: {
  bookCode?: string;
  bookResolution?: BookResolution;
}): BookResolution {
  if (input.bookResolution) return input.bookResolution;
  if (input.bookCode) {
    return { mode: "single", bookCode: input.bookCode };
  }
  // Default to US_GAAP single mode when neither is set — matches the
  // v0.7 importer default that was `bookCode ?? "US_GAAP"`.
  return { mode: "single", bookCode: "US_GAAP" };
}
