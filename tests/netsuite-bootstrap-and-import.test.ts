// Tests for importFromNsWithBootstrap composition helper.
//
// Mocks the underlying bootstrap + importFromNs calls — this file
// tests the COMPOSITION (correct ordering, code resolution, error
// surfacing), not the underlying behavior. Each underlying function
// has its own dedicated test suite:
//   - bootstrap mappers: tests/netsuite-bootstrap-mappers.test.ts
//   - importFromNs: tests/netsuite-mapping.test.ts (integration)

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the bootstrap module's import functions
const mockImportSubsidiaries = vi.fn();
const mockImportAccountingBooks = vi.fn();
const mockImportAccountingPeriods = vi.fn();
const mockImportFromNs = vi.fn();

vi.mock("../src/lib/mappers/netsuite/bootstrap", async () => {
  const actual = await vi.importActual<
    typeof import("../src/lib/mappers/netsuite/bootstrap")
  >("../src/lib/mappers/netsuite/bootstrap");
  return {
    ...actual,
    importSubsidiaries: (...args: unknown[]) =>
      mockImportSubsidiaries(...args),
    importAccountingBooks: (...args: unknown[]) =>
      mockImportAccountingBooks(...args),
    importAccountingPeriods: (...args: unknown[]) =>
      mockImportAccountingPeriods(...args),
  };
});

vi.mock("../src/lib/mappers/netsuite/import", () => ({
  importFromNs: (...args: unknown[]) => mockImportFromNs(...args),
}));

import { importFromNsWithBootstrap } from "../src/lib/mappers/netsuite/bootstrap-and-import";
import type { NsSubsidiaryBootstrap } from "../src/lib/mappers/netsuite/bootstrap";

const fakePrisma = {} as Parameters<typeof importFromNsWithBootstrap>[0];

const baseSubs: NsSubsidiaryBootstrap[] = [
  {
    internalid: "9",
    name: "Parent",
    base_currency: "USD",
    fiscal_calendar: "Standard 2026",
    is_elimination: false,
    is_inactive: false,
  },
  {
    internalid: "10",
    name: "Subsidiary A",
    base_currency: "USD",
    fiscal_calendar: "Standard 2026",
    parent_subsidiary_id: "9",
    is_elimination: false,
    is_inactive: false,
  },
];

const okBootstrapResult = {
  subsidiariesCreated: 2,
  subsidiariesSkipped: 0,
  fiscalCalendarsCreated: 2,
  errors: [],
};
const okBooksResult = { booksCreated: 1, booksSkipped: 0, errors: [] };
const okPeriodsResult = { periodsCreated: 12, periodsSkipped: 0, errors: [] };
const okTxResult = {
  customFieldsRegistered: 0,
  dimensionsCreated: 0,
  dimensionValuesCreated: 0,
  dimensionSetsCreated: 0,
  accountsImported: 0,
  accountsSkipped: 0,
  partiesImported: 0,
  partiesSkipped: 0,
  itemsImported: 0,
  itemsSkipped: 0,
  journalEntriesImported: 0,
  journalEntriesSkipped: 0,
  arOpenItemsOpened: 0,
  apOpenItemsOpened: 0,
  paymentsApplied: 0,
  errors: [],
};

beforeEach(() => {
  mockImportSubsidiaries.mockReset();
  mockImportAccountingBooks.mockReset();
  mockImportAccountingPeriods.mockReset();
  mockImportFromNs.mockReset();
  mockImportSubsidiaries.mockResolvedValue(okBootstrapResult);
  mockImportAccountingBooks.mockResolvedValue(okBooksResult);
  mockImportAccountingPeriods.mockResolvedValue(okPeriodsResult);
  mockImportFromNs.mockResolvedValue(okTxResult);
});

describe("importFromNsWithBootstrap — composition order", () => {
  it("runs bootstrap BEFORE the transaction import", async () => {
    const callOrder: string[] = [];
    mockImportSubsidiaries.mockImplementation(async () => {
      callOrder.push("subs");
      return okBootstrapResult;
    });
    mockImportAccountingBooks.mockImplementation(async () => {
      callOrder.push("books");
      return okBooksResult;
    });
    mockImportAccountingPeriods.mockImplementation(async () => {
      callOrder.push("periods");
      return okPeriodsResult;
    });
    mockImportFromNs.mockImplementation(async () => {
      callOrder.push("tx");
      return okTxResult;
    });

    await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: {
        subsidiaries: baseSubs,
        accountingBooks: [
          {
            internalid: "1",
            name: "US GAAP",
            base_currency: "USD",
            accounting_standard: "US_GAAP",
            is_inactive: false,
          },
        ],
        accountingPeriods: [
          {
            internalid: "100",
            name: "Jan 2026",
            start_date: "2026-01-01",
            end_date: "2026-01-31",
            fiscal_year: 2026,
            month: 1,
            status: "open",
          },
        ],
      },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(callOrder).toEqual(["subs", "books", "periods", "tx"]);
  });

  it("skips accountingBooks step when array is omitted", async () => {
    await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(mockImportAccountingBooks).not.toHaveBeenCalled();
  });

  it("skips accountingPeriods step when array is omitted", async () => {
    await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(mockImportAccountingPeriods).not.toHaveBeenCalled();
  });
});

describe("importFromNsWithBootstrap — code resolution", () => {
  it("resolves the primary subsidiary's entityCode via NSSUB-{id}", async () => {
    const r = await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(r.resolvedCodes.entityCode).toBe("NSSUB-9");
  });

  it("resolves the primary book's bookCode via NSBOOK-{id}", async () => {
    const r = await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      primaryBookId: "1",
      transactionImport: { export: {} },
    });

    expect(r.resolvedCodes.bookCode).toBe("NSBOOK-1");
  });

  it("falls back to US_GAAP when primaryBookId is omitted", async () => {
    const r = await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(r.resolvedCodes.bookCode).toBe("US_GAAP");
  });

  it("resolves the fiscalCalendarCode using the primary subsidiary's fiscal_calendar", async () => {
    const r = await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(r.resolvedCodes.fiscalCalendarCode).toBe(
      "NSSUB-9-CAL-STANDARD_2026"
    );
  });

  it("passes the resolved entityCode + bookCode to importFromNs", async () => {
    await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "10",
      primaryBookId: "2",
      transactionImport: { export: {} },
    });

    const call = mockImportFromNs.mock.calls[0]![1] as {
      entityCode: string;
      bookCode: string;
    };
    expect(call.entityCode).toBe("NSSUB-10");
    expect(call.bookCode).toBe("NSBOOK-2");
  });
});

describe("importFromNsWithBootstrap — input validation", () => {
  it("throws when primarySubsidiaryId is not in bootstrap.subsidiaries", async () => {
    await expect(
      importFromNsWithBootstrap(fakePrisma, {
        tenantId: "tenant-1",
        bootstrap: { subsidiaries: baseSubs },
        primarySubsidiaryId: "999",
        transactionImport: { export: {} },
      })
    ).rejects.toThrow(/primarySubsidiaryId 999 not found/);
  });
});

describe("importFromNsWithBootstrap — result shape", () => {
  it("returns the bootstrap results + transaction result + resolved codes", async () => {
    const r = await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: {
        subsidiaries: baseSubs,
        accountingBooks: [
          {
            internalid: "1",
            name: "US GAAP",
            base_currency: "USD",
            accounting_standard: "US_GAAP",
            is_inactive: false,
          },
        ],
        accountingPeriods: [
          {
            internalid: "100",
            name: "Jan 2026",
            start_date: "2026-01-01",
            end_date: "2026-01-31",
            fiscal_year: 2026,
            month: 1,
            status: "open",
          },
        ],
      },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(r.bootstrap.subsidiaries).toEqual(okBootstrapResult);
    expect(r.bootstrap.accountingBooks).toEqual(okBooksResult);
    expect(r.bootstrap.accountingPeriods).toEqual(okPeriodsResult);
    expect(r.transactions).toEqual(okTxResult);
    expect(r.resolvedCodes.entityCode).toBe("NSSUB-9");
  });

  it("returns null for accountingPeriods when omitted", async () => {
    const r = await importFromNsWithBootstrap(fakePrisma, {
      tenantId: "tenant-1",
      bootstrap: { subsidiaries: baseSubs },
      primarySubsidiaryId: "9",
      transactionImport: { export: {} },
    });

    expect(r.bootstrap.accountingPeriods).toBeNull();
  });
});
