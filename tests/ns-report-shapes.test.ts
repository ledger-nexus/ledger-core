// v0.9 NS SuiteAnalytics Phase 3 — shape mapper unit test.
//
// Pure functions, no DB. Verifies the field-mapping table against
// canned ledger-core-native shapes that mimic real getTrialBalance /
// getIncomeStatement / getBalanceSheet output.
//
// What the test pins down:
//   - acctnumber/acctname/accttype field name renaming
//   - debitamount/creditamount/amount field name renaming
//   - subsidiary.internalid + accountingBook.internalid wrapper objects
//   - 4-decimal Decimal → string serialization
//   - AccountType 5-way enum → NS accttype mapping
//   - Totals wrapper field renaming per report

import { describe, expect, it } from "vitest";
import { Decimal } from "decimal.js";

import {
  toNsTrialBalance,
  toNsIncomeStatement,
  toNsBalanceSheet,
  toNsConsolidatedTrialBalance,
  type NativeTrialBalanceRow,
  type NativeFinancialStatementRow,
} from "@/lib/external/ns-report-shapes";

const CTX = {
  subsidiaryInternalid: "1",
  accountingBookInternalid: "9",
};

describe("v0.9 NS SuiteAnalytics Phase 3: toNsTrialBalance", () => {
  it("maps ledger-core TB rows to NS-canonical shape with all field renames", async () => {
    const rows: NativeTrialBalanceRow[] = [
      {
        accountCode: "1000",
        accountName: "Cash",
        type: "ASSET",
        debit: new Decimal("1000.0000"),
        credit: new Decimal("0.0000"),
        balance: new Decimal("1000.0000"),
        parentCode: null,
        isContra: false,
      },
      {
        accountCode: "4000",
        accountName: "Revenue",
        type: "REVENUE",
        debit: new Decimal("0.0000"),
        credit: new Decimal("1000.0000"),
        balance: new Decimal("1000.0000"),
        parentCode: null,
        isContra: false,
      },
    ];
    const totals = {
      totalDebit: new Decimal("1000.0000"),
      totalCredit: new Decimal("1000.0000"),
    };
    const body = toNsTrialBalance(rows, totals, "2026-04-30", CTX);

    expect(body.reportName).toBe("Trial Balance");
    expect(body.subsidiary.internalid).toBe("1");
    expect(body.accountingBook.internalid).toBe("9");
    expect(body.asOf).toBe("2026-04-30");

    // First row — ASSET → "OthCurAsset".
    expect(body.rows[0].account.acctnumber).toBe("1000");
    expect(body.rows[0].account.acctname).toBe("Cash");
    expect(body.rows[0].account.accttype).toBe("OthCurAsset");
    expect(body.rows[0].debitamount).toBe("1000.0000");
    expect(body.rows[0].creditamount).toBe("0.0000");
    expect(body.rows[0].amount).toBe("1000.0000");

    // Second row — REVENUE → "Income".
    expect(body.rows[1].account.accttype).toBe("Income");
    expect(body.rows[1].creditamount).toBe("1000.0000");

    expect(body.totals.debitamount).toBe("1000.0000");
    expect(body.totals.creditamount).toBe("1000.0000");
  });

  it("maps all 5 ledger-core AccountType enum values to NS types", async () => {
    const rows: NativeTrialBalanceRow[] = (
      ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const
    ).map((type, i) => ({
      accountCode: String(1000 + i),
      accountName: `${type} test`,
      type,
      debit: new Decimal("100.0000"),
      credit: new Decimal("0.0000"),
      balance: new Decimal("100.0000"),
      parentCode: null,
      isContra: false,
    }));
    const body = toNsTrialBalance(
      rows,
      {
        totalDebit: new Decimal("500.0000"),
        totalCredit: new Decimal("0.0000"),
      },
      "2026-04-30",
      CTX
    );
    const types = body.rows.map((r) => r.account.accttype);
    // NS-canonical accttype values (the most common one per ledger-core
    // primary type). Per-row subtype refinement is a follow-up PR.
    expect(types).toEqual([
      "OthCurAsset",
      "OthCurLiab",
      "Equity",
      "Income",
      "Expense",
    ]);
  });

  it("preserves 4-decimal Decimal precision through string serialization", async () => {
    const body = toNsTrialBalance(
      [
        {
          accountCode: "1000",
          accountName: "Cash",
          type: "ASSET",
          debit: new Decimal("1234.5678"),
          credit: new Decimal("0.0000"),
          balance: new Decimal("1234.5678"),
          parentCode: null,
          isContra: false,
        },
      ],
      {
        totalDebit: new Decimal("1234.5678"),
        totalCredit: new Decimal("0.0000"),
      },
      "2026-04-30",
      CTX
    );
    expect(body.rows[0].debitamount).toBe("1234.5678");
    expect(body.totals.debitamount).toBe("1234.5678");
  });
});

describe("v0.9 NS SuiteAnalytics Phase 3: toNsIncomeStatement", () => {
  it("emits revenue + expense sections with NS-canonical field shape", async () => {
    const income: NativeFinancialStatementRow[] = [
      {
        code: "4000",
        name: "Revenue",
        amount: new Decimal("5000.0000"),
        parentCode: null,
        isContra: false,
      },
    ];
    const expenses: NativeFinancialStatementRow[] = [
      {
        code: "5000",
        name: "COGS",
        amount: new Decimal("2000.0000"),
        parentCode: null,
        isContra: false,
      },
    ];
    const body = toNsIncomeStatement(
      income,
      expenses,
      {
        totalRevenue: new Decimal("5000.0000"),
        totalExpenses: new Decimal("2000.0000"),
        netIncome: new Decimal("3000.0000"),
      },
      { fromDate: "2026-04-01", toDate: "2026-04-30" },
      CTX
    );
    expect(body.reportName).toBe("Income Statement");
    expect(body.fromDate).toBe("2026-04-01");
    expect(body.toDate).toBe("2026-04-30");
    expect(body.income[0].account.acctnumber).toBe("4000");
    expect(body.income[0].account.accttype).toBe("Income");
    expect(body.expenses[0].account.acctnumber).toBe("5000");
    expect(body.expenses[0].account.accttype).toBe("Expense");
    expect(body.totals.netIncome).toBe("3000.0000");
  });
});

describe("v0.9 NS SuiteAnalytics Phase 5: toNsConsolidatedTrialBalance", () => {
  it("emits NS SubsidiaryElimination-canonical consolidation shape", async () => {
    const body = toNsConsolidatedTrialBalance(
      {
        entities: [
          {
            code: "ACME_NS1",
            name: "ACME Parent",
            isRoot: true,
            functionalCurrencyId: "USD",
          },
          {
            code: "ACME_NS2",
            name: "ACME Sub UK",
            isRoot: false,
            functionalCurrencyId: "GBP",
          },
        ],
        rows: [
          {
            accountCode: "1000",
            accountName: "Cash",
            type: "ASSET",
            subtype: null,
            perEntity: [
              {
                entityCode: "ACME_NS1",
                debit: new Decimal("1000.0000"),
                credit: new Decimal("0.0000"),
              },
              {
                entityCode: "ACME_NS2",
                debit: new Decimal("500.0000"),
                credit: new Decimal("0.0000"),
              },
            ],
            totalDebit: new Decimal("1500.0000"),
            totalCredit: new Decimal("0.0000"),
            isEliminated: false,
            eliminatedDebit: new Decimal("0.0000"),
            eliminatedCredit: new Decimal("0.0000"),
            consolidatedDebit: new Decimal("1500.0000"),
            consolidatedCredit: new Decimal("0.0000"),
            consolidatedBalance: new Decimal("1500.0000"),
          },
        ],
        preEliminationTotalDebit: new Decimal("1500.0000"),
        preEliminationTotalCredit: new Decimal("0.0000"),
        consolidatedTotalDebit: new Decimal("1500.0000"),
        consolidatedTotalCredit: new Decimal("0.0000"),
        balances: true,
      },
      "2026-04-30",
      {
        subsidiaryInternalid: "1",
        accountingBookInternalid: "9",
        rootEntityName: "ACME Parent",
        entityCodeToNsInternalid: {
          ACME_NS1: "1",
          ACME_NS2: "2",
        },
      }
    );

    expect(body.reportName).toBe("Consolidated Trial Balance");
    expect(body.rootSubsidiary).toEqual({
      internalid: "1",
      name: "ACME Parent",
    });
    expect(body.accountingBook.internalid).toBe("9");

    // entities[] surfaces NS internalid + ledger-core code together.
    expect(body.entities.length).toBe(2);
    expect(body.entities[0]).toMatchObject({
      internalid: "1",
      code: "ACME_NS1",
      isRoot: true,
      currency: "USD",
    });
    expect(body.entities[1]).toMatchObject({
      internalid: "2",
      code: "ACME_NS2",
      isRoot: false,
      currency: "GBP",
    });

    // Row shape: account wrapper + perSubsidiary array with NS ids.
    expect(body.rows[0].account.acctnumber).toBe("1000");
    expect(body.rows[0].account.accttype).toBe("OthCurAsset");
    expect(body.rows[0].perSubsidiary).toEqual([
      { internalid: "1", debit: "1000.0000", credit: "0.0000" },
      { internalid: "2", debit: "500.0000", credit: "0.0000" },
    ]);

    // Translation section: rates + CTA.
    // Translation keys pinned null/false: ASC 830 translation was
    // dispositioned unmerged (v1.27); keys survive for NS-shape-strict
    // BI adapters.
    expect(body.translation.active).toBe(false);
    expect(body.translation.ratesByEntity).toBeNull();
    expect(body.translation.cta).toBeNull();
    expect(body.totals.cumulativeTranslationAdjustment).toBeNull();

    expect(body.balances).toBe(true);
  });

  it("emits empty internalid for entities missing the NS mapping", async () => {
    // An entity NOT in entityCodeToNsInternalid → internalid "".
    // Operators see the placeholder + know which entity to import.
    const body = toNsConsolidatedTrialBalance(
      {
        entities: [
          {
            code: "UNMAPPED",
            name: "Unmapped Entity",
            isRoot: true,
            functionalCurrencyId: "USD",
          },
        ],
        rows: [],
        preEliminationTotalDebit: new Decimal("0.0000"),
        preEliminationTotalCredit: new Decimal("0.0000"),
        consolidatedTotalDebit: new Decimal("0.0000"),
        consolidatedTotalCredit: new Decimal("0.0000"),
        balances: true,
      },
      "2026-04-30",
      {
        subsidiaryInternalid: "1",
        accountingBookInternalid: "9",
        rootEntityName: "Unmapped Entity",
        entityCodeToNsInternalid: {}, // empty map → fall back to ""
      }
    );
    expect(body.entities[0].internalid).toBe("");
  });
});

describe("v0.9 NS SuiteAnalytics Phase 3: toNsBalanceSheet", () => {
  it("emits assets/liabilities/equity sections plus balanced flag", async () => {
    const sections = {
      assets: [
        {
          code: "1000",
          name: "Cash",
          amount: new Decimal("1000.0000"),
          parentCode: null,
          isContra: false,
        },
      ],
      liabilities: [
        {
          code: "2000",
          name: "AP",
          amount: new Decimal("300.0000"),
          parentCode: null,
          isContra: false,
        },
      ],
      equity: [
        {
          code: "3000",
          name: "Capital",
          amount: new Decimal("700.0000"),
          parentCode: null,
          isContra: false,
        },
      ],
    };
    const body = toNsBalanceSheet(
      sections,
      {
        totalAssets: new Decimal("1000.0000"),
        totalLiabilities: new Decimal("300.0000"),
        totalEquity: new Decimal("700.0000"),
        retainedEarnings: new Decimal("0.0000"),
        totalLiabilitiesAndEquity: new Decimal("1000.0000"),
      },
      true,
      "2026-04-30",
      CTX
    );
    expect(body.reportName).toBe("Balance Sheet");
    expect(body.assets[0].account.accttype).toBe("OthCurAsset");
    expect(body.liabilities[0].account.accttype).toBe("OthCurLiab");
    expect(body.equity[0].account.accttype).toBe("Equity");
    expect(body.totals.totalAssets).toBe("1000.0000");
    expect(body.totals.totalLiabilitiesAndEquity).toBe("1000.0000");
    expect(body.balances).toBe(true);
  });
});
