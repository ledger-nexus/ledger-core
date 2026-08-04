// Report Builder PR 9 — Server Actions for ReportTemplate persistence.
//
// Clone / rename / delete user-defined templates. The actual template
// DEFINITION (rows/columns) is not editable in this PR — a clone is
// a verbatim copy of the system template the operator chose. PR 10
// will add the row/column editor; this PR proves the persistence +
// resolution + audit + auth pattern works end-to-end.
//
// SOC 2 baseline:
// - CC6.3 Authorization: every mutation gates on canManageReportTemplates
//   (ADMIN floor) via requirePermitted, which also writes the
//   ACCESS_DENIED audit row on refusal. Rendering/viewing stays
//   VIEWER+ — the floor here is for changing what statements look like.
// - CC6.1 Multi-tenant: all writes carry the resolved tenantId.
//   Composite unique `(tenantId, code)` is enforced at the DB layer.
// - CC6.8 Input validation: Zod schemas on every input.
// - CC7.2 Audit: every mutation writes a PRIVILEGED_ACTION audit row
//   with the actor + tenant + resource id.
//
// Constraints:
// - Cannot delete or rename a system template (isSystem: true). User
//   must clone first, then edit the clone. System rows are
//   re-installed by `seedSystemTemplates` and should never be lost.
// - User-defined codes can be ANY non-system code. Clone defaults to
//   `{source_code}_COPY` and the user can rename later.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/db";
import { NotAuthenticatedError } from "@/lib/auth/current-user";
import { requirePermitted, type AuthzContext } from "@/lib/auth/authorize";
import {
  canManageReportTemplates,
  PermissionDeniedError,
} from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";

import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";
import {
  ReportTemplateDefinitionSchema,
  validateDefinitionIntegrity,
} from "@/lib/accounting/reports/builder/schema";

const CloneInputSchema = z.object({
  sourceCode: z.string().min(1).max(60),
  newCode: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[A-Z0-9_-]+$/, "Code must be uppercase letters, digits, _ or -"),
  newName: z.string().min(1).max(120),
});

const RenameInputSchema = z.object({
  templateId: z.string().uuid(),
  newName: z.string().min(1).max(120),
});

const DeleteInputSchema = z.object({
  templateId: z.string().uuid(),
});

const UpdateDefinitionInputSchema = z.object({
  templateId: z.string().uuid(),
  // JSON-stringified ReportTemplateDefinition. Stored separately
  // because <textarea> values pre-serialize cleanly.
  definitionJson: z.string().min(2).max(64_000),
  /**
   * Optimistic concurrency token. Caller passes the `version` value
   * the editor was loaded with. If the row's current `version` no
   * longer matches, another operator (or the same operator in a
   * second tab) edited the template after this editor was loaded.
   * The Server Action rejects the write with a structured error so
   * the operator can refresh + retry instead of silently clobbering
   * the other edit.
   */
  expectedVersion: z.number().int().min(1),
});

export type ActionResult =
  | { ok: true; templateId?: string }
  | { ok: false; error: string };

// Shared authz gate for the four mutations. requirePermitted writes the
// ACCESS_DENIED audit row on refusal; this wrapper converts the throw
// into the ActionResult shape the editor UI renders inline. Unknown
// errors keep propagating — only authn/authz outcomes are "expected".
async function requireTemplateManager(): Promise<
  { ctx: AuthzContext; refusal: null } | { ctx: null; refusal: ActionResult }
> {
  try {
    const ctx = await requirePermitted(
      "reportTemplate.manage",
      canManageReportTemplates
    );
    return { ctx, refusal: null };
  } catch (e) {
    if (e instanceof PermissionDeniedError || e instanceof NotAuthenticatedError) {
      return { ctx: null, refusal: { ok: false, error: e.message } };
    }
    throw e;
  }
}

/**
 * Clone a system template into a tenant-scoped user-defined row. The
 * source can be:
 *  - A SYSTEM_TEMPLATES code (IS / BS / CF / EQ), OR
 *  - A `(tenantId, sourceCode)` row already persisted (operator clones
 *    a previously-customized template).
 *
 * The new row is `isSystem: false` so future `seedSystemTemplates`
 * calls never clobber it.
 */
export async function cloneReportTemplate(
  input: z.infer<typeof CloneInputSchema>
): Promise<ActionResult> {
  const parsed = CloneInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { sourceCode, newCode, newName } = parsed.data;
  const upperSource = sourceCode.toUpperCase();
  const upperNew = newCode.toUpperCase();

  const { ctx, refusal } = await requireTemplateManager();
  if (refusal) return refusal;
  const { user, tenant } = ctx;

  // Resolve the source: prefer the tenant's DB row; fall back to the
  // hard-coded SYSTEM_TEMPLATES registry (covers tenants that haven't
  // been `seedSystemTemplates`'d yet).
  const existingSource = await prisma.reportTemplate.findUnique({
    where: { tenantId_code: { tenantId: tenant.id, code: upperSource } },
  });
  const sourceDefinition: Prisma.InputJsonValue | null = existingSource
    ? (existingSource.definition as Prisma.InputJsonValue)
    : (SYSTEM_TEMPLATES.find((t) => t.code === upperSource)?.definition as
        | Prisma.InputJsonValue
        | undefined) ?? null;
  if (!sourceDefinition) {
    return { ok: false, error: `Source template "${upperSource}" not found` };
  }

  // Guard against accidental clobber of an existing code in this tenant.
  const conflict = await prisma.reportTemplate.findUnique({
    where: { tenantId_code: { tenantId: tenant.id, code: upperNew } },
    select: { id: true },
  });
  if (conflict) {
    return {
      ok: false,
      error: `A template with code "${upperNew}" already exists in this tenant`,
    };
  }

  const created = await prisma.reportTemplate.create({
    data: {
      tenantId: tenant.id,
      code: upperNew,
      name: newName,
      // User-cloned. seedSystemTemplates skips this row from now on.
      isSystem: false,
      version: 1,
      definition: sourceDefinition,
      createdBy: user.id,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "report-template.clone",
    resource: "ReportTemplate",
    resourceId: created.id,
    tenantId: tenant.id,
    metadata: {
      sourceCode: upperSource,
      newCode: upperNew,
      newName,
    },
  });

  revalidatePath("/reports/builder");
  return { ok: true, templateId: created.id };
}

/**
 * Rename a user-defined template. System templates (isSystem: true)
 * cannot be renamed — clone first.
 */
export async function renameReportTemplate(
  input: z.infer<typeof RenameInputSchema>
): Promise<ActionResult> {
  const parsed = RenameInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { templateId, newName } = parsed.data;

  const { ctx, refusal } = await requireTemplateManager();
  if (refusal) return refusal;
  const { user, tenant } = ctx;

  // Authorization: must exist AND belong to this tenant AND be user-defined.
  const existing = await prisma.reportTemplate.findFirst({
    where: { id: templateId, tenantId: tenant.id },
    select: { id: true, isSystem: true, code: true, name: true },
  });
  if (!existing) {
    return { ok: false, error: "Template not found" };
  }
  if (existing.isSystem) {
    return {
      ok: false,
      error: "Cannot rename a system template. Clone it first.",
    };
  }

  await prisma.reportTemplate.update({
    where: { id: templateId },
    data: { name: newName },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "report-template.rename",
    resource: "ReportTemplate",
    resourceId: templateId,
    tenantId: tenant.id,
    metadata: {
      code: existing.code,
      oldName: existing.name,
      newName,
    },
  });

  revalidatePath("/reports/builder");
  return { ok: true, templateId };
}

/**
 * Delete a user-defined template. System templates cannot be deleted.
 */
/**
 * Replace the JSON definition of a user-defined template. System
 * templates cannot be edited from this surface — clone first.
 *
 * Validation pipeline:
 *   1. Server Action Zod (UUID + JSON-string envelope)
 *   2. JSON.parse — reject malformed JSON
 *   3. ReportTemplateDefinitionSchema — structural shape check
 *   4. validateDefinitionIntegrity — cross-ref integrity
 *   5. Persist + bump version
 *   6. Audit-log the change with row count delta in metadata
 *
 * Returning structured errors at each step keeps the editor UI useful.
 */
export async function updateReportTemplateDefinition(
  input: z.infer<typeof UpdateDefinitionInputSchema>
): Promise<ActionResult> {
  const parsed = UpdateDefinitionInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { templateId, definitionJson, expectedVersion } = parsed.data;

  const { ctx, refusal } = await requireTemplateManager();
  if (refusal) return refusal;
  const { user, tenant } = ctx;

  // Step 2: JSON.parse.
  let raw: unknown;
  try {
    raw = JSON.parse(definitionJson);
  } catch (e) {
    return {
      ok: false,
      error: `Invalid JSON: ${(e as Error).message}`,
    };
  }

  // Step 3: structural Zod validation.
  const defParse = ReportTemplateDefinitionSchema.safeParse(raw);
  if (!defParse.success) {
    return {
      ok: false,
      error: `Schema validation failed: ${defParse.error.errors
        .slice(0, 3)
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ")}`,
    };
  }
  const definition = defParse.data;

  // Step 4: cross-reference integrity.
  const integrity = validateDefinitionIntegrity(definition);
  if (integrity.length > 0) {
    return {
      ok: false,
      error: `Integrity errors: ${integrity
        .slice(0, 3)
        .map((i) => `[${i.rowOrColumnId}] ${i.message}`)
        .join("; ")}`,
    };
  }

  // Step 5: authorize + persist.
  const existing = await prisma.reportTemplate.findFirst({
    where: { id: templateId, tenantId: tenant.id },
    select: {
      id: true,
      isSystem: true,
      code: true,
      name: true,
      version: true,
    },
  });
  if (!existing) {
    return { ok: false, error: "Template not found" };
  }
  if (existing.isSystem) {
    return {
      ok: false,
      error: "Cannot edit a system template. Clone it first.",
    };
  }

  // Optimistic concurrency check (PR 11 adversarial-pass fix). Without
  // this, two operators editing the same template in parallel would
  // silently clobber each other: each loads version N, each writes
  // version N+1, second write overwrites first. Forces refresh-and-
  // retry instead.
  if (existing.version !== expectedVersion) {
    return {
      ok: false,
      error:
        `Template was modified by another user (now version ${existing.version}, ` +
        `you loaded version ${expectedVersion}). Refresh + retry.`,
    };
  }

  // The Prisma update uses an explicit version filter so a concurrent
  // write between the read above and this update is also rejected at
  // the DB level (defense-in-depth — the application-layer check is
  // the primary gate).
  const updated = await prisma.reportTemplate.updateMany({
    where: { id: templateId, version: expectedVersion },
    data: {
      definition: definition as unknown as Prisma.InputJsonValue,
      version: expectedVersion + 1,
    },
  });
  if (updated.count === 0) {
    return {
      ok: false,
      error:
        "Template was modified concurrently — DB-layer version filter rejected the write. Refresh + retry.",
    };
  }

  // Step 6: audit. Include row/column counts so reviewers can quickly
  // see whether the change was a "small tweak" or "wholesale replace."
  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "report-template.update-definition",
    resource: "ReportTemplate",
    resourceId: templateId,
    tenantId: tenant.id,
    metadata: {
      code: existing.code,
      oldVersion: expectedVersion,
      newVersion: expectedVersion + 1,
      rowCount: definition.rows.length,
      columnCount: definition.columns.length,
    },
  });

  revalidatePath("/reports/builder");
  revalidatePath(`/reports/builder/${existing.code}`);
  return { ok: true, templateId };
}

export async function deleteReportTemplate(
  input: z.infer<typeof DeleteInputSchema>
): Promise<ActionResult> {
  const parsed = DeleteInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { templateId } = parsed.data;

  const { ctx, refusal } = await requireTemplateManager();
  if (refusal) return refusal;
  const { user, tenant } = ctx;

  const existing = await prisma.reportTemplate.findFirst({
    where: { id: templateId, tenantId: tenant.id },
    select: { id: true, isSystem: true, code: true, name: true },
  });
  if (!existing) {
    return { ok: false, error: "Template not found" };
  }
  if (existing.isSystem) {
    return {
      ok: false,
      error: "Cannot delete a system template.",
    };
  }

  await prisma.reportTemplate.delete({ where: { id: templateId } });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "report-template.delete",
    resource: "ReportTemplate",
    resourceId: templateId,
    tenantId: tenant.id,
    metadata: {
      code: existing.code,
      name: existing.name,
    },
  });

  revalidatePath("/reports/builder");
  return { ok: true };
}
