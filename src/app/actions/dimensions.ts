"use server";

// Dimension groups and their values — the master data behind Layer 3.
//
// `CLAUDE.md` describes the dimension engine as "an empty table seam since
// v0.2". It is not empty in the schema — Dimension / DimensionValue /
// DimensionSet are all there, and the NetSuite importer fills them — it is
// empty in the sense that nothing in the product lets a person see or create
// one. This is that surface.
//
// ⚠️ WHAT THESE ACTIONS DELIBERATELY DO NOT EXPOSE: `isRequired` and
// `appliesToAccountTypes`. Both columns exist on Dimension and are written by
// the NetSuite mapper, and NOTHING READS THEM — `postJournalEntry` contains
// zero references to dimensions of any kind. The NS importer attaches
// `dimensionSetId` to line rows AFTER the entry is created, so there is no
// point in the canonical write path where a "this dimension is required" rule
// could be checked.
//
// So a toggle labelled "Required" would be a control that does nothing, which
// is the exact failure this codebase keeps finding in other people's work and
// in its own (`bg-warning/5` emitting no CSS; `isRequired` is the same shape).
// Wiring dimensions into postJournalEntry is a change to the canonical ledger
// write path and belongs in its own design, not smuggled in behind a checkbox.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requirePermitted } from "@/lib/auth/authorize";
import { canEditAccounts } from "@/lib/auth/policy";
import { auditPrivilegedAction } from "@/lib/audit/log";

export type ActionResult = { ok: true } | { ok: false; error: string };

/** Codes are uppercase identifiers — they key the DimensionSet hash. */
const CODE = z
  .string()
  .trim()
  .min(2)
  .max(30)
  .regex(/^[A-Z][A-Z0-9_]*$/, "Code is uppercase letters, digits and underscores");

const NAME = z.string().trim().min(1).max(60);

const CreateDimension = z.object({
  code: CODE,
  name: NAME,
  description: z.string().trim().max(200).optional(),
});

const CreateValue = z.object({
  dimensionId: z.string().uuid(),
  // Value codes come from source systems ("20", "NORTH") and are not
  // constrained to the uppercase-identifier shape a dimension code is.
  code: z.string().trim().min(1).max(30),
  name: NAME,
});

export async function createDimensionAction(formData: FormData): Promise<ActionResult> {
  const { user, tenant } = await requirePermitted("dimension.manage", canEditAccounts);

  const parsed = CreateDimension.safeParse({
    code: String(formData.get("code") ?? "").toUpperCase(),
    name: formData.get("name"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid dimension" };
  }

  const existing = await prisma.dimension.findFirst({
    where: { tenantId: tenant.id, code: parsed.data.code },
    select: { id: true },
  });
  if (existing) {
    // Refuse rather than upsert. A dimension code is part of the DimensionSet
    // hash, so silently rewriting one would change the meaning of every set
    // already built from it.
    return { ok: false, error: `Dimension ${parsed.data.code} already exists` };
  }

  const created = await prisma.dimension.create({
    data: {
      tenantId: tenant.id,
      code: parsed.data.code,
      name: parsed.data.name,
      description: parsed.data.description ?? null,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "dimension.create",
    resource: "Dimension",
    resourceId: created.id,
    tenantId: tenant.id,
    metadata: { code: parsed.data.code, name: parsed.data.name },
  });

  revalidatePath("/dimensions");
  return { ok: true };
}

export async function createDimensionValueAction(formData: FormData): Promise<ActionResult> {
  const { user, tenant } = await requirePermitted("dimension.manage", canEditAccounts);

  const parsed = CreateValue.safeParse({
    dimensionId: formData.get("dimensionId"),
    code: formData.get("code"),
    name: formData.get("name"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid value" };
  }

  // ⚠️ Tenant in the WHERE, not just the id. `DimensionValue` is unique on
  // (dimensionId, code) with no tenant term, so an unscoped parent lookup
  // would let a caller hang a value off another tenant's dimension — the same
  // shape as deficiency #32.
  const parent = await prisma.dimension.findFirst({
    where: { id: parsed.data.dimensionId, tenantId: tenant.id },
    select: { id: true, code: true },
  });
  if (!parent) return { ok: false, error: "Dimension not found" };

  const clash = await prisma.dimensionValue.findFirst({
    where: { dimensionId: parent.id, code: parsed.data.code },
    select: { id: true },
  });
  if (clash) {
    return { ok: false, error: `${parent.code} already has a value ${parsed.data.code}` };
  }

  const created = await prisma.dimensionValue.create({
    data: {
      tenantId: tenant.id,
      dimensionId: parent.id,
      code: parsed.data.code,
      name: parsed.data.name,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "dimension_value.create",
    resource: "DimensionValue",
    resourceId: created.id,
    tenantId: tenant.id,
    metadata: { dimension: parent.code, code: parsed.data.code },
  });

  revalidatePath("/dimensions");
  return { ok: true };
}

// Form adapters — `<form action>` wants void. See the note in
// src/app/actions/saved-views.ts about the error-surfacing limitation.
export async function createDimensionFormAction(formData: FormData): Promise<void> {
  const r = await createDimensionAction(formData);
  if (!r.ok) throw new Error(r.error);
}

export async function createDimensionValueFormAction(formData: FormData): Promise<void> {
  const r = await createDimensionValueAction(formData);
  if (!r.ok) throw new Error(r.error);
}
