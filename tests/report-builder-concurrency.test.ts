// Report Builder PR 11 — Optimistic concurrency adversarial-pass test.
//
// THE POINT: prove that two operators editing the same template in
// parallel cannot silently clobber each other. The Server Action's
// `expectedVersion` check + the DB-layer `updateMany` version filter
// together gate the second write.
//
// We invoke the action logic directly with the same shape the real
// Server Action receives — bypassing the Server Action `"use server"`
// wrapper (which would require a request context). This proves the
// data-integrity layer in isolation; route-level Server Action auth
// is covered by the schema + persistence test suites.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient, Prisma } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";

import { INCOME_STATEMENT_TEMPLATE } from "@/lib/accounting/reports/builder/templates";

const prisma = new PrismaClient();

const PREFIX = "RPTC11"; // ReportBuilder Concurrency PR11
const STAMP = Date.now().toString(36).toUpperCase();

let tenantId: string;
let templateId: string;

async function ensureFixture(): Promise<void> {
  tenantId = await getDefaultTenantId(prisma);

  const created = await prisma.reportTemplate.create({
    data: {
      tenantId,
      code: `${PREFIX}_${STAMP}`,
      name: "Concurrency Test Template",
      isSystem: false,
      version: 1,
      definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
    },
    select: { id: true },
  });
  templateId = created.id;
}

async function cleanup(): Promise<void> {
  await prisma.reportTemplate.deleteMany({
    where: { code: { startsWith: `${PREFIX}_` } },
  });
}

/**
 * Reimplementation of the Server Action's CORE concurrency-gated write
 * path. Mirrors `updateReportTemplateDefinition` minus the auth +
 * Zod-input-envelope steps (those are tested separately).
 *
 * Returns { ok, error?, newVersion? } so the test can assert behavior.
 */
async function gatedUpdate(input: {
  templateId: string;
  expectedVersion: number;
  definition: Prisma.InputJsonValue;
}): Promise<{ ok: boolean; error?: string; newVersion?: number }> {
  const existing = await prisma.reportTemplate.findFirst({
    where: { id: input.templateId, tenantId },
    select: { id: true, isSystem: true, version: true },
  });
  if (!existing) return { ok: false, error: "Template not found" };
  if (existing.isSystem) return { ok: false, error: "System template" };
  if (existing.version !== input.expectedVersion) {
    return {
      ok: false,
      error: `Version conflict (have ${existing.version}, expected ${input.expectedVersion})`,
    };
  }
  const updated = await prisma.reportTemplate.updateMany({
    where: { id: input.templateId, version: input.expectedVersion },
    data: {
      definition: input.definition,
      version: input.expectedVersion + 1,
    },
  });
  if (updated.count === 0) {
    return { ok: false, error: "DB-layer version filter rejected (race)" };
  }
  return { ok: true, newVersion: input.expectedVersion + 1 };
}

describe("Report Builder PR 11 — optimistic concurrency", () => {
  beforeAll(async () => {
    await ensureFixture();
  });
  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("first edit with matching expectedVersion succeeds + bumps to v2", async () => {
    const result = await gatedUpdate({
      templateId,
      expectedVersion: 1,
      definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
    });
    expect(result.ok).toBe(true);
    expect(result.newVersion).toBe(2);
    const row = await prisma.reportTemplate.findUnique({
      where: { id: templateId },
      select: { version: true },
    });
    expect(row!.version).toBe(2);
  });

  it("second edit with STALE expectedVersion (1) is rejected at app layer", async () => {
    // Row is at v2 now. Operator B still has the editor open at v1.
    const result = await gatedUpdate({
      templateId,
      expectedVersion: 1,
      definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/Version conflict/);
    // Row stays at v2 — no silent clobber.
    const row = await prisma.reportTemplate.findUnique({
      where: { id: templateId },
      select: { version: true },
    });
    expect(row!.version).toBe(2);
  });

  it("edit with current expectedVersion (2) succeeds + bumps to v3", async () => {
    const result = await gatedUpdate({
      templateId,
      expectedVersion: 2,
      definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
    });
    expect(result.ok).toBe(true);
    expect(result.newVersion).toBe(3);
  });

  it("simulated true-race: app-check passes, DB-filter catches the collision", async () => {
    // Setup a fresh row at v1.
    const raceRow = await prisma.reportTemplate.create({
      data: {
        tenantId,
        code: `${PREFIX}_RACE_${STAMP}`,
        name: "Race row",
        isSystem: false,
        version: 1,
        definition: INCOME_STATEMENT_TEMPLATE.definition as unknown as Prisma.InputJsonValue,
      },
      select: { id: true },
    });

    // Bump the row to v2 OUT-OF-BAND between the application-layer
    // findFirst and the updateMany. This simulates an interleaved
    // second writer landing first. Application layer can't see it
    // because we're not re-querying; the DB filter is the safety net.
    const result = await prisma.$transaction(async (tx) => {
      const existing = await tx.reportTemplate.findFirst({
        where: { id: raceRow.id },
        select: { version: true },
      });
      expect(existing!.version).toBe(1);

      // External writer slips in between findFirst and updateMany.
      await prisma.reportTemplate.update({
        where: { id: raceRow.id },
        data: { version: 2 },
      });

      // Our update — still scoped to version=1 at the DB layer.
      const updated = await tx.reportTemplate.updateMany({
        where: { id: raceRow.id, version: 1 },
        data: { version: 2 },
      });
      return updated.count;
    });
    expect(result).toBe(0); // DB layer rejected — no clobber.
  });
});
