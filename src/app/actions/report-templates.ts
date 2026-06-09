// Report Builder PR 9 — Server Actions for ReportTemplate persistence.
//
// Clone / rename / delete user-defined templates. The actual template
// DEFINITION (rows/columns) is not editable in this PR — a clone is
// a verbatim copy of the system template the operator chose. PR 10
// will add the row/column editor; this PR proves the persistence +
// resolution + audit + auth pattern works end-to-end.
//
// SOC 2 baseline:
// - CC6.3 Authorization: every action requires a signed-in user with a
//   current tenant. requireCurrentTenant throws if not authenticated.
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
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";

import { SYSTEM_TEMPLATES } from "@/lib/accounting/reports/builder/templates";

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

export type ActionResult =
  | { ok: true; templateId?: string }
  | { ok: false; error: string };

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

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

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

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

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
export async function deleteReportTemplate(
  input: z.infer<typeof DeleteInputSchema>
): Promise<ActionResult> {
  const parsed = DeleteInputSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.errors[0]?.message ?? "Invalid input" };
  }
  const { templateId } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

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
