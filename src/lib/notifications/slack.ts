// Slack message sender + payload formatter.
//
// Talks to incoming-webhook URLs only (the simpler of the two Slack
// auth modes). The URL itself acts as the bearer token; whoever has
// it can post. We keep the URL encrypted at rest (see crypto.ts).
//
// Format: Slack Block Kit JSON. We use the simpler text + section
// layout rather than Block Kit's full power because:
//   - Close alerts have a uniform shape (severity, pillar, title,
//     description, ageDays, href)
//   - Operators want a glanceable feed, not an interactive UI
//   - One alert = one section block keeps the message focused
//
// Retry: NOT IMPLEMENTED in v1. Slack incoming webhooks are
// best-effort and the failure mode is "alert eventually surfaces in
// the next dispatch cycle." For a richer story (exponential backoff,
// 429 handling, persistent retry queue) the cron route can be
// extended.
//
// Timeout: 5s hard cap on the fetch. Slack typically responds in
// <500ms; anything longer suggests connectivity issues we don't want
// blocking the dispatch loop.

import type { CloseAlert, AlertSeverity } from "@/lib/close/alerts";

const SLACK_TIMEOUT_MS = 5000;

const SEVERITY_EMOJI: Record<AlertSeverity, string> = {
  high: "🔴",
  medium: "🟠",
  low: "🟡",
};

const SEVERITY_COLOR: Record<AlertSeverity, string> = {
  high: "#dc2626", // red-600
  medium: "#f59e0b", // amber-500
  low: "#facc15", // yellow-400
};

/**
 * Builds a Slack Block Kit payload for one alert. Each alert renders
 * as: emoji + severity + pillar header line, then title + age, then
 * description. The href is rendered as a Slack link in the action
 * button — clicking takes the operator straight to the gap page.
 */
export function formatSlackBlocks(
  alert: CloseAlert,
  context: {
    appBaseUrl: string;
    entity: string;
    book: string;
    period: string;
  }
): Record<string, unknown> {
  const ageLabel =
    alert.ageDays === 0
      ? "today"
      : alert.ageDays === 1
        ? "1 day ago"
        : `${alert.ageDays} days ago`;
  return {
    // Slack falls back to `text` when blocks render fails (e.g. in
    // notification previews or non-Block-Kit clients). Keep it
    // self-contained so the alert is readable without rich rendering.
    text: `${SEVERITY_EMOJI[alert.severity]} *${alert.severity.toUpperCase()} ${alert.pillar.toUpperCase()}* — ${alert.title}`,
    attachments: [
      {
        color: SEVERITY_COLOR[alert.severity],
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `${SEVERITY_EMOJI[alert.severity]} *${alert.severity.toUpperCase()}* · *${alert.pillar.toUpperCase()}* · ${ageLabel}\n*${alert.title}*\n${alert.description}`,
            },
          },
          {
            type: "context",
            elements: [
              {
                type: "mrkdwn",
                text: `Scope: \`${context.entity}\` · \`${context.book}\` · Period \`${context.period}\``,
              },
            ],
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "Open" },
                url: `${context.appBaseUrl}${alert.href}`,
              },
            ],
          },
        ],
      },
    ],
  };
}

export type SlackSendResult =
  | { ok: true; status: number }
  | { ok: false; status: number | null; error: string };

/**
 * POSTs a Slack Block Kit payload to a webhook URL. Returns a
 * structured result rather than throwing — the cron dispatch loop
 * uses this to decide whether to mark a NotificationDispatch row as
 * sent or to defer (and try again next cycle).
 */
export async function sendSlackMessage(
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<SlackSendResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SLACK_TIMEOUT_MS);
  try {
    const res = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return {
        ok: false,
        status: res.status,
        error: `Slack returned ${res.status}: ${body.slice(0, 200)}`,
      };
    }
    return { ok: true, status: res.status };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return { ok: false, status: null, error: "Slack webhook timeout (5s)" };
    }
    return {
      ok: false,
      status: null,
      error:
        err instanceof Error ? err.message : "Unknown Slack fetch error",
    };
  } finally {
    clearTimeout(timer);
  }
}
