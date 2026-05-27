// Invite-by-email template. Plain text + minimal HTML.
//
// The HTML is intentionally simple — no images, no external CSS, no
// complex layout — so it renders identically across Gmail / Outlook /
// Apple Mail without preview-rendering headaches. Plain text is the
// source of truth; HTML is a styled twin.

import { sendEmail, type SendEmailResult } from "../send";

export interface InviteEmailInput {
  to: string;
  /** Workspace name shown in the invitation. */
  tenantName: string;
  /** Display name of the user who sent the invite. */
  inviterName: string;
  /** Role being granted on acceptance. */
  role: string;
  /** Single-use accept URL. */
  acceptUrl: string;
  /** When the invite expires. */
  expiresAt: Date;
  // Internal: for audit + future tenant-scoped views of email log.
  tenantId: string;
  inviteId: string;
}

export async function sendInviteEmail(
  input: InviteEmailInput
): Promise<SendEmailResult> {
  const subject = `${input.inviterName} invited you to ${input.tenantName} on ledger-nexus`;
  const expiresLine = `This invite expires on ${input.expiresAt.toISOString().slice(0, 10)} (UTC).`;

  const text = [
    `Hi,`,
    ``,
    `${input.inviterName} has invited you to join the ${input.tenantName} workspace on ledger-nexus as ${input.role}.`,
    ``,
    `Accept the invitation by following this link:`,
    `${input.acceptUrl}`,
    ``,
    expiresLine,
    ``,
    `If you weren't expecting this email, you can safely ignore it — no account is created until you click the link.`,
    ``,
    `— The ledger-nexus team`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <h2 style="margin: 0 0 16px; font-size: 18px;">You're invited to a ledger-nexus workspace</h2>
  <p style="margin: 0 0 12px; font-size: 14px;">
    <strong>${escapeHtml(input.inviterName)}</strong> has invited you to join
    <strong>${escapeHtml(input.tenantName)}</strong> as
    <code style="background:#f1f5f9; padding:2px 6px; border-radius:4px;">${escapeHtml(input.role)}</code>.
  </p>
  <p style="margin: 16px 0;">
    <a href="${input.acceptUrl}" style="display: inline-block; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
      Accept invitation
    </a>
  </p>
  <p style="margin: 0 0 8px; font-size: 12px; color: #64748b;">${escapeHtml(expiresLine)}</p>
  <p style="margin: 0 0 12px; font-size: 12px; color: #64748b;">
    If you weren't expecting this email, you can safely ignore it — no account is created until you click the link.
  </p>
  <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 16px 0;" />
  <p style="margin: 0; font-size: 11px; color: #94a3b8;">
    Or paste this URL into your browser:<br/>
    <span style="word-break: break-all;">${escapeHtml(input.acceptUrl)}</span>
  </p>
</body></html>`;

  return sendEmail({
    to: input.to,
    subject,
    text,
    html,
    template: "tenant_invite",
    tenantId: input.tenantId,
    metadata: {
      inviteId: input.inviteId,
      role: input.role,
      inviterName: input.inviterName,
      tenantName: input.tenantName,
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
