// Layer 3 dimension engine helpers.
//
// The first real exercise of the Dimension / DimensionValue / DimensionSet
// / DimensionSetValue tables. NetSuite ships with three built-in
// dimensions (Class, Department, Location) plus arbitrary custom
// segments. The NS mapper builds a Dimension row per kind, a
// DimensionValue row per NS internal id, and a deduplicated DimensionSet
// per unique combination assigned to a transaction line.
//
// The dedup key is a stable hash of sorted (dimensionCode, valueCode)
// pairs. Two transaction lines with identical assignments share the same
// DimensionSet row.

import { PrismaClient } from "@prisma/client";
import { getDefaultTenantId } from "@/lib/seed/default-tenant";

// Sort assignments + concatenate. The hash is the dedup key for
// DimensionSet — every line with the same (dim, value) combo shares one
// DimensionSet row, which is the entire point of the engine.
export function dimensionSetHash(
  assignments: { dimensionCode: string; valueCode: string }[]
): string {
  const sorted = [...assignments].sort((a, b) =>
    a.dimensionCode.localeCompare(b.dimensionCode)
  );
  return sorted.map((a) => `${a.dimensionCode}:${a.valueCode}`).join("|");
}

export interface SetupDimensionInput {
  code: string;                       // "CLASS", "DEPARTMENT", "LOCATION", "REGION"
  name: string;
  description?: string;               // optional free-form, for roundtrip preservation
  isRequired?: boolean;
  appliesToAccountTypes?: ("ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE")[];
}

export async function setupDimension(
  prisma: PrismaClient,
  input: SetupDimensionInput
): Promise<{ id: string }> {
  const applies = input.appliesToAccountTypes ?? [];
  const tenantId = await getDefaultTenantId(prisma);
  // Phase 4b: dimension.code is unique per [tenantId, code]. Upsert
  // targets the composite key explicitly so different tenants can each
  // define their own "CLASS" / "DEPARTMENT" / etc.
  return await prisma.dimension.upsert({
    where: { tenantId_code: { tenantId, code: input.code } },
    create: {
      tenantId,
      code: input.code,
      name: input.name,
      description: input.description,
      isRequired: input.isRequired ?? false,
      appliesToAccountTypes: applies as unknown as any,
    },
    update: {
      tenantId,
      name: input.name,
      description: input.description,
      isRequired: input.isRequired ?? false,
      appliesToAccountTypes: applies as unknown as any,
    },
    select: { id: true },
  });
}

export interface SetupDimensionValueInput {
  dimensionCode: string;
  code: string;
  name: string;
}

export async function setupDimensionValue(
  prisma: PrismaClient,
  input: SetupDimensionValueInput
): Promise<{ id: string }> {
  // Phase 4b: dimension.code unique per [tenantId, code]; findFirst.
  const dimension = await prisma.dimension.findFirstOrThrow({
    where: { code: input.dimensionCode },
    select: { id: true, tenantId: true },
  });
  return await prisma.dimensionValue.upsert({
    where: {
      dimensionId_code: { dimensionId: dimension.id, code: input.code },
    },
    create: {
      tenantId: dimension.tenantId,
      dimensionId: dimension.id,
      code: input.code,
      name: input.name,
    },
    update: { tenantId: dimension.tenantId, name: input.name },
    select: { id: true },
  });
}

// Look up or create a DimensionSet matching the given assignments.
// Returns the DimensionSet id. Assignments missing from input are NOT
// considered part of the set — a line tagged Class+Dept matches an
// existing set with Class+Dept exactly, NOT one with Class+Dept+Location.
export async function getOrCreateDimensionSet(
  prisma: PrismaClient,
  assignments: { dimensionCode: string; valueCode: string }[]
): Promise<string> {
  if (assignments.length === 0) {
    throw new Error("Cannot build a DimensionSet with zero assignments");
  }

  const hash = dimensionSetHash(assignments);
  // Resolve tenant up-front so the dedup lookup is tenant-scoped
  // (Phase 4b: dimension_set.hash is unique per [tenantId, hash]).
  const tenantId = await getDefaultTenantId(prisma);

  // Fast path: existing set in THIS tenant.
  const existing = await prisma.dimensionSet.findUnique({
    where: { tenantId_hash: { tenantId, hash } },
    select: { id: true },
  });
  if (existing) return existing.id;

  // Resolve dimension + dimension-value ids.
  const dimCodes = Array.from(new Set(assignments.map((a) => a.dimensionCode)));
  const dims = await prisma.dimension.findMany({
    where: { code: { in: dimCodes } },
    select: { id: true, code: true },
  });
  const dimByCode = new Map(dims.map((d) => [d.code, d.id]));

  const resolved: { dimensionId: string; dimensionValueId: string }[] = [];
  for (const a of assignments) {
    const dimensionId = dimByCode.get(a.dimensionCode);
    if (!dimensionId) {
      throw new Error(`Dimension ${a.dimensionCode} not set up. Call setupDimension first.`);
    }
    const value = await prisma.dimensionValue.findUnique({
      where: { dimensionId_code: { dimensionId, code: a.valueCode } },
      select: { id: true },
    });
    if (!value) {
      throw new Error(
        `Dimension value ${a.dimensionCode}.${a.valueCode} not set up. Call setupDimensionValue first.`
      );
    }
    resolved.push({ dimensionId, dimensionValueId: value.id });
  }

  // Create the set + its value bridges. There's a small race window
  // between the findUnique above and create here; if two callers race for
  // the same hash, the unique constraint will reject the second one. We
  // catch P2002 and refetch, returning the existing row's id — making
  // the function safe to call concurrently and across multiple test runs
  // where the same hash gets seeded repeatedly.
  try {
    const created = await prisma.dimensionSet.create({
      data: {
        tenantId,
        hash,
        values: {
          create: resolved.map((r) => ({
            dimensionId: r.dimensionId,
            dimensionValueId: r.dimensionValueId,
          })),
        },
      },
      select: { id: true },
    });
    return created.id;
  } catch (e) {
    // Prisma's typed code; tolerate raw pg "23505" too.
    const code = (e as { code?: string }).code;
    if (code === "P2002" || code === "23505") {
      const reread = await prisma.dimensionSet.findUnique({
        where: { tenantId_hash: { tenantId, hash } },
        select: { id: true },
      });
      if (reread) return reread.id;
    }
    throw e;
  }
}
