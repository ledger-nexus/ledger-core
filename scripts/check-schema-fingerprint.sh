#!/usr/bin/env bash
# CI gate + local dev check for schema drift.
#
# What this guards: a contributor changes prisma/schema.prisma without
# updating the committed fingerprint. The .sha256 file is a forcing
# function — any schema change is paired with an explicit
# acknowledgement of the new hash, which goes through PR review.
#
# Pairs with the schemaFingerprint() helper in src/lib/soc2/ which
# surfaces the runtime model-shape hash via /api/health. The file
# fingerprint catches schema-source drift; the runtime fingerprint
# catches deploy-runtime drift. Defense in depth.
#
# Closes deficiency-log #21 — "schema-drift detection wired in CI".
#
# Usage:
#   scripts/check-schema-fingerprint.sh         # CI gate
#   scripts/check-schema-fingerprint.sh --update  # accept the new hash
#
# Exit codes:
#   0 — match
#   1 — mismatch (with diff message)
#   2 — file missing / setup error

set -euo pipefail

SCHEMA_FILE="prisma/schema.prisma"
FINGERPRINT_FILE="prisma/schema.prisma.sha256"

if [ ! -f "$SCHEMA_FILE" ]; then
  echo "error: $SCHEMA_FILE not found (run from repo root)" >&2
  exit 2
fi

ACTUAL=$(shasum -a 256 "$SCHEMA_FILE" | awk '{print $1}')

# --update flag: write the new hash and exit. Used by the developer
# who intentionally changed the schema and wants to accept the new
# fingerprint in the same PR.
if [ "${1:-}" = "--update" ]; then
  echo "$ACTUAL" > "$FINGERPRINT_FILE"
  echo "updated $FINGERPRINT_FILE → $ACTUAL"
  exit 0
fi

if [ ! -f "$FINGERPRINT_FILE" ]; then
  echo "error: $FINGERPRINT_FILE not found — bootstrap with --update" >&2
  exit 2
fi

EXPECTED=$(cat "$FINGERPRINT_FILE" | tr -d '[:space:]')

if [ "$ACTUAL" = "$EXPECTED" ]; then
  echo "✓ schema fingerprint matches ($ACTUAL)"
  exit 0
fi

cat >&2 <<EOF
✗ schema fingerprint MISMATCH

  $SCHEMA_FILE actual:    $ACTUAL
  $FINGERPRINT_FILE expected: $EXPECTED

The schema changed but the fingerprint file wasn't updated.
This is the CC8 change-management gate — schema changes must be
explicitly acknowledged in the PR.

To accept the change:
  $0 --update
  git add $FINGERPRINT_FILE
  git commit --amend  # or a new commit

If the schema didn't change intentionally, investigate why
$SCHEMA_FILE was modified.
EOF

exit 1
