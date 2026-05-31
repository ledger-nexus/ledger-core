// Audit logging helpers.
//
// Writes to the `audit_log` table that SOC 2 CC6/CC7 expect to see
// reviewed quarterly. Distinct from `RecordEvent` (which tracks state
// changes on tracked records like JEs and AR items) — AuditLog records
// SECURITY EVENTS: logins, access denials, privileged actions,
// internal-API token use, data exports, configuration changes.
//
// Failure mode: audit writes MUST NOT throw and break the caller.
// If the log can't be written, we console.warn and move on. The
// invariant is "every privileged action MUST emit a log if possible,"
// not "every privileged action MUST emit a log no matter what." A
// degraded log is better than a degraded application.
//
// Retention: the table is designed for ≥12-month retention. Don't
// truncate or auto-purge without a documented policy (Phase 4).

import { headers } from "next/headers";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

export type AuditEventType =
  | "LOGIN_SUCCESS"
  | "LOGIN_FAILURE"
  | "LOGOUT"
  | "ACCESS_DENIED"
  | "PRIVILEGED_ACTION"
  | "DATA_EXPORT"
  | "DATA_ERASURE" // GDPR Art. 17 right-to-erasure events
  | "TOKEN_USED"
  | "TOKEN_REJECTED"
  | "CONFIG_CHANGE"
  | "SECURITY_EVENT";

export type AuditOutcome = "SUCCESS" | "FAILURE" | "ANOMALOUS";

export interface AuditLogInput {
  eventType: AuditEventType;
  action: string;
  outcome?: AuditOutcome;
  actorUserId?: string | null;
  actorEmail?: string | null;
  resource?: string | null;
  resourceId?: string | null;
  metadata?: Record<string, unknown> | null;
  // Multi-tenancy scope. When the audit row is generated inside a
  // resolved tenant context (Server Action, internal API after token
  // resolution), pass the tenantId so quarterly access reviews filter
  // each tenant's events independently. Null when the event happened
  // before tenant resolution (e.g. TOKEN_REJECTED before identity
  // lookup completes) or in a global context (CONFIG_CHANGE on boot).
  tenantId?: string | null;
  // When called from a route handler (NextRequest), pass the headers
  // through so we can extract ip + user-agent.
  requestHeaders?: { ip?: string | null; userAgent?: string | null };
}

/**
 * Write one audit-log row. Never throws — if Prisma can't reach the DB,
 * we log to stderr and return. SOC 2 expects best-effort durability of
 * the audit trail, but breaking the calling action to enforce it would
 * fail-deadly under outage.
 */
export async function logAuditEvent(input: AuditLogInput): Promise<void> {
  try {
    // Try to pull ip + user-agent from the request scope when available.
    // In a Server Action, the next/headers `headers()` works directly.
    // In a route handler, the caller passes them in via requestHeaders.
    let ip: string | null = input.requestHeaders?.ip ?? null;
    let userAgent: string | null = input.requestHeaders?.userAgent ?? null;
    if (!ip && !userAgent) {
      try {
        const h = headers();
        // Vercel + most proxies set x-forwarded-for; first IP is the client.
        const xff = h.get("x-forwarded-for");
        ip = xff ? xff.split(",")[0].trim() : null;
        userAgent = h.get("user-agent");
      } catch {
        // headers() throws outside a request scope; that's fine
      }
    }

    await prisma.auditLog.create({
      data: {
        tenantId: input.tenantId ?? null,
        eventType: input.eventType,
        action: input.action,
        outcome: input.outcome ?? "SUCCESS",
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        resource: input.resource ?? null,
        resourceId: input.resourceId ?? null,
        ipAddress: ip,
        userAgent,
        metadata:
          input.metadata == null
            ? Prisma.JsonNull
            : (input.metadata as Prisma.InputJsonValue),
      },
    });
  } catch (e) {
    // Don't propagate — audit failures should never break the caller.
    console.warn(
      `[audit] Failed to write ${input.eventType}/${input.action}:`,
      e instanceof Error ? e.message : e
    );
  }
}

// ─── Convenience wrappers ────────────────────────────────────────────────

/** Successful login (setCurrentUserAction). */
export async function auditLogin(user: { id: string; email: string }) {
  return logAuditEvent({
    eventType: "LOGIN_SUCCESS",
    action: "set-current-user",
    actorUserId: user.id,
    actorEmail: user.email,
  });
}

/** Failed login attempt — unknown user, inactive user, etc. */
export async function auditLoginFailure(
  reason: string,
  attemptedIdentifier?: string | null
) {
  return logAuditEvent({
    eventType: "LOGIN_FAILURE",
    action: "set-current-user",
    outcome: "FAILURE",
    actorEmail: attemptedIdentifier ?? null,
    metadata: { reason },
  });
}

/** Logout. */
export async function auditLogout(user: { id: string; email: string } | null) {
  return logAuditEvent({
    eventType: "LOGOUT",
    action: "clear-current-user",
    actorUserId: user?.id ?? null,
    actorEmail: user?.email ?? null,
  });
}

/**
 * A privileged action successfully executed. Use this for period close,
 * user lifecycle changes, admin reset, manual reassignments, etc.
 */
export async function auditPrivilegedAction(input: {
  actor: { id: string; email: string };
  action: string;
  resource: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
  /**
   * Tenant the action operates within. Required for tenant-scoped audit
   * reviews; null only for platform-level actions (system config changes
   * etc.). Callers in Server Actions can pull from requireCurrentTenant.
   */
  tenantId?: string | null;
}) {
  return logAuditEvent({
    eventType: "PRIVILEGED_ACTION",
    action: input.action,
    actorUserId: input.actor.id,
    actorEmail: input.actor.email,
    resource: input.resource,
    resourceId: input.resourceId,
    tenantId: input.tenantId ?? null,
    metadata: input.metadata,
  });
}

/** Access denied — requireAdmin/requireCurrentUser failed. */
export async function auditAccessDenied(input: {
  attemptedAction: string;
  actor?: { id: string; email: string } | null;
  reason: string;
  resource?: string;
  resourceId?: string;
}) {
  return logAuditEvent({
    eventType: "ACCESS_DENIED",
    action: input.attemptedAction,
    outcome: "FAILURE",
    actorUserId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    resource: input.resource,
    resourceId: input.resourceId,
    metadata: { reason: input.reason },
  });
}

/** Internal API token use (success or failure). */
export async function auditTokenUse(input: {
  success: boolean;
  endpoint: string;
  reason?: string;
  metadata?: Record<string, unknown>;
  /**
   * Tenant the token was resolved against. Null when resolution failed
   * (TOKEN_REJECTED before identity lookup) — the audit row still
   * captures the rejection but isn't tied to a tenant.
   */
  tenantId?: string | null;
  requestHeaders?: { ip?: string | null; userAgent?: string | null };
}) {
  return logAuditEvent({
    eventType: input.success ? "TOKEN_USED" : "TOKEN_REJECTED",
    action: input.endpoint,
    outcome: input.success ? "SUCCESS" : "FAILURE",
    resource: "InternalAPI",
    resourceId: input.endpoint,
    tenantId: input.tenantId ?? null,
    metadata: { reason: input.reason, ...(input.metadata ?? {}) },
    requestHeaders: input.requestHeaders,
  });
}

/** Data export — CSV / PDF / bulk download. */
export async function auditDataExport(input: {
  actor?: { id: string; email: string } | null;
  format: string; // "csv" | "pdf" | "json"
  resource: string;
  resourceId?: string;
  rowCount?: number;
  /**
   * Tenant the exported data belongs to. Required for tenant-scoped
   * audit queries (SOC 2 CC4 quarterly reviews filter by tenant).
   * Null only for platform-level exports.
   */
  tenantId?: string | null;
  requestHeaders?: { ip?: string | null; userAgent?: string | null };
}) {
  return logAuditEvent({
    eventType: "DATA_EXPORT",
    action: `download-${input.format}`,
    actorUserId: input.actor?.id ?? null,
    actorEmail: input.actor?.email ?? null,
    resource: input.resource,
    resourceId: input.resourceId,
    tenantId: input.tenantId ?? null,
    metadata: { format: input.format, rowCount: input.rowCount },
    requestHeaders: input.requestHeaders,
  });
}
