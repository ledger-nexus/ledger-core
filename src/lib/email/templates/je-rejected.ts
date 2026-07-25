// "Your journal entry was rejected" email. Sent to the submitter when
// an admin rejects their entry, with the rejection reason so they
// know what to fix before resubmitting.

import { sendEmail, type SendEmailResult } from "../send";

export interface JeRejectedEmailInput {
  to: string;
  recipientName: string;
  rejectorName: string;
  entryNumber: string;
  tenantName: string;
  memo: string;
  /** Admin's reason — required by the lifecycle module. */
  reason: string;
  entryUrl: string;
  tenantId: string;
  entryId: string;
}

export async function sendJeRejectedEmail(
  input: JeRejectedEmailInput
): Promise<SendEmailResult> {
  const subject = `Rejected: ${input.entryNumber}`;

  const text = [
    `Hi ${input.recipientName},`,
    ``,
    `${input.rejectorName} rejected your journal entry ${input.entryNumber}:`,
    ``,
    `  ${input.memo}`,
    ``,
    `Reason:`,
    `  ${input.reason}`,
    ``,
    `View the entry to see the full lines + reason, then create a new entry with the fix:`,
    `${input.entryUrl}`,
    ``,
    `— The ${input.tenantName} workspace`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <h2 style="margin: 0 0 16px; font-size: 18px; color: #b91c1c;">
    Your journal entry needs a fix
  </h2>
  <p style="margin: 0 0 12px; font-size: 14px;">
    Hi ${escapeHtml(input.recipientName)},
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    <strong>${escapeHtml(input.rejectorName)}</strong> rejected
    <code style="background:#f1f5f9; padding:2px 6px; border-radius:4px; font-size: 13px;">${escapeHtml(input.entryNumber)}</code>
    with the following reason:
  </p>
  <blockquote style="margin: 12px 0; padding: 8px 12px; background: #fef2f2; border-left: 3px solid #fca5a5; font-size: 13px; color: #7f1d1d; white-space: pre-wrap;">
    ${escapeHtml(input.reason)}
  </blockquote>
  <p style="margin: 12px 0 4px; font-size: 12px; color: #64748b;">
    Original memo:
  </p>
  <blockquote style="margin: 0 0 12px; padding: 8px 12px; background: #f8fafc; border-left: 3px solid #cbd5e1; font-size: 13px; color: #475569;">
    ${escapeHtml(input.memo)}
  </blockquote>
  <p style="margin: 16px 0;">
    <a href="${input.entryUrl}" style="display: inline-block; background: #0f172a; color: #fff; padding: 10px 16px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500;">
      Review and resubmit
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
    template: "je_rejected",
    tenantId: input.tenantId,
    metadata: {
      entryId: input.entryId,
      entryNumber: input.entryNumber,
      rejectorName: input.rejectorName,
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
