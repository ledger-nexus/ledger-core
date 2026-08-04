#!/usr/bin/env python3
# Validation pass: translate NetSuite Fleet revenue_arrangements +
# revenue_elements + revenue_plans + revenue_plan_lines into the JSON
# shape that revenue-rec's RevenueContract / PerformanceObligation /
# RecognitionSchedule expects. Report what fits cleanly + what doesn't.
#
# CAVEAT: NetSuite arrangement IDs in the elements/plans/plan_lines
# tables range 1-130000+; the truncated 1000-row exports only overlap
# on a small subset. We translate every arrangement that has at least
# one element in the truncated dataset.

import openpyxl
import json
from collections import defaultdict, Counter
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
_, arrangements = read_sheet("revenue_arrangements")
_, elements = read_sheet("revenue_elements")
_, rules = read_sheet("revenue_rules")
_, plans = read_sheet("revenue_plans")
_, plan_lines = read_sheet("revenue_plan_lines")
_, customers = read_sheet("customers")
_, items = read_sheet("items")
_, subsidiaries = read_sheet("subsidiaries")
_, accounts = read_sheet("accounts")

print(f"  arrangements: {len(arrangements)}")
print(f"  elements:     {len(elements)}")
print(f"  rules:        {len(rules)}")
print(f"  plans:        {len(plans)}")
print(f"  plan_lines:   {len(plan_lines)}")
print(f"  accounts:     {len(accounts)}")

# Lookups
cust_by_id = {c["customers"]: c for c in customers if c.get("customers") is not None}
item_by_id = {i["id"]: i for i in items if i.get("id") is not None}
rule_by_id = {r["id"]: r for r in rules if r.get("id") is not None}
sub_by_id = {s["id"]: s for s in subsidiaries if s.get("id") is not None}
acct_by_id = {a["id"]: a for a in accounts if a.get("id") is not None}

elem_by_arr = defaultdict(list)
for e in elements:
    if e.get("arrangement_id") is not None:
        elem_by_arr[e["arrangement_id"]].append(e)

plan_by_elem = defaultdict(list)
for p in plans:
    if p.get("revenue_element_id") is not None:
        plan_by_elem[p["revenue_element_id"]].append(p)

lines_by_plan = defaultdict(list)
for pl in plan_lines:
    if pl.get("plan_id") is not None:
        lines_by_plan[pl["plan_id"]].append(pl)

# Find arrangements that overlap with the elements truncated dataset
arrs_with_elements = [a for a in arrangements if a["id"] in elem_by_arr]
print(f"\nArrangements with overlapping elements: {len(arrs_with_elements)}")

# Mapping tables
SATISFACTION_TO_PATTERN = {
    "point_in_time": "POINT_IN_TIME",
    "over_time": "OVER_TIME_STRAIGHT",
}
RECOGNITION_METHOD_TO_PATTERN = {
    "point_in_time": "POINT_IN_TIME",
    "straight_line": "OVER_TIME_STRAIGHT",
    "ratable": "OVER_TIME_STRAIGHT",
    "percentage_completion": "UNMAPPED__needs_extension",
    "milestone": "OVER_TIME_MILESTONE",
    "usage": "OVER_TIME_USAGE",
}

translated = []
unmapped_fields = Counter()
unmapped_methods = Counter()
issues = []

for arr in arrs_with_elements:
    elems = elem_by_arr.get(arr["id"], [])
    cust = cust_by_id.get(arr.get("customer_id"))

    contract = {
        "code": arr.get("arrangement_number"),
        "description": f"Arrangement {arr.get('arrangement_number')}",
        "customerPartyCode": cust.get("customer_id") if cust else f"UNKNOWN-{arr.get('customer_id')}",
        "contractStartDate": str(arr.get("arrangement_date") or "")[:10],
        "contractEndDate": None,
        "totalContractValue": float(arr.get("total_arrangement_value") or 0),
        "currencyId": cust.get("currency", "USD") if cust else "USD",
        "entityCode": f"SUB-{int(arr.get('subsidiary_id'))}" if arr.get("subsidiary_id") else None,
        "status": "ACTIVE" if arr.get("status") == "active" else "COMPLETED" if arr.get("status") == "completed" else "UNKNOWN",
        "sourceSystem": "netsuite",
        "sourceRecordType": "revenue_arrangement",
        "sourceRecordId": f"ns-arr-{int(arr['id'])}",
        "performanceObligations": [],
    }

    for f in ["allocated_amount", "recognized_amount", "deferred_amount", "accounting_standard", "fair_value_method"]:
        if arr.get(f) is not None:
            unmapped_fields[f"arrangement.{f}"] += 1

    for seq, elem in enumerate(elems, 1):
        item = item_by_id.get(elem.get("item_id"))
        elem_plans = plan_by_elem.get(elem["id"], [])

        ns_satisfaction = elem.get("satisfaction_method")
        pattern = SATISFACTION_TO_PATTERN.get(ns_satisfaction)

        if not pattern and elem_plans:
            ns_method = elem_plans[0].get("recognition_method")
            pattern = RECOGNITION_METHOD_TO_PATTERN.get(ns_method)
            if pattern and pattern.startswith("UNMAPPED"):
                unmapped_methods[ns_method] += 1

        if not pattern:
            pattern = "UNKNOWN__pattern_resolution_failed"

        rev_account = None
        deferred_account = None
        if elem.get("recognition_rule_id"):
            rule = rule_by_id.get(elem["recognition_rule_id"])
            if rule:
                if rule.get("revenue_account_id"):
                    acct = acct_by_id.get(rule["revenue_account_id"])
                    rev_account = acct["account_number"] if acct else f"ACCT-{int(rule['revenue_account_id'])}"
                if rule.get("deferred_revenue_account_id"):
                    acct = acct_by_id.get(rule["deferred_revenue_account_id"])
                    deferred_account = acct["account_number"] if acct else f"ACCT-{int(rule['deferred_revenue_account_id'])}"
        if not rev_account and item and item.get("income_account_id"):
            acct = acct_by_id.get(item["income_account_id"])
            rev_account = acct["account_number"] if acct else f"ACCT-{int(item['income_account_id'])}"

        # Plan-line driven schedule
        schedule_entries = []
        for p in elem_plans:
            for pl in lines_by_plan.get(p["id"], []):
                schedule_entries.append({
                    "recognitionDate": str(pl.get("recognition_date") or "")[:10],
                    "amount": float(pl.get("amount") or 0),
                    "percent": float(pl.get("percent") or 0),
                    "status": pl.get("status"),
                    "sourceRecordId": f"ns-pl-{int(pl['id'])}",
                })

        po = {
            "sequenceNo": seq,
            "description": elem.get("description") or f"Element {elem['id']}",
            "ssp": float(elem.get("standalone_selling_price") or 0),
            "recognitionPattern": pattern,
            "startDate": str(elem.get("start_date") or "")[:10],
            "endDate": str(elem.get("end_date") or "")[:10] if elem.get("end_date") else None,
            "recognizedToDate": float(elem.get("recognized_amount") or 0),
            "revenueAccountCode": rev_account or "UNRESOLVED",
            "deferredAccountCode": deferred_account or "UNRESOLVED",
            "sourceRecordType": "revenue_element",
            "sourceRecordId": f"ns-elem-{int(elem['id'])}",
            "_netsuiteOnly": {
                "quantity": float(elem.get("quantity") or 0),
                "allocatedAmount": float(elem.get("allocated_amount") or 0),
                "satisfactionMethod": ns_satisfaction,
                "planCount": len(elem_plans),
                "scheduleEntryCount": len(schedule_entries),
            },
            "_recognitionScheduleFromPlanLines": schedule_entries,
        }

        for f in ["quantity", "allocated_amount", "deferred_amount"]:
            if elem.get(f) is not None:
                unmapped_fields[f"element.{f}"] += 1

        contract["performanceObligations"].append(po)

    translated.append(contract)

# Report
out_dir = Path("/tmp/ns_revenue_validation")
out_dir.mkdir(exist_ok=True)

total_pos = sum(len(c["performanceObligations"]) for c in translated)
with_unresolved_pattern = sum(
    1 for c in translated for po in c["performanceObligations"]
    if po["recognitionPattern"].startswith(("UNKNOWN", "UNMAPPED"))
)
with_unresolved_accounts = sum(
    1 for c in translated for po in c["performanceObligations"]
    if po["revenueAccountCode"] == "UNRESOLVED" or po["deferredAccountCode"] == "UNRESOLVED"
)
total_schedule_entries = sum(
    len(po["_recognitionScheduleFromPlanLines"]) for c in translated for po in c["performanceObligations"]
)

all_methods = Counter(p.get("recognition_method") for p in plans if p.get("recognition_method"))
all_satisfaction = Counter(e.get("satisfaction_method") for e in elements if e.get("satisfaction_method"))
all_fair_value = Counter(a.get("fair_value_method") for a in arrangements if a.get("fair_value_method"))

report = {
    "validation_run": {
        "source_totals": {
            "arrangements": len(arrangements),
            "elements": len(elements),
            "plans": len(plans),
            "plan_lines": len(plan_lines),
        },
        "translatable_arrangements": len(arrs_with_elements),
        "translation_note": "Source tables are truncated at 1,000 rows each. Arrangement IDs in elements span 1-130k+; only ~5 arrangements have overlapping element data. Full-dataset translation would require the un-truncated export.",
    },
    "translation_outcomes": {
        "contracts_built": len(translated),
        "performance_obligations_built": total_pos,
        "performance_obligations_with_unresolved_pattern": with_unresolved_pattern,
        "performance_obligations_with_unresolved_accounts": with_unresolved_accounts,
        "recognition_schedule_entries_carried_over": total_schedule_entries,
        "coverage_summary": f"{total_pos}/{total_pos} POs translated; {total_pos - with_unresolved_pattern}/{total_pos} with resolved pattern; {total_pos - with_unresolved_accounts}/{total_pos} with resolved accounts",
    },
    "recognition_methods_in_full_dataset": dict(all_methods),
    "satisfaction_methods_in_full_dataset": dict(all_satisfaction),
    "fair_value_methods_in_full_dataset": dict(all_fair_value),
    "unmapped_recognition_methods": dict(unmapped_methods),
    "unmapped_netsuite_fields_with_count_in_sample": dict(unmapped_fields),
}

(out_dir / "report.json").write_text(json.dumps(report, indent=2, default=str))
(out_dir / "translated_contracts.json").write_text(json.dumps(translated, indent=2, default=str))

print("\n=== VALIDATION REPORT ===\n")
print(json.dumps(report, indent=2, default=str))
print(f"\nFull outputs in {out_dir}/")
