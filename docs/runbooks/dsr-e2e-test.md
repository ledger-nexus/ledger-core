# Runbook — DSR end-to-end smoke test

> Verifies the cross-repo DSR attribution loop against **running**
> services. Run before shipping anything that touches
> `src/lib/privacy/` in ledger-core or the attribution endpoint in any
> companion repo.

## Why this exists

Every other DSR test injects a fake `fetch`. Those prove our parsing is
right. None of them proves that ledger-core and the four companion
repos still agree on the wire format — and that agreement is spread
across five independently-deployed codebases, which is exactly the kind
of contract that rots silently.

The failure this catches: a companion renames a field, its own tests
pass, ledger-core's mocked tests pass, and the next real Art. 15 export
quietly reports `reachable: false` for that companion. The regulator
sees a gap; nobody sees a broken build.

## What it asserts

1. The bundle comes back at `schemaVersion: 2` — the signal that
   companion attribution was attempted at all.
2. All four companions answer `reachable: true`.
3. The serialized bundle contains **no** credential-shaped strings
   (`access_token`, `client_secret`, `Bearer `, the shared token
   itself) and **no** contents-shaped strings (`counterpartyName`,
   `bankAccountNumber`, `routingNumber`). This is the Art. 15(4)
   rights-of-others boundary: companions return **counts**, never
   contents.
4. `fetchedAt` is stamped at export time, not carried from an earlier
   run.
5. Without a token, the bundle stays at `schemaVersion: 1` and omits
   the attribution section entirely — rather than presenting an empty
   section as though the companions had reported zero.

Unit-level coverage lives in `tests/companion-attribution.test.ts`.
This runbook is for the cross-process loop only.

## Prerequisites

- All five repos checked out and installed.
- **The same `INTERNAL_API_TOKEN` in all five.** A mismatch surfaces as
  `HTTP 401` in the `reachable: false` error, which is the single most
  common reason this test fails.
- At least one `User` row in the ledger-core database (`npm run db:seed`).

## Running it

Five servers, on the ports baked into `COMPANION_URLS` in
`src/lib/privacy/companion-attribution.ts`:

```bash
npm --prefix ~/Code/ledger-core   run dev -- --port 3010
```

```bash
npm --prefix ~/Code/recon         run dev -- --port 3001
```

```bash
npm --prefix ~/Code/revenue-rec   run dev -- --port 3002
```

```bash
npm --prefix ~/Code/integrations  run dev -- --port 3003
```

```bash
npm --prefix ~/Code/fa-amort      run dev -- --port 3004
```

Then, from the ledger-core root:

```bash
E2E_DSR_TEST=1 INTERNAL_API_TOKEN=<the-shared-token> npx vitest run tests/dsr-e2e-smoke.test.ts
```

To target staging instead of localhost, override per service:
`RECON_URL`, `REVENUE_REC_URL`, `INTEGRATIONS_URL`, `FA_AMORT_URL`.

## Reading a failure

| Symptom | Cause |
|---|---|
| `reachable: false — HTTP 401` | `INTERNAL_API_TOKEN` differs between that companion and ledger-core |
| `reachable: false — fetch failed` | That server isn't running, or is on a different port |
| `reachable: false — The operation was aborted` | Companion exceeded the 5s timeout in `companion-attribution.ts` |
| `expected 1 to be 2` on `schemaVersion` | No token reached `buildUserDataExport` — check the env var actually exported into the vitest process |
| Art. 15(4) failure listing leaked keys | **Stop and fix the companion.** It is returning contents where it should return counts. This is a privacy defect, not a test defect. |

## When it skips

The suite skips silently — and does not fail CI — unless `E2E_DSR_TEST=1`,
`INTERNAL_API_TOKEN`, and `DATABASE_URL` are all set. CI has no companion
services, so skipping there is correct.

One always-on case remains in the file, asserting that the skip
predicate itself is coherent. Without it, a typo in the predicate could
disable the whole file permanently and nothing would ever say so.

## When to run

- Before deploying a release touching `src/lib/privacy/` in ledger-core.
- Before deploying a companion release touching its
  `POST /api/internal/dsr/attribution` handler.
- When changing the wire format of that endpoint — in which case run it
  **twice**: once before the change to confirm the environment is good,
  once after.
