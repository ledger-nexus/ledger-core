// Tests for the NetSuite bootstrap mappers (Subsidiary + AccountingBook
// + AccountingPeriod). Pure-function level — no DB involved.
//
// The import-orchestrator functions (importSubsidiaries,
// importAccountingBooks, importAccountingPeriods) need real Postgres
// + a Tenant + a Currency; their integration tests live in
// tests/netsuite-bootstrap-import.test.ts (when added).

import { describe, it, expect } from "vitest";
import {
  mapNsSubsidiary,
  mapNsAccountingBook,
  mapNsAccountingPeriod,
  nsSubsidiaryCode,
  nsBookCode,
  nsCalendarCode,
  nsPeriodCode,
  type NsSubsidiaryBootstrap,
  type NsAccountingBookBootstrap,
  type NsAccountingPeriodBootstrap,
} from "../src/lib/mappers/netsuite/bootstrap";

describe("nsSubsidiaryCode + nsBookCode (code conventions)", () => {
  it("prefixes subsidiary IDs with NSSUB-", () => {
    expect(nsSubsidiaryCode("9")).toBe("NSSUB-9");
    expect(nsSubsidiaryCode("abc-123")).toBe("NSSUB-abc-123");
  });

  it("prefixes book IDs with NSBOOK-", () => {
    expect(nsBookCode("1")).toBe("NSBOOK-1");
  });

  it("nsCalendarCode uses per-entity prefix to satisfy FiscalCalendar.entityId FK", () => {
    expect(nsCalendarCode("NSSUB-9", "Standard 2026")).toBe(
      "NSSUB-9-CAL-STANDARD_2026"
    );
    expect(nsCalendarCode("NSSUB-9")).toBe("NSSUB-9-CAL-DEFAULT");
  });

  it("nsPeriodCode handles year / quarter / month variants", () => {
    expect(
      nsPeriodCode({
        internalid: "1",
        name: "FY 2026",
        start_date: "2026-01-01",
        end_date: "2026-12-31",
        fiscal_year: 2026,
        status: "open",
        is_year: true,
      })
    ).toBe("2026");

    expect(
      nsPeriodCode({
        internalid: "2",
        name: "Q1 2026",
        start_date: "2026-01-01",
        end_date: "2026-03-31",
        fiscal_year: 2026,
        quarter: 1,
        status: "open",
        is_quarter: true,
      })
    ).toBe("2026-Q1");

    expect(
      nsPeriodCode({
        internalid: "3",
        name: "Jan 2026",
        start_date: "2026-01-01",
        end_date: "2026-01-31",
        fiscal_year: 2026,
        month: 1,
        status: "closed",
      })
    ).toBe("2026-01");
  });
});

describe("mapNsSubsidiary", () => {
  const baseNs: NsSubsidiaryBootstrap = {
    internalid: "9",
    name: "Parent Co",
    legal_name: "Parent Co, Inc.",
    country: "US",
    state: "DE",
    base_currency: "USD",
    functional_currency: "USD",
    fiscal_calendar: "Standard 2026",
    parent_subsidiary_id: null,
    is_elimination: false,
    is_inactive: false,
    consolidation_method: "full",
    accounting_standard: "US_GAAP",
  };

  it("translates the basic fields", () => {
    const m = mapNsSubsidiary(baseNs);
    expect(m.code).toBe("NSSUB-9");
    expect(m.name).toBe("Parent Co, Inc."); // legal_name preferred
    expect(m.functionalCurrencyCode).toBe("USD");
    expect(m.parentEntityCode).toBeNull();
    expect(m.fiscalCalendarCode).toBe("NSSUB-9-CAL-STANDARD_2026");
    expect(m.sourceSystem).toBe("NETSUITE");
    expect(m.sourceRecordType).toBe("Subsidiary");
    expect(m.sourceRecordId).toBe("9");
  });

  it("preserves NetSuite-only fields in extensions (not on the LegalEntity schema)", () => {
    const m = mapNsSubsidiary(baseNs);
    expect(m.extensions.isElimination).toBe(false);
    expect(m.extensions.consolidationMethod).toBe("FULL");
    expect(m.extensions.country).toBe("US");
    expect(m.extensions.state).toBe("DE");
    expect(m.extensions.accountingStandard).toBe("US_GAAP");
  });

  it("preserves the entire NetSuite payload in sourcePayload (for roundtrip)", () => {
    const m = mapNsSubsidiary(baseNs);
    expect(m.sourcePayload).toEqual(baseNs);
  });

  it("falls back to name when legal_name is absent", () => {
    const m = mapNsSubsidiary({ ...baseNs, legal_name: undefined });
    expect(m.name).toBe("Parent Co");
  });

  it("falls back to base_currency when functional_currency is absent", () => {
    const m = mapNsSubsidiary({
      ...baseNs,
      functional_currency: undefined,
      base_currency: "EUR",
    });
    expect(m.functionalCurrencyCode).toBe("EUR");
  });

  it("maps consolidation_method enum (full → FULL, equity → EQUITY, cost → COST)", () => {
    expect(
      mapNsSubsidiary({ ...baseNs, consolidation_method: "full" }).extensions
        .consolidationMethod
    ).toBe("FULL");
    expect(
      mapNsSubsidiary({ ...baseNs, consolidation_method: "equity" })
        .extensions.consolidationMethod
    ).toBe("EQUITY");
    expect(
      mapNsSubsidiary({ ...baseNs, consolidation_method: "cost" }).extensions
        .consolidationMethod
    ).toBe("COST");
  });

  it("defaults to FULL when consolidation_method is absent", () => {
    expect(
      mapNsSubsidiary({ ...baseNs, consolidation_method: undefined })
        .extensions.consolidationMethod
    ).toBe("FULL");
  });

  it("translates parent_subsidiary_id to parentEntityCode", () => {
    const m = mapNsSubsidiary({ ...baseNs, parent_subsidiary_id: "1" });
    expect(m.parentEntityCode).toBe("NSSUB-1");
  });

  it("preserves is_elimination flag (substrate handles intercompany via account subtypes, not entity flag)", () => {
    expect(
      mapNsSubsidiary({ ...baseNs, is_elimination: true }).extensions
        .isElimination
    ).toBe(true);
  });
});

describe("mapNsAccountingBook", () => {
  const baseNs: NsAccountingBookBootstrap = {
    internalid: "1",
    name: "US GAAP",
    base_currency: "USD",
    accounting_standard: "US_GAAP",
    is_inactive: false,
  };

  it("translates the basic fields", () => {
    const m = mapNsAccountingBook(baseNs);
    expect(m.code).toBe("NSBOOK-1");
    expect(m.name).toBe("US GAAP");
    expect(m.basis).toBe("US_GAAP");
    expect(m.reportingCurrencyCode).toBe("USD");
    expect(m.active).toBe(true);
  });

  it("maps accounting_standard variants to BookBasis enum", () => {
    expect(mapNsAccountingBook({ ...baseNs, accounting_standard: "US_GAAP" }).basis).toBe("US_GAAP");
    expect(mapNsAccountingBook({ ...baseNs, accounting_standard: "GAAP" }).basis).toBe("US_GAAP");
    expect(mapNsAccountingBook({ ...baseNs, accounting_standard: "IFRS" }).basis).toBe("IFRS");
    expect(mapNsAccountingBook({ ...baseNs, accounting_standard: "TAX" }).basis).toBe("US_TAX");
  });

  it("falls back to STATUTORY for unknown accounting_standard", () => {
    expect(
      mapNsAccountingBook({ ...baseNs, accounting_standard: "LOCAL_DE_HGB" })
        .basis
    ).toBe("STATUTORY");
  });

  it("falls back to STATUTORY when accounting_standard is absent", () => {
    expect(
      mapNsAccountingBook({ ...baseNs, accounting_standard: undefined }).basis
    ).toBe("STATUTORY");
  });

  it("translates is_inactive to active (inverted)", () => {
    expect(mapNsAccountingBook({ ...baseNs, is_inactive: true }).active).toBe(false);
  });

  it("preserves sourcePayload", () => {
    const m = mapNsAccountingBook(baseNs);
    expect(m.sourcePayload).toEqual(baseNs);
  });
});

describe("mapNsAccountingPeriod", () => {
  const baseNs: NsAccountingPeriodBootstrap = {
    internalid: "1",
    name: "Jan 2026",
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    fiscal_year: 2026,
    month: 1,
    status: "open",
  };

  it("translates monthly period with correct ordinal", () => {
    const m = mapNsAccountingPeriod(baseNs, "NSSUB-9-CAL-STANDARD_2026");
    expect(m.code).toBe("2026-01");
    expect(m.ordinal).toBe(1);
    expect(m.startsOn).toBe("2026-01-01");
    expect(m.endsOn).toBe("2026-01-31");
    expect(m.status).toBe("OPEN");
    expect(m.fiscalCalendarCode).toBe("NSSUB-9-CAL-STANDARD_2026");
  });

  it("maps status closed → CLOSED", () => {
    const m = mapNsAccountingPeriod(
      { ...baseNs, status: "closed" },
      "NSSUB-9-CAL-STANDARD_2026"
    );
    expect(m.status).toBe("CLOSED");
  });

  it("preserves source lineage", () => {
    const m = mapNsAccountingPeriod(baseNs, "NSSUB-9-CAL-STANDARD_2026");
    expect(m.sourceSystem).toBe("NETSUITE");
    expect(m.sourceRecordType).toBe("AccountingPeriod");
    expect(m.sourceRecordId).toBe("1");
    expect(m.sourcePayload).toEqual(baseNs);
  });

  it("handles all 12 months correctly", () => {
    for (let month = 1; month <= 12; month++) {
      const m = mapNsAccountingPeriod(
        {
          internalid: `${month}`,
          name: `Month ${month}`,
          start_date: "2026-01-01",
          end_date: "2026-01-31",
          fiscal_year: 2026,
          month,
          status: "open",
        },
        "CAL-X"
      );
      expect(m.ordinal).toBe(month);
      expect(m.code).toBe(`2026-${String(month).padStart(2, "0")}`);
    }
  });
});
