// React-PDF Document for the month-end packet.
//
// One Document with a Page per logical section:
//   - Cover page: entity / book / period / close status / tie-out
//   - Income statement
//   - Balance sheet
//   - Trial balance (multi-page if it overflows)
//
// Pure presentation — all data comes from the route handler that calls
// renderToStream(<MonthEndDocument {...props} />). React-PDF doesn't run
// in the browser; it generates a binary PDF on the server.

/* eslint-disable react/no-unknown-property */
// react-pdf's primitives use props (e.g. `fixed`, `wrap`) that ESLint flags
// as non-standard. They're correct for @react-pdf/renderer.

import * as React from "react";
import {
  Document,
  Page,
  Text,
  View,
  StyleSheet,
} from "@react-pdf/renderer";
import { Decimal } from "@/lib/utils/decimal";

// ─── Types — mirror the report functions' return shapes ────────────────

export interface MonthEndPdfProps {
  entity: { code: string; name: string };
  book: { code: string; name: string };
  period: { code: string; startsOn: string; endsOn: string };
  close: { closedAt: string; closedBy: string | null } | null;
  tieOuts: {
    tbTies: boolean;
    bsTies: boolean;
    // Recons signed off — BlackLine arc Phase 1 PR 8. null when no
    // recons opened for the period (renders as "n/a"). true = all
    // terminal (RECONCILED/WAIVED). false = anything outstanding.
    reconsAllDone: boolean | null;
    reconsDone: number;
    reconsTotal: number;
  };
  // Per-status histogram — null when no recons opened.
  reconRollup: {
    total: number;
    reconciled: number;
    waived: number;
    prepared: number;
    inProgress: number;
    open: number;
    exception: number;
    done: number;
    pctDone: number;
  } | null;
  incomeStatement: {
    revenue: { code: string; name: string; amount: string }[];
    expenses: { code: string; name: string; amount: string }[];
    totalRevenue: string;
    totalExpenses: string;
    netIncome: string;
  };
  balanceSheet: {
    assets: { code: string; name: string; amount: string }[];
    liabilities: { code: string; name: string; amount: string }[];
    equity: { code: string; name: string; amount: string }[];
    totalAssets: string;
    totalLiabilities: string;
    totalEquity: string;
  };
  trialBalance: {
    rows: {
      accountCode: string;
      accountName: string;
      type: string;
      debit: string;
      credit: string;
      balance: string;
    }[];
    totalDebit: string;
    totalCredit: string;
  };
  generatedAt: string;
}

// ─── Styles ────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  page: {
    fontFamily: "Helvetica",
    fontSize: 9,
    padding: 32,
    color: "#0f172a",
  },
  h1: { fontSize: 18, fontWeight: 700, marginBottom: 8 },
  h2: { fontSize: 13, fontWeight: 700, marginBottom: 6, marginTop: 8 },
  meta: { color: "#475569", marginBottom: 4 },
  metaRow: { flexDirection: "row", gap: 6, marginBottom: 2 },
  metaLabel: { width: 60, color: "#64748b" },
  metaValue: { flex: 1, fontFamily: "Courier" },
  tieOutRow: { flexDirection: "row", gap: 12, marginTop: 6 },
  tieOutOk: { color: "#047857" },
  tieOutFail: { color: "#b91c1c" },
  badgeOpen: {
    color: "#047857",
    backgroundColor: "#d1fae5",
    padding: 3,
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 700,
  },
  badgeClosed: {
    color: "#b91c1c",
    backgroundColor: "#fee2e2",
    padding: 3,
    borderRadius: 4,
    fontSize: 9,
    fontWeight: 700,
  },

  // Table
  table: { width: "100%", marginTop: 4 },
  thead: {
    flexDirection: "row",
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
    paddingBottom: 4,
    marginBottom: 2,
    fontWeight: 700,
  },
  trow: {
    flexDirection: "row",
    paddingVertical: 2,
    borderBottomWidth: 0.5,
    borderBottomColor: "#e2e8f0",
  },
  trowTotal: {
    flexDirection: "row",
    paddingTop: 4,
    paddingBottom: 2,
    borderTopWidth: 1,
    borderTopColor: "#0f172a",
    fontWeight: 700,
  },
  trowFinal: {
    flexDirection: "row",
    paddingTop: 4,
    borderTopWidth: 2,
    borderTopColor: "#0f172a",
    fontWeight: 700,
  },
  // Column widths
  colCode: { width: 50, fontFamily: "Courier" },
  colName: { flex: 1 },
  colType: { width: 60, fontFamily: "Courier", color: "#64748b" },
  colAmount: { width: 80, textAlign: "right", fontFamily: "Courier" },
  colAmountRight: { width: 90, textAlign: "right", fontFamily: "Courier" },

  footer: {
    position: "absolute",
    bottom: 16,
    left: 32,
    right: 32,
    fontSize: 8,
    color: "#94a3b8",
    flexDirection: "row",
    justifyContent: "space-between",
  },
});

// ─── Helpers ───────────────────────────────────────────────────────────

function formatMoney(value: string | Decimal): string {
  const num = value instanceof Decimal ? value.toNumber() : Number(value);
  if (Number.isNaN(num)) return "—";
  const abs = Math.abs(num).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return num < 0 ? `(${abs})` : abs;
}

function Footer({ generatedAt, entityCode, bookCode, periodCode }: {
  generatedAt: string;
  entityCode: string;
  bookCode: string;
  periodCode: string;
}) {
  return (
    <View style={styles.footer} fixed>
      <Text>
        {entityCode} · {bookCode} · {periodCode}
      </Text>
      <Text
        render={({ pageNumber, totalPages }) =>
          `Page ${pageNumber} of ${totalPages} · Generated ${generatedAt}`
        }
      />
    </View>
  );
}

// ─── Document ──────────────────────────────────────────────────────────

export function MonthEndDocument(props: MonthEndPdfProps) {
  const { entity, book, period, close, tieOuts } = props;
  const footerProps = {
    generatedAt: props.generatedAt,
    entityCode: entity.code,
    bookCode: book.code,
    periodCode: period.code,
  };

  return (
    <Document
      title={`Month-end packet — ${entity.code} ${book.code} ${period.code}`}
    >
      {/* ─── Cover ────────────────────────────────────────────────── */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Month-end packet</Text>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Entity</Text>
          <Text style={styles.metaValue}>
            {entity.code} — {entity.name}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Book</Text>
          <Text style={styles.metaValue}>
            {book.code} — {book.name}
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Period</Text>
          <Text style={styles.metaValue}>
            {period.code} ({period.startsOn} → {period.endsOn})
          </Text>
        </View>
        <View style={styles.metaRow}>
          <Text style={styles.metaLabel}>Status</Text>
          <View style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
            {close ? (
              <>
                <Text style={styles.badgeClosed}>CLOSED</Text>
                <Text>
                  on {close.closedAt.slice(0, 10)} by{" "}
                  {close.closedBy ?? "—"}
                </Text>
              </>
            ) : (
              <>
                <Text style={styles.badgeOpen}>OPEN</Text>
                <Text>Posting still allowed.</Text>
              </>
            )}
          </View>
        </View>
        <View style={styles.tieOutRow}>
          <Text style={tieOuts.tbTies ? styles.tieOutOk : styles.tieOutFail}>
            {tieOuts.tbTies ? "✓" : "✗"} Trial balance DR/CR ties
          </Text>
          <Text style={tieOuts.bsTies ? styles.tieOutOk : styles.tieOutFail}>
            {tieOuts.bsTies ? "✓" : "✗"} Balance sheet A = L + E
          </Text>
          {tieOuts.reconsAllDone !== null && (
            <Text
              style={
                tieOuts.reconsAllDone ? styles.tieOutOk : styles.tieOutFail
              }
            >
              {tieOuts.reconsAllDone ? "✓" : "✗"} Recons signed off (
              {tieOuts.reconsDone}/{tieOuts.reconsTotal})
            </Text>
          )}
        </View>

        <Text style={styles.h2}>Contents</Text>
        <Text>1. Income statement</Text>
        <Text>2. Balance sheet</Text>
        <Text>3. Trial balance</Text>
        {props.reconRollup && (
          <Text>4. Account reconciliations</Text>
        )}
        <Footer {...footerProps} />
      </Page>

      {/* ─── Income statement ─────────────────────────────────────── */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Income statement</Text>
        <Text style={styles.meta}>
          {entity.code} · {book.code} · {period.startsOn} → {period.endsOn}
        </Text>

        <View style={styles.table}>
          <View style={styles.thead} fixed>
            <Text style={styles.colCode}>Code</Text>
            <Text style={styles.colName}>Account</Text>
            <Text style={styles.colAmountRight}>Amount</Text>
          </View>
          {props.incomeStatement.revenue.map((r) => (
            <View key={`rev-${r.code}`} style={styles.trow}>
              <Text style={styles.colCode}>{r.code}</Text>
              <Text style={styles.colName}>{r.name}</Text>
              <Text style={styles.colAmountRight}>{formatMoney(r.amount)}</Text>
            </View>
          ))}
          <View style={styles.trowTotal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Total revenue</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(props.incomeStatement.totalRevenue)}
            </Text>
          </View>
          {props.incomeStatement.expenses.map((e) => (
            <View key={`exp-${e.code}`} style={styles.trow}>
              <Text style={styles.colCode}>{e.code}</Text>
              <Text style={styles.colName}>{e.name}</Text>
              <Text style={styles.colAmountRight}>{formatMoney(e.amount)}</Text>
            </View>
          ))}
          <View style={styles.trowTotal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Total expenses</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(props.incomeStatement.totalExpenses)}
            </Text>
          </View>
          <View style={styles.trowFinal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Net income</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(props.incomeStatement.netIncome)}
            </Text>
          </View>
        </View>
        <Footer {...footerProps} />
      </Page>

      {/* ─── Balance sheet ────────────────────────────────────────── */}
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.h1}>Balance sheet</Text>
        <Text style={styles.meta}>
          {entity.code} · {book.code} · As of {period.endsOn}
        </Text>

        <View style={styles.table}>
          <View style={styles.thead} fixed>
            <Text style={styles.colCode}>Code</Text>
            <Text style={styles.colName}>Account</Text>
            <Text style={styles.colAmountRight}>Balance</Text>
          </View>
          {props.balanceSheet.assets.map((a) => (
            <View key={`a-${a.code}`} style={styles.trow}>
              <Text style={styles.colCode}>{a.code}</Text>
              <Text style={styles.colName}>{a.name}</Text>
              <Text style={styles.colAmountRight}>{formatMoney(a.amount)}</Text>
            </View>
          ))}
          <View style={styles.trowTotal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Total assets</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(props.balanceSheet.totalAssets)}
            </Text>
          </View>
          {props.balanceSheet.liabilities.map((l) => (
            <View key={`l-${l.code}`} style={styles.trow}>
              <Text style={styles.colCode}>{l.code}</Text>
              <Text style={styles.colName}>{l.name}</Text>
              <Text style={styles.colAmountRight}>{formatMoney(l.amount)}</Text>
            </View>
          ))}
          <View style={styles.trowTotal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Total liabilities</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(props.balanceSheet.totalLiabilities)}
            </Text>
          </View>
          {props.balanceSheet.equity.map((e) => (
            <View key={`e-${e.code}`} style={styles.trow}>
              <Text style={styles.colCode}>{e.code}</Text>
              <Text style={styles.colName}>{e.name}</Text>
              <Text style={styles.colAmountRight}>{formatMoney(e.amount)}</Text>
            </View>
          ))}
          <View style={styles.trowTotal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Total equity</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(props.balanceSheet.totalEquity)}
            </Text>
          </View>
          <View style={styles.trowFinal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>Liabilities + Equity</Text>
            <Text style={styles.colAmountRight}>
              {formatMoney(
                new Decimal(props.balanceSheet.totalLiabilities)
                  .plus(props.balanceSheet.totalEquity)
                  .toFixed(2)
              )}
            </Text>
          </View>
        </View>
        <Footer {...footerProps} />
      </Page>

      {/* ─── Trial balance (multi-page) ──────────────────────────── */}
      <Page size="LETTER" style={styles.page} wrap>
        <Text style={styles.h1}>Trial balance</Text>
        <Text style={styles.meta}>
          {entity.code} · {book.code} · As of {period.endsOn}
        </Text>

        <View style={styles.table}>
          <View style={styles.thead} fixed>
            <Text style={styles.colCode}>Code</Text>
            <Text style={styles.colName}>Account</Text>
            <Text style={styles.colType}>Type</Text>
            <Text style={styles.colAmount}>Debit</Text>
            <Text style={styles.colAmount}>Credit</Text>
            <Text style={styles.colAmount}>Balance</Text>
          </View>
          {props.trialBalance.rows
            .filter(
              (r) =>
                new Decimal(r.debit).gt(0) ||
                new Decimal(r.credit).gt(0)
            )
            .map((r) => (
              <View key={r.accountCode} style={styles.trow} wrap={false}>
                <Text style={styles.colCode}>{r.accountCode}</Text>
                <Text style={styles.colName}>{r.accountName}</Text>
                <Text style={styles.colType}>{r.type}</Text>
                <Text style={styles.colAmount}>
                  {new Decimal(r.debit).isZero() ? "—" : formatMoney(r.debit)}
                </Text>
                <Text style={styles.colAmount}>
                  {new Decimal(r.credit).isZero() ? "—" : formatMoney(r.credit)}
                </Text>
                <Text style={styles.colAmount}>{formatMoney(r.balance)}</Text>
              </View>
            ))}
          <View style={styles.trowFinal}>
            <Text style={styles.colCode}></Text>
            <Text style={styles.colName}>TOTALS</Text>
            <Text style={styles.colType}></Text>
            <Text style={styles.colAmount}>
              {formatMoney(props.trialBalance.totalDebit)}
            </Text>
            <Text style={styles.colAmount}>
              {formatMoney(props.trialBalance.totalCredit)}
            </Text>
            <Text style={styles.colAmount}></Text>
          </View>
        </View>
        <Footer {...footerProps} />
      </Page>

      {/* ─── Account reconciliations (BlackLine arc Phase 1 PR 8) ── */}
      {/* Only rendered when at least one recon exists for the period —
          empty periods (first-use) skip the section. */}
      {props.reconRollup && (
        <Page size="LETTER" style={styles.page}>
          <Text style={styles.h1}>Account reconciliations</Text>
          <Text style={styles.meta}>
            {props.reconRollup.done} of {props.reconRollup.total} signed off (
            {props.reconRollup.pctDone}%) ·{" "}
            {props.entity.code} · {props.book.code} ·{" "}
            {props.period.code}
          </Text>
          <View style={{ marginTop: 12 }}>
            <View style={styles.thead}>
              <Text style={styles.colCode}>Status</Text>
              <Text style={styles.colAmount}>Count</Text>
              <Text style={styles.colAmount}>% of total</Text>
            </View>
            {[
              { label: "RECONCILED", count: props.reconRollup.reconciled },
              { label: "WAIVED", count: props.reconRollup.waived },
              { label: "PREPARED", count: props.reconRollup.prepared },
              { label: "IN_PROGRESS", count: props.reconRollup.inProgress },
              { label: "OPEN", count: props.reconRollup.open },
              { label: "EXCEPTION", count: props.reconRollup.exception },
            ].map(({ label, count }) => (
              <View key={label} style={styles.trow}>
                <Text style={styles.colCode}>{label}</Text>
                <Text style={styles.colAmount}>{count}</Text>
                <Text style={styles.colAmount}>
                  {props.reconRollup!.total === 0
                    ? "0%"
                    : `${Math.round((count / props.reconRollup!.total) * 100)}%`}
                </Text>
              </View>
            ))}
            <View style={styles.trowTotal}>
              <Text style={styles.colCode}>TOTAL</Text>
              <Text style={styles.colAmount}>{props.reconRollup.total}</Text>
              <Text style={styles.colAmount}>100%</Text>
            </View>
          </View>
          <Footer {...footerProps} />
        </Page>
      )}
    </Document>
  );
}
