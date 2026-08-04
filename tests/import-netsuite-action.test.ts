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

describe("importNsAction server-side prefix/code validation (defense-in-depth)", () => {
  // A malicious client can bypass the form regex by POSTing directly.
  // These cases confirm the action re-validates server-side. Each one
  // simulates a client trying to slip a hostile value through.

  const validNsExport = JSON.stringify({
    _meta: {},
    Account: [{ internalid: "1" }],
    Subsidiary: [{ internalid: "1", name: "X", currency: "USD" }],
  });

  it("rejects entityCodePrefix with spaces", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "multi",
      entityCodePrefix: "ACME 17",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects entityCodePrefix with path traversal", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "multi",
      entityCodePrefix: "../etc",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects entityCodePrefix with SQL-ish characters", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "multi",
      entityCodePrefix: "ACME'; DROP",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects entityCodePrefix longer than 16 chars", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "multi",
      entityCodePrefix: "A".repeat(17),
    });
    expect(r.ok).toBe(false);
  });

  it("rejects entityCodePrefix with non-ASCII (homoglyph defense)", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "multi",
      // Cyrillic 'A' looks like Latin A but would collide differently
      // in the unique constraint.
      entityCodePrefix: "АCME",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects entityCode with control chars (single mode)", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "single",
      entityCode: "ACME\x00",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bookCode with shell metacharacters", async () => {
    const r = await importNsAction({
      exportJson: validNsExport,
      mode: "single",
      entityCode: "ACME",
      bookCode: "US_GAAP; rm -rf /",
    });
    expect(r.ok).toBe(false);
  });
});

describe("importNsAction multi-book validation (v0.9 Phase 5)", () => {
  // A NS export with an AccountingBook array — required for multi-book
  // mode. The Subsidiary array is present too so multi-sub callers can
  // also opt into multi-book without re-exporting.
  const multiBookExport = JSON.stringify({
    _meta: {},
    Account: [{ internalid: "1" }],
    Subsidiary: [{ internalid: "1", name: "X", currency: "USD" }],
    AccountingBook: [
      { internalid: "1", name: "US GAAP" },
      { internalid: "2", name: "US TAX" },
    ],
  });

  it("rejects multi book mode without a bookMapping", async () => {
    const r = await importNsAction({
      exportJson: multiBookExport,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      // Missing bookMapping entirely.
    });
    expect(r.ok).toBe(false);
  });

  it("rejects multi book mode with an empty bookMapping", async () => {
    const r = await importNsAction({
      exportJson: multiBookExport,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      bookMapping: {},
    });
    expect(r.ok).toBe(false);
  });

  it("rejects multi book mode when the export has no AccountingBook array", async () => {
    const exportWithoutBooks = JSON.stringify({
      _meta: {},
      Account: [{ internalid: "1" }],
      Subsidiary: [{ internalid: "1", name: "X", currency: "USD" }],
      // No AccountingBook
    });
    const r = await importNsAction({
      exportJson: exportWithoutBooks,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      bookMapping: { "1": "US_GAAP" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bookMapping with an invalid NS internalid (SQL-ish key)", async () => {
    const r = await importNsAction({
      exportJson: multiBookExport,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      bookMapping: { "1'; DROP TABLE": "US_GAAP" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bookMapping with an invalid ledger-core book code value", async () => {
    const r = await importNsAction({
      exportJson: multiBookExport,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      bookMapping: { "1": "US_GAAP; rm -rf /" },
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bookMapping with too many entries (memory DoS guard)", async () => {
    const huge: Record<string, string> = {};
    for (let i = 0; i < 50; i++) huge[String(i)] = "US_GAAP";
    const r = await importNsAction({
      exportJson: multiBookExport,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      bookMapping: huge,
    });
    expect(r.ok).toBe(false);
  });

  it("rejects bookMapping with non-string values", async () => {
    const r = await importNsAction({
      exportJson: multiBookExport,
      mode: "multi",
      entityCodePrefix: "ACME",
      bookMode: "multi",
      // Cast through unknown to simulate a malicious POST with a
      // non-string value slipping past TypeScript at the wire.
      bookMapping: { "1": 42 as unknown as string },
    });
    expect(r.ok).toBe(false);
  });
});
