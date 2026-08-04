#!/usr/bin/env python3
# Validate NetSuite Fleet fixed_assets + depreciation_schedules against
# fa-amort's FixedAsset + FixedAssetBookAttributes schema.
#
# Companion to scripts/netsuite-revenue-validator.py.

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
_, assets = read_sheet("fixed_assets")
_, dep_schedules = read_sheet("depreciation_schedules")
_, subsidiaries = read_sheet("subsidiaries")
_, vendors = read_sheet("vendors")
_, accounts = read_sheet("accounts")
_, locations = read_sheet("locations")

print(f"  fixed_assets:           {len(assets)}")
print(f"  depreciation_schedules: {len(dep_schedules)}")

# Lookups
sub_by_id = {s["id"]: s for s in subsidiaries if s.get("id") is not None}
vendor_by_id = {v["id"]: v for v in vendors if v.get("id") is not None}
acct_by_id = {a["id"]: a for a in accounts if a.get("id") is not None}
loc_by_id = {l["id"]: l for l in locations if l.get("id") is not None}

# NB: depreciation_schedules.fixed_asset_id (not asset_id)
dep_by_asset = defaultdict(list)
for ds in dep_schedules:
    aid = ds.get("fixed_asset_id")
    if aid is not None:
        dep_by_asset[aid].append(ds)

all_methods = Counter()
for a in assets:
    m = a.get("depreciation_method")
    if m:
        all_methods[m] += 1

# NetSuite Fleet uses human-readable strings, not enum codes
METHOD_MAP = {
    "Straight Line": "STRAIGHT_LINE",
    "straight_line": "STRAIGHT_LINE",
    "Double Declining": "DOUBLE_DECLINING",
    "Double Declining Balance": "DOUBLE_DECLINING",
    "150% Declining Balance": "UNMAPPED__150_db",
    "Sum of Years Digits": "UNMAPPED__SYD",
    "Units of Production": "UNMAPPED__UoP",
    "MACRS": "MACRS_5_HY",
    "MACRS 3-year": "MACRS_3_HY",
    "MACRS 5-year": "MACRS_5_HY",
    "MACRS 7-year": "MACRS_7_HY",
    "Amortization": "UNMAPPED__amortization",
    "None": "UNMAPPED__none",
}

STATUS_MAP = {
    "active": "IN_SERVICE",
    "in_service": "IN_SERVICE",
    "idle": "IDLE",
    "disposed": "DISPOSED",
    "retired": "DISPOSED",
    "fully_depreciated": "IN_SERVICE",
}

translated = []
unmapped_methods = Counter()
unmapped_statuses = Counter()
unmapped_fields = Counter()

for ns_asset in assets:
    sub = sub_by_id.get(ns_asset.get("subsidiary_id"))
    asset_account = acct_by_id.get(ns_asset.get("asset_account_id"))
    dep_account = acct_by_id.get(ns_asset.get("depreciation_account_id"))
    accum_account = acct_by_id.get(ns_asset.get("accumulated_depr_account_id"))

    ns_method = ns_asset.get("depreciation_method")
    fa_method = METHOD_MAP.get(ns_method)
    if not fa_method or fa_method.startswith("UNMAPPED"):
        unmapped_methods[ns_method] += 1
        if not fa_method:
            fa_method = f"UNKNOWN__{ns_method}"

    ns_status = ns_asset.get("status")
    fa_status = STATUS_MAP.get(ns_status)
    if not fa_status:
        unmapped_statuses[ns_status] += 1
        fa_status = f"UNKNOWN__{ns_status}"

    asset_acct_code = asset_account["account_number"] if asset_account else (f"ACCT-{int(ns_asset['asset_account_id'])}" if ns_asset.get("asset_account_id") else "UNRESOLVED")
    dep_acct_code = dep_account["account_number"] if dep_account else (f"ACCT-{int(ns_asset['depreciation_account_id'])}" if ns_asset.get("depreciation_account_id") else "UNRESOLVED")
    accum_acct_code = accum_account["account_number"] if accum_account else (f"ACCT-{int(ns_asset['accumulated_depr_account_id'])}" if ns_asset.get("accumulated_depr_account_id") else "UNRESOLVED")

    schedule_rows = dep_by_asset.get(ns_asset["id"], [])

    asset = {
        "code": ns_asset.get("asset_number"),
        "description": ns_asset.get("description") or ns_asset.get("name"),
        "category": ns_asset.get("asset_type"),
        "entityCode": f"SUB-{int(ns_asset['subsidiary_id'])}" if ns_asset.get("subsidiary_id") else None,
        "acquisitionDate": str(ns_asset.get("acquisition_date") or "")[:10],
        "acquisitionCost": float(ns_asset.get("original_cost") or 0),
        "acquisitionCurrencyId": "USD",
        "status": fa_status,
        "disposalDate": str(ns_asset.get("disposal_date") or "")[:10] if ns_asset.get("disposal_date") else None,
        "disposalProceeds": float(ns_asset.get("disposal_amount") or 0) if ns_asset.get("disposal_amount") else None,
        "assetAccountCode": asset_acct_code,
        "bookAttributes": [{
            "bookCode": "US_GAAP",
            "usefulLifeMonths": int(ns_asset.get("useful_life_months") or 0),
            "depreciationMethod": fa_method,
            "inServiceDate": str(ns_asset.get("placed_in_service_date") or "")[:10],
            "salvageValue": float(ns_asset.get("residual_value") or 0),
            "accumulatedDepreciation": float(ns_asset.get("accumulated_depreciation") or 0),
            "depreciationExpenseAccountCode": dep_acct_code,
            "accumDepreciationAccountCode": accum_acct_code,
        }],
        "sourceSystem": "netsuite",
        "sourceRecordType": "fixed_asset",
        "sourceRecordId": f"ns-fa-{int(ns_asset['id'])}",
        "_netsuiteOnly": {
            "currentBookValue": float(ns_asset.get("current_book_value") or 0),
            "gainLoss": float(ns_asset.get("gain_loss") or 0) if ns_asset.get("gain_loss") else None,
            "custodianId": ns_asset.get("custodian_id"),
            "locationId": ns_asset.get("location_id"),
            "scheduleRowCount": len(schedule_rows),
        },
    }

    for f in ["custodian_id", "location_id", "current_book_value"]:
        if ns_asset.get(f) is not None:
            unmapped_fields[f"fixed_asset.{f}"] += 1

    translated.append(asset)

# Report
total = len(translated)
with_unknown_method = sum(1 for a in translated for ba in a["bookAttributes"] if ba["depreciationMethod"].startswith(("UNKNOWN", "UNMAPPED")))
with_unknown_status = sum(1 for a in translated if a["status"].startswith("UNKNOWN"))
with_unresolved_accounts = sum(
    1 for a in translated
    if a["assetAccountCode"] == "UNRESOLVED"
    or any(ba["depreciationExpenseAccountCode"] == "UNRESOLVED" or ba["accumDepreciationAccountCode"] == "UNRESOLVED" for ba in a["bookAttributes"])
)

asset_ids_with_assets = set(a["id"] for a in assets if a.get("id") is not None)
asset_ids_in_schedule = set(ds.get("fixed_asset_id") for ds in dep_schedules if ds.get("fixed_asset_id") is not None)
schedule_overlap = asset_ids_with_assets & asset_ids_in_schedule

assets_with_schedule_entries = [a for a in translated if a["_netsuiteOnly"]["scheduleRowCount"] > 0]

report = {
    "validation_run": {
        "source_totals": {
            "fixed_assets": len(assets),
            "depreciation_schedules": len(dep_schedules),
            "asset_id_range_in_assets_table": f"{int(min(asset_ids_with_assets))} to {int(max(asset_ids_with_assets))}",
            "asset_id_range_in_schedules_table": f"{int(min(asset_ids_in_schedule))} to {int(max(asset_ids_in_schedule))}" if asset_ids_in_schedule else "n/a",
            "overlap_assets_with_schedule_entries": len(schedule_overlap),
            "total_schedule_entries_for_overlapping_assets": sum(len(dep_by_asset[aid]) for aid in schedule_overlap),
        },
    },
    "translation_outcomes": {
        "assets_translated": total,
        "with_resolved_depreciation_method": total - with_unknown_method,
        "with_resolved_status": total - with_unknown_status,
        "with_unresolved_accounts": with_unresolved_accounts,
        "assets_with_schedule_entries_to_carry_over": len(assets_with_schedule_entries),
        "coverage_summary": f"{total - with_unknown_method - with_unknown_status - with_unresolved_accounts}/{total} translated with full field resolution",
    },
    "depreciation_methods_in_dataset": dict(all_methods),
    "unmapped_methods": dict(unmapped_methods),
    "unmapped_statuses": dict(unmapped_statuses),
    "unmapped_netsuite_fields_with_count": dict(unmapped_fields),
}

out_dir = Path("/tmp/ns_fa_validation")
out_dir.mkdir(exist_ok=True)
(out_dir / "report.json").write_text(json.dumps(report, indent=2, default=str))
(out_dir / "translated_assets.json").write_text(json.dumps(translated, indent=2, default=str))

print("\n=== VALIDATION REPORT ===\n")
print(json.dumps(report, indent=2, default=str))
print(f"\nFull outputs in {out_dir}/")
