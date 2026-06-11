// v0.8 NS Accounting Books Phase 1 — unit tests.
//
// Covers:
//   - resolveBookCodes: single-mode literal, multi-mode mapping,
//     missing-mapping throw, dedup when multiple NS books map to
//     the same ledger-core book
//   - resolveBookResolution: backward-compat fold (bookCode →
//     {single}, bookResolution passthrough, default fallback)
//   - mapNsBook: pure mapper preserves byref + sets isAdjustment
//   - setupBooks: integration with real Postgres
//     * single mode happy path
//     * single mode + multiple NS books surfaces a warning
//     * multi mode happy path
//     * multi mode + missing mapping throws BookNotMappedError
//     * multi mode + missing target book throws (operator-actionable)
//     * empty NS books array in multi mode warns + returns 0
//
// Requires DATABASE_URL pointing at a dev DB.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";

import {
  BookNotMappedError,
  mapNsBook,
  resolveBookCodes,
  resolveBookResolution,
  setupBooks,
} from "@/lib/mappers/netsuite/books";
import type { NsAccountingBook } from "@/lib/mappers/netsuite/types";

const prisma = new PrismaClient();

const NS_GAAP: NsAccountingBook = {
  internalid: "1",
  name: "US GAAP",
  isadjustment: false,
  basis: "GAAP",
  currency: "USD",
};
const NS_TAX: NsAccountingBook = {
  internalid: "2",
  name: "US TAX",
  isadjustment: false,
  basis: "TAX",
  currency: "USD",
};
const NS_TAX_ADJ: NsAccountingBook = {
  internalid: "3",
  name: "US TAX Adjustments",
  isadjustment: true,
  basis: "TAX",
  currency: "USD",
};

describe("resolveBookCodes (pure)", () => {
  it("single mode returns the literal book code regardless of NS ids", () => {
    expect(resolveBookCodes(["1", "2", "3"], { mode: "single", bookCode: "US_GAAP" })).toEqual([
      "US_GAAP",
    ]);
    expect(resolveBookCodes([], { mode: "single", bookCode: "IFRS" })).toEqual(["IFRS"]);
  });

  it("multi mode resolves each NS id via the mapping", () => {
    const r = resolveBookCodes(["1", "2"], {
      mode: "multi",
      bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
    });
    expect(r.sort()).toEqual(["US_GAAP", "US_TAX"].sort());
  });

  it("multi mode deduplicates when multiple NS books map to the same ledger-core book", () => {
    // NS book 3 is an adjustment book folded into US_TAX. We don't
    // want to post twice to US_TAX.
    const r = resolveBookCodes(["2", "3"], {
      mode: "multi",
      bookMapping: { "2": "US_TAX", "3": "US_TAX" },
    });
    expect(r).toEqual(["US_TAX"]);
  });

  it("multi mode throws BookNotMappedError when an NS id is missing", () => {
    expect(() =>
      resolveBookCodes(["1", "99"], {
        mode: "multi",
        bookMapping: { "1": "US_GAAP" },
      })
    ).toThrow(BookNotMappedError);
  });

  it("BookNotMappedError carries the unmapped id + available keys", () => {
    try {
      resolveBookCodes(["99"], {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      });
      expect.fail("should have thrown");
    } catch (e) {
      const err = e as BookNotMappedError;
      expect(err.nsBookInternalId).toBe("99");
      expect(err.availableKeys.sort()).toEqual(["1", "2"]);
      expect(err.message).toContain("US_TAX");
    }
  });
});

describe("resolveBookResolution (backward compat fold)", () => {
  it("returns bookResolution when set", () => {
    const explicit = { mode: "multi" as const, bookMapping: { "1": "US_GAAP" } };
    expect(resolveBookResolution({ bookResolution: explicit })).toBe(explicit);
  });

  it("folds bookCode → single mode", () => {
    expect(resolveBookResolution({ bookCode: "IFRS" })).toEqual({
      mode: "single",
      bookCode: "IFRS",
    });
  });

  it("defaults to US_GAAP single when neither is set (matches importer default)", () => {
    expect(resolveBookResolution({})).toEqual({
      mode: "single",
      bookCode: "US_GAAP",
    });
  });

  it("bookResolution wins when both are set (explicit overrides legacy)", () => {
    const explicit = { mode: "multi" as const, bookMapping: { "1": "US_GAAP" } };
    expect(
      resolveBookResolution({ bookCode: "IFRS", bookResolution: explicit })
    ).toBe(explicit);
  });
});

describe("mapNsBook (pure)", () => {
  it("returns the resolved code + frozen sourcePayload", () => {
    const m = mapNsBook(NS_GAAP, {
      mode: "multi",
      bookMapping: { "1": "US_GAAP" },
    });
    expect(m.internalid).toBe("1");
    expect(m.bookCode).toBe("US_GAAP");
    expect(m.name).toBe("US GAAP");
    expect(m.isAdjustment).toBe(false);
    // sourcePayload must be the SAME object — byref preservation is the
    // lineage-replay contract per CLAUDE.md.
    expect(m.sourcePayload).toBe(NS_GAAP);
  });

  it("propagates isadjustment when true", () => {
    const m = mapNsBook(NS_TAX_ADJ, {
      mode: "multi",
      bookMapping: { "3": "US_TAX" },
    });
    expect(m.isAdjustment).toBe(true);
  });

  it("defaults isAdjustment=false when NS field is missing", () => {
    const ns: NsAccountingBook = { internalid: "9", name: "Whatever" };
    const m = mapNsBook(ns, { mode: "multi", bookMapping: { "9": "US_GAAP" } });
    expect(m.isAdjustment).toBe(false);
  });
});

describe("setupBooks (vs real Postgres)", () => {
  beforeAll(async () => {
    // Ensure the books our tests reference exist. Northwind + the
    // v0.4 multi-book seed creates US_GAAP, US_TAX, IFRS already on
    // the dev DB, but we upsert to be defensive — a fresh dev DB
    // shouldn't fail this test.
    for (const code of ["US_GAAP", "US_TAX", "IFRS"]) {
      await prisma.book.upsert({
        where: { code },
        create: {
          code,
          name: code,
          basis: code === "US_TAX" ? "US_TAX" : code === "IFRS" ? "IFRS" : "US_GAAP",
          reportingCurrencyId: "USD",
        },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("single mode + empty books returns booksProcessed=0", async () => {
    const r = await setupBooks(prisma, {
      books: [],
      resolution: { mode: "single", bookCode: "US_GAAP" },
    });
    expect(r.booksProcessed).toBe(0);
    expect(r.warnings).toEqual([]);
    expect(r.bookCodeByInternalid.size).toBe(0);
  });

  it("single mode + N NS books populates map but warns", async () => {
    // The operator declared single-book mode but provided multiple
    // NS books. We warn (data-loss risk) but proceed.
    const r = await setupBooks(prisma, {
      books: [NS_GAAP, NS_TAX],
      resolution: { mode: "single", bookCode: "US_GAAP" },
    });
    expect(r.booksProcessed).toBe(2);
    expect(r.bookCodeByInternalid.get("1")).toBe("US_GAAP");
    expect(r.bookCodeByInternalid.get("2")).toBe("US_GAAP");
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/Single-book mode with 2 NS books/);
  });

  it("multi mode happy path — maps each NS book + verifies ledger-core target exists", async () => {
    const r = await setupBooks(prisma, {
      books: [NS_GAAP, NS_TAX],
      resolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX" },
      },
    });
    expect(r.booksProcessed).toBe(2);
    expect(r.bookCodeByInternalid.get("1")).toBe("US_GAAP");
    expect(r.bookCodeByInternalid.get("2")).toBe("US_TAX");
    expect(r.warnings).toEqual([]);
  });

  it("multi mode + missing mapping throws BookNotMappedError", async () => {
    await expect(
      setupBooks(prisma, {
        books: [NS_GAAP, NS_TAX],
        resolution: {
          mode: "multi",
          bookMapping: { "1": "US_GAAP" }, // 2 missing
        },
      })
    ).rejects.toBeInstanceOf(BookNotMappedError);
  });

  it("multi mode + mapping target doesn't exist throws operator-actionable error", async () => {
    await expect(
      setupBooks(prisma, {
        books: [NS_GAAP],
        resolution: {
          mode: "multi",
          bookMapping: { "1": "NONEXISTENT_BOOK_XYZ" },
        },
      })
    ).rejects.toThrow(/NONEXISTENT_BOOK_XYZ.*does not exist/);
  });

  it("multi mode + empty NS books returns 0 + warning", async () => {
    const r = await setupBooks(prisma, {
      books: [],
      resolution: { mode: "multi", bookMapping: { "1": "US_GAAP" } },
    });
    expect(r.booksProcessed).toBe(0);
    expect(r.warnings.length).toBe(1);
    expect(r.warnings[0]).toMatch(/no AccountingBook/);
  });

  it("multi mode + multiple NS books folded into the same ledger-core book", async () => {
    // Adjustment book (NS id 3) folded into US_TAX. The result should
    // only have 2 distinct ledger-core book codes, but the map still
    // has 3 entries (the per-NS-id lookup is what the per-tx routing
    // needs).
    const r = await setupBooks(prisma, {
      books: [NS_GAAP, NS_TAX, NS_TAX_ADJ],
      resolution: {
        mode: "multi",
        bookMapping: { "1": "US_GAAP", "2": "US_TAX", "3": "US_TAX" },
      },
    });
    expect(r.booksProcessed).toBe(3);
    expect(r.bookCodeByInternalid.get("1")).toBe("US_GAAP");
    expect(r.bookCodeByInternalid.get("2")).toBe("US_TAX");
    expect(r.bookCodeByInternalid.get("3")).toBe("US_TAX");
    expect(r.warnings).toEqual([]);
  });
});
