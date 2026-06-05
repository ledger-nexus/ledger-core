// Tests for the cross-repo DSR attribution fetcher.
//
// All fetches go through an injected `fetchImpl` so we exercise the
// happy path, timeout, 5xx, and partial-failure modes without any
// network I/O. No real companion repos involved.

import { describe, it, expect, vi } from "vitest";
import {
  fetchCompanionAttribution,
  type ConnectionsAttribution,
  type ReconAttribution,
  type FaAmortAttribution,
  type RevenueRecAttribution,
} from "../src/lib/privacy/companion-attribution";

const USER_ID = "00000000-0000-0000-0000-0000000000aa";
const TOKEN = "test-internal-api-token-min-32-chars-long";

function makeFetchImpl(
  responses: Record<string, () => Promise<Response> | Response>
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    for (const [needle, handler] of Object.entries(responses)) {
      if (url.includes(needle)) {
        return handler();
      }
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchCompanionAttribution", () => {
  it("aggregates all four companions on the happy path", async () => {
    const integrationsData: ConnectionsAttribution = {
      connectionsCreated: 3,
      connectionsByStatus: { ACTIVE: 2, REVOKED: 1, PAUSED: 0, ERROR: 0 },
      syncRunsInitiated: 12,
      connectionsBySystem: { plaid: 2, stripe: 1 },
      snapshotAt: "2026-06-04T12:00:00.000Z",
    };
    const reconData: ReconAttribution = {
      bankStatementsUploaded: 5,
      reconciliationMatchesApproved: 40,
      aiSuggestionsAccepted: 30,
      aiSuggestionsRejected: 5,
      snapshotAt: "2026-06-04T12:00:00.000Z",
    };
    const faData: FaAmortAttribution = {
      fixedAssetsRegistered: 0,
      depreciationRunsInitiated: 0,
      aiAssetSuggestionsAccepted: 0,
      aiAssetSuggestionsRejected: 0,
      assetDisposalsAuthorized: 0,
      snapshotAt: "2026-06-04T12:00:00.000Z",
    };
    const rrData: RevenueRecAttribution = {
      revenueContractsCreated: 0,
      contractDocumentsUploaded: 7,
      recognitionSchedulesApproved: 84,
      aiExtractionsAccepted: 0,
      aiExtractionsRejected: 0,
      snapshotAt: "2026-06-04T12:00:00.000Z",
    };

    const fetchImpl = makeFetchImpl({
      ":3003": () => jsonResponse(integrationsData),
      ":3001": () => jsonResponse(reconData),
      ":3004": () => jsonResponse(faData),
      ":3002": () => jsonResponse(rrData),
    });

    const result = await fetchCompanionAttribution(USER_ID, {
      internalApiToken: TOKEN,
      fetchImpl,
    });

    expect(result.integrations).toEqual({ reachable: true, data: integrationsData });
    expect(result.recon).toEqual({ reachable: true, data: reconData });
    expect(result.faAmort).toEqual({ reachable: true, data: faData });
    expect(result.revenueRec).toEqual({ reachable: true, data: rrData });
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("sends the Bearer token + userId body on every request", async () => {
    const seen: Array<{ url: string; headers: Headers; body: string }> = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      seen.push({
        url,
        headers: new Headers(init?.headers ?? {}),
        body: String(init?.body ?? ""),
      });
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    await fetchCompanionAttribution(USER_ID, {
      internalApiToken: TOKEN,
      fetchImpl,
    });

    expect(seen).toHaveLength(4);
    for (const call of seen) {
      expect(call.url).toMatch(/\/api\/internal\/dsr\/attribution$/);
      expect(call.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
      expect(call.headers.get("content-type")).toBe("application/json");
      expect(JSON.parse(call.body)).toEqual({ userId: USER_ID });
    }
  });

  it("marks a companion unreachable on HTTP 5xx", async () => {
    const fetchImpl = makeFetchImpl({
      ":3003": () => jsonResponse({ msg: "ok" }), // integrations OK
      ":3001": () =>
        new Response("server down", { status: 503, statusText: "Service Unavailable" }),
      ":3004": () => jsonResponse({ msg: "ok" }),
      ":3002": () => jsonResponse({ msg: "ok" }),
    });

    const result = await fetchCompanionAttribution(USER_ID, {
      internalApiToken: TOKEN,
      fetchImpl,
    });

    expect(result.integrations.reachable).toBe(true);
    expect(result.recon.reachable).toBe(false);
    if (!result.recon.reachable) {
      expect(result.recon.error).toContain("503");
    }
    expect(result.faAmort.reachable).toBe(true);
    expect(result.revenueRec.reachable).toBe(true);
  });

  it("marks a companion unreachable on network error", async () => {
    const fetchImpl = makeFetchImpl({
      ":3003": () => jsonResponse({}),
      ":3001": () => jsonResponse({}),
      ":3004": () => {
        throw new TypeError("fetch failed: connection refused");
      },
      ":3002": () => jsonResponse({}),
    });

    const result = await fetchCompanionAttribution(USER_ID, {
      internalApiToken: TOKEN,
      fetchImpl,
    });

    expect(result.faAmort.reachable).toBe(false);
    if (!result.faAmort.reachable) {
      expect(result.faAmort.error).toContain("connection refused");
    }
    // Other companions still OK — graceful degradation works.
    expect(result.integrations.reachable).toBe(true);
    expect(result.recon.reachable).toBe(true);
    expect(result.revenueRec.reachable).toBe(true);
  });

  it("never throws even if all four companions fail", async () => {
    const fetchImpl = (async () => {
      throw new Error("everything is down");
    }) as typeof fetch;

    const result = await fetchCompanionAttribution(USER_ID, {
      internalApiToken: TOKEN,
      fetchImpl,
    });

    expect(result.integrations.reachable).toBe(false);
    expect(result.recon.reachable).toBe(false);
    expect(result.faAmort.reachable).toBe(false);
    expect(result.revenueRec.reachable).toBe(false);
    expect(result.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("aborts on timeout (signal is wired to AbortController)", async () => {
    // Companion that never resolves — the AbortSignal must time us out.
    // We don't wait the full 5s; we simulate the abort by checking that
    // the request includes a signal that, when aborted, surfaces as an
    // AbortError-shaped failure.
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const sig = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        if (sig) {
          if (sig.aborted) {
            reject(new DOMException("aborted", "AbortError"));
            return;
          }
          sig.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }
        // Synthesize an immediate abort to exercise the catch branch
        // without real timer overhead.
        const c = (init as { signal?: AbortSignal & { dispatchEvent?: unknown } })
          .signal;
        // Manually fire abort on the next microtask.
        if (c && typeof (c as unknown as { abort?: () => void }).abort === "function") {
          (c as unknown as { abort: () => void }).abort();
        }
      });
    }) as typeof fetch;

    // Don't actually rely on the synthesized abort. Just assert that
    // SOMEHOW the call resolves to unreachable when the response is
    // never returned within the timeout — by using vi.useFakeTimers
    // we can also fast-forward the AbortController's setTimeout.
    vi.useFakeTimers();
    const promise = fetchCompanionAttribution(USER_ID, {
      internalApiToken: TOKEN,
      fetchImpl,
    });
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await promise;
    vi.useRealTimers();

    // At least one companion should have surfaced as unreachable.
    const reachable = [
      result.integrations.reachable,
      result.recon.reachable,
      result.faAmort.reachable,
      result.revenueRec.reachable,
    ];
    expect(reachable.every((r) => r === false)).toBe(true);
  });
});
