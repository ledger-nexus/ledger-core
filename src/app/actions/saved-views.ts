"use server";

// Saved views — name a filter state, get it back later.
//
// A view is the surface's query string plus a name (see the SavedView model
// comment for why a string rather than a JSON config). These actions do the
// storing; `src/lib/url-state.ts` does the interpreting, and neither knows the
// other's field names, which is the property that keeps them from drifting.

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireActor } from "@/lib/auth/authorize";
import { auditPrivilegedAction } from "@/lib/audit/log";

/**
 * ⚠️ `query` is stored and later concatenated into an href, so it is validated
 * as a query string and nothing else: no leading `?`, no `#`, no scheme, no
 * `//`. Without this a saved "view" could carry `//evil.example/x` and the
 * surface would render an off-site link under the user's own view name.
 *
 * Length is bounded because a view is a filter, not a payload.
 */
const QUERY = z
  .string()
  .max(2048)
  .refine((q) => !q.startsWith("?"), "query must not include the leading '?'")
  .refine((q) => !/[#\s]/.test(q), "query must not contain '#' or whitespace")
  .refine((q) => !q.includes("//") && !/^[a-z]+:/i.test(q), "query must not look like a URL");

const SaveInput = z.object({
  surface: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/, "surface is a route slug"),
  name: z.string().trim().min(1).max(60),
  query: QUERY,
  shared: z.boolean().default(false),
});

export type ActionResult = { ok: true } | { ok: false; error: string };

export async function saveViewAction(formData: FormData): Promise<ActionResult> {
  const { user, tenant } = await requireActor("saved-view.save");

  const parsed = SaveInput.safeParse({
    surface: formData.get("surface"),
    name: formData.get("name"),
    query: formData.get("query") ?? "",
    shared: formData.get("shared") === "on",
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid view" };
  }
  const { surface, name, query, shared } = parsed.data;

  // Re-saving a name REPLACES that view. The alternative — refusing, or
  // silently making "Q2 (2)" — turns the natural "adjust the filters and save
  // again" loop into a cleanup chore.
  const view = await prisma.savedView.upsert({
    where: {
      tenantId_surface_ownerId_name: { tenantId: tenant.id, surface, ownerId: user.id, name },
    },
    create: { tenantId: tenant.id, surface, ownerId: user.id, name, query, shared },
    update: { query, shared },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "saved_view.save",
    resource: "SavedView",
    resourceId: view.id,
    tenantId: tenant.id,
    // The query string is the point of the row and holds only filter values
    // the user just typed into their own screen — no PII beyond what they
    // searched for, which the audit row's own actor already identifies.
    metadata: { surface, name, shared },
  });

  revalidatePath(`/${surface}`);
  return { ok: true };
}

export async function deleteViewAction(formData: FormData): Promise<ActionResult> {
  const { user, tenant } = await requireActor("saved-view.delete");

  const id = z.string().uuid().safeParse(formData.get("id"));
  if (!id.success) return { ok: false, error: "Invalid view id" };

  // ⚠️ Tenant AND owner in the WHERE, not just the id. A uuid is unguessable,
  // which is an argument for it being hard to abuse and not an argument for
  // leaving the scope off — the same reasoning that left four sub-ledgers
  // resolving entities by code alone until deficiency #32.
  const deleted = await prisma.savedView.deleteMany({
    where: { id: id.data, tenantId: tenant.id, ownerId: user.id },
  });
  if (deleted.count === 0) {
    // Same message whether it never existed or belongs to someone else —
    // "not yours" would confirm the id is real.
    return { ok: false, error: "View not found" };
  }

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "saved_view.delete",
    resource: "SavedView",
    resourceId: id.data,
    tenantId: tenant.id,
  });

  revalidatePath("/");
  return { ok: true };
}

/**
 * Views visible to the caller on one surface: their own, plus anything shared
 * within the tenant. Tenant-pinned in the query, not merely on the column.
 */
export async function listViews(surface: string) {
  const { user, tenant } = await requireActor("saved-view.list");
  return prisma.savedView.findMany({
    where: {
      tenantId: tenant.id,
      surface,
      OR: [{ ownerId: user.id }, { shared: true }],
    },
    select: { id: true, name: true, query: true, shared: true, ownerId: true },
    orderBy: [{ name: "asc" }],
  });
}

// ─── Form adapters ────────────────────────────────────────────────────────
//
// `<form action={…}>` in Next 14 requires `void | Promise<void>`, while the
// actions above return a result — which is what tests and any future
// `useFormState` client wrapper want. These are the thin bridge.
//
// ⚠️ THEY THROW ON FAILURE, and that is a deliberate v1 cut with a real cost:
// a rejected name renders the error boundary rather than a message beside the
// field. Showing it inline needs `useFormState`, which needs a client
// component, which is a bigger change than this slice. Validation here rejects
// only genuinely malformed input (an empty name, a 2KB query, a URL-shaped
// query), so the common path does not hit it — but "the common path doesn't
// hit it" is not the same as good, and this is the follow-up.

export async function saveViewFormAction(formData: FormData): Promise<void> {
  const result = await saveViewAction(formData);
  if (!result.ok) throw new Error(result.error);
}

export async function deleteViewFormAction(formData: FormData): Promise<void> {
  const result = await deleteViewAction(formData);
  if (!result.ok) throw new Error(result.error);
}
