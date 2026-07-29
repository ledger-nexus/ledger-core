// "Your ownership transfer was accepted" email. Sent to the PREVIOUS
// OWNER (now ADMIN) after the target accepts the offer.

import { sendEmail, type SendEmailResult } from "../send";

export interface OwnerTransferAcceptedEmailInput {
  to: string;
  /** Display name of the previous OWNER (now ADMIN). */
  recipientName: string;
  /** Display name of the new OWNER who accepted. */
  accepterName: string;
  /** Tenant name for the subject + body. */
  tenantName: string;
  /** Permalink to /admin/team. */
  teamUrl: string;
  tenantId: string;
}

export async function sendOwnerTransferAcceptedEmail(
  input: OwnerTransferAcceptedEmailInput
): Promise<SendEmailResult> {
  const subject = `Ownership of ${input.tenantName} transferred to ${input.accepterName}`;

  const text = [
    `Hi ${input.recipientName},`,
    ``,
    `${input.accepterName} accepted the ownership transfer of the ${input.tenantName} workspace.`,
    ``,
    `You are now an ADMIN on this workspace. You retain all member-management and approval permissions; only owner-only actions (workspace deletion, billing changes, ownership transfer) are no longer available to you.`,
    ``,
    `Workspace admin:`,
    `${input.teamUrl}`,
    ``,
    `— The ${input.tenantName} workspace`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <h2 style="margin: 0 0 16px; font-size: 18px; color: #0f172a;">
    Ownership transferred
  </h2>
  <p style="margin: 0 0 12px; font-size: 14px;">
    Hi ${escapeHtml(input.recipientName)},
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    <strong>${escapeHtml(input.accepterName)}</strong> accepted the ownership transfer of
    <strong>${escapeHtml(input.tenantName)}</strong>.
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    You are now an ADMIN on this workspace. You keep all member-management
    and approval permissions; only owner-only actions (workspace deletion,
    billing, ownership transfer) are no longer available to you.
  </p>
  <p style="margin: 16px 0;">
    <a href="${input.teamUrl}" style="display: inline-block; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
      Open workspace admin
    </a>
  </p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
  <p style="margin: 0; font-size: 11px; color: #94a3b8;">
    From the ${escapeHtml(input.tenantName)} workspace
  </p>
</body></html>`;

  return sendEmail({
    to: input.to,
    subject,
    text,
    html,
    template: "owner_transfer_accepted",
    tenantId: input.tenantId,
    metadata: {
      accepterName: input.accepterName,
    },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
