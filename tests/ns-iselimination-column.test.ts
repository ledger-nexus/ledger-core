// v0.9 NS Books — isEliminationEntity column promotion test.
//
// Proves the migration + setupSubsidiaries dual-write:
//   1. Migration backfilled the column from extensions.nsIsElimination
//   2. New setupSubsidiaries calls populate BOTH the column AND the
//      JSON flag (transition state — future migration drops the
//      JSON side after all consumers migrate)
//   3. The column survives idempotent re-runs
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import { getDefaultTenantId } from "@/lib/seed/default-tenant";
import { setupSubsidiaries } from "@/lib/mappers/netsuite/subsidiaries";
import type { NsSubsidiary } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const PREFIX = "ISELIM";

const SUBSIDIARIES: NsSubsidiary[] = [
  {
    internalid: "1",
    name: "Elim Test Parent",
    iselimination: false,
    currency: "USD",
    country: "US",
  },
  {
    internalid: "2",
    name: "Elim Test Sub",
    iselimination: false,
    currency: "USD",
    country: "US",
    parent: { internalid: "1", name: "Elim Test Parent" },
  },
  {
    internalid: "99",
    name: "Elim Test ELIMINATION Sub",
    iselimination: true, // ← the one the test cares about
    currency: "USD",
    country: "US",
    parent: { internalid: "1", name: "Elim Test Parent" },
  },
];

async function cleanup(): Promise<void> {
  const tenantId = await getDefaultTenantId(prisma);
  await prisma.legalEntity.deleteMany({
    where: {
      tenantId,
      code: { in: [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS99`] },
    },
  });
}

describe("v0.9 NS Books: isEliminationEntity column", () => {
  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await prisma.$disconnect();
  });

  it("setupSubsidiaries populates the column AND the JSON flag (dual-write transition)", async () => {
    const result = await setupSubsidiaries(prisma, {
      subsidiaries: SUBSIDIARIES,
      resolution: { mode: "multi", entityCodePrefix: PREFIX },
    });
    expect(result.subsidiariesUpserted).toBe(3);

    const tenantId = await getDefaultTenantId(prisma);
    const entities = await prisma.legalEntity.findMany({
      where: {
        tenantId,
        code: { in: [`${PREFIX}_NS1`, `${PREFIX}_NS2`, `${PREFIX}_NS99`] },
      },
      select: {
        code: true,
        isEliminationEntity: true,
        extensions: true,
      },
      orderBy: { code: "asc" },
    });
    expect(entities.length).toBe(3);

    const elimSub = entities.find((e) => e.code === `${PREFIX}_NS99`)!;
    expect(elimSub.isEliminationEntity).toBe(true);
    // Dual-write: JSON flag also true
    expect(
      (elimSub.extensions as Record<string, unknown>).nsIsElimination
    ).toBe(true);

    const nonElim = entities.find((e) => e.code === `${PREFIX}_NS2`)!;
    expect(nonElim.isEliminationEntity).toBe(false);
    expect(
      (nonElim.extensions as Record<string, unknown>).nsIsElimination
    ).toBe(false);
  });

  it("re-running setupSubsidiaries preserves the column on update path", async () => {
    // The first run populated. Run again with the SAME data; the
    // upsert update branch must keep isEliminationEntity correct.
    await setupSubsidiaries(prisma, {
      subsidiaries: SUBSIDIARIES,
      resolution: { mode: "multi", entityCodePrefix: PREFIX },
    });

    const tenantId = await getDefaultTenantId(prisma);
    const elimSub = await prisma.legalEntity.findFirstOrThrow({
      where: { tenantId, code: `${PREFIX}_NS99` },
      select: { isEliminationEntity: true },
    });
    expect(elimSub.isEliminationEntity).toBe(true);
  });

  it("migration backfill: every existing entity has a column value (no NULLs)", async () => {
    // The migration sets the column on every row. Even rows that have
    // no extensions.nsIsElimination flag get the default false.
    const nullCount = await prisma.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS count FROM "legal_entity" WHERE "isEliminationEntity" IS NULL`
    );
    expect(Number(nullCount[0].count)).toBe(0);
  });
});
