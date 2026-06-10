// GET /api/close/reconciliations/[id]/attachments/[attachmentId]/download
//
// BlackLine arc — Phase 1 PR 5 sibling. Streams a single attachment's
// bytes through an auth-gated endpoint.
//
// Why an API route instead of public storage URL: the bytes live in
// Postgres BYTEA (not S3), and the row's tenantId is the access
// control boundary. A signed-storage URL would skip auth. Every
// download writes a DATA_EXPORT audit row so the auditor sees a per-
// pull trail with actor + IP + UA + attachment metadata.
//
// Content-Type comes from the column (allowlist-validated at upload
// time), so this endpoint can't be tricked into serving HTML/SVG as
// "PDF" — the validator already rejected those at upload.
//
// Content-Disposition is `attachment; filename="..."` so the browser
// downloads the file rather than rendering it inline — additional
// defense against a stored-XSS attempt that slipped past the upload
// allowlist.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { auditDataExport } from "@/lib/audit/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: { id: string; attachmentId: string } }
): Promise<NextResponse> {
  // CC6.3 authorization. No anonymous downloads — bank statements
  // and payroll exports are sensitive.
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  if (!user || !tenant) {
    return new NextResponse("Sign in required", { status: 403 });
  }

  // CC6.1 multi-tenant: the where clause ties tenantId AND
  // reconciliationId AND attachmentId together. Any one mismatching
  // → NOT_FOUND (no leak via existence).
  const attachment = await prisma.reconciliationAttachment.findFirst({
    where: {
      id: params.attachmentId,
      tenantId: tenant.id,
      reconciliationId: params.id,
    },
    select: {
      filename: true,
      contentType: true,
      payload: true,
      sizeBytes: true,
    },
  });

  if (!attachment) {
    return new NextResponse("Not found", { status: 404 });
  }

  // CC7.2 audit. Every byte stream out of the system writes a row so
  // the auditor can pivot on "who downloaded what when" later.
  await auditDataExport({
    actor: { id: user.id, email: user.email },
    format: attachment.contentType.split("/")[1] ?? "bin",
    resource: "ReconciliationAttachment",
    resourceId: params.attachmentId,
    rowCount: 1,
    tenantId: tenant.id,
    requestHeaders: {
      ip: req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? null,
      userAgent: req.headers.get("user-agent"),
    },
  });

  // The filename goes inside double-quotes per RFC 6266. We URL-encode
  // any embedded quotes via the safer-than-percent-encoding-quotes-
  // in-Content-Disposition path: replace `"` with `\"`. Filenames
  // were already sanitized at upload (no path separators), so the
  // remaining attack surface is the quote-injection lane.
  const dispoFilename = attachment.filename.replace(/"/g, '\\"');

  return new NextResponse(new Uint8Array(attachment.payload), {
    headers: {
      "Content-Type": attachment.contentType,
      "Content-Length": String(attachment.sizeBytes),
      "Content-Disposition": `attachment; filename="${dispoFilename}"`,
      // No-cache: each download is auth-gated + audit-logged. Caching
      // would let a logged-out browser replay the file.
      "Cache-Control": "private, no-store",
    },
  });
}
