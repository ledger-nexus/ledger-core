// Report Builder — system template type-contract validation.
//
// PR 1 of the report-builder arc ships the SCHEMA + TYPES + 4 system
// templates only. The actual row + column engines that RENDER these
// templates ship in PR 2 + PR 3.
//
// This test validates that the 4 system templates conform to the type
// contract (compile-time + structural checks). Render tests against
// Northwind seed data come in PR 2's test file.

import { describe, it, expect } from "vitest";

import {
  SYSTEM_TEMPLATES,
  INCOME_STATEMENT_TEMPLATE,
  BALANCE_SHEET_TEMPLATE,
  CASH_FLOW_TEMPLATE,
  EQUITY_TEMPLATE,
} from "@/lib/accounting/reports/builder/templates";
import type { RowDef, ColumnDef } from "@/lib/accounting/reports/builder/types";

describe("Report Builder — system template registry", () => {
  it("exports exactly 4 GAAP financial statements", () => {
    expect(SYSTEM_TEMPLATES).toHaveLength(4);
    const codes = SYSTEM_TEMPLATES.map((t) => t.code).sort();
    expect(codes).toEqual(["BS", "CF", "EQ", "IS"]);
  });

  it("every system template is marked isSystem: true", () => {
    for (const tmpl of SYSTEM_TEMPLATES) {
      expect(tmpl.isSystem).toBe(true);
    }
  });

  it("every system template has version 1 in the initial release", () => {
    for (const tmpl of SYSTEM_TEMPLATES) {
      expect(tmpl.version).toBe(1);
    }
  });

  it("template codes are unique across the registry", () => {
    const codes = SYSTEM_TEMPLATES.map((t) => t.code);
    const unique = new Set(codes);
    expect(unique.size).toBe(codes.length);
  });
});

describe("Report Builder — row + column contract checks", () => {
  function assertRowsValid(rows: RowDef[]): void {
    const ids = new Set<string>();
    for (const row of rows) {
      // Every row has a unique id.
      expect(ids.has(row.id), `Duplicate row id: ${row.id}`).toBe(false);
      ids.add(row.id);
    }
    // Every FORMULA / SUBTOTAL reference must resolve to an actual row
    // OR a cross-template alias starting with "@".
    for (const row of rows) {
      if (row.kind === "FORMULA") {
        const refs = [...(row.add ?? []), ...(row.subtract ?? [])];
        for (const ref of refs) {
          if (ref.startsWith("@")) continue; // cross-template alias, resolved later
          expect(
            ids.has(ref),
            `FORMULA row "${row.id}" references unknown row "${ref}"`
          ).toBe(true);
        }
      }
      if (row.kind === "SUBTOTAL") {
        for (const childId of row.childIds) {
          expect(
            ids.has(childId),
            `SUBTOTAL row "${row.id}" references unknown child "${childId}"`
          ).toBe(true);
        }
      }
    }
  }

  function assertColumnsValid(columns: ColumnDef[]): void {
    expect(columns.length).toBeGreaterThan(0);
    const ids = new Set<string>();
    for (const col of columns) {
      expect(ids.has(col.id), `Duplicate column id: ${col.id}`).toBe(false);
      ids.add(col.id);
    }
    // VARIANCE columns must reference real columns.
    for (const col of columns) {
      if (col.kind === "VARIANCE") {
        expect(ids.has(col.from), `VARIANCE references unknown column ${col.from}`).toBe(true);
        expect(ids.has(col.to), `VARIANCE references unknown column ${col.to}`).toBe(true);
      }
      if (col.kind === "SCOPE") {
        // Either scope or offset must be set (not both required, but at
        // least one).
        const hasScope = col.scope != null;
        const hasOffset = col.offset != null;
        expect(hasScope || hasOffset).toBe(true);
      }
    }
  }

  it("Income Statement: row references resolve", () => {
    assertRowsValid(INCOME_STATEMENT_TEMPLATE.definition.rows);
    assertColumnsValid(INCOME_STATEMENT_TEMPLATE.definition.columns);
  });

  it("Balance Sheet: row references resolve (cross-template ref OK)", () => {
    assertRowsValid(BALANCE_SHEET_TEMPLATE.definition.rows);
    assertColumnsValid(BALANCE_SHEET_TEMPLATE.definition.columns);
    // BS references @IS.ni via cross-template alias.
    expect(BALANCE_SHEET_TEMPLATE.definition.references).toBeDefined();
    expect(
      BALANCE_SHEET_TEMPLATE.definition.references!.find((r) => r.alias === "@IS.ni")
    ).toBeDefined();
  });

  it("Cash Flow Statement: row references resolve", () => {
    assertRowsValid(CASH_FLOW_TEMPLATE.definition.rows);
    assertColumnsValid(CASH_FLOW_TEMPLATE.definition.columns);
    expect(CASH_FLOW_TEMPLATE.definition.references).toBeDefined();
  });

  it("Statement of Stockholders' Equity: row references resolve", () => {
    assertRowsValid(EQUITY_TEMPLATE.definition.rows);
    assertColumnsValid(EQUITY_TEMPLATE.definition.columns);
    expect(EQUITY_TEMPLATE.definition.references).toBeDefined();
  });
});

describe("Report Builder — GAAP coverage check", () => {
  it("ledger-core ships ALL 4 GAAP financial statements via the builder", () => {
    // The whole point of PR 4 of the arc is the missing Equity statement.
    // Even at PR 1 (this PR), the template registry must declare it so
    // the arc's intent is captured.
    const labels = SYSTEM_TEMPLATES.map((t) => t.name);
    expect(labels).toContain("Income Statement");
    expect(labels).toContain("Balance Sheet");
    expect(labels).toContain("Statement of Cash Flows");
    expect(labels).toContain("Statement of Stockholders' Equity");
  });
});
