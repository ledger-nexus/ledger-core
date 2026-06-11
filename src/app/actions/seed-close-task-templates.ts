// BlackLine arc — Phase 2 PR 6: seed-templates Server Action wrapper.
//
// Wraps src/lib/seed/close-task-templates.ts → seedCloseTaskTemplates
// in the SOC 2 baseline:
//   - admin gate (template catalog is tenant-wide config)
//   - PRIVILEGED_ACTION audit row with the upsert count
//   - revalidate periods + close-tasks pages so the operator sees the
//     new templates immediately
//
// Idempotent — re-running yields the same 50 templates with no
// duplicates, since the underlying upsert hits the @@unique(tenantId,
// key) composite.

"use server";

import { revalidatePath } from "next/cache";
import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireTenantAdmin, getCurrentTenant } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";
import { seedCloseTaskTemplates } from "@/lib/seed/close-task-templates";

export type SeedTemplatesResult =
  | { ok: true; upserted: number }
  | { ok: false; code: string; error: string };

export async function seedCloseTaskTemplatesAction(): Promise<SeedTemplatesResult> {
  const user = await requireCurrentUser();
  try {
    await requireTenantAdmin();
  } catch {
    return {
      ok: false,
      code: "NOT_ADMIN",
      error: "Only a tenant admin can seed the close-task catalog",
    };
  }
  const tenant = await getCurrentTenant();
  if (!tenant) {
    return {
      ok: false,
      code: "NO_TENANT",
      error: "No current tenant resolved",
    };
  }

  const { upserted } = await seedCloseTaskTemplates(prisma, tenant.id);

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "closeTask.template.seed",
    resource: "CloseTaskTemplate",
    resourceId: tenant.id,
    tenantId: tenant.id,
    metadata: { upserted },
  });

  revalidatePath("/periods");
  revalidatePath("/close/tasks");

  return { ok: true, upserted };
}
