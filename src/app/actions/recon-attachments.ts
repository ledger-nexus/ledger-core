// BlackLine arc — Phase 1 PR 5: Reconciliation attachment Server Actions.
//
// Two actions covering the attachment lifecycle:
//
//   uploadAttachment   File → ReconciliationAttachment row with bytes
//                      stored in BYTEA. Validates content type +
//                      size before any DB write.
//   deleteAttachment   Removes an attachment. Uploader OR tenant admin.
//                      The recon row itself is never deleted (recons
//                      are append-only by audit doctrine; the attachment
//                      is corrective evidence cleanup, not a recon
//                      mutation).
//
// SOC 2 baseline:
//   CC6.3 Authorization: every action requires user + tenant. Cross-
//         tenant attachment access returns NOT_FOUND.
//   CC6.1 Multi-tenant: parent reconciliation looked up
//         findFirst({tenantId, id}). Attachment writes inherit the
//         recon's tenantId — we never trust client input for that.
//   CC6.8 Input validation: Zod for the action shape; content-type +
//         size validation in code (Zod can't reach into File bytes).
//         Content type allowlist (PDF, PNG, JPG, CSV, XLSX) prevents
//         random EXE/HTML/SVG uploads that would XSS via the download
//         endpoint.
//   CC7.2 Audit: PRIVILEGED_ACTION row on upload + delete. Filename,
//         size, content type, and the recon scope tuple all land in
//         metadata.
//
// CONFIDENTIALITY NOTE: bytes are stored PLAINTEXT in BYTEA for v1.
// ledger-core does not yet carry the PrismaExtension confidential-
// column path that other portfolio repos use (recon, fa-amort,
// revenue-rec). The schema column is sized for encrypted payloads so
// retrofitting via an extension later is non-breaking. The download
// endpoint is auth-gated end-to-end so plaintext-at-rest exposure
// requires DB-level access, not API-level. Tracked in the BlackLine
// arc design doc as a follow-up.

"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";

import { prisma } from "@/lib/db";
import { requireCurrentUser } from "@/lib/auth/current-user";
import { requireCurrentTenant, isTenantAdmin } from "@/lib/auth/tenant";
import { auditPrivilegedAction } from "@/lib/audit/log";

// ─────────────────────────────────────────────────────────────────────────
// Validation policy
// ─────────────────────────────────────────────────────────────────────────

// 10 MiB cap. Bank-statement PDFs are typically <2 MiB; sub-ledger
// CSV exports under 1 MiB. 10 MiB gives headroom for high-res scans
// without blowing up the database row footprint. Postgres BYTEA can
// technically hold up to 1 GB; our limit is a UX + abuse guard.
export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

// Allowlist of MIME types. Anything else gets rejected before the bytes
// hit the DB. The download route sets Content-Type from this column, so
// allowing text/html or image/svg+xml would open a stored-XSS hole.
const ALLOWED_CONTENT_TYPES = new Set<string>([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/jpg", // some clients send this non-standard variant
  "text/csv",
  "application/vnd.ms-excel", // .xls
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", // .xlsx
]);

// Display-friendly hint for the UI's file picker.
export const ATTACHMENT_ACCEPT_HINT =
  "PDF, PNG, JPEG, CSV, XLSX up to 10 MB";

// Filename safety. Strip path separators so a malicious filename like
// "../../etc/passwd" can't influence any downstream code path. Lift to
// 200 chars (Postgres TEXT handles more, but a CPA's filename rarely
// crosses 80).
function sanitizeFilename(raw: string): string {
  const noPath = raw.replace(/[\\/]/g, "_");
  return noPath.slice(0, 200);
}

// ─────────────────────────────────────────────────────────────────────────
// Action shapes + result type
// ─────────────────────────────────────────────────────────────────────────

const UploadInput = z.object({
  reconId: z.string().uuid(),
});

const DeleteInput = z.object({
  reconId: z.string().uuid(),
  attachmentId: z.string().uuid(),
});

export type AttachmentResult =
  | { ok: true; attachmentId?: string }
  | { ok: false; code: string; error: string };

function fail(code: string, error: string): AttachmentResult {
  return { ok: false, code, error };
}

// ─────────────────────────────────────────────────────────────────────────
// uploadAttachment
//
// Server Action — invoked from the detail page's <form action={...}>
// or from a `useTransition` + manual FormData submission. Accepts the
// raw FormData rather than a parsed object so the File survives the
// React-side hydration boundary intact.
// ─────────────────────────────────────────────────────────────────────────
export async function uploadAttachment(
  formData: FormData
): Promise<AttachmentResult> {
  const parsed = UploadInput.safeParse({
    reconId: formData.get("reconId"),
  });
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      parsed.error.errors[0]?.message ?? "Invalid input"
    );
  }
  const { reconId } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  // The file. React stuffs File objects directly into FormData on
  // submit; we just need to verify the cast.
  const file = formData.get("file");
  if (!file || typeof file === "string" || !(file instanceof Blob)) {
    return fail("NO_FILE", "No file uploaded");
  }

  // Content-type + size validation BEFORE we read bytes into memory.
  // Reading bytes is the only line item that scales with file size; a
  // misclick on a 500 MB video shouldn't OOM the server.
  const contentType = file.type;
  if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
    return fail(
      "INVALID_TYPE",
      `Content type "${contentType}" not allowed. Use ${ATTACHMENT_ACCEPT_HINT}.`
    );
  }
  // file.size is the Blob spec property; it's set by the browser before
  // the upload begins, so we can short-circuit big uploads at validation.
  if (file.size === 0) {
    return fail("EMPTY_FILE", "File is empty");
  }
  if (file.size > MAX_ATTACHMENT_BYTES) {
    return fail(
      "TOO_LARGE",
      `File is ${(file.size / 1024 / 1024).toFixed(1)} MB; limit is 10 MB`
    );
  }

  // Tenant-scope the parent reconciliation. NOT_FOUND on cross-tenant
  // probes so existence doesn't leak.
  const recon = await prisma.reconciliation.findFirst({
    where: { id: reconId, tenantId: tenant.id },
    select: { id: true, accountId: true, periodId: true },
  });
  if (!recon) {
    return fail("NOT_FOUND", "Reconciliation not found in this tenant");
  }

  // Filename from the File (browser-provided). Sanitize for safety; the
  // user sees the same name we store.
  const filename = sanitizeFilename(
    file instanceof File ? file.name : "attachment"
  );

  // Read the bytes. This is the memory-hungry step; the size guard
  // above caps it at 10 MiB so we can keep this in-process without
  // streaming infrastructure.
  const bytes = Buffer.from(await file.arrayBuffer());

  const created = await prisma.reconciliationAttachment.create({
    data: {
      tenantId: tenant.id,
      reconciliationId: recon.id,
      filename,
      contentType,
      payload: bytes,
      sizeBytes: bytes.length,
      uploadedById: user.id,
    },
    select: { id: true },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.attachment.upload",
    resource: "ReconciliationAttachment",
    resourceId: created.id,
    tenantId: tenant.id,
    metadata: {
      reconciliationId: recon.id,
      filename,
      contentType,
      sizeBytes: bytes.length,
    },
  });

  revalidatePath(`/close/reconciliations/${reconId}`);

  return { ok: true, attachmentId: created.id };
}

// ─────────────────────────────────────────────────────────────────────────
// deleteAttachment
//
// Removes a single attachment. Authorized for the uploader OR a tenant
// admin. The recon itself never deletes; this is just evidence cleanup
// (e.g. uploaded the wrong file, want to re-upload the correct one).
// ─────────────────────────────────────────────────────────────────────────
export async function deleteAttachment(
  input: z.infer<typeof DeleteInput>
): Promise<AttachmentResult> {
  const parsed = DeleteInput.safeParse(input);
  if (!parsed.success) {
    return fail(
      "VALIDATION_FAILED",
      parsed.error.errors[0]?.message ?? "Invalid input"
    );
  }
  const { reconId, attachmentId } = parsed.data;

  const user = await requireCurrentUser();
  const tenant = await requireCurrentTenant();

  // Tenant-scope both lookups in one go via the FK.
  const attachment = await prisma.reconciliationAttachment.findFirst({
    where: {
      id: attachmentId,
      tenantId: tenant.id,
      reconciliationId: reconId,
    },
    select: {
      id: true,
      filename: true,
      uploadedById: true,
      reconciliation: { select: { id: true, tenantId: true } },
    },
  });
  if (!attachment) {
    return fail("NOT_FOUND", "Attachment not found");
  }

  // Authorize: uploader OR admin. CPAs who upload the wrong file want
  // to clean it up themselves. Admins can clean up anyone's mistakes.
  const admin = isTenantAdmin(tenant);
  if (attachment.uploadedById !== user.id && !admin) {
    return fail(
      "FORBIDDEN",
      "Only the uploader or a tenant admin can delete this attachment"
    );
  }

  await prisma.reconciliationAttachment.delete({
    where: { id: attachmentId },
  });

  await auditPrivilegedAction({
    actor: { id: user.id, email: user.email },
    action: "recon.attachment.delete",
    resource: "ReconciliationAttachment",
    resourceId: attachmentId,
    tenantId: tenant.id,
    metadata: {
      reconciliationId: reconId,
      filename: attachment.filename,
      asAdmin: admin && attachment.uploadedById !== user.id,
    },
  });

  revalidatePath(`/close/reconciliations/${reconId}`);

  return { ok: true };
}
