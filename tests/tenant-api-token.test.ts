// TenantApiToken + Bearer-resolution tests (Phase 5 of multi-tenancy).
//
// Verifies the token-tenant binding:
//   1. provisionTenantApiToken creates a row + returns plaintext once.
//   2. hashToken is deterministic + matches the stored hash.
//   3. resolveBearerToken with a valid TenantApiToken returns the tenant.
//   4. resolveBearerToken with a revoked token returns null.
//   5. resolveBearerToken with the INTERNAL_API_TOKEN env value falls
//      back to the default tenant.
//   6. resolveBearerToken with garbage returns null.
//   7. Two tenants' tokens don't collide.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { PrismaClient } from "@prisma/client";
import {
  resolveBearerToken,
  hashToken,
  provisionTenantApiToken,
  revokeTenantApiToken,
} from "@/lib/auth/token";

const prisma = new PrismaClient();

const SUFFIX = "tok" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenantA: { id: string };
let tenantB: { id: string };
let ownerUser: { id: string };

beforeAll(async () => {
  ownerUser = await prisma.user.create({
    data: {
      email: `tok-owner-${SUFFIX}@example.test`,
      displayName: "Token Test Owner",
      isActive: true,
    },
  });
  tenantA = await prisma.tenant.create({
    data: {
      slug: `tokA-${SUFFIX}`,
      name: "Token Test A",
      ownerUserId: ownerUser.id,
    },
  });
  tenantB = await prisma.tenant.create({
    data: {
      slug: `tokB-${SUFFIX}`,
      name: "Token Test B",
      ownerUserId: ownerUser.id,
    },
  });
});

afterAll(async () => {
  await prisma.tenantApiToken.deleteMany({
    where: { tenantId: { in: [tenantA.id, tenantB.id] } },
  });
  await prisma.tenant.deleteMany({
    where: { id: { in: [tenantA.id, tenantB.id] } },
  });
  await prisma.user.deleteMany({ where: { id: ownerUser.id } }).catch(() => {});
  await prisma.$disconnect();
});

describe("hashToken", () => {
  it("produces a 64-char hex SHA-256", () => {
    const h = hashToken("hello");
    expect(h).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(h)).toBe(true);
  });

  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });

  it("differs across inputs", () => {
    expect(hashToken("a")).not.toBe(hashToken("b"));
  });
});

describe("provisionTenantApiToken", () => {
  it("creates a row with hashed token and returns plaintext once", async () => {
    const result = await provisionTenantApiToken({
      tenantId: tenantA.id,
      label: `provision-test-${SUFFIX}`,
    });
    expect(result.plaintext).toHaveLength(64); // 32 bytes hex
    expect(/^[0-9a-f]+$/.test(result.plaintext)).toBe(true);
    const row = await prisma.tenantApiToken.findUnique({
      where: { id: result.tokenId },
      select: { tokenHash: true, tenantId: true, label: true },
    });
    expect(row).not.toBeNull();
    expect(row!.tokenHash).toBe(hashToken(result.plaintext));
    expect(row!.tenantId).toBe(tenantA.id);
    expect(row!.label).toBe(`provision-test-${SUFFIX}`);
  });
});

describe("resolveBearerToken: DB path", () => {
  let plaintextA: string;
  let tokenIdA: string;

  beforeAll(async () => {
    const result = await provisionTenantApiToken({
      tenantId: tenantA.id,
      label: `resolve-test-A-${SUFFIX}`,
    });
    plaintextA = result.plaintext;
    tokenIdA = result.tokenId;
  });

  it("resolves a valid token to its tenant + label", async () => {
    const id = await resolveBearerToken(plaintextA);
    expect(id).not.toBeNull();
    expect(id!.tenantId).toBe(tenantA.id);
    expect(id!.source).toBe("db");
    expect(id!.label).toBe(`resolve-test-A-${SUFFIX}`);
    expect(id!.tokenId).toBe(tokenIdA);
  });

  it("touches lastUsedAt on successful resolution", async () => {
    const before = await prisma.tenantApiToken.findUnique({
      where: { id: tokenIdA },
      select: { lastUsedAt: true },
    });
    await resolveBearerToken(plaintextA);
    // lastUsedAt is updated fire-and-forget (not awaited, to keep token
    // resolution latency low). Poll for it instead of a fixed sleep: a
    // loaded CI runner can take >100ms to commit the async write, which
    // made the old `setTimeout(100)` intermittently see null. Break as
    // soon as it's set, so this stays fast in the common case.
    let after: { lastUsedAt: Date | null } | null = null;
    for (let i = 0; i < 50; i++) {
      after = await prisma.tenantApiToken.findUnique({
        where: { id: tokenIdA },
        select: { lastUsedAt: true },
      });
      if (after?.lastUsedAt != null) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(after?.lastUsedAt).not.toBeNull();
    if (before?.lastUsedAt && after?.lastUsedAt) {
      expect(after.lastUsedAt.getTime()).toBeGreaterThanOrEqual(
        before.lastUsedAt.getTime()
      );
    }
  });

  it("returns null after revocation", async () => {
    const r = await provisionTenantApiToken({
      tenantId: tenantA.id,
      label: `revoke-test-${SUFFIX}`,
    });
    // Sanity: works before revoke.
    expect(await resolveBearerToken(r.plaintext)).not.toBeNull();
    await revokeTenantApiToken(r.tokenId);
    expect(await resolveBearerToken(r.plaintext)).toBeNull();
  });
});

describe("resolveBearerToken: env fallback", () => {
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  it("matches INTERNAL_API_TOKEN value and resolves to default tenant", async () => {
    const envValue = "FAKE_LEGACY_TOKEN_VALUE_FOR_ENV_FALLBACK_TEST";
    vi.stubEnv("INTERNAL_API_TOKEN", envValue);
    const id = await resolveBearerToken(envValue);
    expect(id).not.toBeNull();
    expect(id!.source).toBe("env");
    expect(id!.label).toMatch(/legacy/i);
    // Default tenant exists from the Phase 1 migration.
    const def = await prisma.tenant.findUnique({ where: { slug: "default" } });
    expect(id!.tenantId).toBe(def!.id);
  });

  it("returns null when env is unset and token doesn't match any DB row", async () => {
    vi.stubEnv("INTERNAL_API_TOKEN", "");
    expect(
      await resolveBearerToken("totally-random-garbage-token-no-match")
    ).toBeNull();
  });

  it("returns null for empty input", async () => {
    expect(await resolveBearerToken("")).toBeNull();
  });
});

describe("token isolation: tenant A's token does not authenticate as tenant B", () => {
  it("provisioning two tokens for different tenants keeps identities distinct", async () => {
    const a = await provisionTenantApiToken({
      tenantId: tenantA.id,
      label: `iso-A-${SUFFIX}`,
    });
    const b = await provisionTenantApiToken({
      tenantId: tenantB.id,
      label: `iso-B-${SUFFIX}`,
    });

    const idA = await resolveBearerToken(a.plaintext);
    const idB = await resolveBearerToken(b.plaintext);

    expect(idA!.tenantId).toBe(tenantA.id);
    expect(idB!.tenantId).toBe(tenantB.id);
    expect(idA!.tenantId).not.toBe(idB!.tenantId);
  });
});
