// "Ownership transfer cancelled" email. Sent to the OTHER party when
// one side cancels a pending transfer. Two flavors keyed by who acted:
//   - OWNER cancels → recipient is the target ("offer withdrawn")
//   - TARGET declines → recipient is the OWNER ("offer declined")

import { sendEmail, type SendEmailResult } from "../send";

export type OwnerTransferCancelledDirection = "OWNER" | "TARGET";

export interface OwnerTransferCancelledEmailInput {
  to: string;
  /** Display name of the recipient (the OTHER party). */
  recipientName: string;
  /** Display name of whoever clicked cancel/decline. */
  cancellerName: string;
  /** Who clicked — OWNER (withdrew offer) or TARGET (declined). */
  cancelledBy: OwnerTransferCancelledDirection;
  /** Tenant name for the subject + body. */
  tenantName: string;
  /** Permalink to /admin/team. */
  teamUrl: string;
  tenantId: string;
}

export async function sendOwnerTransferCancelledEmail(
  input: OwnerTransferCancelledEmailInput
): Promise<SendEmailResult> {
  const wasWithdrawn = input.cancelledBy === "OWNER";
  const subject = wasWithdrawn
    ? `Ownership offer for ${input.tenantName} withdrawn`
    : `Ownership offer for ${input.tenantName} declined`;

  const lead = wasWithdrawn
    ? `${input.cancellerName} cancelled the offer to transfer ownership of the ${input.tenantName} workspace to you.`
    : `${input.cancellerName} declined the offer to take over ownership of the ${input.tenantName} workspace.`;

  const followup = wasWithdrawn
    ? `No change to your role. You remain a member as before.`
    : `No change to your role. You remain the OWNER of this workspace. You can re-offer the transfer at any time.`;

  const text = [
    `Hi ${input.recipientName},`,
    ``,
    lead,
    ``,
    followup,
    ``,
    `Workspace admin:`,
    `${input.teamUrl}`,
    ``,
    `— The ${input.tenantName} workspace`,
  ].join("\n");

  const html = `<!DOCTYPE html>
<html><body style="font-family: -apple-system, system-ui, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #0f172a;">
  <h2 style="margin: 0 0 16px; font-size: 18px; color: #0f172a;">
    ${wasWithdrawn ? "Ownership offer withdrawn" : "Ownership offer declined"}
  </h2>
  <p style="margin: 0 0 12px; font-size: 14px;">
    Hi ${escapeHtml(input.recipientName)},
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    ${escapeHtml(lead)}
  </p>
  <p style="margin: 0 0 12px; font-size: 14px;">
    ${escapeHtml(followup)}
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
    template: wasWithdrawn ? "owner_transfer_withdrawn" : "owner_transfer_declined",
    tenantId: input.tenantId,
    metadata: {
      cancellerName: input.cancellerName,
      cancelledBy: input.cancelledBy,
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
