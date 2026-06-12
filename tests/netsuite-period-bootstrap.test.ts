// Tests for the NetSuite AccountingPeriod bootstrap mappers — pure
// function level, no DB. Extracted from the chain's bootstrap-mapper
// suite (PR #43); the Subsidiary/Book halves were superseded by the
// landed setupSubsidiaries / setupBooks orchestrators.

import { describe, it, expect } from "vitest";
import {
  mapNsAccountingPeriod,
  nsCalendarCode,
  nsPeriodCode,
  type NsAccountingPeriodBootstrap,
} from "../src/lib/mappers/netsuite/periods";

describe("nsCalendarCode + nsPeriodCode (code conventions)", () => {
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

