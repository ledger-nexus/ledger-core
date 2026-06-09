// Report Builder PR 8 — Generic React-PDF document for any RenderedMatrix.
//
// Takes a marshaled (Decimal → string) RenderedMatrix plus the scope
// context and renders a printable PDF. Template-agnostic: works for any
// of the 4 GAAP statements OR a user-defined template. Same flavor as
// `renderedMatrixToCsv` — the renderer doesn't know template specifics.
//
// CPAs print these and hand them to auditors. The packet must be:
//   - Single-document (no missing pages)
//   - Tabular numbers (column-aligned via Courier monospace)
//   - Negative numbers visually distinct (parens, per accountant convention)
//   - Generated-at timestamp (provenance — when was the snapshot taken)
//   - Section headers + indented subtotals/formulas (visual hierarchy)

/* eslint-disable react/no-unknown-property */
// react-pdf's primitives use props (e.g. `fixed`, `wrap`) that ESLint
// flags as non-standard. They're correct for @react-pdf/renderer.

import * as React from "react";
import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";

// Shape of a marshaled cell (route handler converts Decimal.display to
// the typed string here; the component is pure presentation).
interface PdfCell {
  display: string;
}

interface PdfRow {
  id: string;
  label: string;
  cells: PdfCell[];
  isHeader: boolean;
  isSpacer: boolean;
  isFormula: boolean;
  isSubtotal: boolean;
}

interface PdfColumn {
  id: string;
  label: string;
}

export interface BuilderPdfProps {
  /** Template that produced this matrix. */
  template: { code: string; name: string; version: number };
  /** Scope context shown on cover (entity / book / asOf). */
  scope: { entityCode: string; bookCode: string; asOf: string };
  /** Column headers in render order. */
  columns: PdfColumn[];
  /** All rows, including SPACERs (rendered as gaps) + HEADERs. */
  rows: PdfRow[];
  /** Time at which the route handler captured the data — provenance. */
  generatedAt: string;
}

// ─── Styles ─────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    padding: 36,
    color: "#0f172a",
  },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 8 },
  scopeBar: {
    fontSize: 10,
    color: "#475569",
    marginBottom: 16,
    paddingBottom: 8,
    borderBottomWidth: 0.5,
    borderBottomColor: "#cbd5e1",
  },
  table: {
    flexDirection: "column",
    marginBottom: 12,
  },
  colHeaderRow: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
    paddingBottom: 4,
    marginBottom: 4,
    fontWeight: 700,
  },
  colHeaderLabel: {
    flex: 2,
    fontSize: 9,
  },
  colHeaderValue: {
    flex: 1,
    fontSize: 9,
    textAlign: "right",
    fontFamily: "Courier",
  },
  bodyRow: {
    flexDirection: "row",
    paddingVertical: 1.5,
  },
  bodySpacerRow: {
    height: 6,
  },
  bodyHeaderRow: {
    flexDirection: "row",
    backgroundColor: "#f1f5f9",
    paddingHorizontal: 2,
    paddingVertical: 2,
    marginTop: 4,
    marginBottom: 2,
  },
  bodyHeaderLabel: {
    flex: 1,
    fontSize: 9,
    fontWeight: 700,
  },
  bodySubtotalRow: {
    flexDirection: "row",
    paddingVertical: 1.5,
    fontWeight: 700,
    borderTopWidth: 0.5,
    borderTopColor: "#cbd5e1",
    marginTop: 2,
  },
  bodyFormulaRow: {
    flexDirection: "row",
    paddingVertical: 1.5,
    fontWeight: 700,
    fontStyle: "italic",
  },
  rowLabel: {
    flex: 2,
    paddingLeft: 2,
  },
  rowLabelIndent: {
    flex: 2,
    paddingLeft: 12,
  },
  rowValue: {
    flex: 1,
    textAlign: "right",
    fontFamily: "Courier",
  },
  footer: {
    position: "absolute",
    bottom: 16,
    left: 36,
    right: 36,
    fontSize: 7,
    color: "#94a3b8",
    flexDirection: "row",
    justifyContent: "space-between",
    borderTopWidth: 0.5,
    borderTopColor: "#cbd5e1",
    paddingTop: 4,
  },
});

// ─── Document ───────────────────────────────────────────────────────────

/**
 * Render a builder-produced RenderedMatrix as a PDF Document.
 *
 * v1 packs everything into a single Page with React-PDF's `wrap` auto-
 * pagination. For very long custom templates (hundreds of accounts), a
 * future enhancement could split per section/HEADER row.
 */
export function BuilderPdfDocument(props: BuilderPdfProps): React.ReactElement {
  const { template, scope, columns, rows, generatedAt } = props;

  return (
    <Document>
      <Page size="LETTER" style={styles.page} wrap>
        <Text style={styles.h1}>{template.name}</Text>
        <Text style={styles.scopeBar}>
          {scope.entityCode} / {scope.bookCode} · as of {scope.asOf}
        </Text>

        <View style={styles.table}>
          {/* Column header row (sticky-ish; React-PDF doesn't have CSS
              position: sticky but the visual divider keeps the header
              identifiable on page 2+). */}
          <View style={styles.colHeaderRow} fixed>
            <Text style={styles.colHeaderLabel}>Row</Text>
            {columns.map((col) => (
              <Text key={col.id} style={styles.colHeaderValue}>
                {col.label}
              </Text>
            ))}
          </View>

          {/* Body rows. Variants:
              - SPACER → vertical gap only
              - HEADER → boxed label, no values
              - SUBTOTAL / FORMULA → bold + top border, indented
              - regular ACCOUNTS → plain row */}
          {rows.map((row) => {
            if (row.isSpacer) {
              return <View key={row.id} style={styles.bodySpacerRow} />;
            }
            if (row.isHeader) {
              return (
                <View key={row.id} style={styles.bodyHeaderRow}>
                  <Text style={styles.bodyHeaderLabel}>{row.label}</Text>
                </View>
              );
            }
            const rowStyle = row.isSubtotal
              ? styles.bodySubtotalRow
              : row.isFormula
                ? styles.bodyFormulaRow
                : styles.bodyRow;
            const labelStyle =
              row.isSubtotal || row.isFormula
                ? styles.rowLabelIndent
                : styles.rowLabel;
            return (
              <View key={row.id} style={rowStyle} wrap={false}>
                <Text style={labelStyle}>{row.label}</Text>
                {row.cells.map((cell, idx) => (
                  <Text key={idx} style={styles.rowValue}>
                    {cell.display}
                  </Text>
                ))}
              </View>
            );
          })}
        </View>

        <View style={styles.footer} fixed>
          <Text>
            Generated {generatedAt} · Template {template.code} v{template.version}
          </Text>
          <Text
            render={({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
              `Page ${pageNumber} of ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}
