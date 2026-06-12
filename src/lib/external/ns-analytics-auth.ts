// v0.9 NS SuiteAnalytics Phase 1 — bearer auth + audit shim for the
// /api/external/ns-analytics/* endpoints.
//
// Reuses the existing `resolveBearerToken` helper from src/lib/auth/
// token.ts. The TenantApiToken table already handles per-token
// labels + revocability + quarterly rotation per the SOC 2 access
// review policy. The design (PR #173) initially proposed a separate
// NS_SUITEANALYTICS_TOKEN env, but reusing TenantApiToken gives us
// per-tenant scoping + rotation for free — every BI tool wiring an
// adapter gets its own token.
//
// Audit policy: every successful + failed auth attempt writes an
// audit row. SOC 2 CC7.2 requires API access logs with sufficient
// detail to support quarterly access reviews.

import { NextRequest, NextResponse } from "next/server";
import { resolveBearerToken } from "@/lib/auth/token";
import { logAuditEvent } from "@/lib/audit/log";

export interface AuthenticatedExternalRequest {
  /** Tenant the token resolves to. All queries scope to this. */
  tenantId: string;
  /** Token label for audit log + error message context. */
  tokenLabel: string;
  /** DB row id when source="db", undefined for env fallback. */
  tokenId?: string;
}

/**
 * Authenticate a request to the /api/external/ns-analytics/* surface.
 * On success returns the resolved tenant + token context. On failure
 * writes an ACCESS_DENIED audit row and returns a 401 NextResponse
 * — the caller can `if (result instanceof NextResponse) return result`.
 *
 * Failure modes (all 401):
 *   - Missing Authorization header
 *   - Wrong scheme (we only accept "Bearer")
 *   - Token doesn't resolve (no TenantApiToken row + INTERNAL_API_TOKEN
 *     env mismatch)
 *   - Token row exists but is revoked
 */
export async function authenticateExternalRequest(
  req: NextRequest,
  endpoint: string
): Promise<AuthenticatedExternalRequest | NextResponse> {
  const authHeader = req.headers.get("authorization");
  const ipAddress =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null;
  const userAgent = req.headers.get("user-agent");

  if (!authHeader) {
    await logAuditEvent({
      eventType: "ACCESS_DENIED",
      action: "NS_ANALYTICS_AUTH",
      outcome: "FAILURE",
      resource: endpoint,
      metadata: { reason: "missing_authorization_header", ipAddress, userAgent },
    });
    return new NextResponse(
      JSON.stringify({ error: "Missing Authorization header" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="ns-analytics"',
        },
      }
    );
  }

  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  if (!match || !match[1]) {
    await logAuditEvent({
      eventType: "ACCESS_DENIED",
      action: "NS_ANALYTICS_AUTH",
      outcome: "FAILURE",
      resource: endpoint,
      metadata: { reason: "wrong_auth_scheme", ipAddress, userAgent },
    });
    return new NextResponse(
      JSON.stringify({ error: "Bearer token required" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="ns-analytics"',
        },
      }
    );
  }

  const identity = await resolveBearerToken(match[1]);
  if (!identity) {
    await logAuditEvent({
      eventType: "ACCESS_DENIED",
      action: "NS_ANALYTICS_AUTH",
      outcome: "FAILURE",
      resource: endpoint,
      metadata: { reason: "unknown_token", ipAddress, userAgent },
    });
    return new NextResponse(
      JSON.stringify({ error: "Invalid or revoked token" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate": 'Bearer realm="ns-analytics"',
        },
      }
    );
  }

  return {
    tenantId: identity.tenantId,
    tokenLabel: identity.label,
    tokenId: identity.tokenId,
  };
}

/**
 * Audit-log a successful external report read. Called after the report
 * helper returns but before the response is sent — so a failed report
 * (Decimal overflow, etc.) also gets recorded.
 */
export async function auditExternalReportAccess(input: {
  auth: AuthenticatedExternalRequest;
  endpoint: string;
  scope: { entityCode: string; bookCode: string };
  rowCount: number;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<void> {
  await logAuditEvent({
    eventType: "DATA_EXPORT",
    action: "NS_ANALYTICS_READ",
    outcome: "SUCCESS",
    resource: input.endpoint,
    tenantId: input.auth.tenantId,
    metadata: {
      tokenLabel: input.auth.tokenLabel,
      tokenId: input.auth.tokenId ?? null,
      entityCode: input.scope.entityCode,
      bookCode: input.scope.bookCode,
      rowCount: input.rowCount,
      ipAddress: input.ipAddress,
      userAgent: input.userAgent,
    },
  });
}
