#!/usr/bin/env python3
# Validate NetSuite Fleet GL substrate (accounts + subsidiaries +
# accounting_books + accounting_periods + journal_entries +
# journal_entry_lines) against ledger-core's universal schema.
#
# This is the headline validator — the universal-schema thesis says
# "any major ERP's GL absorbs cleanly". This test that claim against
# 75 accounts + 17 subsidiaries + 3 books + 71 periods + 1,000 JE
# headers + 1,000 JE lines.

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
_, accounts = read_sheet("accounts")
_, subsidiaries = read_sheet("subsidiaries")
_, books = read_sheet("accounting_books")
_, periods = read_sheet("accounting_periods")
_, je_headers = read_sheet("journal_entries")
_, je_lines = read_sheet("journal_entry_lines")
_, departments = read_sheet("departments")
_, classes = read_sheet("Classes")
_, locations = read_sheet("locations")

print(f"  accounts:           {len(accounts)}")
print(f"  subsidiaries:       {len(subsidiaries)}")
print(f"  accounting_books:   {len(books)}")
print(f"  accounting_periods: {len(periods)}")
print(f"  journal_entries:    {len(je_headers)}")
print(f"  journal_entry_lines: {len(je_lines)}")

# ─────────────────────────────────────────────────────────────────────
# Account type mapping: 14 NetSuite types → 5 ledger-core enum values
# ─────────────────────────────────────────────────────────────────────

TYPE_MAP = {
    # ASSET
    "other_asset": "ASSET",
    "accounts_receivable": "ASSET",
    "other_current_asset": "ASSET",
    "bank": "ASSET",
    "fixed_asset": "ASSET",
    # LIABILITY
    "other_current_liability": "LIABILITY",
    "long_term_liability": "LIABILITY",
    "deferred_revenue": "LIABILITY",
    "accounts_payable": "LIABILITY",
    # EQUITY
    "equity": "EQUITY",
    # REVENUE
    "income": "REVENUE",
    # EXPENSE
    "expense": "EXPENSE",
    "other_expense": "EXPENSE",
    "cost_of_goods_sold": "EXPENSE",
}

# Normal balance follows from type
NORMAL_BALANCE = {
    "ASSET": "DEBIT",
    "EXPENSE": "DEBIT",
    "LIABILITY": "CREDIT",
    "EQUITY": "CREDIT",
    "REVENUE": "CREDIT",
}

unmapped_types = Counter()
translated_accounts = []
for a in accounts:
    ns_type = a.get("type")
    lc_type = TYPE_MAP.get(ns_type)
    if not lc_type:
        unmapped_types[ns_type] += 1
        lc_type = "UNKNOWN__" + str(ns_type)

    translated_accounts.append({
        "code": a.get("account_number"),
        "name": a.get("name"),
        "type": lc_type,
        "normalBalance": NORMAL_BALANCE.get(lc_type, "UNKNOWN"),
        "subtype": a.get("subtype"),
        "isContra": False,  # NetSuite doesn't flag explicitly; would need heuristic
        "isControlAccount": ns_type in ("accounts_receivable", "accounts_payable"),
        "isBank": ns_type == "bank",
        "entityCode": f"SUB-{int(a['subsidiary_id'])}" if a.get("subsidiary_id") else None,
        "parentAccountCode": None,  # would need second pass to resolve parent_account_id → code
        "bookScope": [],  # NetSuite restrict_to_class/dept/location not modeled here
        "active": not a.get("is_inactive"),
        "sourceSystem": "netsuite",
        "sourceRecordType": "account",
        "sourceRecordId": f"ns-acct-{int(a['id'])}",
    })

# ─────────────────────────────────────────────────────────────────────
# Subsidiary → LegalEntity
# ─────────────────────────────────────────────────────────────────────

translated_entities = []
for s in subsidiaries:
    translated_entities.append({
        "code": f"SUB-{int(s['id'])}",
        "name": s.get("name"),
        "legalName": s.get("legal_name") or s.get("name"),
        "country": s.get("country"),
        "functionalCurrencyCode": s.get("functional_currency") or s.get("base_currency"),
        "parentEntityCode": f"SUB-{int(s['parent_subsidiary_id'])}" if s.get("parent_subsidiary_id") else None,
        "isElimination": bool(s.get("is_elimination")),
        "consolidationMethod": s.get("consolidation_method"),  # NetSuite has FULL/EQUITY/COST — richer than ledger-core
        "fiscalCalendarCode": s.get("fiscal_calendar"),
        "sourceSystem": "netsuite",
        "sourceRecordType": "subsidiary",
        "sourceRecordId": f"ns-sub-{int(s['id'])}",
    })

# ─────────────────────────────────────────────────────────────────────
# Books → ledger-core Book
# ─────────────────────────────────────────────────────────────────────

translated_books = []
for b in books:
    translated_books.append({
        "code": b.get("name"),
        "name": b.get("name"),
        "basis": "UNRESOLVED",  # NetSuite doesn't store basis enum the same way
        "reportingCurrencyCode": b.get("base_currency"),
        "isActive": not b.get("is_inactive"),
        "sourceSystem": "netsuite",
        "sourceRecordType": "accounting_book",
        "sourceRecordId": f"ns-book-{int(b['id'])}",
        "_netsuiteOnly": {
            "accounting_standard": b.get("accounting_standard"),
            "subsidiary_id": b.get("subsidiary_id"),
        }
    })

# ─────────────────────────────────────────────────────────────────────
# Journal entries + lines
# ─────────────────────────────────────────────────────────────────────

# Index lines by header id
lines_by_je = defaultdict(list)
for l in je_lines:
    if l.get("journal_entry_id") is not None:
        lines_by_je[l["journal_entry_id"]].append(l)

# Sample a slice: first 100 JE headers with lines
je_overlap = [je for je in je_headers if je["id"] in lines_by_je][:100]
print(f"\nJE headers with overlapping lines (sampled 100): {len(je_overlap)}")

translated_jes = []
balance_failures = []
unmapped_je_fields = Counter()

for je in je_overlap:
    lines = lines_by_je.get(je["id"], [])

    # Verify debits = credits at the line level
    total_debit = sum(float(l.get("debit") or 0) for l in lines)
    total_credit = sum(float(l.get("credit") or 0) for l in lines)
    is_balanced = abs(total_debit - total_credit) < 0.01

    if not is_balanced:
        balance_failures.append({
            "je_id": int(je["id"]),
            "entry_number": je.get("entry_number"),
            "debit_total": total_debit,
            "credit_total": total_credit,
            "diff": total_debit - total_credit,
        })

    translated_lines = []
    for l in lines:
        translated_lines.append({
            "accountCode": f"NSACCT-{int(l['account_id'])}" if l.get("account_id") else "UNRESOLVED",
            "debit": float(l.get("debit") or 0),
            "credit": float(l.get("credit") or 0),
            "memo": l.get("memo"),
            "entityCode": f"SUB-{int(l['subsidiary_id'])}" if l.get("subsidiary_id") else None,
            # Line-level dimension assignments — NetSuite stores these directly;
            # ledger-core uses the Layer 3 dimension engine to dedupe.
            "dimensions": {
                "DEPARTMENT": f"DEPT-{int(l['department_id'])}" if l.get("department_id") else None,
                "CLASS": f"CLASS-{int(l['class_id'])}" if l.get("class_id") else None,
                "LOCATION": f"LOC-{int(l['location_id'])}" if l.get("location_id") else None,
            },
            # Source-document FKs that NetSuite stores on the line
            "_netsuiteSourceFKs": {
                "customer_id": l.get("customer_id"),
                "vendor_id": l.get("vendor_id"),
                "invoice_id": l.get("invoice_id"),
                "bill_id": l.get("bill_id"),
                "payment_id": l.get("payment_id"),
                "bill_payment_id": l.get("bill_payment_id"),
                "consolidation_id": l.get("consolidation_id"),
                "intercompany_transaction_id": l.get("intercompany_transaction_id"),
            },
            "sourceRecordId": f"ns-jel-{int(l['id'])}",
        })

    translated_jes.append({
        "entryNumber": je.get("entry_number"),
        "documentDate": str(je.get("date") or "")[:10],
        "postingDate": str(je.get("date") or "")[:10],
        "memo": je.get("memo"),
        "currencyCode": je.get("currency"),
        "exchangeRate": float(je.get("exchange_rate") or 1),
        "entityCode": f"SUB-{int(je['subsidiary_id'])}" if je.get("subsidiary_id") else None,
        "bookCode": f"BOOK-{int(je['accounting_book_id'])}" if je.get("accounting_book_id") else None,
        "isBookSpecific": bool(je.get("is_book_specific")),
        "status": je.get("status"),
        "entryType": je.get("entry_type"),
        "sourceSystem": "netsuite",
        "sourceRecordType": "journal_entry",
        "sourceRecordId": f"ns-je-{int(je['id'])}",
        "lines": translated_lines,
        "_balanced": is_balanced,
        "_debitTotal": total_debit,
        "_creditTotal": total_credit,
    })

    # Track NetSuite-only fields
    for f in ["reversal_date", "reversal_defer", "recurrence_frequency", "parent_recurring_entry_id",
              "document_data", "document_file_name", "approved_by_id", "posted_by_id"]:
        if je.get(f) is not None:
            unmapped_je_fields[f"journal_entry.{f}"] += 1

# ─────────────────────────────────────────────────────────────────────
# Compute coverage statistics
# ─────────────────────────────────────────────────────────────────────

# Account dimension coverage on lines
lines_with_dept = sum(1 for je in translated_jes for l in je["lines"] if l["dimensions"]["DEPARTMENT"])
lines_with_class = sum(1 for je in translated_jes for l in je["lines"] if l["dimensions"]["CLASS"])
lines_with_location = sum(1 for je in translated_jes for l in je["lines"] if l["dimensions"]["LOCATION"])
total_translated_lines = sum(len(je["lines"]) for je in translated_jes)

# Source-document FK coverage on lines
fk_types = Counter()
for je in translated_jes:
    for l in je["lines"]:
        for fk_name, fk_val in l["_netsuiteSourceFKs"].items():
            if fk_val is not None:
                fk_types[fk_name] += 1

# Account type coverage
type_distribution = Counter(a["type"] for a in translated_accounts)
subtype_distribution = Counter(a["subtype"] for a in translated_accounts if a["subtype"])

# Period coverage check
period_statuses = Counter()
for p in periods:
    s = p.get("status")
    if s:
        period_statuses[s] += 1

# Entry types seen in NetSuite
entry_types = Counter()
for je in je_headers:
    et = je.get("entry_type")
    if et:
        entry_types[et] += 1

# is_book_specific distribution
book_specific_count = sum(1 for je in je_headers if je.get("is_book_specific"))

report = {
    "validation_run": {
        "source_totals": {
            "accounts": len(accounts),
            "subsidiaries": len(subsidiaries),
            "accounting_books": len(books),
            "accounting_periods": len(periods),
            "journal_entries_truncated": len(je_headers),
            "journal_entry_lines_truncated": len(je_lines),
            "je_headers_with_overlapping_lines": len([je for je in je_headers if je["id"] in lines_by_je]),
            "je_headers_sampled_for_translation": len(je_overlap),
        },
    },
    "accounts_translation": {
        "total": len(translated_accounts),
        "with_resolved_type": sum(1 for a in translated_accounts if not a["type"].startswith("UNKNOWN")),
        "with_subtype_preserved": sum(1 for a in translated_accounts if a["subtype"]),
        "type_distribution_after_mapping": dict(type_distribution),
        "subtype_diversity": len(subtype_distribution),
        "unmapped_netsuite_types": dict(unmapped_types),
    },
    "subsidiaries_translation": {
        "total": len(translated_entities),
        "with_parent": sum(1 for e in translated_entities if e["parentEntityCode"]),
        "elimination_entities": sum(1 for e in translated_entities if e["isElimination"]),
        "consolidation_methods_in_dataset": dict(Counter(e["consolidationMethod"] for e in translated_entities if e["consolidationMethod"])),
    },
    "books_translation": {
        "total": len(translated_books),
        "with_resolved_basis": sum(1 for b in translated_books if b["basis"] != "UNRESOLVED"),
        "accounting_standards_in_dataset": dict(Counter(b["_netsuiteOnly"]["accounting_standard"] for b in translated_books if b["_netsuiteOnly"].get("accounting_standard"))),
    },
    "periods_translation": {
        "total": len(periods),
        "status_distribution": dict(period_statuses),
    },
    "journal_entries_translation": {
        "headers_sampled": len(translated_jes),
        "balance_check_passed": len(translated_jes) - len(balance_failures),
        "balance_failures": balance_failures[:5],
        "total_translated_lines": total_translated_lines,
        "lines_with_DEPARTMENT_dimension": lines_with_dept,
        "lines_with_CLASS_dimension": lines_with_class,
        "lines_with_LOCATION_dimension": lines_with_location,
        "source_document_FK_counts_on_lines": dict(fk_types),
        "entry_types_in_full_dataset": dict(entry_types),
        "book_specific_je_count_in_full_dataset": book_specific_count,
        "unmapped_netsuite_fields": dict(unmapped_je_fields),
    },
}

out_dir = Path("/tmp/ns_gl_validation")
out_dir.mkdir(exist_ok=True)
(out_dir / "report.json").write_text(json.dumps(report, indent=2, default=str))
(out_dir / "translated_accounts.json").write_text(json.dumps(translated_accounts, indent=2, default=str))
(out_dir / "translated_entities.json").write_text(json.dumps(translated_entities, indent=2, default=str))
(out_dir / "translated_books.json").write_text(json.dumps(translated_books, indent=2, default=str))
(out_dir / "translated_jes.json").write_text(json.dumps(translated_jes[:20], indent=2, default=str))

print("\n=== VALIDATION REPORT ===\n")
print(json.dumps(report, indent=2, default=str))
print(f"\nFull outputs in {out_dir}/")
