// Report Builder PR 10 — Zod schema for ReportTemplateDefinition.
//
// Validates user-supplied JSON before persisting to ReportTemplate. The
// types in `./types.ts` are the authority; this file mirrors them at
// runtime so any malformed input gets rejected at the Server Action
// boundary.
//
// Use cases:
// - `updateReportTemplateDefinition` Server Action: parse + validate
//   pasted JSON, reject with structured error if shape is wrong
// - Future PRs (per-row form editor) can re-use the same schema as the
//   validator gate
//
// Cross-references between rows / columns (FORMULA add[] pointing at a
// non-existent row id, SUBTOTAL childIds, VARIANCE column.from/to) are
// NOT enforced by the Zod schema directly — they're enforced by a
// second-pass `validateDefinitionIntegrity` helper after the structural
// parse. Splitting concerns keeps Zod errors readable.

import { z } from "zod";

// ─── Layer 2: Rows ──────────────────────────────────────────────────────

const AccountTypeSchema = z.enum([
  "ASSET",
  "LIABILITY",
  "EQUITY",
  "REVENUE",
  "EXPENSE",
]);

export const AccountFilterSchema = z
  .object({
    types: z.array(AccountTypeSchema).optional(),
    subtypes: z.array(z.string().min(1)).optional(),
    parentCodes: z.array(z.string().min(1)).optional(),
    includeCodes: z.array(z.string().min(1)).optional(),
    excludeCodes: z.array(z.string().min(1)).optional(),
    excludeSubtypes: z.array(z.string().min(1)).optional(),
  })
  .strict();

const ROW_ID_REGEX = /^[a-zA-Z0-9_]+$/;
const ROW_ID_OR_REF_REGEX = /^@[A-Z0-9]+\.[a-zA-Z0-9_]+$|^[a-zA-Z0-9_]+$/;

const RowAccountsSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("ACCOUNTS"),
    label: z.string().min(1).max(120),
    filter: AccountFilterSchema,
    signFlip: z.boolean().optional(),
    showAccountDetail: z.boolean().optional(),
  })
  .strict();

const RowSubtotalSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("SUBTOTAL"),
    label: z.string().min(1).max(120),
    childIds: z.array(z.string().min(1).regex(ROW_ID_REGEX)).min(1),
    signFlip: z.boolean().optional(),
  })
  .strict();

const RowFormulaSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("FORMULA"),
    label: z.string().min(1).max(120),
    // add[] / subtract[] entries may be local row ids OR cross-template
    // aliases like "@IS.ni".
    add: z.array(z.string().regex(ROW_ID_OR_REF_REGEX)).optional(),
    subtract: z.array(z.string().regex(ROW_ID_OR_REF_REGEX)).optional(),
  })
  .strict();

const RowPeriodDeltaSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("PERIOD_DELTA"),
    label: z.string().min(1).max(120),
    filter: AccountFilterSchema,
    direction: z.enum(["increase", "decrease"]).optional(),
  })
  .strict();

const RowSpacerSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("SPACER"),
  })
  .strict();

const RowHeaderSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("HEADER"),
    label: z.string().min(1).max(120),
  })
  .strict();

export const RowDefSchema = z.discriminatedUnion("kind", [
  RowAccountsSchema,
  RowSubtotalSchema,
  RowFormulaSchema,
  RowPeriodDeltaSchema,
  RowSpacerSchema,
  RowHeaderSchema,
]);

// ─── Layer 3: Columns ───────────────────────────────────────────────────

const DATE_ISO_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const ColumnScopeSchema = z
  .object({
    entityCode: z.string().min(1).max(60),
    bookCode: z.string().min(1).max(60),
    asOf: z.string().regex(DATE_ISO_REGEX).optional(),
    period: z
      .object({
        fromDate: z.string().regex(DATE_ISO_REGEX),
        toDate: z.string().regex(DATE_ISO_REGEX),
      })
      .strict()
      .optional(),
    currencyCode: z.string().min(1).max(10).optional(),
  })
  .strict();

const BasisSchema = z.enum(["MONTH", "QUARTER", "YEAR", "YTD", "QTD"]);

const PeriodOffsetSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("current"),
      basis: BasisSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("prior"),
      basis: BasisSchema,
      offset: z.number().int().min(1).max(60),
    })
    .strict(),
  z
    .object({
      type: z.literal("absolute"),
      asOf: z.string().regex(DATE_ISO_REGEX).optional(),
      fromDate: z.string().regex(DATE_ISO_REGEX).optional(),
      toDate: z.string().regex(DATE_ISO_REGEX).optional(),
    })
    .strict(),
]);

// NB: the "scope OR offset must be set" constraint is checked in
// validateDefinitionIntegrity, not here — Zod's discriminatedUnion does
// not accept ZodEffects (the type that `.refine` produces), so the
// structural schema stays a plain ZodObject and the cross-field rule
// lives in the integrity pass.
const ColumnScopeKindSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("SCOPE"),
    label: z.string().min(1).max(120),
    scope: ColumnScopeSchema.optional(),
    offset: PeriodOffsetSchema.optional(),
    accountFilter: AccountFilterSchema.optional(),
  })
  .strict();

const ColumnVarianceSchema = z
  .object({
    id: z.string().min(1).max(60).regex(ROW_ID_REGEX),
    kind: z.literal("VARIANCE"),
    label: z.string().min(1).max(120),
    from: z.string().regex(ROW_ID_REGEX),
    to: z.string().regex(ROW_ID_REGEX),
    format: z.enum(["money", "percent"]),
  })
  .strict();

export const ColumnDefSchema = z.discriminatedUnion("kind", [
  ColumnScopeKindSchema,
  ColumnVarianceSchema,
]);

// ─── Layer 4: Template definition ───────────────────────────────────────

const ReportPresentationSchema = z
  .object({
    moneyFormat: z
      .object({
        decimals: z.number().int().min(0).max(8),
        thousands: z.boolean(),
        parens: z.boolean(),
      })
      .strict()
      .optional(),
    showDrillDown: z.boolean().optional(),
    showAccountCodes: z.boolean().optional(),
  })
  .strict();

const CrossTemplateReferenceSchema = z
  .object({
    alias: z.string().regex(/^@[A-Z0-9]+\.[a-zA-Z0-9_]+$/),
    templateCode: z.string().min(1).max(60),
    rowId: z.string().min(1).max(60).regex(ROW_ID_REGEX),
  })
  .strict();

export const ReportTemplateDefinitionSchema = z
  .object({
    // Bound the size to keep DB rows + audit metadata sane. A real
    // template tops out around 30 rows / 6 columns; 256 is generous.
    rows: z.array(RowDefSchema).min(1).max(256),
    columns: z.array(ColumnDefSchema).min(1).max(64),
    presentation: ReportPresentationSchema,
    references: z.array(CrossTemplateReferenceSchema).optional(),
  })
  .strict();

// ─── Integrity helper (second-pass) ─────────────────────────────────────

export interface DefinitionIntegrityIssue {
  rowOrColumnId: string;
  message: string;
}

/**
 * Cross-reference + uniqueness validation that doesn't fit Zod's
 * declarative shape:
 *  - row ids unique
 *  - column ids unique
 *  - SUBTOTAL.childIds reference existing earlier row ids
 *  - FORMULA add[]/subtract[] non-aliased entries reference existing
 *    earlier row ids
 *  - VARIANCE.from / .to reference existing column ids
 *  - References to @TEMPLATE.row pass through (validated by alias regex
 *    only; cross-template resolution happens at render time)
 *
 * Returns a list of issues. Empty list = valid.
 */
export function validateDefinitionIntegrity(
  def: z.infer<typeof ReportTemplateDefinitionSchema>
): DefinitionIntegrityIssue[] {
  const issues: DefinitionIntegrityIssue[] = [];

  // Row ids unique + indexed for ref lookups.
  const rowIds = new Set<string>();
  const seenRowIdsByOrder: string[] = [];
  for (const row of def.rows) {
    if (rowIds.has(row.id)) {
      issues.push({
        rowOrColumnId: row.id,
        message: `Duplicate row id "${row.id}"`,
      });
    }
    rowIds.add(row.id);
    seenRowIdsByOrder.push(row.id);
  }

  // Column ids unique.
  const colIds = new Set<string>();
  for (const col of def.columns) {
    if (colIds.has(col.id)) {
      issues.push({
        rowOrColumnId: col.id,
        message: `Duplicate column id "${col.id}"`,
      });
    }
    colIds.add(col.id);
  }

  // Reference checks per row kind.
  for (const row of def.rows) {
    const seenSoFar = new Set(
      seenRowIdsByOrder.slice(0, seenRowIdsByOrder.indexOf(row.id))
    );
    if (row.kind === "SUBTOTAL") {
      for (const childId of row.childIds) {
        if (!seenSoFar.has(childId)) {
          issues.push({
            rowOrColumnId: row.id,
            message: `SUBTOTAL row "${row.id}" references unknown or forward row id "${childId}"`,
          });
        }
      }
    }
    if (row.kind === "FORMULA") {
      for (const ref of [...(row.add ?? []), ...(row.subtract ?? [])]) {
        if (ref.startsWith("@")) continue; // cross-template alias, resolved at render
        if (!seenSoFar.has(ref)) {
          issues.push({
            rowOrColumnId: row.id,
            message: `FORMULA row "${row.id}" references unknown or forward row id "${ref}"`,
          });
        }
      }
    }
  }

  // SCOPE columns must have either `scope` or `offset` set (column
  // engine throws at render time otherwise). Catch pre-persist.
  for (const col of def.columns) {
    if (col.kind === "SCOPE") {
      if (col.scope == null && col.offset == null) {
        issues.push({
          rowOrColumnId: col.id,
          message: `SCOPE column "${col.id}" must have either \`scope\` or \`offset\` set`,
        });
      }
    }
  }

  // Variance column references.
  for (const col of def.columns) {
    if (col.kind === "VARIANCE") {
      if (!colIds.has(col.from)) {
        issues.push({
          rowOrColumnId: col.id,
          message: `VARIANCE column "${col.id}" references unknown column "${col.from}"`,
        });
      }
      if (!colIds.has(col.to)) {
        issues.push({
          rowOrColumnId: col.id,
          message: `VARIANCE column "${col.id}" references unknown column "${col.to}"`,
        });
      }
    }
  }

  return issues;
}
