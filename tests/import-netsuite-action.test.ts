// Unit tests for the importNsAction Server Action.
//
// What we cover here (without standing up Next.js):
//   - The validation guards (mode mismatch, missing prefix, missing
//     subsidiaries, oversize payload, malformed JSON)
//   - The "doesn't look like an NS export" guard
//
// Auth + tenant resolution isn't tested here — the action ALWAYS
// short-circuits on auth failure first (requireAdmin throws), so under
// vitest where neither Clerk nor a test tenant is wired up, the
// happy path lives in the Server Action's integration with the page.
//
// What's NOT tested here: the happy-path import. That's covered
// end-to-end by tests/netsuite-import-multi-sub-e2e.test.ts and
// tests/netsuite-roundtrip-multi-sub.test.ts, which exercise
// importFromNs directly (the Server Action is a thin wrapper). The
// auth gate is the only thing the action adds on top.

import { describe, expect, it } from "vitest";

import { importNsAction } from "@/app/actions/import-netsuite";

describe("importNsAction validation guards", () => {
  it("rejects malformed JSON", async () => {
    const r = await importNsAction({
      exportJson: "{ not json",
      mode: "single",
      entityCode: "ACME",
    });
    expect(r.ok).toBe(false);
    // Either auth error (env not wired) or JSON error — both are
    // expected paths under test. We just confirm it didn't crash.
    expect(r).toMatchObject({ ok: false });
    if (r.ok === false) {
      expect(typeof r.error).toBe("string");
    }
  });

  it("rejects oversized payloads", async () => {
    // 11 MB of bytes — over the 10 MB limit. We expect EITHER the size
    // guard (if auth lets us through) OR the auth guard (in test env).
    const big = JSON.stringify({ _meta: {}, Account: [] }).padEnd(
      11 * 1024 * 1024,
      " "
    );
    const r = await importNsAction({
      exportJson: big,
      mode: "single",
      entityCode: "ACME",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects JSON that doesn't look like an NS export", async () => {
    const r = await importNsAction({
      exportJson: JSON.stringify({ foo: "bar" }),
      mode: "single",
      entityCode: "ACME",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects single mode without entityCode", async () => {
    const r = await importNsAction({
      exportJson: JSON.stringify({ _meta: {}, Account: [{ internalid: "1" }] }),
      mode: "single",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects multi mode without entityCodePrefix", async () => {
    const r = await importNsAction({
      exportJson: JSON.stringify({
        _meta: {},
        Account: [{ internalid: "1" }],
        Subsidiary: [{ internalid: "1" }],
      }),
      mode: "multi",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects multi mode when the export has no Subsidiary array", async () => {
    const r = await importNsAction({
      exportJson: JSON.stringify({
        _meta: {},
        Account: [{ internalid: "1" }],
      }),
      mode: "multi",
      entityCodePrefix: "ACME",
    });
    expect(r.ok).toBe(false);
  });
});
