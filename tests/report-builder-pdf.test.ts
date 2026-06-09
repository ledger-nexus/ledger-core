// Report Builder PR 8 — PDF generation smoke test.
//
// THE POINT: prove that the builder PDF document actually compiles
// through @react-pdf/renderer's `renderToBuffer` and produces a real
// PDF binary (header `%PDF-`). Doesn't try to assert text layout —
// React-PDF rendering is enough surface to break on its own
// (StyleSheet mismatches, missing fonts, wrap loops).
//
// Uses synthesized RenderedMatrix shapes so the test is fast and
// hermetic — no DB. The full route integration is exercised by the
// route handler itself; this gates the component + props shape.

import { describe, it, expect } from "vitest";
import { renderToBuffer } from "@react-pdf/renderer";

import { BuilderPdfDocument } from "@/lib/accounting/reports/builder/pdf";

const FIXTURE_TEMPLATE = { code: "IS", name: "Income Statement", version: 1 };
const FIXTURE_SCOPE = {
  entityCode: "ACME",
  bookCode: "US_GAAP",
  asOf: "2026-03-31",
};

describe("BuilderPdfDocument — React-PDF generation", () => {
  it("renders a single-column IS-shaped matrix to a valid PDF buffer", async () => {
    const buffer = await renderToBuffer(
      BuilderPdfDocument({
        template: FIXTURE_TEMPLATE,
        scope: FIXTURE_SCOPE,
        columns: [{ id: "current", label: "Current period" }],
        rows: [
          {
            id: "header_rev",
            label: "Revenue",
            cells: [],
            isHeader: true,
            isSpacer: false,
            isFormula: false,
            isSubtotal: false,
          },
          {
            id: "rev",
            label: "Total revenue",
            cells: [{ display: "5,000.00" }],
            isHeader: false,
            isSpacer: false,
            isFormula: false,
            isSubtotal: false,
          },
          {
            id: "spacer_1",
            label: "",
            cells: [],
            isHeader: false,
            isSpacer: true,
            isFormula: false,
            isSubtotal: false,
          },
          {
            id: "header_exp",
            label: "Expenses",
            cells: [],
            isHeader: true,
            isSpacer: false,
            isFormula: false,
            isSubtotal: false,
          },
          {
            id: "exp",
            label: "Total expenses",
            cells: [{ display: "3,000.00" }],
            isHeader: false,
            isSpacer: false,
            isFormula: false,
            isSubtotal: false,
          },
          {
            id: "ni",
            label: "Net income",
            cells: [{ display: "2,000.00" }],
            isHeader: false,
            isSpacer: false,
            isFormula: true,
            isSubtotal: false,
          },
        ],
        generatedAt: "2026-06-09 12:00:00 UTC",
      })
    );

    // Smoke check: actual PDF binaries begin with `%PDF-`.
    expect(buffer.length).toBeGreaterThan(500);
    const head = buffer.slice(0, 5).toString("ascii");
    expect(head).toBe("%PDF-");
  });

  it("renders a multi-column matrix layout (Equity-shaped) without crashing", async () => {
    const buffer = await renderToBuffer(
      BuilderPdfDocument({
        template: { code: "EQ", name: "Statement of Stockholders' Equity", version: 2 },
        scope: FIXTURE_SCOPE,
        columns: [
          { id: "cs", label: "Common Stock" },
          { id: "apic", label: "APIC" },
          { id: "re", label: "Retained Earnings" },
          { id: "total", label: "Total" },
        ],
        rows: [
          {
            id: "balance",
            label: "Equity (ending)",
            cells: [
              { display: "50,000.00" },
              { display: "25,000.00" },
              { display: "0.00" },
              { display: "75,000.00" },
            ],
            isHeader: false,
            isSpacer: false,
            isFormula: false,
            isSubtotal: false,
          },
          {
            id: "ni",
            label: "Net income",
            cells: [
              { display: "4,000.00" },
              { display: "4,000.00" },
              { display: "4,000.00" },
              { display: "4,000.00" },
            ],
            isHeader: false,
            isSpacer: false,
            isFormula: true,
            isSubtotal: false,
          },
          {
            id: "total_row",
            label: "Total equity",
            cells: [
              { display: "54,000.00" },
              { display: "29,000.00" },
              { display: "4,000.00" },
              { display: "79,000.00" },
            ],
            isHeader: false,
            isSpacer: false,
            isFormula: false,
            isSubtotal: true,
          },
        ],
        generatedAt: "2026-06-09 12:00:00 UTC",
      })
    );
    expect(buffer.length).toBeGreaterThan(500);
    expect(buffer.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders an empty matrix (zero rows) without crashing", async () => {
    const buffer = await renderToBuffer(
      BuilderPdfDocument({
        template: FIXTURE_TEMPLATE,
        scope: FIXTURE_SCOPE,
        columns: [{ id: "c1", label: "Amount" }],
        rows: [],
        generatedAt: "2026-06-09 12:00:00 UTC",
      })
    );
    expect(buffer.length).toBeGreaterThan(200);
    expect(buffer.slice(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
