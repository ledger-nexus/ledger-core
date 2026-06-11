// Slack message sender + payload formatter tests.
//
// Pins:
//   1. formatSlackBlocks renders the alert into Block Kit
//   2. Severity emoji + color match the matrix
//   3. The fallback text field is populated (Slack needs it for
//      preview clients)
//   4. The Open button URL appends alert.href to appBaseUrl
//   5. sendSlackMessage POSTs JSON to the webhook URL
//   6. sendSlackMessage returns { ok: true, status } on 2xx
//   7. sendSlackMessage returns { ok: false, ... } on non-2xx
//   8. sendSlackMessage handles fetch rejection (network error)

import { describe, it, expect, vi, afterEach } from "vitest";

import {
  formatSlackBlocks,
  sendSlackMessage,
} from "@/lib/notifications/slack";
import type { CloseAlert } from "@/lib/close/alerts";

const baseAlert: CloseAlert = {
  id: "recon:abc-123",
  severity: "high",
  pillar: "recon",
  title: "EXCEPTION on 1100 Cash",
  description: "Reconciliation is over tolerance.",
  ageDays: 3,
  href: "/close/reconciliations/abc-123",
  createdAt: new Date("2026-06-05T12:00:00Z"),
};

const baseContext = {
  appBaseUrl: "https://ledger.example.com",
  entity: "NORTHWIND",
  book: "US_GAAP",
  period: "2026-06",
};

afterEach(() => {
  vi.restoreAllMocks();
});

describe("formatSlackBlocks", () => {
  it("renders a fallback text field for preview clients", () => {
    const payload = formatSlackBlocks(baseAlert, baseContext);
    expect(typeof payload.text).toBe("string");
    expect(payload.text).toContain("HIGH");
    expect(payload.text).toContain("RECON");
    expect(payload.text).toContain("EXCEPTION on 1100 Cash");
  });

  it("uses red color for high severity", () => {
    const payload = formatSlackBlocks(baseAlert, baseContext);
    const attachments = payload.attachments as { color: string }[];
    expect(attachments[0].color).toBe("#dc2626");
  });

  it("uses amber color for medium severity", () => {
    const payload = formatSlackBlocks(
      { ...baseAlert, severity: "medium" },
      baseContext
    );
    const attachments = payload.attachments as { color: string }[];
    expect(attachments[0].color).toBe("#f59e0b");
  });

  it("renders an Open button with the absolute deep-link URL", () => {
    const payload = formatSlackBlocks(baseAlert, baseContext);
    const attachments = payload.attachments as {
      blocks: { type: string; elements?: { type: string; url?: string }[] }[];
    }[];
    const actionBlock = attachments[0].blocks.find((b) => b.type === "actions");
    expect(actionBlock).toBeDefined();
    const button = actionBlock!.elements!.find((e) => e.type === "button");
    expect(button).toBeDefined();
    expect(button!.url).toBe(
      "https://ledger.example.com/close/reconciliations/abc-123"
    );
  });

  it("renders 'today' when ageDays is 0", () => {
    const payload = formatSlackBlocks(
      { ...baseAlert, ageDays: 0 },
      baseContext
    );
    const attachments = payload.attachments as {
      blocks: { type: string; text?: { text: string } }[];
    }[];
    const section = attachments[0].blocks.find((b) => b.type === "section");
    expect(section!.text!.text).toContain("today");
  });

  it("renders '1 day ago' for ageDays=1, 'N days ago' otherwise", () => {
    const one = formatSlackBlocks({ ...baseAlert, ageDays: 1 }, baseContext);
    const oneText = (
      (one.attachments as {
        blocks: { type: string; text?: { text: string } }[];
      }[])[0].blocks.find((b) => b.type === "section")!.text!.text
    );
    expect(oneText).toContain("1 day ago");

    const five = formatSlackBlocks({ ...baseAlert, ageDays: 5 }, baseContext);
    const fiveText = (
      (five.attachments as {
        blocks: { type: string; text?: { text: string } }[];
      }[])[0].blocks.find((b) => b.type === "section")!.text!.text
    );
    expect(fiveText).toContain("5 days ago");
  });
});

describe("sendSlackMessage", () => {
  it("POSTs JSON to the webhook URL", async () => {
    const spy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(
        new Response("ok", { status: 200 }) as unknown as Response
      );
    const r = await sendSlackMessage("https://hooks.slack.com/services/X/Y/Z", {
      text: "hello",
    });
    expect(r).toEqual({ ok: true, status: 200 });
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe("https://hooks.slack.com/services/X/Y/Z");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init?.body as string)).toEqual({ text: "hello" });
  });

  it("returns ok:false on non-2xx with status only — never echoes response body", async () => {
    // Slack's response body could contain the webhook URL or other
    // sensitive content that would then land in NotificationDispatch
    // .sendError (a plaintext column). The sender drains the body but
    // does NOT include any of it in the error string.
    vi.spyOn(global, "fetch").mockResolvedValueOnce(
      new Response(
        "secret_marker_should_never_appear https://hooks.slack.com/services/SECRET/PATH/HASH",
        { status: 400 }
      ) as unknown as Response
    );
    const r = await sendSlackMessage("https://hooks.slack.com/services/X/Y/Z", {
      text: "broken",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(r.error).toContain("400");
      expect(r.error).not.toContain("secret_marker_should_never_appear");
      expect(r.error).not.toContain("hooks.slack.com");
    }
  });

  it("returns ok:false with null status on network error", async () => {
    vi.spyOn(global, "fetch").mockRejectedValueOnce(
      new Error("ECONNREFUSED")
    );
    const r = await sendSlackMessage("https://hooks.slack.com/services/X/Y/Z", {
      text: "x",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBeNull();
      expect(r.error).toContain("ECONNREFUSED");
    }
  });
});
