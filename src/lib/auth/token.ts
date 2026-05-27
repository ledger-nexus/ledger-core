// Internal-API token resolution — maps a Bearer token to a tenant.
//
// Two resolution paths, in priority order:
//
//   1. TenantApiToken table: hash the incoming token, look up by
//      tokenHash. Per-tenant tokens, per-token last-used timestamps,
//      and revocability without redeploying. This is the v2+ path
//      and the one we want all new deploys to use.
//
//   2. INTERNAL_API_TOKEN env var: if the token matches the global
//      env, resolve to the "default" tenant. Backward compatibility
//      for companion repos that already shipped with this env set.
//      Will retire once all repos rotate to per-tenant tokens.
//
// A failed lookup returns null; the caller (route handler) is responsible
// for returning 401 + audit-logging. Never throws on bad input — token
// shape validation belongs at the route level.
//
// Hashing: SHA-256 of the plaintext token, hex-encoded. NOT bcrypt /
// argon2 because these tokens are random 64-hex-char strings with
// ~256 bits of entropy — there's no human-memorability to defend.
// SHA-256 is fast enough that a 10k-row scan + hash compare is sub-
// millisecond; bcrypt would add 100ms per request for no security gain.

import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

export interface TokenIdentity {
  tenantId: string;
  /** Source: "db" for TenantApiToken hit, "env" for INTERNAL_API_TOKEN fallback */
  source: "db" | "env";
  /** Human-readable label — "recon-prod", "INTERNAL_API_TOKEN", etc. */
  label: string;
  /** Defined only for source="db". For audit log. */
  tokenId?: string;
}

/** SHA-256 hex of the plaintext token. */
export function hashToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/**
 * Resolve a Bearer token to a TokenIdentity, or null when neither path
 * matches. Side-effect: updates lastUsedAt on a successful DB hit so
 * stale tokens are easy to identify during quarterly access reviews
 * (per access-control.md).
 */
export async function resolveBearerToken(
  plaintext: string
): Promise<TokenIdentity | null> {
  if (!plaintext) return null;

  // Path 1: TenantApiToken lookup.
  const hash = hashToken(plaintext);
  const row = await prisma.tenantApiToken.findUnique({
    where: { tokenHash: hash },
    select: { id: true, tenantId: true, label: true, revokedAt: true },
  });
  if (row && !row.revokedAt) {
    // Best-effort touch — don't fail the request if this update throws.
    prisma.tenantApiToken
      .update({
        where: { id: row.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((e) => {
        console.warn(
          `[token] Failed to update lastUsedAt for ${row.label}:`,
          e instanceof Error ? e.message : e
        );
      });
    return {
      tenantId: row.tenantId,
      source: "db",
      label: row.label,
      tokenId: row.id,
    };
  }

  // Path 2: INTERNAL_API_TOKEN env fallback.
  // Constant-time compare to defeat timing attacks on the env value.
  const envToken = process.env.INTERNAL_API_TOKEN;
  if (envToken && envToken.length > 0 && constantTimeEquals(plaintext, envToken)) {
    // Resolve to default tenant. If it doesn't exist (pre-migration DB),
    // refuse — better to fail closed than to silently mis-attribute.
    try {
      const tenantId = await getDefaultTenantId(prisma);
      return {
        tenantId,
        source: "env",
        label: "INTERNAL_API_TOKEN (legacy)",
      };
    } catch {
      return null;
    }
  }

  return null;
}

/**
 * Constant-time string equality. Returns false immediately on length
 * mismatch (a length-leak side-channel exists there, but for high-entropy
 * tokens the attack surface is negligible compared to the upside of
 * early-exit on the common-case miss). Exported so other token-compare
 * sites (admin/reset, future endpoints) can reuse rather than reimplement.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Provision a new TenantApiToken for the given tenant. Returns the
 * plaintext ONCE (caller MUST capture it — there's no way to retrieve
 * later, by design). The hash is stored in the DB.
 *
 * Used by:
 *   - The deploy script (bin/deploy.sh) when provisioning per-tenant
 *     tokens during a fresh deploy.
 *   - A future tenant admin UI (out of Phase 5 scope).
 */
export async function provisionTenantApiToken(input: {
  tenantId: string;
  label: string;
}): Promise<{ tokenId: string; plaintext: string }> {
  // 64 hex chars = 256 bits of entropy. Same shape as the existing
  // INTERNAL_API_TOKEN, so companion repos accept it as a drop-in.
  const { randomBytes } = await import("node:crypto");
  const plaintext = randomBytes(32).toString("hex");
  const tokenHash = hashToken(plaintext);
  const row = await prisma.tenantApiToken.create({
    data: {
      tenantId: input.tenantId,
      tokenHash,
      label: input.label,
    },
    select: { id: true },
  });
  return { tokenId: row.id, plaintext };
}

/**
 * Revoke a TenantApiToken. Sets revokedAt = now. Cannot be un-revoked
 * (audit trail). Future use of the token resolves to null.
 */
export async function revokeTenantApiToken(tokenId: string): Promise<void> {
  await prisma.tenantApiToken.update({
    where: { id: tokenId },
    data: { revokedAt: new Date() },
  });
}
