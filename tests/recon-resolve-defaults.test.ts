// BlackLine arc — Phase 1 PR 2: cascade resolution tests for
// requiresReview + tolerance defaults.
//
// Cheap unit-flavored tests against a real DB. No Server Action context
// needed — these exercise the `resolveReconDefaults` helper directly,
// which is the surface that the Server Actions call into at recon-open
// time.
//
// Locks Decision #2 from the design doc: per-Account override wins over
// tenant default wins over BlackLine fallback (true, 0).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Decimal } from "@/lib/utils/decimal";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { resolveReconDefaults } from "@/lib/recon/resolve-defaults";

const prisma = new PrismaClient();

const PREFIX = "RCN1";
const STAMP = Date.now().toString(36).toUpperCase();

let tenantId: string;
// Track ids so afterAll can wipe them.
const createdAccountIds: string[] = [];
let configCreated = false;

async function ensureFixture(): Promise<void> {
  tenantId = await getDefaultTenantId(prisma);
  // Clean any leftover config row from a prior aborted run so we start
  // each test set deterministically.
  await prisma.reconciliationConfig.deleteMany({ where: { tenantId } });
}

async function cleanup(): Promise<void> {
  await prisma.account.deleteMany({
    where: { id: { in: createdAccountIds } },
  });
  if (configCreated) {
    await prisma.reconciliationConfig.deleteMany({ where: { tenantId } });
  }
}

async function makeAccount(opts: {
  code: string;
  requiresReconReview?: boolean | null;
  reconTolerance?: number | null;
}): Promise<string> {
  const a = await prisma.account.create({
    data: {
      tenantId,
      code: opts.code,
      name: `${opts.code} test`,
      type: "ASSET",
      normalBalance: "DEBIT",
      requiresReconReview: opts.requiresReconReview ?? null,
      reconTolerance:
        opts.reconTolerance != null
          ? (opts.reconTolerance.toString() as never)
          : null,
    },
    select: { id: true },
  });
  createdAccountIds.push(a.id);
  return a.id;
}

describe("resolveReconDefaults — Decision #2 cascade", () => {
  beforeAll(async () => {
    await ensureFixture();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("Fallback to BlackLine standard (true, 0) when no config + no Account override", async () => {
    const accountId = await makeAccount({ code: `${PREFIX}_F1_${STAMP}` });
    const defaults = await resolveReconDefaults(prisma, tenantId, accountId);
    expect(defaults.requiresReview).toBe(true);
    expect(defaults.tolerance.toString()).toBe("0");
  });

  it("Tenant default overrides BlackLine fallback", async () => {
    await prisma.reconciliationConfig.create({
      data: {
        tenantId,
        defaultRequiresReview: false,
        defaultTolerance: "1.50" as never,
      },
    });
    configCreated = true;
    const accountId = await makeAccount({ code: `${PREFIX}_T1_${STAMP}` });
    const defaults = await resolveReconDefaults(prisma, tenantId, accountId);
    expect(defaults.requiresReview).toBe(false);
    expect(defaults.tolerance.equals(new Decimal("1.5"))).toBe(true);
  });

  it("Account.requiresReconReview=true wins over tenant default=false", async () => {
    const accountId = await makeAccount({
      code: `${PREFIX}_A1_${STAMP}`,
      requiresReconReview: true,
    });
    const defaults = await resolveReconDefaults(prisma, tenantId, accountId);
    expect(defaults.requiresReview).toBe(true);
  });

  it("Account.requiresReconReview=false wins over tenant default=false (explicit override)", async () => {
    // Even when both say false, the Account-level explicit value wins.
    // No behavioral difference here, but the test pins the precedence.
    const accountId = await makeAccount({
      code: `${PREFIX}_A2_${STAMP}`,
      requiresReconReview: false,
    });
    const defaults = await resolveReconDefaults(prisma, tenantId, accountId);
    expect(defaults.requiresReview).toBe(false);
  });

  it("Account.reconTolerance wins over tenant default", async () => {
    const accountId = await makeAccount({
      code: `${PREFIX}_A3_${STAMP}`,
      reconTolerance: 99.99,
    });
    const defaults = await resolveReconDefaults(prisma, tenantId, accountId);
    expect(defaults.tolerance.equals(new Decimal("99.99"))).toBe(true);
  });

  it("Account.reconTolerance=0 wins over tenant default (forces tie-out exactly)", async () => {
    // CPA case: tenant uses $1.50 rounding tolerance globally; cash account
    // wants strict tie-out only. Explicit 0 must win over tenant 1.5.
    const accountId = await makeAccount({
      code: `${PREFIX}_A4_${STAMP}`,
      reconTolerance: 0,
    });
    const defaults = await resolveReconDefaults(prisma, tenantId, accountId);
    expect(defaults.tolerance.equals(new Decimal(0))).toBe(true);
  });

  it("throws cleanly when accountId belongs to another tenant", async () => {
    const accountId = await makeAccount({ code: `${PREFIX}_X1_${STAMP}` });
    const fakeTenantId = "00000000-0000-0000-0000-000000000001";
    await expect(
      resolveReconDefaults(prisma, fakeTenantId, accountId)
    ).rejects.toThrow(/not found/i);
  });
});
