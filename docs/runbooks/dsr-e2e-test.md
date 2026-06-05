# DSR End-to-End Smoke Test Runbook

> Verify the cross-repo DSR attribution loop against running services.
> Run before every release that touches `src/lib/privacy/`, and ad-hoc
> whenever a companion repo's attribution helper changes.

## What this verifies

`buildUserDataExport({ internalApiToken })` in ledger-core fetches
attribution counts from all four companion repos via
`POST /api/internal/dsr/attribution`. The end-to-end smoke test
asserts:

1. The returned bundle has `schemaVersion: 2`.
2. Every companion section has `reachable: true` with a valid
   `snapshotAt` timestamp.
3. The serialized bundle contains no credentials- or contents-shaped
   strings (HARD INVARIANTS — Art. 15(4) rights-of-others +
   counterparty PII carve-outs).
4. `companionAttribution.fetchedAt` is fresh (within ±1s of the test
   wall clock).

Unit-level tests live in `tests/companion-attribution.test.ts`. This
runbook is for the actual cross-process loop.

## When to run

- Before deploying any release that touches `src/lib/privacy/` in
  ledger-core or any companion repo.
- When changing the wire format of `POST /api/internal/dsr/attribution`
  in any companion.
- When rotating `INTERNAL_API_TOKEN`.
- As part of the quarterly DSR drill (see
  `docs/policies/data-subject-requests.md` → "Quarterly verification").

## Prereqs

- All 5 repos cloned + `pnpm install`'d:
  ledger-core, recon, revenue-rec, integrations, fa-amort.
- Shared `DATABASE_URL` set in each repo's `.env`.
- The SAME `INTERNAL_API_TOKEN` set in each repo's `.env`.
- At least one User row in the shared DB (any tenant will do —
  the test asserts nothing about the user's specific data).

## Run

Open 6 terminals:

```bash
# Terminal 1 — ledger-core (port 3000)
cd ledger-core && pnpm dev

# Terminal 2 — recon (port 3001)
cd recon && pnpm dev

# Terminal 3 — revenue-rec (port 3002)
cd revenue-rec && pnpm dev

# Terminal 4 — integrations (port 3003)
cd integrations && pnpm dev

# Terminal 5 — fa-amort (port 3004)
cd fa-amort && pnpm dev

# Terminal 6 — run the smoke test
cd ledger-core
E2E_DSR_TEST=1 \
INTERNAL_API_TOKEN=<the-token-all-five-repos-share> \
pnpm vitest run tests/dsr-e2e-smoke.test.ts
```

Expected output:

```
✓ tests/dsr-e2e-smoke.test.ts (4 tests) ~3000ms
  ✓ returns schemaVersion 2 bundle with all four companions reachable
  ✓ HARD INVARIANT: serialized bundle contains no credentials- or contents-shaped strings
  ✓ fetchedAt is a valid ISO 8601 timestamp from this run
  ✓ reports its skip status (skipped: false, reason: running live)
```

## Failure triage

### `companion "X" was unreachable: HTTP 503`

The companion's `/api/internal/dsr/attribution` endpoint is disabled
because its `INTERNAL_API_TOKEN` is unset. Set it in that repo's `.env`
and restart its `pnpm dev`.

### `companion "X" was unreachable: HTTP 401`

The `INTERNAL_API_TOKEN` value in that companion's env doesn't match
the one ledger-core is sending. Make sure all five `.env` files share
the same value.

### `companion "X" was unreachable: ECONNREFUSED`

The companion's `pnpm dev` isn't running on the expected port. Check:
- integrations → 3003
- recon → 3001
- revenue-rec → 3002
- fa-amort → 3004

### `HARD INVARIANT` test fails with `accesstoken` or `credentials` found

A companion's attribution helper is leaking sensitive data into its
response. Inspect the failing companion's
`src/lib/privacy/{name}-attribution.ts` — the returned shape MUST NOT
include any token-shaped or contents-shaped fields. Find the leaking
field, remove it from the type, and re-run.

### `HARD INVARIANT` test fails with `rawtext` or `rawpayload`

revenue-rec or recon is leaking counterparty PII. Check that the
attribution helper returns only COUNTS, not document contents.

### Skipped when expected to run

Verify:
- `E2E_DSR_TEST=1` is set in the test terminal (the export of the
  variable, not in `.env`).
- `INTERNAL_API_TOKEN` is set in the test terminal.
- `DATABASE_URL` is set in the test terminal.

The test file prints its skip reason in the test name when it skips.

## When the test passes

Record the run in the audit-log:

```sql
-- inserted via /api/internal/audit-log or directly via prisma
INSERT INTO audit_log (id, event_type, actor_user_id, metadata)
VALUES (
  gen_random_uuid(),
  'dsr_smoke_test_passed',
  '<your-user-id>',
  '{"ranAt": "<ISO timestamp>", "version": "<git-sha>"}'
);
```

The append-only RULE on `audit_log` ensures this is preserved across
the SOC 2 observation window.

## Related

- `docs/policies/data-subject-requests.md` — DSR procedure policy
- `src/lib/privacy/companion-attribution.ts` — the consumer code
- `src/lib/privacy/user-data.ts` — `buildUserDataExport`
- Each companion's `src/app/api/internal/dsr/attribution/route.ts`
- Unit tests: `tests/companion-attribution.test.ts`,
  `tests/data-subject-request.test.ts`
