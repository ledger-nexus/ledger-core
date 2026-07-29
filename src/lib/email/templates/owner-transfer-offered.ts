// "Ownership transfer offered" email. Sent to the TARGET user when
// the current OWNER initiates a hand-off offer.

import { sendEmail, type SendEmailResult } from "../send";

export interface OwnerTransferOfferedEmailInput {
  to: string;
  /** Display name of the recipient (offered the transfer). */
  recipientName: string;
  /** Display name of the current OWNER who initiated. */
  initiatorName: string;
  /** Tenant name for the subject + body. */
  tenantName: string;
  /** Permalink to /admin/team where the recipient accepts/declines. */
  teamUrl: string;
  // Internal: for audit attribution.
  tenantId: string;
}

export async function sendOwnerTransferOfferedEmail(
  input: OwnerTransferOfferedEmailInput
): Promise<SendEmailResult> {
  const subject = `Ownership of ${input.tenantName} offered to you`;

  const text = [
    `Hi ${input.recipientName},`,
    ``,
    `${input.initiatorName} has offered to transfer ownership of the ${input.tenantName} workspace to you.`,
    ``,
    `If you accept, you become the OWNER of this workspace and ${input.initiatorName} is demoted to ADMIN. If you decline, ownership stays where it is. You can also leave the offer pending.`,
    ``,
    `Review the offer at:`,
    `${input.teamUrl}`,
    ``,
    `— The ${input.tenantName} workspace`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <h2 style="margin: 0 0 16px; font-size: 18px; color: #0f172a;">
    Ownership offered to you
  </h2>
  <p style="margin: 0 0 12px; font-size: 14px;">
    Hi ${escapeHtml(input.recipientName)},
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    <strong>${escapeHtml(input.initiatorName)}</strong> has offered to transfer ownership of
    <strong>${escapeHtml(input.tenantName)}</strong> to you.
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    If you accept, you become OWNER and ${escapeHtml(input.initiatorName)} is demoted to ADMIN.
    If you decline, ownership stays where it is.
  </p>
  <p style="margin: 16px 0;">
    <a href="${input.teamUrl}" style="display: inline-block; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
      Review the offer
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
    template: "owner_transfer_offered",
    tenantId: input.tenantId,
    metadata: {
      initiatorName: input.initiatorName,
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
