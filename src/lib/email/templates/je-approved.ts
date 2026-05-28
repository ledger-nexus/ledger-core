// "Your journal entry was approved" email. Sent to the submitter after
// an admin approves their entry.

import { sendEmail, type SendEmailResult } from "../send";

export interface JeApprovedEmailInput {
  to: string;
  /** Display name of the submitter (for the greeting). */
  recipientName: string;
  /** Display name of the admin who approved. */
  approverName: string;
  entryNumber: string;
  /** Tenant name for the subject line. */
  tenantName: string;
  /** Free-text memo from the entry. */
  memo: string;
  /** Permalink to the entry detail. */
  entryUrl: string;
  // Internal: for audit attribution.
  tenantId: string;
  entryId: string;
}

export async function sendJeApprovedEmail(
  input: JeApprovedEmailInput
): Promise<SendEmailResult> {
  const subject = `Approved: ${input.entryNumber}`;

  const text = [
    `Hi ${input.recipientName},`,
    ``,
    `${input.approverName} approved your journal entry ${input.entryNumber}:`,
    ``,
    `  ${input.memo}`,
    ``,
    `The entry is now posted to the ledger. View it here:`,
    `${input.entryUrl}`,
    ``,
    `— The ${input.tenantName} workspace`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <h2 style="margin: 0 0 16px; font-size: 18px; color: #047857;">
    Your journal entry was approved
  </h2>
  <p style="margin: 0 0 12px; font-size: 14px;">
    Hi ${escapeHtml(input.recipientName)},
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    <strong>${escapeHtml(input.approverName)}</strong> approved
    <code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size: 13px;">${escapeHtml(input.entryNumber)}</code>.
    It&rsquo;s now posted to the ledger.
  </p>
  <blockquote style="margin: 12px 0; padding: 8px 12px; background: #f8fafc; border-left: 3px solid #cbd5e1; font-size: 13px; color: #475569;">
    ${escapeHtml(input.memo)}
  </blockquote>
  <p style="margin: 16px 0;">
    <a href="${input.entryUrl}" style="display: inline-block; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
      View entry
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
    template: "je_approved",
    tenantId: input.tenantId,
    metadata: {
      entryId: input.entryId,
      entryNumber: input.entryNumber,
      approverName: input.approverName,
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
