// Lazy seed of the 4 GAAP system templates per tenant.
//
// Called by:
//   - tenant-creation Server Action (when v2's user lifecycle lands)
//   - the /reports list page if its query returns 0 templates for the
//     current tenant (lazy backfill for tenants created pre-arc)
//
// Idempotent: upserts by (tenantId, code). Re-running for the same
// tenant is a no-op.
//
// IMPORTANT: this helper MUST run inside withTenantContext when RLS
// Phase 3 FORCE lands. For now (pre-FORCE), the function takes a
// PrismaClient or TransactionClient interchangeably and the caller is
// responsible for tenant scoping.

import type { PrismaClient, Prisma } from "@prisma/client";

import { SYSTEM_TEMPLATES } from "./templates";

type DbClient = PrismaClient | Prisma.TransactionClient;

export interface SeedSystemTemplatesResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/**
 * Seed the 4 system templates for one tenant. Upserts by (tenantId, code).
 *
 * For tenants that already have a template at the same code:
 *   - If isSystem=true on the existing row AND the version matches → skip
 *   - If isSystem=true AND version differs → update (system template
 *     bumped; refresh the definition)
 *   - If isSystem=false (user-cloned) → skip; never clobber user edits
 *
 * @param prisma   Prisma client or transaction client (per-tenant context required)
 * @param tenantId Tenant UUID
 */
export async function seedSystemTemplates(
  prisma: DbClient,
  tenantId: string
): Promise<SeedSystemTemplatesResult> {
  const result: SeedSystemTemplatesResult = {
    inserted: 0,
    updated: 0,
    skipped: 0,
  };

  for (const tmpl of SYSTEM_TEMPLATES) {
    const existing = await prisma.reportTemplate.findUnique({
      where: { tenantId_code: { tenantId, code: tmpl.code } },
      select: { id: true, isSystem: true, version: true },
    });

    if (!existing) {
      await prisma.reportTemplate.create({
        data: {
          tenantId,
          code: tmpl.code,
          name: tmpl.name,
          isSystem: true,
          version: tmpl.version,
          definition: tmpl.definition as unknown as Prisma.InputJsonValue,
        },
      });
      result.inserted += 1;
      continue;
    }

    // Existing row — only update if it's a system row and the version
    // bumped. User-cloned rows (isSystem=false) are sacred — never
    // clobber.
    if (!existing.isSystem) {
      result.skipped += 1;
      continue;
    }

    if (existing.version === tmpl.version) {
      result.skipped += 1;
      continue;
    }

    await prisma.reportTemplate.update({
      where: { id: existing.id },
      data: {
        name: tmpl.name,
        version: tmpl.version,
        definition: tmpl.definition as unknown as Prisma.InputJsonValue,
      },
    });
    result.updated += 1;
  }

  return result;
}
