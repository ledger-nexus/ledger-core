#!/usr/bin/env bash
# Non-interactive deploy of the entire ledger-nexus portfolio to Vercel.
#
# What you need before running:
#
#   1. A Vercel account.  Sign up at https://vercel.com (free).
#
#   2. A Vercel deploy token.  Generate one at:
#        https://vercel.com/account/tokens
#      Click "Create Token" → no scope restrictions needed → copy.
#
#   3. A Neon Postgres project.  Sign up at https://neon.tech (free).
#      Create a project named "ledger-nexus".  From Connection Details,
#      copy the POOLED connection string (the URL ends in "-pooler").
#
# Then:
#
#   export VERCEL_TOKEN=<your token from step 2>
#   export DATABASE_URL=<Neon pooled URL from step 3>
#   ./bin/deploy.sh
#
# The script generates the three internal-auth tokens automatically,
# saves them to /tmp/ledger-nexus-tokens.txt for your reference, and
# wires them into every Vercel project's env vars.  It then deploys
# ledger-core first, pushes the schema to Neon, runs the seed, and
# deploys the other four repos with ledger-core's URL injected.
#
# Cross-repo URLs propagate automatically: recon and revenue-rec and
# fa-amort all get LEDGER_CORE_URL set to the deployed URL of step 1;
# integrations gets RECON_URL set to the deployed URL of step 2.
#
# Runtime: roughly 10-15 minutes end-to-end on a normal connection.
# Most of the time is Vercel's build, not Neon round trips.
#
# All five repos must live as sibling directories under one parent:
#
#   $PORTFOLIO_ROOT/
#     ledger-core/   ← this script lives in ./bin/
#     recon/
#     revenue-rec/
#     integrations/
#     fa-amort/

set -euo pipefail

# ─── Pre-flight ─────────────────────────────────────────────────────────

if [ -z "${VERCEL_TOKEN:-}" ]; then
  echo "✗ VERCEL_TOKEN is not set." >&2
  echo "  Generate one at https://vercel.com/account/tokens and run:" >&2
  echo "    export VERCEL_TOKEN=<token>" >&2
  exit 1
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "✗ DATABASE_URL is not set." >&2
  echo "  Get the Neon pooled URL (ends in '-pooler') from" >&2
  echo "    https://console.neon.tech/" >&2
  echo "  and run:  export DATABASE_URL=<url>" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "✗ openssl is required for token generation." >&2
  exit 1
fi

PORTFOLIO_ROOT="$(cd "$(dirname "$0")/../../" && pwd)"
echo "Portfolio root: $PORTFOLIO_ROOT"

# Verify all 5 repos are present as siblings.
for repo in ledger-core recon revenue-rec integrations fa-amort; do
  if [ ! -d "$PORTFOLIO_ROOT/$repo" ]; then
    echo "✗ Missing repo at $PORTFOLIO_ROOT/$repo" >&2
    echo "  Clone all 5 repos as siblings under one parent directory." >&2
    exit 1
  fi
done

# ─── Generate shared tokens ─────────────────────────────────────────────

# These are the secrets that gate the cross-repo HTTP boundaries.
# Saved to /tmp so you can recover them if a redeploy fails partway.
INTERNAL_API_TOKEN="$(openssl rand -hex 32)"
RECON_INTERNAL_API_TOKEN="$(openssl rand -hex 32)"
AUTH_STUB_SECRET="$(openssl rand -hex 32)"
ADMIN_TOKEN="$(openssl rand -hex 32)"

cat > /tmp/ledger-nexus-tokens.txt <<EOF
# ledger-nexus deploy tokens — generated $(date -u +%Y-%m-%dT%H:%M:%SZ)
INTERNAL_API_TOKEN=$INTERNAL_API_TOKEN
RECON_INTERNAL_API_TOKEN=$RECON_INTERNAL_API_TOKEN
AUTH_STUB_SECRET=$AUTH_STUB_SECRET
ADMIN_TOKEN=$ADMIN_TOKEN
EOF
echo "Saved generated tokens to /tmp/ledger-nexus-tokens.txt"

# ─── Helpers ────────────────────────────────────────────────────────────

# set_env_var <project> <key> <value>
# Idempotent: removes any existing value first, then adds.  Vercel's CLI
# refuses to overwrite an env var via `add`, so we delete-and-add.
set_env_var() {
  local project=$1 key=$2 value=$3
  # rm is best-effort; ignore "not found" exit codes
  (cd "$PORTFOLIO_ROOT/$project" && \
    npx --yes vercel env rm "$key" production --yes --token="$VERCEL_TOKEN" \
    >/dev/null 2>&1) || true
  printf '%s' "$value" | (cd "$PORTFOLIO_ROOT/$project" && \
    npx --yes vercel env add "$key" production --token="$VERCEL_TOKEN" \
    >/dev/null)
  echo "    $key set"
}

# link_project <repo-dir> <project-name>
# Links the working directory to a Vercel project, creating one with the
# given name if it doesn't exist yet. `--yes` accepts default scope (the
# user's personal account, fine for a free-tier deploy); `--project`
# names the project. Re-running is idempotent — Vercel writes
# .vercel/project.json on first link and skips on subsequent runs.
link_project() {
  local repo=$1 project=$2
  (cd "$PORTFOLIO_ROOT/$repo" && \
    npx --yes vercel link --yes --project="$project" --token="$VERCEL_TOKEN" \
    >/dev/null)
}

# deploy_prod <repo>
# Runs the production deploy and prints the deploy URL (just the URL)
# on the LAST line of stdout.
deploy_prod() {
  local repo=$1
  cd "$PORTFOLIO_ROOT/$repo"
  npx --yes vercel deploy --prod --token="$VERCEL_TOKEN" \
    2>/tmp/vercel-deploy-$repo.log | tail -1
}

# ─── Step 1: ledger-core ────────────────────────────────────────────────

echo
echo "==== [1/5] ledger-core"
link_project ledger-core ledger-nexus-ledger-core
echo "  setting env vars..."
set_env_var ledger-core DATABASE_URL "$DATABASE_URL"
set_env_var ledger-core INTERNAL_API_TOKEN "$INTERNAL_API_TOKEN"
set_env_var ledger-core AUTH_STUB_SECRET "$AUTH_STUB_SECRET"
set_env_var ledger-core ADMIN_TOKEN "$ADMIN_TOKEN"
echo "  deploying..."
LEDGER_URL=$(deploy_prod ledger-core)
echo "  ✓ ledger-core deployed: $LEDGER_URL"

# ─── Step 2: schema push + seed ─────────────────────────────────────────

echo
echo "==== Pushing schema + seed to Neon"
cd "$PORTFOLIO_ROOT/ledger-core"
DATABASE_URL="$DATABASE_URL" npx prisma generate >/dev/null
DATABASE_URL="$DATABASE_URL" npx prisma db push --accept-data-loss
DATABASE_URL="$DATABASE_URL" npm run db:seed
echo "  ✓ schema + Northwind seed loaded"

# ─── Step 3: recon ──────────────────────────────────────────────────────

echo
echo "==== [2/5] recon"
link_project recon ledger-nexus-recon
echo "  setting env vars..."
set_env_var recon DATABASE_URL "$DATABASE_URL"
set_env_var recon LEDGER_CORE_URL "$LEDGER_URL"
set_env_var recon LEDGER_CORE_INTERNAL_TOKEN "$INTERNAL_API_TOKEN"
set_env_var recon RECON_INTERNAL_API_TOKEN "$RECON_INTERNAL_API_TOKEN"
set_env_var recon AUTH_STUB_SECRET "$AUTH_STUB_SECRET"
echo "  deploying..."
RECON_URL=$(deploy_prod recon)
echo "  ✓ recon deployed: $RECON_URL"

# ─── Step 4: revenue-rec ────────────────────────────────────────────────

echo
echo "==== [3/5] revenue-rec"
link_project revenue-rec ledger-nexus-revenue-rec
echo "  setting env vars..."
set_env_var revenue-rec DATABASE_URL "$DATABASE_URL"
set_env_var revenue-rec LEDGER_CORE_URL "$LEDGER_URL"
set_env_var revenue-rec LEDGER_CORE_INTERNAL_TOKEN "$INTERNAL_API_TOKEN"
set_env_var revenue-rec AUTH_STUB_SECRET "$AUTH_STUB_SECRET"
echo "  deploying..."
REV_URL=$(deploy_prod revenue-rec)
echo "  ✓ revenue-rec deployed: $REV_URL"

# ─── Step 5: integrations ───────────────────────────────────────────────

echo
echo "==== [4/5] integrations"
link_project integrations ledger-nexus-integrations
echo "  setting env vars..."
set_env_var integrations DATABASE_URL "$DATABASE_URL"
set_env_var integrations RECON_URL "$RECON_URL"
set_env_var integrations RECON_INTERNAL_API_TOKEN "$RECON_INTERNAL_API_TOKEN"
set_env_var integrations AUTH_STUB_SECRET "$AUTH_STUB_SECRET"
echo "  deploying..."
INT_URL=$(deploy_prod integrations)
echo "  ✓ integrations deployed: $INT_URL"

# ─── Step 6: fa-amort ───────────────────────────────────────────────────

echo
echo "==== [5/5] fa-amort"
link_project fa-amort ledger-nexus-fa-amort
echo "  setting env vars..."
set_env_var fa-amort DATABASE_URL "$DATABASE_URL"
set_env_var fa-amort LEDGER_CORE_URL "$LEDGER_URL"
set_env_var fa-amort LEDGER_CORE_INTERNAL_TOKEN "$INTERNAL_API_TOKEN"
set_env_var fa-amort AUTH_STUB_SECRET "$AUTH_STUB_SECRET"
echo "  deploying..."
FA_URL=$(deploy_prod fa-amort)
echo "  ✓ fa-amort deployed: $FA_URL"

# ─── Summary ────────────────────────────────────────────────────────────

echo
echo "═══════════════════════════════════════════════════════════════════════"
echo "DEPLOY COMPLETE"
echo "═══════════════════════════════════════════════════════════════════════"
echo
echo "ledger-core:   $LEDGER_URL"
echo "recon:         $RECON_URL"
echo "revenue-rec:   $REV_URL"
echo "integrations:  $INT_URL"
echo "fa-amort:      $FA_URL"
echo
echo "Tokens saved to /tmp/ledger-nexus-tokens.txt (keep these somewhere safe)."
echo
echo "Quick smoke test:  curl -sI $LEDGER_URL | head -3"
echo
echo "Run the demo against prod:"
echo "  cd $PORTFOLIO_ROOT/ledger-core"
echo "  DATABASE_URL=\"$DATABASE_URL\" npm run demo"
echo
echo "Then open:  $LEDGER_URL/reports/month-end?entity=DEMO_CO&book=US_GAAP&period=2026-05"
