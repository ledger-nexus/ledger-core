#!/usr/bin/env bash
# verify-encryption-rollout.sh — post-deploy sanity check for the SOC 2
# field-encryption rollout.
#
# Hits /api/health on each portfolio Vercel project and confirms:
#   1. status === "ok"            (the deploy is alive)
#   2. encryption.configured === true (FIELD_ENCRYPTION_KEY is set + well-formed)
#   3. encryption.columnCount matches the expected value per repo
#      (so a botched merge can't silently truncate the registry)
#
# Run this AFTER setting FIELD_ENCRYPTION_KEY in each Vercel project and
# AFTER each PR merges + deploys. If any check fails, STOP — do not
# proceed to the backfill scripts in the runbook.
#
# Usage:
#   FIELD_ENCRYPTION_KEY env var is NOT required to run this script — it
#   only inspects the public /api/health endpoint, which never exposes
#   the key.
#
#   ./scripts/verify-encryption-rollout.sh \
#     https://<ledger-core>.vercel.app \
#     https://<recon>.vercel.app \
#     https://<fa-amort>.vercel.app \
#     https://<revenue-rec>.vercel.app
#
# With no args, defaults to the canonical vercel.app subdomains for the
# `chrissoncpa` account. Adjust if you've remapped to a custom domain.
#
# Exit codes:
#   0 — every project passed every check
#   1 — at least one project failed
#   2 — usage error (jq missing, curl missing, etc.)

set -euo pipefail

# ── Required tools ──────────────────────────────────────────────────────
command -v curl >/dev/null 2>&1 || { echo "ERR: curl is required."; exit 2; }
command -v jq   >/dev/null 2>&1 || { echo "ERR: jq is required."; exit 2; }

# ── Per-repo expected column counts ─────────────────────────────────────
# Source of truth: src/lib/db/encrypted-fields-extension.ts ENCRYPTED_COLUMNS
# in each repo. Bump these when the registry changes; otherwise this
# script will (correctly) start failing and surface the drift.
EXPECTED_LEDGER_CORE=11
EXPECTED_RECON=7
EXPECTED_FA_AMORT=3
EXPECTED_REVENUE_REC=6

# ── Default URLs (override via CLI args) ────────────────────────────────
DEFAULTS=(
  "https://ledger-core.vercel.app"
  "https://recon.vercel.app"
  "https://fa-amort.vercel.app"
  "https://revenue-rec.vercel.app"
)
if [[ $# -gt 0 ]]; then
  URLS=("$@")
else
  URLS=("${DEFAULTS[@]}")
fi

if [[ ${#URLS[@]} -ne 4 ]]; then
  echo "ERR: expected 4 project URLs (ledger-core, recon, fa-amort, revenue-rec); got ${#URLS[@]}."
  echo "Usage: $0 <ledger-core-url> <recon-url> <fa-amort-url> <revenue-rec-url>"
  exit 2
fi

EXPECTED=("$EXPECTED_LEDGER_CORE" "$EXPECTED_RECON" "$EXPECTED_FA_AMORT" "$EXPECTED_REVENUE_REC")
NAMES=("ledger-core" "recon" "fa-amort" "revenue-rec")

# ── ANSI colors (only if stdout is a tty) ───────────────────────────────
if [[ -t 1 ]]; then
  GREEN=$'\033[0;32m'; RED=$'\033[0;31m'; YELLOW=$'\033[0;33m'; RESET=$'\033[0m'
else
  GREEN=""; RED=""; YELLOW=""; RESET=""
fi

ok()   { printf "  %sPASS%s %s\n" "$GREEN" "$RESET" "$1"; }
fail() { printf "  %sFAIL%s %s\n" "$RED" "$RESET" "$1"; }
warn() { printf "  %sWARN%s %s\n" "$YELLOW" "$RESET" "$1"; }

failures=0

# ── Per-project check ───────────────────────────────────────────────────
for i in "${!URLS[@]}"; do
  url="${URLS[$i]}"
  name="${NAMES[$i]}"
  expected_cols="${EXPECTED[$i]}"
  health_url="$url/api/health"

  printf "\n• %s — %s\n" "$name" "$health_url"

  # 5s connect, 10s total. The health endpoint should return well
  # within that; longer means something else is wrong.
  body=$(curl --silent --show-error --connect-timeout 5 --max-time 10 \
              -H "Accept: application/json" \
              "$health_url" 2>&1) || {
    fail "curl failed: $body"
    failures=$((failures + 1))
    continue
  }

  if ! echo "$body" | jq . >/dev/null 2>&1; then
    fail "response is not valid JSON. First 200 chars: ${body:0:200}"
    failures=$((failures + 1))
    continue
  fi

  status=$(echo "$body" | jq -r '.status // "unknown"')
  if [[ "$status" == "ok" ]]; then
    ok "status = ok"
  else
    fail "status = $status (expected ok)"
    failures=$((failures + 1))
  fi

  configured=$(echo "$body" | jq -r '.encryption.configured // "missing"')
  if [[ "$configured" == "true" ]]; then
    ok "encryption.configured = true"
  elif [[ "$configured" == "false" ]]; then
    fail "encryption.configured = false (FIELD_ENCRYPTION_KEY not set or malformed in Vercel env)"
    failures=$((failures + 1))
  else
    fail "encryption.configured is missing — is this build before the rollout?"
    failures=$((failures + 1))
  fi

  actual_cols=$(echo "$body" | jq -r '.encryption.columnCount // -1')
  if [[ "$actual_cols" == "$expected_cols" ]]; then
    ok "encryption.columnCount = $actual_cols"
  elif [[ "$actual_cols" == "-1" ]]; then
    fail "encryption.columnCount is missing"
    failures=$((failures + 1))
  else
    fail "encryption.columnCount = $actual_cols (expected $expected_cols — registry may have been truncated)"
    failures=$((failures + 1))
  fi

  # Bonus signals — warn-only, not failures
  db_reachable=$(echo "$body" | jq -r '.db.reachable // "unknown"')
  [[ "$db_reachable" == "true" ]] || warn "db.reachable = $db_reachable"
  sentry=$(echo "$body" | jq -r '.monitoring.sentryDsnPresent // "unknown"')
  [[ "$sentry" == "true" ]] || warn "monitoring.sentryDsnPresent = $sentry (CC7 evidence gap)"
done

# ── Summary ─────────────────────────────────────────────────────────────
echo
if [[ $failures -eq 0 ]]; then
  printf "%sAll 4 projects passed%s — encryption rollout is verified.\n" "$GREEN" "$RESET"
  echo "Next: run the backfill scripts per docs/runbooks/encryption-rollout.md."
  exit 0
else
  printf "%s$failures check(s) failed.%s STOP — do NOT run backfill scripts until resolved.\n" "$RED" "$RESET"
  echo "See docs/runbooks/encryption-rollout.md → Rollback section."
  exit 1
fi
