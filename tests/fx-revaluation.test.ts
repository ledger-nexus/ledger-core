// FX revaluation tests. Mocked prisma — tests the math + the JE-build
// path without touching a real DB.
//
// The substantive guarantees we want to verify:
//   - delta = revalued reporting − carrying reporting, signed by
//     account normalBalance so a positive delta means "P&L direction
//     gain"
//   - Net gain/loss across accounts = signed sum
//   - JE balances: every account adjustment offsets the FX P&L line
//   - Zero-delta accounts skip
//   - Missing CLOSE rate returns the currency in missingRates and
//     skips the account
//   - P&L accounts (REVENUE/EXPENSE) skip — only ASSET/LIABILITY/EQUITY revalue

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({ prisma: {} as never }));

// Mock postJournalEntry so the post path's JE construction can be
// asserted without a DB. vi.mock is hoisted, so we use a factory
// that references the mock fn via mock-state — defined inside the
// factory and retrieved via vi.mocked() after import.
vi.mock("../src/lib/accounting/post-journal", () => ({
  postJournalEntry: vi.fn().mockResolvedValue({
    id: "00000000-0000-0000-0000-000000000099",
    entryNumber: "TEST-US_GAAP-00001",
    bookCode: "US_GAAP",
  }),
}));

import {
  previewFxRevaluation,
  postFxRevaluation,
} from "../src/lib/accounting/reports/fx-revaluation";
import { postJournalEntry } from "../src/lib/accounting/post-journal";

const postJournalEntryMock = vi.mocked(postJournalEntry);

const TENANT_ID = "00000000-0000-0000-0000-000000000001";
const ENTITY_ID = "11111111-1111-1111-1111-111111111111";
const BOOK_ID = "22222222-2222-2222-2222-222222222222";

interface AccountFixture {
  id: string;
  code: string;
  name: string;
  normalBalance: "DEBIT" | "CREDIT";
  type: "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE";
}

function buildPrisma(args: {
  rawRows: Array<{
    accountId: string;
    transactionCurrencyId: string;
    txDr: string;
    txCr: string;
    rptDr: string;
    rptCr: string;
  }>;
  accounts: AccountFixture[];
  closeRates: Array<{ from: string; rate: string }>;
}): unknown {
  return {
    book: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        id: BOOK_ID,
        reportingCurrencyId: "USD",
      }),
    },
    legalEntity: {
      findFirstOrThrow: vi.fn().mockResolvedValue({ id: ENTITY_ID }),
    },
    $queryRaw: vi.fn().mockResolvedValue(args.rawRows),
    account: {
      findMany: vi.fn().mockResolvedValue(args.accounts),
    },
    fxRate: {
      findMany: vi.fn().mockResolvedValue(
        args.closeRates.map((r) => ({
          fromCurrencyId: r.from,
          toCurrencyId: "USD",
          rate: { toString: () => r.rate },
        }))
      ),
    },
  };
}

const baseInput = {
  tenantId: TENANT_ID,
  entityCode: "ACME",
  bookCode: "US_GAAP",
  asOfDate: new Date("2026-05-31"),
};

beforeEach(() => {
  postJournalEntryMock.mockClear();
});

describe("previewFxRevaluation: AR-EUR strengthens", () => {
  // €1,000 of AR booked at $1.00/EUR → carrying $1,000.
  // CLOSE rate $1.10/EUR → revalued $1,100.
  // Delta = +$100 = unrealized gain (asset got more valuable).
  it("returns a positive delta for an ASSET account whose currency strengthened", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ar",
          transactionCurrencyId: "EUR",
          txDr: "1000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
      ],
      accounts: [
        {
          id: "ar",
          code: "1100",
          name: "AR — EUR",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });

    const result = await previewFxRevaluation(prisma as never, baseInput);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].delta.toFixed(2)).toBe("100.00");
    expect(result.adjustments[0].reportingRevalued.toFixed(2)).toBe("1100.00");
    expect(result.netGainLoss.toFixed(2)).toBe("100.00");
  });
});

describe("previewFxRevaluation: AP-EUR strengthens", () => {
  // €1,000 of AP booked at $1.00/EUR → carrying $1,000.
  // CLOSE rate $1.10/EUR → revalued $1,100.
  // Delta = +$100 (liability got bigger) = unrealized LOSS for us.
  it("returns a negative net for a LIABILITY whose currency strengthened", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ap",
          transactionCurrencyId: "EUR",
          txDr: "0",
          txCr: "1000",
          rptDr: "0",
          rptCr: "1000",
        },
      ],
      accounts: [
        {
          id: "ap",
          code: "2100",
          name: "AP — EUR",
          normalBalance: "CREDIT",
          type: "LIABILITY",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });

    const result = await previewFxRevaluation(prisma as never, baseInput);
    expect(result.adjustments).toHaveLength(1);
    // Liability carrying: $1,000 credit balance. Revalued: $1,100.
    // delta (signed via normalBalance): +$100.
    // netGainLoss (P&L direction): we SUBTRACT delta for CREDIT-normal
    // accounts because a bigger liability is unfavorable.
    expect(result.adjustments[0].delta.toFixed(2)).toBe("100.00");
    expect(result.netGainLoss.toFixed(2)).toBe("-100.00");
  });
});

describe("previewFxRevaluation: opposite-direction accounts net out", () => {
  it("AR-EUR gain + AP-EUR loss of equal magnitude → net zero", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ar",
          transactionCurrencyId: "EUR",
          txDr: "1000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
        {
          accountId: "ap",
          transactionCurrencyId: "EUR",
          txDr: "0",
          txCr: "1000",
          rptDr: "0",
          rptCr: "1000",
        },
      ],
      accounts: [
        {
          id: "ar",
          code: "1100",
          name: "AR — EUR",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
        {
          id: "ap",
          code: "2100",
          name: "AP — EUR",
          normalBalance: "CREDIT",
          type: "LIABILITY",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });

    const result = await previewFxRevaluation(prisma as never, baseInput);
    expect(result.adjustments).toHaveLength(2);
    expect(result.netGainLoss.toFixed(2)).toBe("0.00");
  });
});

describe("previewFxRevaluation: zero-delta accounts skip", () => {
  it("Carrying equals revalued — no adjustment row", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ar",
          transactionCurrencyId: "EUR",
          txDr: "1000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
      ],
      accounts: [
        {
          id: "ar",
          code: "1100",
          name: "AR — EUR",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
      ],
      // Rate is exactly 1.0 — carrying already matches.
      closeRates: [{ from: "EUR", rate: "1.0000000000" }],
    });

    const result = await previewFxRevaluation(prisma as never, baseInput);
    expect(result.adjustments).toHaveLength(0);
    expect(result.netGainLoss.toFixed(2)).toBe("0.00");
  });
});

describe("previewFxRevaluation: missing CLOSE rate", () => {
  it("Surfaces the currency in missingRates + skips the account", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ar-jpy",
          transactionCurrencyId: "JPY",
          txDr: "100000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
        {
          accountId: "ar-eur",
          transactionCurrencyId: "EUR",
          txDr: "1000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
      ],
      accounts: [
        {
          id: "ar-jpy",
          code: "1101",
          name: "AR — JPY",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
        {
          id: "ar-eur",
          code: "1100",
          name: "AR — EUR",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
      ],
      // Only EUR rate provided; JPY missing.
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });

    const result = await previewFxRevaluation(prisma as never, baseInput);
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0].transactionCurrencyId).toBe("EUR");
    expect(result.missingRates).toEqual(["JPY"]);
  });
});

describe("previewFxRevaluation: P&L accounts skip", () => {
  it("REVENUE / EXPENSE accounts don't revalue — only balance sheet does", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "rev",
          transactionCurrencyId: "EUR",
          txDr: "0",
          txCr: "1000",
          rptDr: "0",
          rptCr: "1000",
        },
      ],
      accounts: [
        {
          id: "rev",
          code: "4000",
          name: "Revenue — EUR",
          normalBalance: "CREDIT",
          type: "REVENUE",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });

    const result = await previewFxRevaluation(prisma as never, baseInput);
    expect(result.adjustments).toHaveLength(0);
  });
});

describe("postFxRevaluation: builds a balanced JE", () => {
  it("Single-currency gain → 1 account DR + 1 FX-gain CR, balanced", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ar",
          transactionCurrencyId: "EUR",
          txDr: "1000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
      ],
      accounts: [
        {
          id: "ar",
          code: "1100",
          name: "AR — EUR",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });

    const result = await postFxRevaluation(prisma as never, baseInput);
    expect(result.entryNumber).toBe("TEST-US_GAAP-00001");
    expect(postJournalEntryMock).toHaveBeenCalledOnce();
    const call = postJournalEntryMock.mock.calls[0][1];
    expect(call.lines).toHaveLength(2);
    // Find the AR line and the FX-gain line.
    const arLine = call.lines.find((l: { accountCode: string }) => l.accountCode === "1100");
    const gainLine = call.lines.find((l: { accountCode: string }) => l.accountCode === "7300");
    expect(arLine?.debit).toBe("100.0000");
    expect(gainLine?.credit).toBe("100.0000");
  });

  it("Zero adjustments → no JE posted", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ar",
          transactionCurrencyId: "EUR",
          txDr: "1000",
          txCr: "0",
          rptDr: "1000",
          rptCr: "0",
        },
      ],
      accounts: [
        {
          id: "ar",
          code: "1100",
          name: "AR — EUR",
          normalBalance: "DEBIT",
          type: "ASSET",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.0000000000" }],
    });
    const result = await postFxRevaluation(prisma as never, baseInput);
    expect(result.entryNumber).toBeNull();
    expect(postJournalEntryMock).not.toHaveBeenCalled();
  });

  it("Liability strengthening produces a loss line on the DR side", async () => {
    const prisma = buildPrisma({
      rawRows: [
        {
          accountId: "ap",
          transactionCurrencyId: "EUR",
          txDr: "0",
          txCr: "1000",
          rptDr: "0",
          rptCr: "1000",
        },
      ],
      accounts: [
        {
          id: "ap",
          code: "2100",
          name: "AP — EUR",
          normalBalance: "CREDIT",
          type: "LIABILITY",
        },
      ],
      closeRates: [{ from: "EUR", rate: "1.10" }],
    });
    const result = await postFxRevaluation(prisma as never, baseInput);
    expect(result.entryNumber).toBe("TEST-US_GAAP-00001");
    const call = postJournalEntryMock.mock.calls[0][1];
    const apLine = call.lines.find((l: { accountCode: string }) => l.accountCode === "2100");
    const lossLine = call.lines.find((l: { accountCode: string }) => l.accountCode === "7400");
    // Liability got bigger → CR the AP account.
    expect(apLine?.credit).toBe("100.0000");
    // Net loss → DR the loss account.
    expect(lossLine?.debit).toBe("100.0000");
  });
});
