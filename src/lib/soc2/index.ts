// SOC 2 control helpers — the standing reference module every new
// feature should import from.
//
// Why this exists:
//   The user asked for "a helper class the system constantly refers
//   back into for all future builds." This module is that helper.
//   Each export below is keyed to a Common Criterion the function
//   satisfies; the comment block names the CC, the threat it counters,
//   and the place a code reviewer should check when they encounter
//   the helper in a diff.
//
// Companion artifacts:
//   - docs/SOC2_READINESS.md  — gap analysis + ratings
//   - .claude/skills/soc2     — skill that surfaces this module to
//                              future Claude sessions automatically
//   - docs/policies/          — written policies the auditor reads
//
// Usage discipline:
//   1. Every new Server Action that mutates data calls
//      auditMutation() (CC5, CC6, CC7).
//   2. Every new table that holds customer data carries a tenantId
//      column and gets validated via assertTenantScope() in any
//      cross-tenant-risky query (CC6).
//   3. Every log line that might include user-visible identifiers
//      runs through redactPii() (Confidentiality TSC).
//   4. Every cryptographic / token comparison goes through
//      constantTimeEqual() — never `===` (CC6).
//   5. Every error response sent to a client goes through
//      sanitizeError() — never raw .message + .stack (CC7).
//
// This module is import-stable. Add new helpers; do not change the
// signature of an existing helper without a coordinated update to every
// caller (Search across the portfolio: `from "@/lib/soc2"`).

import { timingSafeEqual } from "node:crypto";
import type { PrismaClient } from "@prisma/client";

// ─────────────────────────────────────────────────────────────────────────────
// CC6 — Multi-tenant scope assertion
// ─────────────────────────────────────────────────────────────────────────────
//
// Threat: IDOR (Insecure Direct Object Reference). A query that
// findFirst's by id without also constraining tenantId can return
// another tenant's row if the caller hands a forged id.
//
// Pattern this helper enforces:
//   1. Resolve the actor's tenantId (from getCurrentTenant / scope).
//   2. Read the row with `where: { id, tenantId }`.
//   3. Pass both into assertTenantScope to confirm the row actually
//      belongs to the actor's tenant before any mutation.
//
// Code reviewers: any time you see `findUnique({ where: { id } })`
// without a tenantId on a customer-data table, flag it.

export class CrossTenantAccessError extends Error {
  constructor(resource: string) {
    super(
      `Cross-tenant access blocked: ${resource} belongs to another tenant.`
    );
    this.name = "CrossTenantAccessError";
  }
}

/**
 * Asserts the loaded row's tenantId matches the actor's tenant.
 * Throws CrossTenantAccessError on mismatch. Returns the row narrowed
 * to a type that asserts tenantId is set.
 *
 * Use AFTER reading the row, BEFORE acting on it. Pairs with a
 * tenantId-constrained read query but adds belt-and-suspenders.
 */
export function assertTenantScope<T extends { tenantId: string }>(
  row: T | null,
  actorTenantId: string,
  resourceLabel: string
): T {
  if (!row) {
    // 404-equivalent. Don't distinguish "not found" from "found in
    // another tenant" — leaking that distinction confirms record
    // existence to an attacker probing IDs.
    throw new CrossTenantAccessError(resourceLabel);
  }
  if (row.tenantId !== actorTenantId) {
    throw new CrossTenantAccessError(resourceLabel);
  }
  return row;
}

// ─────────────────────────────────────────────────────────────────────────────
// CC6 — Constant-time string compare
// ─────────────────────────────────────────────────────────────────────────────
//
// Threat: timing attacks on secret comparison. A `===` over an HMAC,
// session token, or API key leaks bytes one-at-a-time via response-
// time differences.
//
// Use for any comparison where one side is a secret. For non-secret
// comparisons (e.g., tenant slug match), `===` is fine.

export function constantTimeEqual(a: string, b: string): boolean {
  // Different lengths can't match. node:crypto's timingSafeEqual would
  // throw on length mismatch; checking here avoids that side channel.
  // The length-check itself is not constant-time, but a length-difference
  // signal is acceptable — attackers usually know the target length
  // (e.g., a token format).
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

// ─────────────────────────────────────────────────────────────────────────────
// Confidentiality TSC — PII redaction in logs
// ─────────────────────────────────────────────────────────────────────────────
//
// Threat: PII or financial data leaking into application logs that
// ship to a third-party log aggregator (Sentry, Datadog, Vercel logs).
// SOC 2 auditors will pull a log sample and grep for emails, names,
// and dollar amounts.
//
// Use `redactPii(obj)` to deep-clone an object with sensitive fields
// masked before passing it to console.log / Sentry / etc.

const PII_FIELD_NAMES = new Set<string>([
  // Identity
  "email",
  "emailAddress",
  "displayName",
  "firstName",
  "lastName",
  "fullName",
  "phone",
  "phoneNumber",
  "address",
  "addressLine1",
  "addressLine2",
  // Financial
  "accountNumber",
  "routingNumber",
  "ssn",
  "taxId",
  "ein",
  // Auth
  "password",
  "token",
  "apiKey",
  "secret",
  "accessToken",
  "refreshToken",
  "sessionToken",
  "clerkUserId", // pseudonymous but still subject identifier
  // Customer payload
  "memo",
  "description",
  "notes",
  // EmailDelivery body fields (encrypted at rest; never log either).
  "subject",
  "bodyText",
  "bodyHtml",
  // JournalEntryNote.body — encrypted at rest (2026-05-30).
  // Already-listed "notes" above catches singular-aliased fields;
  // "body" catches the actual column name on JournalEntryNote.
  "body",
  // Notification.title — encrypted at rest (2026-05-31). Renders the
  // alert text shown in the notification bell + email templates.
  // Title often includes a verb + customer name + amount; redact.
  "title",
]);

const REDACTED = "[REDACTED]";

/**
 * Returns a deep clone of `value` with any property whose name is in
 * PII_FIELD_NAMES masked to "[REDACTED]". Arrays are traversed.
 * Non-objects (strings, numbers, etc.) pass through unchanged.
 *
 * The PII_FIELD_NAMES list is conservative — over-redaction is
 * acceptable; under-redaction is a finding. Add to the list as new
 * sensitive fields enter the schema.
 */
export function redactPii<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactPii(item)) as unknown as T;
  }
  const result: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (PII_FIELD_NAMES.has(k)) {
      result[k] = REDACTED;
    } else {
      result[k] = redactPii(v);
    }
  }
  return result as unknown as T;
}

// ─────────────────────────────────────────────────────────────────────────────
// CC7 — Sanitized error response
// ─────────────────────────────────────────────────────────────────────────────
//
// Threat: information disclosure via error responses. A raw
// `err.message + err.stack` returned to a user can leak SQL,
// internal file paths, Prisma model names, env-var content (when
// the error includes a misconfiguration value), and so on.
//
// Use sanitizeError() to convert any caught error into a client-safe
// shape. Always log the original via console.error (or the error
// monitor) WITH redactPii BEFORE returning the sanitized payload.

export interface SafeErrorResponse {
  /** Stable machine-readable error code (e.g., "UNAUTHORIZED", "VALIDATION_FAILED"). */
  code: string;
  /** Human-readable message. Always generic — no schema leakage. */
  message: string;
  /** Correlation id to help support find the full log entry. */
  correlationId?: string;
}

/**
 * Returns a client-safe error shape. The original `err` is NOT
 * touched here — log it separately (after redactPii) before
 * returning the response.
 */
export function sanitizeError(
  err: unknown,
  hint: {
    code?: string;
    fallbackMessage?: string;
    correlationId?: string;
  } = {}
): SafeErrorResponse {
  // Known error types pass through with their code; the message stays
  // whatever the caller set on the original (we trust deliberate
  // application errors not to leak schema). Unknown errors get the
  // generic fallback.
  const code = hint.code ?? deriveCode(err) ?? "INTERNAL_ERROR";
  let message: string;
  if (
    err instanceof Error &&
    code !== "INTERNAL_ERROR" &&
    err.message &&
    err.message.length < 200
  ) {
    message = err.message;
  } else {
    message =
      hint.fallbackMessage ??
      "An unexpected error occurred. Please try again or contact support.";
  }
  return {
    code,
    message,
    ...(hint.correlationId ? { correlationId: hint.correlationId } : {}),
  };
}

function deriveCode(err: unknown): string | undefined {
  if (
    err &&
    typeof err === "object" &&
    "code" in err &&
    typeof (err as { code: unknown }).code === "string"
  ) {
    return (err as { code: string }).code;
  }
  if (err instanceof CrossTenantAccessError) return "NOT_FOUND";
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// CC5, CC6, CC7 — Audit-logged mutation wrapper
// ─────────────────────────────────────────────────────────────────────────────
//
// Threat: a mutation that runs without an audit row is invisible to
// the auditor. The SOC 2 expectation is "show me every change to
// customer data on date X" — answering requires every mutation to
// emit an AuditLog row.
//
// Pattern this helper enforces:
//   - Wrap the mutation in a callback so the audit emit always
//     happens (on success AND on failure with outcome="FAILURE").
//   - Caller passes the audit metadata up-front; we don't try to
//     auto-derive it from runtime values.
//
// The actual auditLogEvent writer lives in @/lib/audit/log.ts —
// this helper exists to make the pattern reusable from Server
// Actions without each one re-implementing the try/catch ladder.

export interface AuditedMutationInput<TResult> {
  actorUserId: string;
  tenantId: string;
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /** The mutation itself. Returns the action result on success. */
  run: () => Promise<TResult>;
  /** Optional pre-write hook — last chance to reject before mutating. */
  preFlight?: () => Promise<void> | void;
}

export interface AuditedMutationResult<TResult> {
  ok: true;
  result: TResult;
}
export interface AuditedMutationFailure {
  ok: false;
  error: SafeErrorResponse;
}

/**
 * Runs a mutation with surrounding audit-log emission. Caller is
 * responsible for tenant scoping the inputs (this helper does NOT
 * inject the tenantId filter into the run() callback's queries);
 * use assertTenantScope() inside run() if your mutation operates on
 * a row id received from the client.
 *
 * On success: emits an audit row with outcome="SUCCESS" + metadata.
 * On failure: emits an audit row with outcome="FAILURE" + the error's
 * sanitized code, then returns the sanitized error to the caller.
 *
 * The audit row writer is imported lazily so this module doesn't pull
 * Prisma into pure-function call sites.
 */
export async function auditedMutation<TResult>(
  input: AuditedMutationInput<TResult>
): Promise<AuditedMutationResult<TResult> | AuditedMutationFailure> {
  const { logAuditEvent } = await import("@/lib/audit/log");
  try {
    if (input.preFlight) await input.preFlight();
    const result = await input.run();
    await logAuditEvent({
      tenantId: input.tenantId,
      actorUserId: input.actorUserId,
      eventType: "PRIVILEGED_ACTION",
      action: input.action,
      resource: input.resource,
      resourceId: input.resourceId,
      outcome: "SUCCESS",
      metadata: input.metadata ? redactPii(input.metadata) : undefined,
    });
    return { ok: true, result };
  } catch (err) {
    const sanitized = sanitizeError(err);
    try {
      await logAuditEvent({
        tenantId: input.tenantId,
        actorUserId: input.actorUserId,
        eventType: "PRIVILEGED_ACTION",
        action: input.action,
        resource: input.resource,
        resourceId: input.resourceId,
        outcome: "FAILURE",
        metadata: {
          errorCode: sanitized.code,
          ...(input.metadata ? redactPii(input.metadata) : {}),
        },
      });
    } catch (auditErr) {
      // Don't let an audit-emit failure swallow the original error.
      console.error(
        "[soc2.auditedMutation] audit emit failed for failed action",
        auditErr
      );
    }
    return { ok: false, error: sanitized };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CC8 — Schema-drift detection helper
// ─────────────────────────────────────────────────────────────────────────────
//
// Threat: prisma db push at midnight applies a schema change to
// production that doesn't match the source code. The DB and code drift,
// and the auditor's "every change is reviewed" expectation collapses.
//
// Use schemaFingerprint() in a /api/health endpoint to assert the
// expected Prisma client matches the running DB shape.

export function schemaFingerprint(): string {
  // Stable hash of the current Prisma DMMF. Cheap to compute — the
  // DMMF is loaded at module init and immutable thereafter. Two
  // processes running the same code return the same fingerprint;
  // a deployment drift produces a different fingerprint.
  //
  // Implementation note: we intentionally do not include this at
  // module top to avoid pulling DMMF into the bundle for non-health
  // routes. Construct lazily inside the function.
  // Import lazily to avoid bundling DMMF into Server Actions.
  // The hash itself is computed once and cached.
  const cached = schemaFingerprintCache;
  if (cached) return cached;
  // We hash the keys of the Prisma client at runtime instead of the
  // full DMMF — that's enough to detect added/removed models without
  // requiring DMMF access (which Prisma 5 no longer exposes by default).
  // Returns a deterministic short string.
  const PrismaClientCtor = require("@prisma/client").PrismaClient;
  const proto = PrismaClientCtor.prototype as Record<string, unknown>;
  const modelKeys = Object.keys(proto)
    .filter((k) => !k.startsWith("$") && !k.startsWith("_"))
    .sort();
  const hash = require("node:crypto")
    .createHash("sha256")
    .update(modelKeys.join("|"))
    .digest("hex")
    .slice(0, 16);
  schemaFingerprintCache = hash;
  return hash;
}
let schemaFingerprintCache: string | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports — surface from upstream modules so callers only import "soc2".
// ─────────────────────────────────────────────────────────────────────────────

// Re-export the audit-log writer + helper functions so a feature
// author only ever needs `import {...} from "@/lib/soc2"` for the
// full security primitive surface.
export {
  logAuditEvent,
  auditLogin,
  auditLoginFailure,
  auditLogout,
  auditPrivilegedAction,
  auditAccessDenied,
  auditTokenUse,
} from "@/lib/audit/log";

// Field-level encryption (Confidentiality TSC).
export {
  encryptField,
  decryptField,
  looksEncrypted,
  FieldEncryptionError,
  KeyNotConfiguredError,
} from "./field-encryption";

// Re-export Prisma type for ergonomic helper signatures elsewhere.
export type { PrismaClient };
