#!/usr/bin/env python3
# Validate NetSuite Fleet bank_accounts + bank_statements +
# bank_statement_lines + reconciliations + reconciliation_lines against
# recon's BankAccount + BankStatement + BankStatementLine +
# Reconciliation + ReconciliationMatch schema.
#
# Closes the validator trilogy (after GL, fa-amort, revenue-rec).

import openpyxl
import json
from collections import Counter, defaultdict
from pathlib import Path

SRC = "/Users/hosungson/Downloads/Fleet Netsuite Master Data.xlsx"

print("Loading NetSuite workbook...")
wb = openpyxl.load_workbook(SRC, read_only=True, data_only=True)

def read_sheet(name):
    ws = wb[name]
    rows = list(ws.iter_rows(values_only=True))
    if not rows:
        return [], []
    headers = [str(h) if h is not None else "" for h in rows[0]]
    data = [dict(zip(headers, r)) for r in rows[1:]]
    return headers, data

print("Reading source tables...")
_, bank_accounts = read_sheet("bank_accounts")
_, bank_statements = read_sheet("bank_statements")
_, bank_statement_lines = read_sheet("bank_statement_lines")
_, reconciliations = read_sheet("reconciliations")
_, reconciliation_lines = read_sheet("reconciliation_lines")
_, accounts = read_sheet("accounts")

print(f"  bank_accounts:        {len(bank_accounts)}")
print(f"  bank_statements:      {len(bank_statements)}")
print(f"  bank_statement_lines: {len(bank_statement_lines)}")
print(f"  reconciliations:      {len(reconciliations)}")
print(f"  reconciliation_lines: {len(reconciliation_lines)}")

# Lookups
acct_by_id = {a["id"]: a for a in accounts if a.get("id") is not None}

# Index statement lines by statement id
lines_by_stmt = defaultdict(list)
for l in bank_statement_lines:
    sid = l.get("bank_statement_id")
    if sid is not None:
        lines_by_stmt[sid].append(l)

# Index reconciliation lines by reconciliation id
recon_lines_by_recon = defaultdict(list)
for l in reconciliation_lines:
    rid = l.get("reconciliation_id")
    if rid is not None:
        recon_lines_by_recon[rid].append(l)

# ─────────────────────────────────────────────────────────────────────
# BankAccount translation
# ─────────────────────────────────────────────────────────────────────

translated_accounts = []
unresolved_gl_accounts = 0
for ba in bank_accounts:
    gl_acct = acct_by_id.get(ba.get("gl_account_id"))
    gl_code = gl_acct["account_number"] if gl_acct else f"ACCT-{int(ba['gl_account_id'])}" if ba.get("gl_account_id") else "UNRESOLVED"
    if gl_code == "UNRESOLVED":
        unresolved_gl_accounts += 1

    translated_accounts.append({
        "code": f"BA-{int(ba['id'])}",
        "displayName": ba.get("name"),
        "bankName": ba.get("bank_name"),
        "accountNumberLast4": str(ba.get("account_number") or "")[-4:],
        "currencyCode": ba.get("currency"),
        "glAccountCode": gl_code,
        "entityCode": f"SUB-{int(ba['subsidiary_id'])}" if ba.get("subsidiary_id") else None,
        "isActive": not ba.get("is_inactive"),
        "sourceSystem": "netsuite",
        "sourceRecordType": "bank_account",
        "sourceRecordId": f"ns-ba-{int(ba['id'])}",
        "_netsuiteOnly": {
            "currentBalance": float(ba.get("current_balance") or 0),
            "availableBalance": float(ba.get("available_balance") or 0),
            "routingNumber": ba.get("routing_number"),
            "lastReconciledDate": str(ba.get("last_reconciled_date") or "")[:10] if ba.get("last_reconciled_date") else None,
            "lastReconciledBalance": float(ba.get("last_reconciled_balance") or 0) if ba.get("last_reconciled_balance") else None,
        },
    })

# ─────────────────────────────────────────────────────────────────────
# BankStatement translation
# ─────────────────────────────────────────────────────────────────────

translated_statements = []
balance_failures = []
unmapped_stmt_fields = Counter()

for stmt in bank_statements:
    lines = lines_by_stmt.get(stmt["id"], [])

    # Recon invariant: SUM(line.amount) = closingBalance - openingBalance
    opening = float(stmt.get("opening_balance") or 0)
    closing = float(stmt.get("closing_balance") or 0)
    expected_delta = closing - opening
    actual_delta = sum(float(l.get("amount") or 0) for l in lines)

    is_balanced = abs(expected_delta - actual_delta) < 0.01

    if not is_balanced and len(lines) > 0:
        balance_failures.append({
            "stmt_id": int(stmt["id"]),
            "expected_delta": expected_delta,
            "actual_delta": actual_delta,
            "diff": expected_delta - actual_delta,
            "lines": len(lines),
        })

    translated_statements.append({
        "bankAccountCode": f"BA-{int(stmt['bank_account_id'])}" if stmt.get("bank_account_id") else None,
        "filename": f"NetSuite statement {int(stmt['id'])} - {str(stmt.get('statement_date') or '')[:10]}.json",
        "format": "NETSUITE_IMPORT_V1",
        "rawPayload": "{}",  # recon model stores verbatim file content; NetSuite import has no file
        "periodStart": str(stmt.get("statement_date") or "")[:10],  # NetSuite doesn't have separate start/end
        "periodEnd": str(stmt.get("statement_date") or "")[:10],
        "openingBalance": opening,
        "closingBalance": closing,
        "sourceSystem": "netsuite",
        "sourceRecordType": "bank_statement",
        "sourceRecordId": f"ns-stmt-{int(stmt['id'])}",
        "lineCount": len(lines),
        "_balanced": is_balanced,
    })

    if stmt.get("currency") is not None:
        unmapped_stmt_fields["bank_statement.currency"] += 1

# ─────────────────────────────────────────────────────────────────────
# BankStatementLine translation
# ─────────────────────────────────────────────────────────────────────

# Map matched_transaction_type → status
STATUS_MAP = {
    "bank_transfer": "MATCHED",  # already matched by bank reconciliation
    "deposit": "MATCHED",
    "payment": "MATCHED",
    "bill_payment": "MATCHED",
}

translated_lines = []
match_source_distribution = Counter()
recon_lookup_failures = 0

# Sample 200 lines for translation
for l in bank_statement_lines[:200]:
    ns_match_type = l.get("matched_transaction_type")
    is_reconciled = bool(l.get("reconciled"))
    status = "MATCHED" if is_reconciled else "UNMATCHED"

    translated_lines.append({
        "statementCode": f"ns-stmt-{int(l['bank_statement_id'])}" if l.get("bank_statement_id") else None,
        "lineNo": int(l["id"]),  # NetSuite uses global line IDs; recon uses 1-based within statement
        "transactionDate": str(l.get("transaction_date") or "")[:10],
        "description": l.get("description"),
        "amount": float(l.get("amount") or 0),
        "runningBalance": float(l.get("running_balance") or 0) if l.get("running_balance") is not None else None,
        "status": status,
        "sourceSystem": "netsuite",
        "sourceRecordId": f"ns-bsl-{int(l['id'])}",
        "_netsuiteOnly": {
            "matchedTransactionType": ns_match_type,
            "matchedTransactionId": l.get("matched_transaction_id"),
        },
    })

    if ns_match_type:
        match_source_distribution[ns_match_type] += 1

# ─────────────────────────────────────────────────────────────────────
# Reconciliation + ReconciliationLine translation
# ─────────────────────────────────────────────────────────────────────

translated_recons = []
recon_balance_failures = []
recon_statuses = Counter()

for r in reconciliations:
    recon_lines = recon_lines_by_recon.get(r["id"], [])

    ending = float(r.get("statement_ending_balance") or 0)
    cleared = float(r.get("cleared_balance") or 0)
    uncleared = float(r.get("uncleared_balance") or 0)
    diff = float(r.get("difference") or 0)

    # Recon invariant: cleared + uncleared + diff = ending
    is_balanced = abs((cleared + uncleared + diff) - ending) < 0.01 if ending != 0 else True

    if not is_balanced:
        recon_balance_failures.append({
            "recon_id": int(r["id"]),
            "ending": ending,
            "cleared": cleared,
            "uncleared": uncleared,
            "diff": diff,
        })

    status = r.get("status")
    recon_statuses[status] += 1

    cleared_lines = [l for l in recon_lines if l.get("is_cleared")]
    uncleared_lines = [l for l in recon_lines if not l.get("is_cleared")]

    translated_recons.append({
        "bankAccountCode": f"BA-{int(r['bank_account_id'])}" if r.get("bank_account_id") else None,
        "statementDate": str(r.get("statement_date") or "")[:10],
        "statementEndingBalance": ending,
        "clearedBalance": cleared,
        "unclearedBalance": uncleared,
        "difference": diff,
        "status": "RECONCILED" if status == "reconciled" else "IN_PROGRESS" if status == "in_progress" else "UNKNOWN",
        "reconciledByUserCode": f"USER-{int(r['reconciled_by_id'])}" if r.get("reconciled_by_id") else None,
        "reconciledDate": str(r.get("reconciled_date") or "")[:10] if r.get("reconciled_date") else None,
        "sourceSystem": "netsuite",
        "sourceRecordType": "reconciliation",
        "sourceRecordId": f"ns-recon-{int(r['id'])}",
        "lineCount": len(recon_lines),
        "clearedLineCount": len(cleared_lines),
        "unclearedLineCount": len(uncleared_lines),
        "_balanced": is_balanced,
    })

# ─────────────────────────────────────────────────────────────────────
# Report
# ─────────────────────────────────────────────────────────────────────

# NetSuite matched_transaction_type → ReconciliationMatch.source distribution
ns_match_types = Counter(l.get("matched_transaction_type") for l in bank_statement_lines if l.get("matched_transaction_type"))

# Reconciliation line transaction_type distribution
ns_recon_line_types = Counter(l.get("transaction_type") for l in reconciliation_lines if l.get("transaction_type"))

report = {
    "validation_run": {
        "source_totals": {
            "bank_accounts": len(bank_accounts),
            "bank_statements": len(bank_statements),
            "bank_statement_lines_truncated": len(bank_statement_lines),
            "reconciliations": len(reconciliations),
            "reconciliation_lines_truncated": len(reconciliation_lines),
        },
    },
    "bank_accounts_translation": {
        "total": len(translated_accounts),
        "with_resolved_gl_account": len(translated_accounts) - unresolved_gl_accounts,
        "with_last_reconciled_metadata": sum(1 for a in translated_accounts if a["_netsuiteOnly"]["lastReconciledDate"]),
    },
    "bank_statements_translation": {
        "total": len(translated_statements),
        "balance_check_passed": len(translated_statements) - len(balance_failures),
        "balance_failures_sample": balance_failures[:5],
        "statements_with_no_lines_in_truncated_dataset": sum(1 for s in translated_statements if s["lineCount"] == 0),
        "unmapped_netsuite_fields": dict(unmapped_stmt_fields),
    },
    "bank_statement_lines_translation": {
        "lines_sampled": len(translated_lines),
        "lines_with_matched_transaction": sum(1 for l in translated_lines if l["_netsuiteOnly"]["matchedTransactionType"]),
        "matched_transaction_types_in_full_dataset": dict(ns_match_types),
    },
    "reconciliations_translation": {
        "total": len(translated_recons),
        "balance_check_passed": len(translated_recons) - len(recon_balance_failures),
        "balance_failures_sample": recon_balance_failures[:5],
        "status_distribution": dict(recon_statuses),
        "with_line_entries": sum(1 for r in translated_recons if r["lineCount"] > 0),
    },
    "reconciliation_lines_translation": {
        "total": len(reconciliation_lines),
        "transaction_types_in_full_dataset": dict(ns_recon_line_types),
        "cleared_count": sum(1 for l in reconciliation_lines if l.get("is_cleared")),
        "uncleared_count": sum(1 for l in reconciliation_lines if not l.get("is_cleared")),
    },
}

out_dir = Path("/tmp/ns_recon_validation")
out_dir.mkdir(exist_ok=True)
(out_dir / "report.json").write_text(json.dumps(report, indent=2, default=str))
(out_dir / "translated_accounts.json").write_text(json.dumps(translated_accounts, indent=2, default=str))
(out_dir / "translated_statements.json").write_text(json.dumps(translated_statements[:20], indent=2, default=str))
(out_dir / "translated_lines.json").write_text(json.dumps(translated_lines[:20], indent=2, default=str))
(out_dir / "translated_recons.json").write_text(json.dumps(translated_recons[:20], indent=2, default=str))

print("\n=== VALIDATION REPORT ===\n")
print(json.dumps(report, indent=2, default=str))
print(f"\nFull outputs in {out_dir}/")
