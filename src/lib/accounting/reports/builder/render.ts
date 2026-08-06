// Layer 4: renderTemplate orchestrator.
//
// Top-level entry point that:
//   1. Resolves cross-template references (evaluates dependencies first)
//   2. Calls the column engine for the requested template
//   3. Returns a RenderedMatrix
//
// Dependency graph for the 4 system templates:
//   IS         → no dependencies
//   BS         → depends on IS (for retained_earnings = @IS.ni)
//   CF         → depends on IS (for net_income = @IS.ni)
//   EQ         → depends on IS (for net_income = @IS.ni)
//
// v1 hard-codes the dependency: if the template's `references` array
// includes an "@IS.*" alias, we evaluate IS first, extract the rowId
// value (from the first SCOPE column), and pass it via
// crossTemplateValues.
//
// PR 4+ may generalize to a DAG resolver — for now, IS is the only
// upstream dependency in the system templates.

import { Decimal } from "@/lib/utils/decimal";

import { runColumnEngine, type ColumnEngineOptions } from "./column-engine";
import { INCOME_STATEMENT_TEMPLATE } from "./templates/income-statement";
import type { ReportTemplate, RenderedMatrix } from "./types";
import type { DbClient } from "@/lib/db";


export interface RenderOptions {
  asOfDate: Date;
  entityCode: string;
  bookCode: string;
  tenantId?: string;
}

/**
 * Render a ReportTemplate against the given scope.
 *
 * Resolves cross-template @TEMPLATE.row references by evaluating
 * upstream templates first (v1: only IS is a documented upstream).
 */
export async function renderTemplate(
  prisma: DbClient,
  template: ReportTemplate,
  options: RenderOptions
): Promise<RenderedMatrix> {
  const crossTemplateValues = await resolveCrossTemplateRefs(prisma, template, options);

  const columnOptions: ColumnEngineOptions = {
    asOfDate: options.asOfDate,
    entityCode: options.entityCode,
    bookCode: options.bookCode,
    tenantId: options.tenantId,
    crossTemplateValues,
  };

  return runColumnEngine(prisma, template, columnOptions);
}

async function resolveCrossTemplateRefs(
  prisma: DbClient,
  template: ReportTemplate,
  options: RenderOptions
): Promise<Map<string, Decimal>> {
  const values = new Map<string, Decimal>();
  const refs = template.definition.references ?? [];
  if (refs.length === 0) return values;

  // For v1, only "@IS.*" upstream references are supported. If any
  // ref targets a different template, log a warning but proceed.
  for (const ref of refs) {
    if (ref.templateCode !== "IS") {
      // v2 will generalize. For now, leave unresolved (the row engine
      // will warn at render time).
      continue;
    }

    // Render IS, extract the referenced row's value (from its first
    // SCOPE column — IS has only one column in the system template).
    const isMatrix = await runColumnEngine(prisma, INCOME_STATEMENT_TEMPLATE, {
      asOfDate: options.asOfDate,
      entityCode: options.entityCode,
      bookCode: options.bookCode,
      tenantId: options.tenantId,
    });
    const isRow = isMatrix.rows.find((r) => r.id === ref.rowId);
    if (!isRow) {
      // Referenced row id doesn't exist on IS — skip; downstream will
      // get an "unresolved" warning.
      continue;
    }
    // Use the first column's cell value.
    const cellValue = isRow.cells[0]?.value ?? "0";
    values.set(ref.alias, new Decimal(cellValue));
  }

  return values;
}
