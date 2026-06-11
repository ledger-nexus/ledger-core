// BlackLine arc — Phase 1 PR 5 integration tests.
//
// Drives the attachment lifecycle end-to-end:
//   - upload via Server Action (FormData → File → BYTEA)
//   - download via the auth-gated route (bytes + Content-Type + audit)
//   - delete by uploader (allowed) + by non-uploader (forbidden) +
//     by admin (allowed even though not uploader)
//   - content-type allowlist (HTML rejected)
//   - size limit (oversize rejected without DB write)
//   - cross-tenant isolation (other-tenant attachment → 404)

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { NextRequest } from "next/server";
import { PrismaClient } from "@prisma/client";

const mockCookieStore = new Map<string, { value: string }>();
vi.mock("next/headers", () => ({
  cookies: () => ({
    get: (name: string) => mockCookieStore.get(name),
    set: (
      opts: { name: string; value: string } | string,
      maybeValue?: string
    ) => {
      if (typeof opts === "string") {
        mockCookieStore.set(opts, { value: maybeValue ?? "" });
      } else {
        mockCookieStore.set(opts.name, { value: opts.value });
      }
    },
    delete: (name: string) => mockCookieStore.delete(name),
  }),
  headers: () => ({ get: () => null }),
}));
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

import { _internal as authInternal } from "@/lib/auth/current-user";
import {
  uploadAttachment,
  deleteAttachment,
  MAX_ATTACHMENT_BYTES,
} from "@/app/actions/recon-attachments";
import { GET as downloadGET } from "@/app/api/close/reconciliations/[id]/attachments/[attachmentId]/download/route";

const prisma = new PrismaClient();

const SUFFIX =
  "rcn5" + Date.now().toString(36) + Math.floor(Math.random() * 9999);

let tenant: { id: string; slug: string };
let otherTenant: { id: string; slug: string };
let uploaderUser: { id: string; email: string };
let adminUser: { id: string; email: string };
let outsideUser: { id: string; email: string };
let recon: { id: string };
let otherRecon: { id: string };

beforeAll(async () => {
  const seedUser = await prisma.user.findUnique({
    where: { email: "controller@northwind.test" },
    select: { id: true, email: true },
  });
  if (!seedUser) throw new Error("Run Northwind seed first.");
  uploaderUser = { id: seedUser.id, email: seedUser.email };

  // A second user for admin scenarios and a third for non-member rejection.
  const otherSeed = await prisma.user.findFirst({
    where: { email: { not: seedUser.email } },
    select: { id: true, email: true },
  });
  if (!otherSeed) throw new Error("Seed must have ≥2 users for attachment SoD tests.");
  adminUser = { id: otherSeed.id, email: otherSeed.email };

  // Make a third synthetic user to play the outsider role.
  const outside = await prisma.user.create({
    data: {
      email: `outsider-${SUFFIX}@test.local`,
      displayName: "Outsider",
      // The schema has more fields, but most are nullable; using only
      // what's required keeps this brittle-resistant.
    },
    select: { id: true, email: true },
  });
  outsideUser = { id: outside.id, email: outside.email };

  await prisma.currency.upsert({
    where: { code: "USD" },
    create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
    update: {},
  });

  // Main tenant: uploader as OWNER, admin as ADMIN.
  tenant = await prisma.tenant.create({
    data: {
      slug: `rcn5-${SUFFIX}`.slice(0, 60),
      name: "Recon Attachment Tenant",
      ownerUserId: uploaderUser.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: uploaderUser.id, role: "OWNER" },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: tenant.id, userId: adminUser.id, role: "ADMIN" },
  });

  // Second tenant for cross-tenant tests. Same uploader is the owner so
  // we can simulate "logged-in user clicks a sibling-tenant URL"
  // accidentally / maliciously and confirm NOT_FOUND.
  otherTenant = await prisma.tenant.create({
    data: {
      slug: `rcn5o-${SUFFIX}`.slice(0, 60),
      name: "Other Tenant",
      ownerUserId: uploaderUser.id,
    },
  });
  await prisma.tenantMembership.create({
    data: { tenantId: otherTenant.id, userId: uploaderUser.id, role: "OWNER" },
  });

  // Recon fixtures: one per tenant.
  async function mintRecon(tenantId: string): Promise<{ id: string }> {
    const entity = await prisma.legalEntity.create({
      data: {
        tenantId,
        code: `R5E-${SUFFIX}${tenantId.slice(0, 4)}`.slice(0, 50),
        name: "Recon Attach Entity",
        functionalCurrencyId: "USD",
      },
      select: { id: true },
    });
    const book = await prisma.book.findUnique({
      where: { code: "US_GAAP" },
      select: { id: true },
    });
    if (!book) throw new Error("Missing US_GAAP book");
    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId,
        entityId: entity.id,
        code: `R5C-${SUFFIX}${tenantId.slice(0, 4)}`.slice(0, 32),
        name: "Recon Cal",
        periodFrequency: "MONTHLY",
      },
    });
    const period = await prisma.period.create({
      data: {
        tenantId,
        calendarId: cal.id,
        code: `${SUFFIX.slice(0, 6)}-${tenantId.slice(0, 2)}`,
        ordinal: 1,
        startsOn: new Date("2026-06-01"),
        endsOn: new Date("2026-06-30"),
      },
      select: { id: true },
    });
    const acct = await prisma.account.create({
      data: {
        tenantId,
        code: `R5A-${SUFFIX}${tenantId.slice(0, 4)}`.slice(0, 20),
        name: "Recon Attach Acct",
        type: "ASSET",
        normalBalance: "DEBIT",
      },
      select: { id: true },
    });
    return prisma.reconciliation.create({
      data: {
        tenantId,
        entityId: entity.id,
        bookId: book.id,
        periodId: period.id,
        accountId: acct.id,
        glBalance: "100.00" as never,
        tolerance: "0.50" as never,
        status: "OPEN",
        requiresReview: true,
      },
      select: { id: true },
    });
  }
  recon = await mintRecon(tenant.id);
  otherRecon = await mintRecon(otherTenant.id);
});

afterAll(async () => {
  await prisma.reconciliationAttachment.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.reconciliation.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.account.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.period.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.fiscalCalendar.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.legalEntity.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  await prisma.tenantMembership.deleteMany({
    where: { tenantId: { in: [tenant.id, otherTenant.id] } },
  });
  try {
    await prisma.tenant.delete({ where: { id: tenant.id } });
  } catch {
    /* audit_log FK — known append-only constraint */
  }
  try {
    await prisma.tenant.delete({ where: { id: otherTenant.id } });
  } catch {
    /* audit_log FK */
  }
  // Synthetic user.
  try {
    await prisma.user.delete({ where: { id: outsideUser.id } });
  } catch {
    /* may be pinned by FKs */
  }
  await prisma.$disconnect();
});

function signInAs(u: { id: string }, t: { slug: string }) {
  mockCookieStore.clear();
  mockCookieStore.set("lc-user", { value: authInternal.encode(u.id) });
  mockCookieStore.set("lc-tenant", { value: t.slug });
}

function makeForm(opts: {
  reconId: string;
  filename: string;
  contentType: string;
  bytes: Buffer;
}): FormData {
  const fd = new FormData();
  fd.set("reconId", opts.reconId);
  // Convert Buffer → Uint8Array so the File constructor's BlobPart
  // overload accepts it without the SharedArrayBuffer disagreement.
  const view = new Uint8Array(opts.bytes);
  const file = new File([view], opts.filename, {
    type: opts.contentType,
  });
  fd.set("file", file);
  return fd;
}

describe("recon attachment lifecycle", () => {
  it("uploader can upload, download round-trips the bytes, audit row written", async () => {
    signInAs(uploaderUser, tenant);

    const original = Buffer.from("%PDF-1.4 fake-bank-statement-bytes");
    const r = await uploadAttachment(
      makeForm({
        reconId: recon.id,
        filename: "bank-stmt.pdf",
        contentType: "application/pdf",
        bytes: original,
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("upload failed");
    const attachmentId = r.attachmentId!;

    // Confirm DB row.
    const row = await prisma.reconciliationAttachment.findUnique({
      where: { id: attachmentId },
      select: {
        filename: true,
        contentType: true,
        sizeBytes: true,
        tenantId: true,
        uploadedById: true,
      },
    });
    expect(row).not.toBeNull();
    expect(row!.tenantId).toBe(tenant.id);
    expect(row!.uploadedById).toBe(uploaderUser.id);
    expect(row!.filename).toBe("bank-stmt.pdf");
    expect(row!.contentType).toBe("application/pdf");
    expect(row!.sizeBytes).toBe(original.length);

    // Upload writes a PRIVILEGED_ACTION audit row.
    const auditRow = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        resource: "ReconciliationAttachment",
        resourceId: attachmentId,
        action: "recon.attachment.upload",
      },
      select: { metadata: true },
    });
    expect(auditRow).not.toBeNull();
    const uploadMeta = auditRow!.metadata as Record<string, unknown>;
    expect(uploadMeta.filename).toBe("bank-stmt.pdf");
    expect(uploadMeta.sizeBytes).toBe(original.length);

    // Download round-trips through the route handler.
    const dlReq = new NextRequest(
      `http://localhost/api/close/reconciliations/${recon.id}/attachments/${attachmentId}/download`
    );
    const dlRes = await downloadGET(dlReq, {
      params: { id: recon.id, attachmentId },
    });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers.get("Content-Type")).toBe("application/pdf");
    expect(dlRes.headers.get("Content-Disposition")).toContain(
      'filename="bank-stmt.pdf"'
    );
    const downloaded = Buffer.from(await dlRes.arrayBuffer());
    expect(downloaded.equals(original)).toBe(true);

    // Download writes a DATA_EXPORT audit row.
    const dlAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        eventType: "DATA_EXPORT",
        resource: "ReconciliationAttachment",
        resourceId: attachmentId,
      },
    });
    expect(dlAudit).not.toBeNull();
  });

  it("rejects content type not on the allowlist", async () => {
    signInAs(uploaderUser, tenant);
    const r = await uploadAttachment(
      makeForm({
        reconId: recon.id,
        filename: "evil.html",
        contentType: "text/html",
        bytes: Buffer.from("<script>alert(1)</script>"),
      })
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should reject");
    expect(r.code).toBe("INVALID_TYPE");
    // No DB row.
    const rows = await prisma.reconciliationAttachment.count({
      where: { tenantId: tenant.id, filename: "evil.html" },
    });
    expect(rows).toBe(0);
  });

  it("rejects oversized files", async () => {
    signInAs(uploaderUser, tenant);
    // Synthesize an oversized buffer. The check is `file.size`, which
    // we set via Blob ctor — no need to actually allocate 11 MiB.
    const fd = new FormData();
    fd.set("reconId", recon.id);
    // Allocate a Buffer at the boundary + 1 byte; the route sees this
    // via file.size. Keeping it tight to avoid OOM in CI.
    // Use a Uint8Array (not Buffer) — Node 22's File constructor
    // disagrees with TS's BlobPart on Buffer<SharedArrayBuffer>.
    const oversize = new Uint8Array(MAX_ATTACHMENT_BYTES + 1);
    const file = new File([oversize], "huge.pdf", {
      type: "application/pdf",
    });
    fd.set("file", file);
    const r = await uploadAttachment(fd);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("should reject");
    expect(r.code).toBe("TOO_LARGE");
  });

  it("cross-tenant attachment access returns NOT_FOUND on download", async () => {
    // Upload to otherTenant as the uploader (who owns it).
    signInAs(uploaderUser, otherTenant);
    const r = await uploadAttachment(
      makeForm({
        reconId: otherRecon.id,
        filename: "other.pdf",
        contentType: "application/pdf",
        bytes: Buffer.from("other-tenant-bytes"),
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("upload failed");
    const otherAttachmentId = r.attachmentId!;

    // Switch to main tenant context; attempt download of the
    // other-tenant attachment. Route MUST return 404 — no existence leak.
    signInAs(uploaderUser, tenant);
    const dlReq = new NextRequest(
      `http://localhost/api/close/reconciliations/${otherRecon.id}/attachments/${otherAttachmentId}/download`
    );
    const dlRes = await downloadGET(dlReq, {
      params: { id: otherRecon.id, attachmentId: otherAttachmentId },
    });
    expect(dlRes.status).toBe(404);
  });

  it("non-uploader non-admin cannot delete; admin can; uploader can", async () => {
    // Fresh attachment to delete.
    signInAs(uploaderUser, tenant);
    const r = await uploadAttachment(
      makeForm({
        reconId: recon.id,
        filename: "to-delete.pdf",
        contentType: "application/pdf",
        bytes: Buffer.from("delete-me"),
      })
    );
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error("upload failed");
    const attachmentId = r.attachmentId!;

    // Outsider has no membership in this tenant → cookie-tenant
    // mismatch → requireCurrentTenant rejects. Plumb the outsider
    // through the same lc-user cookie BUT without the tenant
    // membership; the action throws which becomes a Next.js error
    // boundary in real use. We assert it throws here.
    signInAs(outsideUser, tenant);
    await expect(
      deleteAttachment({ reconId: recon.id, attachmentId })
    ).rejects.toThrow();

    // Admin can delete (different user than uploader).
    signInAs(adminUser, tenant);
    const adminDelete = await deleteAttachment({
      reconId: recon.id,
      attachmentId,
    });
    expect(adminDelete.ok).toBe(true);

    // Row is gone.
    const gone = await prisma.reconciliationAttachment.findUnique({
      where: { id: attachmentId },
    });
    expect(gone).toBeNull();

    // Audit row written with asAdmin: true.
    const adminAudit = await prisma.auditLog.findFirst({
      where: {
        tenantId: tenant.id,
        resource: "ReconciliationAttachment",
        resourceId: attachmentId,
        action: "recon.attachment.delete",
      },
      select: { metadata: true },
    });
    expect(adminAudit).not.toBeNull();
    const meta = adminAudit!.metadata as Record<string, unknown>;
    expect(meta.asAdmin).toBe(true);

    // Uploader can delete their own row too. New upload to prove it.
    signInAs(uploaderUser, tenant);
    const r2 = await uploadAttachment(
      makeForm({
        reconId: recon.id,
        filename: "owner-delete.pdf",
        contentType: "application/pdf",
        bytes: Buffer.from("owner-bytes"),
      })
    );
    if (!r2.ok) throw new Error("upload failed");
    const ownerOwnedId = r2.attachmentId!;
    const ownerDelete = await deleteAttachment({
      reconId: recon.id,
      attachmentId: ownerOwnedId,
    });
    expect(ownerDelete.ok).toBe(true);
  });
});
