// Report Builder PR 10 — Zod schema + integrity-validation tests.
//
// Validates:
//   - Every system template (IS / BS / CF / EQ) parses cleanly through
//     ReportTemplateDefinitionSchema. Surfaces drift between TS types
//     and Zod schema at CI time.
//   - validateDefinitionIntegrity returns empty arrays for all system
//     templates.
//   - validateDefinitionIntegrity catches concrete cases: duplicate row
//     ids, FORMULA-references-forward-row, SUBTOTAL-references-missing-
//     child, VARIANCE-references-missing-column, cross-template @alias
//     pass-through.
//   - Bad input shapes get rejected: extra unknown property, invalid
//     row.kind, invalid date format, missing required field.

import { describe, expect, it } from "vitest";

import {
  SYSTEM_TEMPLATES,
  INCOME_STATEMENT_TEMPLATE,
  BALANCE_SHEET_TEMPLATE,
  CASH_FLOW_TEMPLATE,
  EQUITY_TEMPLATE,
} from "@/lib/accounting/reports/builder/templates";
import {
  ReportTemplateDefinitionSchema,
  validateDefinitionIntegrity,
} from "@/lib/accounting/reports/builder/schema";

describe("Report Builder PR 10 — system templates conform to schema", () => {
  it.each(SYSTEM_TEMPLATES)("$code template parses cleanly", (t) => {
    const result = ReportTemplateDefinitionSchema.safeParse(t.definition);
    if (!result.success) {
      // Surface what failed so drift is obvious in CI.
      throw new Error(
        `${t.code} schema validation failed: ${JSON.stringify(result.error.errors)}`
      );
    }
    expect(result.success).toBe(true);
  });

  it.each(SYSTEM_TEMPLATES)("$code template has zero integrity issues", (t) => {
    const parsed = ReportTemplateDefinitionSchema.parse(t.definition);
    expect(validateDefinitionIntegrity(parsed)).toEqual([]);
  });
});

describe("Report Builder PR 10 — validateDefinitionIntegrity catches", () => {
  it("duplicate row ids", () => {
    const def = ReportTemplateDefinitionSchema.parse({
      rows: [
        { id: "dup", kind: "HEADER", label: "First" },
        { id: "dup", kind: "HEADER", label: "Second" },
      ],
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Current",
          offset: { type: "current", basis: "MONTH" },
        },
      ],
      presentation: {},
    });
    const issues = validateDefinitionIntegrity(def);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]!.message).toMatch(/Duplicate row id/);
  });

  it("FORMULA referencing a forward-declared row id", () => {
    const def = ReportTemplateDefinitionSchema.parse({
      rows: [
        // FORMULA refers to "rev" but rev is declared AFTER ni in the
        // array, so the row engine would warn at runtime — schema
        // integrity also catches it pre-persist.
        { id: "ni", kind: "FORMULA", label: "Net income", add: ["rev"] },
        {
          id: "rev",
          kind: "ACCOUNTS",
          label: "Revenue",
          filter: { types: ["REVENUE"] },
        },
      ],
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Current",
          offset: { type: "current", basis: "MONTH" },
        },
      ],
      presentation: {},
    });
    const issues = validateDefinitionIntegrity(def);
    expect(issues.some((i) => /forward row id/.test(i.message))).toBe(true);
  });

  it("SUBTOTAL referencing a missing child", () => {
    const def = ReportTemplateDefinitionSchema.parse({
      rows: [
        {
          id: "rev",
          kind: "ACCOUNTS",
          label: "Revenue",
          filter: { types: ["REVENUE"] },
        },
        {
          id: "total",
          kind: "SUBTOTAL",
          label: "Total",
          childIds: ["rev", "missing_child"],
        },
      ],
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Current",
          offset: { type: "current", basis: "MONTH" },
        },
      ],
      presentation: {},
    });
    const issues = validateDefinitionIntegrity(def);
    expect(issues.some((i) => /missing_child/.test(i.message))).toBe(true);
  });

  it("VARIANCE referencing missing columns", () => {
    const def = ReportTemplateDefinitionSchema.parse({
      rows: [{ id: "rev", kind: "HEADER", label: "Revenue" }],
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Current",
          offset: { type: "current", basis: "MONTH" },
        },
        {
          id: "vari",
          kind: "VARIANCE",
          label: "Variance",
          from: "missing_from",
          to: "c1",
          format: "money",
        },
      ],
      presentation: {},
    });
    const issues = validateDefinitionIntegrity(def);
    expect(issues.some((i) => /missing_from/.test(i.message))).toBe(true);
  });

  it("cross-template @alias FORMULA refs pass integrity (resolved at render)", () => {
    const def = ReportTemplateDefinitionSchema.parse({
      rows: [
        {
          id: "re",
          kind: "FORMULA",
          label: "Retained earnings",
          add: ["@IS.ni"],
        },
      ],
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Current",
          offset: { type: "current", basis: "MONTH" },
        },
      ],
      presentation: {},
    });
    const issues = validateDefinitionIntegrity(def);
    // The @IS.ni alias is resolved at render time, so integrity check
    // should not flag it as a missing row reference.
    expect(issues.length).toBe(0);
  });
});

describe("Report Builder PR 10 — schema rejects malformed input", () => {
  const baseValid = {
    rows: [{ id: "h", kind: "HEADER" as const, label: "Section" }],
    columns: [
      {
        id: "c1",
        kind: "SCOPE" as const,
        label: "Current",
        offset: { type: "current" as const, basis: "MONTH" as const },
      },
    ],
    presentation: {},
  };

  it("rejects unknown extra property (strict mode)", () => {
    const bad: unknown = { ...baseValid, malicious: "extra-field" };
    const r = ReportTemplateDefinitionSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects unknown row.kind", () => {
    const bad: unknown = {
      ...baseValid,
      rows: [{ id: "x", kind: "UNKNOWN_KIND", label: "Bad" }],
    };
    const r = ReportTemplateDefinitionSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects invalid date string in column scope", () => {
    const bad: unknown = {
      ...baseValid,
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Bad date",
          scope: {
            entityCode: "ACME",
            bookCode: "US_GAAP",
            asOf: "not-a-date",
          },
        },
      ],
    };
    const r = ReportTemplateDefinitionSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("integrity check catches SCOPE column missing both scope AND offset", () => {
    // Structural Zod accepts this (both fields are optional), but the
    // integrity helper flags it — column engine would throw at render
    // time. Moved here from the Zod rejection set because
    // discriminatedUnion doesn't accept ZodEffects from `.refine`.
    const def = ReportTemplateDefinitionSchema.parse({
      ...baseValid,
      columns: [
        {
          id: "c1",
          kind: "SCOPE",
          label: "Neither set",
        },
      ],
    });
    const issues = validateDefinitionIntegrity(def);
    expect(issues.some((i) => /must have either/.test(i.message))).toBe(true);
  });

  it("rejects rows array smaller than 1", () => {
    const bad: unknown = { ...baseValid, rows: [] };
    const r = ReportTemplateDefinitionSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });

  it("rejects row.id with disallowed characters", () => {
    const bad: unknown = {
      ...baseValid,
      rows: [{ id: "has-dashes-and-spaces ", kind: "HEADER", label: "Bad" }],
    };
    const r = ReportTemplateDefinitionSchema.safeParse(bad);
    expect(r.success).toBe(false);
  });
});

// Spot-check explicit template imports to confirm export wiring.
describe("Report Builder PR 10 — template-by-template Zod parse", () => {
  it("IS template parses + zero integrity issues", () => {
    const def = ReportTemplateDefinitionSchema.parse(INCOME_STATEMENT_TEMPLATE.definition);
    expect(validateDefinitionIntegrity(def)).toEqual([]);
  });
  it("BS template parses + zero integrity issues", () => {
    const def = ReportTemplateDefinitionSchema.parse(BALANCE_SHEET_TEMPLATE.definition);
    expect(validateDefinitionIntegrity(def)).toEqual([]);
  });
  it("CF template parses + zero integrity issues", () => {
    const def = ReportTemplateDefinitionSchema.parse(CASH_FLOW_TEMPLATE.definition);
    expect(validateDefinitionIntegrity(def)).toEqual([]);
  });
  it("EQ template parses + zero integrity issues", () => {
    const def = ReportTemplateDefinitionSchema.parse(EQUITY_TEMPLATE.definition);
    expect(validateDefinitionIntegrity(def)).toEqual([]);
  });
});
