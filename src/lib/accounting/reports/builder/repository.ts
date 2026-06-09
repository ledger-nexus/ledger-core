// Report Builder PR 9 — DB repository for per-tenant ReportTemplate.
//
// Resolves template code → ReportTemplate by checking:
//   1. The DB (tenant-scoped, isSystem flag preserved)
//   2. Fallback to the hard-coded SYSTEM_TEMPLATES registry
//
// This lets the existing matrix renderer / CSV route / PDF route stay
// blind to the storage tier — they just call `loadTemplate(prisma, code,
// tenantId)` and get a ReportTemplate back.
//
// SOC 2 CC6.1: every query takes tenantId and uses it. Cross-tenant
// reads not possible at this layer.

import type { PrismaClient, Prisma } from "@prisma/client";

import { SYSTEM_TEMPLATES } from "./templates";
import type {
  ReportTemplate,
  ReportTemplateDefinition,
} from "./types";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * Load a template by (tenantId, code).
 *
 * Resolution order:
 *   1. ReportTemplate row in this tenant — uses DB definition (Json
 *      column hydrated to typed shape).
 *   2. SYSTEM_TEMPLATES fallback — for tenants that haven't been
 *      `seedSystemTemplates`'d yet, the hard-coded defaults still work.
 *
 * Returns `null` when neither resolves.
 */
export async function loadTemplate(
  prisma: DbClient,
  code: string,
  tenantId: string
): Promise<ReportTemplate | null> {
  const upper = code.toUpperCase();

  const row = await prisma.reportTemplate.findUnique({
    where: { tenantId_code: { tenantId, code: upper } },
  });
  if (row) {
    // Hydrate Json → typed. We trust write-time validation (Server
    // Actions Zod-validate before insert/update) so this cast is safe.
    return {
      code: row.code,
      name: row.name,
      version: row.version,
      isSystem: row.isSystem,
      definition: row.definition as unknown as ReportTemplateDefinition,
    };
  }

  // Fallback: hard-coded default (covers tenants that haven't been
  // seeded yet, and any caller passing a system code directly).
  return SYSTEM_TEMPLATES.find((t) => t.code === upper) ?? null;
}

/**
 * List every template visible to a tenant. Returns persisted rows from
 * the DB (system + user) — does NOT fall back to SYSTEM_TEMPLATES,
 * because seeded tenants have their copies in the DB. Callers that need
 * unseeded fallback should also check SYSTEM_TEMPLATES.
 */
export async function listTemplates(
  prisma: DbClient,
  tenantId: string
): Promise<
  Array<{
    id: string;
    code: string;
    name: string;
    isSystem: boolean;
    version: number;
    updatedAt: Date;
  }>
> {
  return prisma.reportTemplate.findMany({
    where: { tenantId },
    select: {
      id: true,
      code: true,
      name: true,
      isSystem: true,
      version: true,
      updatedAt: true,
    },
    orderBy: [{ isSystem: "desc" }, { code: "asc" }],
  });
}
