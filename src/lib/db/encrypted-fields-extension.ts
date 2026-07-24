// Prisma client extension — transparent at-rest encryption for
// confidential columns.
//
// Confidentiality TSC. Builds on the AES-256-GCM helper in
// src/lib/soc2/field-encryption.ts. The extension wires the helper
// into Prisma so feature code never has to remember to encrypt/
// decrypt — `prisma.journalEntry.create({ data: { memo } })` writes
// ciphertext to Postgres, and `prisma.journalEntry.findUnique(...)`
// returns the plaintext memo to the caller.
//
// Column registry (single source of truth):
//   See ENCRYPTED_COLUMNS below. To add a column:
//     1. Add the (model, field) pair here
//     2. Verify the Prisma type is `String?` (we encode null-as-null
//        and refuse empty strings)
//     3. Add the field name to `PII_FIELD_NAMES` in
//        `src/lib/soc2/index.ts` so it also redacts in logs
//     4. Add a migration entry in `prisma/sql/encrypt-{model}-{field}.ts`
//        that re-encrypts existing plaintext rows (skip already-
//        encrypted via `looksEncrypted`)
//     5. Update `docs/policies/data-classification.md`
//
// Failure modes:
//   - If FIELD_ENCRYPTION_KEY isn't set, the extension passes the
//     plaintext through unchanged. The helper throws
//     KeyNotConfiguredError if called, but the extension catches and
//     warns rather than failing every Prisma query. This is the
//     "rollout safety net" — production sets the key on day 1; dev
//     can run without it.
//   - Decryption failure (tampered ciphertext, wrong key) on read
//     surfaces as a FieldEncryptionError on the read path.
//     Application code should catch and fall back to displaying
//     "[Encryption error — contact support]" rather than crashing
//     the page.
//
// Per-model wiring is intentionally explicit rather than reflection-
// driven. Adding a new encrypted column is a code review event;
// hiding that behind a decorator would make it invisible.

import { Prisma } from "@prisma/client";
import {
  encryptField,
  decryptField,
  looksEncrypted,
  KeyNotConfiguredError,
  FieldEncryptionError,
} from "@/lib/soc2/field-encryption";
import { searchHash } from "@/lib/soc2/deterministic-encryption";

// ─────────────────────────────────────────────────────────────────────────────
// Column registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Tuples of (Prisma model name, field name) for every column the
 * extension transparently encrypts. Order doesn't matter; lookups
 * happen by model + field.
 *
 * Type modes:
 *   - default ("string"): the column is `String?` or `String` in
 *     Prisma. The plaintext is encrypted as-is; the ciphertext
 *     envelope is stored as a String column value.
 *   - "json": the column is `Json?` or `Json` in Prisma. The value
 *     can be any JsonValue (object / array / primitive / null). On
 *     write we JSON.stringify before encrypt; on read we JSON.parse
 *     after decrypt. The ciphertext envelope is a base64 string, and
 *     a quoted string is itself a valid JsonValue — so Prisma is
 *     happy storing it in a Json column. Mixed plaintext / ciphertext
 *     during rollout works because looksEncrypted gates the parse.
 */
export type EncryptedColumnType = "string" | "json";

/**
 * Search-hash configuration for a column that needs equality lookups.
 * When set, the extension writes BOTH the encrypted value to `field`
 * AND a deterministic HMAC-SHA256 hash to `hashColumn`. Call sites
 * filter by `hashColumn` using the helper from
 * `@/lib/soc2/deterministic-encryption`. See
 * `docs/design/deterministic-encryption.md` for the full design.
 *
 * `domain` is the canonical column name used to separate hashes
 * across columns (so the hash of `"alice@a"` under `"User.email"` is
 * different from the hash under `"TenantInvite.email"`). MUST stay
 * stable for the column's lifetime — changing it invalidates every
 * hash on disk.
 *
 * `normalize` is the canonicalization policy. Currently
 * `"emailLowercase"` (lowercase + trim) and `"exact"` (no transform).
 */
export interface SearchHashConfig {
  hashColumn: string;
  domain: string;
  normalize: "emailLowercase" | "exact";
}

export const ENCRYPTED_COLUMNS: ReadonlyArray<{
  model: string;
  field: string;
  type?: EncryptedColumnType;
  /** Set ONLY on columns that need equality lookups (email, slug). */
  searchHash?: SearchHashConfig;
}> = [
  { model: "JournalEntry", field: "memo" },
  // Bank-feed descriptions carry merchant/payee detail — as sensitive as
  // a JE memo. The dedupeHash is computed on plaintext at import time, so
  // encrypting the stored description doesn't affect idempotency.
  { model: "BankTransaction", field: "description" },
  // Learned rules derive from those descriptions; same sensitivity. The
  // sha256 matchHash column provides the uniqueness the ciphertext can't.
  { model: "BankRule", field: "matchText" },
  // EmailDelivery body fields contain literal email content sent to
  // users — JE memos, owner-transfer offers, invite tokens. Highest-
  // cost-per-leak after JE memo because a leaked email body typically
  // reveals BOTH the tenant context AND the operational event in the
  // same row.
  // Party.displayName is the customer / vendor / contact name as
  // displayed across AR/AP, JE detail, and the aging reports. A
  // leaked Party table = a leaked customer roster, which is also
  // a competitive-intelligence asset. Audited 2026-05-29 across all
  // 5 repos: zero queries filter by displayName (only `code` is
  // searchable), so AES-GCM is safe — no need for deterministic
  // encryption or a secondary search index.
  // EmailDelivery.{subject,bodyText,bodyHtml} intentionally absent —
  // the EmailDelivery model never landed on main (chain-era). Re-add
  // the three entries when that model ships.
  { model: "Party", field: "displayName" },
  // JournalEntryNote.body is plain-text prose CPAs write to annotate
  // ledger entries. The schema comment says it directly: "CPAs write
  // short prose." Annotations regularly include customer names,
  // vendor invoices, internal context ("this is the disputed Acme
  // invoice — see email thread 4/22"). The notes UI displays one note
  // at a time, ordered by createdAt — no text-search filter has ever
  // been requested, and the resolve UI keys off `resolvedAt` not body
  // content. Audited 2026-05-30 across all 5 repos: zero filter-by-
  // body queries. Standard AES-GCM is safe.
  { model: "JournalEntryNote", field: "body" },
  // Tenant.name is the customer's organization name as displayed in
  // the workspace switcher, billing pages, and admin tools. It's NOT
  // the slug (which stays plaintext — it's the URL key, in WHERE
  // clauses everywhere). The pair of {slug, name} is the same shape
  // as Party {code, displayName} — searchable id stays plaintext,
  // free-text display name gets encrypted. Audited 2026-05-30: zero
  // filter-by-name queries. Reads happen on Tenant load (every
  // authenticated request) — AES-GCM is microseconds so the per-
  // session decrypt is perf-neutral.
  { model: "Tenant", field: "name" },
  // Notification.{title,body} carries the rendered per-user alert
  // text: "Acme paid $5,000 invoice 1234", "Owner transfer to alice
  // declined", "JE-2026-01 needs approval". The category enum is
  // plaintext (used for filtering); the rendered text routinely
  // includes customer names, vendor names, dollar amounts, JE
  // numbers — the prose surface where multiple PII vectors land in
  // one row. Audited 2026-05-31: zero filter queries on title or
  // body; only display reads via the notification bell + user-data
  // export.
  { model: "Notification", field: "title" },
  { model: "Notification", field: "body" },
  // LegalEntity.name is the customer's legal company name (e.g.
  // "Acme Corp, Inc."), distinct from `code` (the lookup key, in
  // WHERE clauses everywhere) and `tenantId` (the actor scope).
  // Same {code, name} shape as Tenant and Party — searchable id
  // stays plaintext, free-text display name gets encrypted.
  // Audited 2026-05-31: zero filter-by-name queries; only display
  // reads in reports, headers, BTD, and the consolidation hierarchy.
  { model: "LegalEntity", field: "name" },
  // User.displayName is the human-readable name shown on the user's
  // profile, audit log attributions, and owner-transfer
  // notifications. Audited 2026-05-31: zero filter-by-displayName
  // queries; only display reads.
  { model: "User", field: "displayName" },
  // User.email — the login-keyed PII. Encrypted-at-rest with an
  // HMAC-SHA256 search hash in `emailHash` to preserve the
  // upsert-by-email + findUnique-by-email paths used by the Clerk
  // login flow and the seed code. See
  // `docs/design/deterministic-encryption.md` for the full design.
  //
  // Lookup pattern at every call site:
  //   const hash = emailLookupKeyForUser(email);
  //   await prisma.user.findUnique({ where: { emailHash: hash } });
  //
  // Re-audited 2026-07-23 (the 2026-05-31 note said "3 lookup-by-email
  // sites" — main has moved a great deal since). Actual count on the
  // day this landed: 4 in src/ (Clerk upsert, 2 Northwind seed sites,
  // ensureDefaultTenant) and 47 across 38 test files. Migrating 51 call
  // sites by hand was the wrong shape of fix, so the extension now
  // rewrites equality `where` filters onto `emailHash` itself — see
  // rewriteWhereForSearchHash. Only substring/range filters need
  // hand-editing, and those now throw EncryptedFieldQueryError instead
  // of silently matching nothing.
  {
    model: "User",
    field: "email",
    searchHash: {
      hashColumn: "emailHash",
      domain: "User.email",
      normalize: "emailLowercase",
    },
  },
  // AuditLog.metadata is the per-event payload for SOC 2 audit
  // records — varies by eventType, examples:
  //   - PRIVILEGED_ACTION → { action, reason, resource, resourceId, ... }
  //   - DATA_EXPORT       → { format, rowCount }
  //   - LOGIN_FAILED      → { reason, attemptedEmail (hashed) }
  //   - JE_POSTED         → { entryNumber, lineCount, ... }
  // Routinely embeds resource identifiers + actor context + reason
  // text. While the audit-log row itself is protected by the
  // append-only RULE + admin-only RBAC, the JSON body has high PII
  // density per row and should be encrypted at rest.
  //
  // IMPORTANT — backfill posture: audit_log is append-only at the DB
  // level (CC6). UPDATE/DELETE are blocked by Postgres rules in
  // production. New writes from this rollout forward encrypt
  // automatically (the extension's create hook fires). Legacy
  // plaintext rows can only be migrated in dev/staging where
  // withAuditLogMutable() can temporarily disable the rules.
  // Production legacy rows stay plaintext for the 7-year retention
  // period — a documented limitation, not a code gap.
  //
  // Audited 2026-05-31: zero filter queries on metadata. Display
  // happens via JSON.stringify on /admin/audit-log; the snippet
  // helper at metadataSnippet() also gets the decrypted JsonValue.
  { model: "AuditLog", field: "metadata", type: "json" },
  // JournalEntry.sourcePayload is the FROZEN verbatim payload from
  // the source ERP — QBO Invoice JSON, NetSuite Transaction with
  // nested lines, etc. Per CLAUDE.md mapper discipline: "Every
  // imported row MUST populate sourcePayload (the frozen raw
  // original — verbatim, not a re-encoding). The roundtrip proof
  // depends on sourcePayload being preserved exactly."
  //
  // Content can include: customer/vendor names + addresses, dollar
  // amounts on every line, source-ERP user emails, custom-field
  // values, tax IDs from the source system. Highest per-row PII
  // density in the substrate.
  //
  // The Json-column encryption mode (type: "json") JSON.stringify's
  // on write + JSON.parse's on read — the column stays Prisma type
  // Json (storing the ciphertext envelope as a JSON string), the
  // app surface still sees the original JsonValue. Roundtrip
  // exactness is preserved bit-for-bit.
  //
  // Audited 2026-05-31: zero filter queries on sourcePayload. Only
  // displayed verbatim via JSON.stringify on /journal-entries/[id],
  // and read by QBO/NetSuite reverse-mappers (export paths) which
  // also reconstruct from the same JsonValue.
  { model: "JournalEntry", field: "sourcePayload", type: "json" },
  // Add new rows here as the rollout proceeds. Each addition needs a
  // matching migration script in prisma/sql/ that backfills existing
  // rows. See README in that directory.
];

function isEncryptedColumn(model: string, field: string): boolean {
  return ENCRYPTED_COLUMNS.some((c) => c.model === model && c.field === field);
}

function fieldsForModel(model: string): string[] {
  return ENCRYPTED_COLUMNS.filter((c) => c.model === model).map((c) => c.field);
}

/** Returns the encryption mode for a (model, field), or "string" by default. */
function columnType(model: string, field: string): EncryptedColumnType {
  const entry = ENCRYPTED_COLUMNS.find(
    (c) => c.model === model && c.field === field
  );
  return entry?.type ?? "string";
}

/**
 * Returns the searchHash config for a (model, field), or null if the
 * column doesn't need a deterministic search hash. When non-null, the
 * write path also computes `searchHash(domain, plaintext, normalize)`
 * and writes it to `data[hashColumn]`.
 */
function searchHashConfigFor(
  model: string,
  field: string
): SearchHashConfig | null {
  const entry = ENCRYPTED_COLUMNS.find(
    (c) => c.model === model && c.field === field
  );
  return entry?.searchHash ?? null;
}

/** Every searchHash-backed column declared for a model. */
function searchHashFieldsForModel(
  model: string
): Array<{ field: string; config: SearchHashConfig }> {
  return ENCRYPTED_COLUMNS.filter(
    (c) => c.model === model && c.searchHash != null
  ).map((c) => ({ field: c.field, config: c.searchHash as SearchHashConfig }));
}

/**
 * Thrown when a query filters an encrypted column with an operator that
 * a deterministic hash cannot express.
 *
 * This exists to convert a SILENT WRONG ANSWER into a loud failure.
 * Ciphertext is AES-GCM with a random IV, so `contains` / `startsWith`
 * against the encrypted column matches nothing — the query returns an
 * empty result and the caller concludes "no such rows" instead of
 * "this question can't be asked here". That failure mode bit us in the
 * self-healing `beforeAll` cleanup helpers, where finding zero orphan
 * rows looks exactly like a clean database.
 */
export class EncryptedFieldQueryError extends Error {
  constructor(model: string, field: string, operators: string[], hashColumn: string) {
    super(
      `Cannot filter ${model}.${field} with [${operators.join(", ")}] — the ` +
        `column is encrypted at rest with a random IV, so substring and ` +
        `range operators match nothing. Only equality (a bare value, ` +
        `\`equals\`, \`in\`, \`not\`, \`notIn\`) is supported; those are ` +
        `rewritten onto \`${hashColumn}\` automatically. To select rows by ` +
        `a partial ${field}, filter on a non-encrypted column instead ` +
        `(e.g. an id set gathered beforehand). See ` +
        `docs/design/deterministic-encryption.md.`
    );
    this.name = "EncryptedFieldQueryError";
  }
}

/**
 * Parent-to-child relation map. Lets the encryption walker recurse
 * into nested writes like:
 *   prisma.bankStatement.create({ data: { lines: { create: [{...}] } } })
 * Prisma's $extends query hook only fires on the TOP-LEVEL model;
 * the nested create payload never sees the child's hook. We
 * compensate by enumerating the relation paths that lead to
 * encrypted columns and walking them explicitly.
 *
 * Empty in ledger-core today (no nested-write paths land in an
 * encrypted child). Recon's mirror populates this.
 */
const RELATION_MAP: ReadonlyArray<{
  parent: string;
  relation: string;
  child: string;
}> = [
  // Add { parent, relation, child } when a feature in ledger-core
  // does a nested create that writes into an encrypted column.
];

function relationsForModel(parent: string): Array<{
  relation: string;
  child: string;
}> {
  return RELATION_MAP.filter((r) => r.parent === parent).map((r) => ({
    relation: r.relation,
    child: r.child,
  }));
}

/**
 * True iff this model has either an encrypted column directly OR a
 * relation path to a child model that does. Used by the query hooks
 * to decide whether to walk args.data at all.
 */
function modelTouchesEncryption(model: string): boolean {
  if (fieldsForModel(model).length > 0) return true;
  for (const r of RELATION_MAP) {
    if (r.parent === model && fieldsForModel(r.child).length > 0) return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Encryption helpers (safe wrappers — never crash the query)
// ─────────────────────────────────────────────────────────────────────────────

let warnedAboutMissingKey = false;

/**
 * Encrypt a value if it's a string + the key is configured.
 * Pass-through (with a one-time warning) when key is missing.
 * Skip already-encrypted values (idempotency on UPDATE).
 */
function safeEncrypt(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (looksEncrypted(value)) return value;
  try {
    return encryptField(value);
  } catch (e) {
    if (e instanceof KeyNotConfiguredError) {
      if (!warnedAboutMissingKey) {
        console.warn(
          "[encrypted-fields] FIELD_ENCRYPTION_KEY is not set; columns " +
            "in ENCRYPTED_COLUMNS write plaintext. Set the env var to enable."
        );
        warnedAboutMissingKey = true;
      }
      return value;
    }
    throw e;
  }
}

/**
 * Decrypt a value if it looks encrypted. Pass-through when it
 * doesn't (allows mixed plaintext / ciphertext during rollout).
 * Decryption failures surface as a FieldEncryptionError; callers
 * decide whether to swallow or propagate.
 */
function safeDecrypt(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!looksEncrypted(value)) return value;
  try {
    return decryptField(value);
  } catch (e) {
    if (e instanceof KeyNotConfiguredError) {
      // The ciphertext is in the row but we can't decrypt. Return a
      // sentinel so the application can render "[Encryption error]"
      // rather than crash.
      return "[encrypted — key not configured]";
    }
    if (e instanceof FieldEncryptionError) {
      return "[encryption error — contact support]";
    }
    throw e;
  }
}

/**
 * Encrypt a JsonValue. We JSON.stringify the value first so the
 * AES-GCM helper can do its thing on a string, then store the base64
 * ciphertext envelope as the Json column's value. Quoted strings are
 * legal JsonValues, so Prisma is happy.
 *
 * Null / undefined skip encryption (Prisma writes a SQL NULL).
 *
 * "Already encrypted" idempotency: if Prisma hands us a string that
 * looksEncrypted, we leave it alone (this happens on legacy rows
 * being re-saved, or on the backfill script's UPDATE selector
 * pattern).
 */
function safeEncryptJson(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" && looksEncrypted(value)) return value;
  try {
    return encryptField(JSON.stringify(value));
  } catch (e) {
    if (e instanceof KeyNotConfiguredError) {
      if (!warnedAboutMissingKey) {
        console.warn(
          "[encrypted-fields] FIELD_ENCRYPTION_KEY is not set; Json columns " +
            "in ENCRYPTED_COLUMNS write plaintext. Set the env var to enable."
        );
        warnedAboutMissingKey = true;
      }
      return value;
    }
    throw e;
  }
}

/**
 * Decrypt a JsonValue read from Prisma. If Prisma gave us a string
 * that looksEncrypted, decrypt + JSON.parse to recover the original
 * JsonValue. Otherwise (legacy row, plaintext JSON value, primitive,
 * null) pass through unchanged — this is what enables mixed
 * plaintext/ciphertext during the rollout window.
 */
function safeDecryptJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return value;
  if (!looksEncrypted(value)) return value;
  try {
    const plaintext = decryptField(value);
    if (plaintext === null) return value;
    try {
      return JSON.parse(plaintext);
    } catch {
      // Shouldn't happen — we JSON.stringify on write — but if a row
      // was written by some other path with non-JSON ciphertext,
      // surface the decrypted string rather than crash.
      return plaintext;
    }
  } catch (e) {
    if (e instanceof KeyNotConfiguredError) {
      return "[encrypted — key not configured]";
    }
    if (e instanceof FieldEncryptionError) {
      return "[encryption error — contact support]";
    }
    throw e;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension
// ─────────────────────────────────────────────────────────────────────────────
//
// Two phases per operation:
//   1. WRITE (create / update / upsert / createMany): walk the input
//      `data` recursively and encrypt any field name in the registry
//      for the operating model.
//   2. READ (findFirst / findMany / findUnique / etc.): walk the
//      result and decrypt any ciphertext.
//
// `createMany` returns a count, not rows — no read decryption needed.
// `updateMany` returns a count, no read decryption.

export const encryptedFieldsExtension = Prisma.defineExtension({
  name: "encrypted-fields",
  query: {
    $allModels: {
      async create({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.data = encryptDataObject(model, args.data) as typeof args.data;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async createMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        const data = args.data as unknown;
        if (Array.isArray(data)) {
          args.data = data.map((row) => encryptDataObject(model, row)) as typeof args.data;
        } else {
          args.data = encryptDataObject(model, data) as typeof args.data;
        }
        return query(args);
      },

      async update({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.data = encryptDataObject(model, args.data) as typeof args.data;
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async updateMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.data = encryptDataObject(model, args.data) as typeof args.data;
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        return query(args);
      },

      async upsert({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.create = encryptDataObject(model, args.create) as typeof args.create;
        args.update = encryptDataObject(model, args.update) as typeof args.update;
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async delete({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async deleteMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        return query(args);
      },

      async count({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        return query(args);
      },

      async findUnique({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findUniqueOrThrow({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findFirst({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findFirstOrThrow({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        return decryptRow(model, result);
      },

      async findMany({ model, args, query }) {
        if (!modelTouchesEncryption(model)) return query(args);
        args.where = rewriteWhereForSearchHash(model, args.where) as typeof args.where;
        const result = await query(args);
        if (!Array.isArray(result)) return result;
        return result.map((row) => decryptRow(model, row));
      },
    },
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Walkers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute the search hash for a column, with the same pass-through
 * safety as safeEncrypt: if the deterministic key isn't set, log a
 * one-time warning and return null so the write still succeeds (the
 * hashColumn will be NULL, and that row simply can't be looked up by
 * the deterministic helper until backfilled). This matches the
 * rollout-safety-net behavior of the existing encryption path.
 */
let warnedAboutMissingDeterministicKey = false;
function safeSearchHash(
  config: SearchHashConfig,
  plaintext: string
): Buffer | null {
  try {
    return searchHash(config.domain, plaintext, config.normalize);
  } catch (e) {
    // FieldEncryptionError is thrown when FIELD_DETERMINISTIC_KEY is
    // missing OR malformed. Treat the same way as missing encryption
    // key in the rollout window: warn once, pass through.
    if (e instanceof FieldEncryptionError) {
      if (!warnedAboutMissingDeterministicKey) {
        console.warn(
          "[encrypted-fields] FIELD_DETERMINISTIC_KEY is not set or " +
            "malformed; search-hash columns will be NULL until the env " +
            "var is configured."
        );
        warnedAboutMissingDeterministicKey = true;
      }
      return null;
    }
    throw e;
  }
}

/**
 * Operators a deterministic hash CAN express, because they only ever
 * compare whole values for equality. Everything else (contains,
 * startsWith, endsWith, search, lt/gt, mode) is rejected — see
 * EncryptedFieldQueryError.
 */
const HASH_SAFE_OPERATORS = new Set(["equals", "in", "not", "notIn"]);

/**
 * Rewrite `where` filters on searchHash-backed encrypted columns onto
 * their hash column, so callers can keep writing the natural
 * `where: { email }` and get correct results.
 *
 * Rollout caveat: a row whose hash column is still NULL (written before
 * the backfill, or while FIELD_DETERMINISTIC_KEY was unset) will not
 * match ANY rewritten filter — including a `not`, since SQL `NULL <> x`
 * is NULL, not true. That is the same window the equality path already
 * has, and `scripts/encrypt-user-emails.ts` closes it. When the
 * deterministic key isn't configured at all we leave the filter alone:
 * writes weren't hashed either, so a plaintext match is still correct.
 */
function rewriteWhereForSearchHash(model: string, where: unknown): unknown {
  if (!where || typeof where !== "object" || Array.isArray(where)) return where;
  const configs = searchHashFieldsForModel(model);
  if (configs.length === 0) return where;

  const out: Record<string, unknown> = { ...(where as Record<string, unknown>) };

  // Prisma nests filters under AND / OR / NOT — recurse so a hashed
  // column is rewritten wherever it appears, not just at the top level.
  for (const key of ["AND", "OR", "NOT"] as const) {
    if (!(key in out)) continue;
    const branch = out[key];
    out[key] = Array.isArray(branch)
      ? branch.map((b) => rewriteWhereForSearchHash(model, b))
      : rewriteWhereForSearchHash(model, branch);
  }

  for (const { field, config } of configs) {
    if (!(field in out)) continue;
    const filter = out[field];
    if (filter === null || filter === undefined) continue;

    // Bare value → plain equality.
    if (typeof filter === "string") {
      const hash = safeSearchHash(config, filter);
      if (hash === null) continue; // key unset: writes weren't hashed either
      delete out[field];
      out[config.hashColumn] = hash;
      continue;
    }

    if (typeof filter === "object") {
      const ops = Object.keys(filter as Record<string, unknown>);
      const unsupported = ops.filter((o) => !HASH_SAFE_OPERATORS.has(o));
      if (unsupported.length > 0) {
        throw new EncryptedFieldQueryError(model, field, unsupported, config.hashColumn);
      }
      const rewritten: Record<string, unknown> = {};
      let keyMissing = false;
      for (const [op, val] of Object.entries(filter as Record<string, unknown>)) {
        if (typeof val === "string") {
          const h = safeSearchHash(config, val);
          if (h === null) { keyMissing = true; break; }
          rewritten[op] = h;
        } else if (Array.isArray(val) && val.every((v) => typeof v === "string")) {
          const hashes = val.map((v) => safeSearchHash(config, v as string));
          if (hashes.some((h) => h === null)) { keyMissing = true; break; }
          rewritten[op] = hashes;
        } else {
          throw new EncryptedFieldQueryError(model, field, [op], config.hashColumn);
        }
      }
      if (keyMissing) continue;
      delete out[field];
      out[config.hashColumn] = rewritten;
    }
  }

  return out;
}

/** Encrypt fields in the `data` payload of a write operation. */
function encryptDataObject(model: string, data: unknown): unknown {
  if (!data || typeof data !== "object" || Array.isArray(data)) return data;
  const fields = fieldsForModel(model);
  const out: Record<string, unknown> = { ...(data as Record<string, unknown>) };
  for (const field of fields) {
    if (!(field in out)) continue;
    const value = out[field];
    if (value === null || value === undefined) {
      out[field] = value;
      continue;
    }
    // Route by registry type. Json columns get JSON.stringify before
    // AES-GCM; String columns go straight in.
    const type = columnType(model, field);
    const encrypt = type === "json" ? safeEncryptJson : safeEncrypt;
    const sh = searchHashConfigFor(model, field);
    // Prisma write-operation values can be `{ set: ... }` for nested
    // update inputs. Unwrap before encrypting and re-wrap on the way
    // out so the underlying generator still recognizes the shape.
    if (typeof value === "object" && value !== null && "set" in value) {
      const wrapped = value as { set: unknown };
      out[field] = { set: encrypt(wrapped.set) };
      if (sh && typeof wrapped.set === "string" && wrapped.set.length > 0) {
        out[sh.hashColumn] = {
          set: safeSearchHash(sh, wrapped.set),
        };
      }
      continue;
    }
    out[field] = encrypt(value);
    // Compute the search-hash for the same plaintext if the column
    // has one declared. Caller can omit the hash column from data —
    // we'll populate it from the plaintext automatically. If the
    // caller already passed a hash (e.g., from a backfill script
    // bypassing the encryption path), don't clobber it.
    if (sh && typeof value === "string" && value.length > 0 && !(sh.hashColumn in out)) {
      out[sh.hashColumn] = safeSearchHash(sh, value);
    }
  }

  // Recurse into nested relation writes. Prisma's $extends query
  // hooks only fire on the TOP-LEVEL model; if a feature does a
  // nested write into a model with encrypted columns, the child's
  // hook never sees the payload. We walk the relation map to
  // compensate.
  for (const { relation, child } of relationsForModel(model)) {
    if (!(relation in out)) continue;
    const nested = out[relation];
    if (!nested || typeof nested !== "object") continue;
    const nestedRec = nested as Record<string, unknown>;

    if ("create" in nestedRec) {
      const createPayload = nestedRec.create;
      if (Array.isArray(createPayload)) {
        nestedRec.create = createPayload.map((item) =>
          encryptDataObject(child, item)
        );
      } else if (createPayload && typeof createPayload === "object") {
        nestedRec.create = encryptDataObject(child, createPayload);
      }
    }
    if (
      "createMany" in nestedRec &&
      nestedRec.createMany &&
      typeof nestedRec.createMany === "object"
    ) {
      const cm = nestedRec.createMany as Record<string, unknown>;
      if (Array.isArray(cm.data)) {
        cm.data = cm.data.map((item) => encryptDataObject(child, item));
      } else if (cm.data && typeof cm.data === "object") {
        cm.data = encryptDataObject(child, cm.data);
      }
    }
    out[relation] = nestedRec;
  }

  return out;
}

/** Decrypt fields in a single returned row. */
function decryptRow<T>(model: string, row: T): T {
  if (!row || typeof row !== "object") return row;
  const fields = fieldsForModel(model);
  const out: Record<string, unknown> = { ...(row as Record<string, unknown>) };
  for (const field of fields) {
    if (!(field in out)) continue;
    const value = out[field];
    if (value === null || value === undefined) continue;
    const type = columnType(model, field);
    out[field] = type === "json" ? safeDecryptJson(value) : safeDecrypt(value);
  }
  return out as T;
}

/** Test helper. Reset the one-time missing-key warning so tests can re-trigger. */
export function _resetWarningForTesting(): void {
  warnedAboutMissingKey = false;
}
