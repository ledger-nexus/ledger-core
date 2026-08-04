// Transactional email infrastructure.
//
// Single seam: sendEmail({to, subject, text, html, template, tenantId,
// metadata}). Two backends, chosen at runtime:
//
//   - Resend (when RESEND_API_KEY is set) — POSTs to api.resend.com.
//     The `from` address is EMAIL_FROM_ADDRESS env (must be a verified
//     sender on the Resend domain).
//   - Logged-only (when no key) — writes the EmailDelivery row with
//     LOGGED_ONLY status. Useful in dev and during the gap between
//     deploy and email-domain verification.
//
// Both paths persist an EmailDelivery row so the operator can answer
// "did this customer get their email?" from the delivery log. Failures
// from the provider go in with status FAILED + the provider's error
// message preserved on the row.
//
// Failure isolation: this module NEVER throws to its caller. Email is
// audit-visible failure-OK; a Resend outage should not break invite
// creation. Callers can inspect the returned `result.status`.
//
// Confidentiality: recipient, subject, and bodies are encrypted at rest
// by the encrypted-fields extension (see ENCRYPTED_COLUMNS), and are
// NEVER written to stdout — email bodies carry invite tokens and
// people's names, and the LOGGED_ONLY console line identifies the
// delivery by row id + template only. Read the body from the row.
//
// Templates live in ./templates/ (arriving with their consuming slices)
// and produce {subject, text, html} triples from typed inputs. The send
// function is template-agnostic.

import { prisma } from "@/lib/db";
import type { EmailDeliveryStatus } from "@prisma/client";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 5000;

export interface SendEmailInput {
  to: string;
  subject: string;
  text: string;
  html?: string;
  /** Stable identifier — "tenant_invite", "je_approved", etc. */
  template: string;
  /** Tenant on whose behalf this is sent. Null for platform emails. */
  tenantId?: string | null;
  /** Template-specific payload for audit + future replay. */
  metadata?: Record<string, unknown>;
}

export interface SendEmailResult {
  ok: boolean;
  deliveryId: string;
  status: EmailDeliveryStatus;
  providerId?: string | null;
  errorMessage?: string | null;
}

function fromAddress(): string {
  // No fallback — if Resend is configured but EMAIL_FROM_ADDRESS isn't,
  // every send fails. We surface that on the delivery row's error
  // message rather than silently substituting a sender.
  return process.env.EMAIL_FROM_ADDRESS || "";
}

export async function sendEmail(input: SendEmailInput): Promise<SendEmailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = fromAddress();

  // No key → log-only path. Persist the row, return success-ish so the
  // caller keeps going. The console line deliberately omits recipient,
  // subject, and body — the row holds them (encrypted at rest).
  if (!apiKey) {
    const row = await persistDelivery({
      ...input,
      status: "LOGGED_ONLY",
    });
    console.log(
      `[email] LOGGED_ONLY template=${input.template} deliveryId=${row.id}`
    );
    return { ok: true, deliveryId: row.id, status: "LOGGED_ONLY" };
  }

  if (!from) {
    const row = await persistDelivery({
      ...input,
      status: "FAILED",
      errorMessage:
        "EMAIL_FROM_ADDRESS env var is not set; Resend requires a verified from-address.",
    });
    return {
      ok: false,
      deliveryId: row.id,
      status: "FAILED",
      errorMessage: "EMAIL_FROM_ADDRESS env var unset",
    };
  }

  // Resend POST. 5s timeout. Non-2xx responses are FAILED, not throws.
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        from,
        to: [input.to],
        subject: input.subject,
        text: input.text,
        ...(input.html ? { html: input.html } : {}),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      // Provider error bodies can echo the recipient — stored on the
      // row for diagnosis, never logged.
      const errBody = await res.text().catch(() => "<unreadable>");
      const row = await persistDelivery({
        ...input,
        status: "FAILED",
        errorMessage: `Resend ${res.status}: ${errBody.slice(0, 500)}`,
      });
      return {
        ok: false,
        deliveryId: row.id,
        status: "FAILED",
        errorMessage: row.errorMessage,
      };
    }

    const body = (await res.json().catch(() => ({}))) as { id?: string };
    const row = await persistDelivery({
      ...input,
      status: "DELIVERED",
      providerId: body.id ?? null,
    });
    return {
      ok: true,
      deliveryId: row.id,
      status: "DELIVERED",
      providerId: row.providerId,
    };
  } catch (e) {
    const row = await persistDelivery({
      ...input,
      status: "FAILED",
      errorMessage:
        e instanceof Error ? e.message : "Unknown email send failure",
    });
    return {
      ok: false,
      deliveryId: row.id,
      status: "FAILED",
      errorMessage: row.errorMessage,
    };
  }
}

interface PersistInput extends SendEmailInput {
  status: EmailDeliveryStatus;
  providerId?: string | null;
  errorMessage?: string | null;
}

async function persistDelivery(input: PersistInput): Promise<{
  id: string;
  providerId: string | null;
  errorMessage: string | null;
}> {
  // toEmail/subject/bodies encrypt (and toEmailHash populates) inside
  // the extension — no crypto here. Omitting metadata leaves the
  // column NULL rather than JSON-null.
  return prisma.emailDelivery.create({
    data: {
      tenantId: input.tenantId ?? null,
      toEmail: input.to,
      template: input.template,
      subject: input.subject,
      bodyText: input.text,
      bodyHtml: input.html ?? null,
      status: input.status,
      providerId: input.providerId ?? null,
      errorMessage: input.errorMessage ?? null,
      ...(input.metadata ? { metadata: input.metadata as object } : {}),
    },
    select: { id: true, providerId: true, errorMessage: true },
  });
}
