// Cross-repo DSR attribution fetcher for the portfolio.
//
// Privacy TSC. Companion piece to `user-data.ts buildUserDataExport()`.
//
// When ledger-core assembles a Data Export bundle for a subject, the
// substrate's own attribution (JE counts, audit log, notes) lives in
// `user-data.ts`. The FOUR companion repos own additional attribution
// columns on their tables; we collect those counts here.
//
// Architecture:
//   - Each companion repo exposes `POST /api/internal/dsr/attribution`
//     (token-gated by INTERNAL_API_TOKEN, mirrors the existing
//     /api/internal/journal-entries pattern).
//   - This module POSTs to each endpoint in parallel and assembles
//     the results.
//   - On any failure (timeout, 5xx, network error, missing endpoint),
//     the affected companion contributes a `reachable: false` entry
//     with zero counts. The bundle still gets assembled — partial
//     attribution is preferable to a failed DSR.
//
// Companion endpoint contract:
//   Request:  POST /api/internal/dsr/attribution
//             Authorization: Bearer <INTERNAL_API_TOKEN>
//             Body: { "userId": "<uuid>" }
//   Response: 200 with the companion's attribution shape, or
//             4xx/5xx → treat as unreachable
//   Timeout:  5 seconds per companion (DSR is bound by 30-day SLA,
//             not request latency — long timeouts hurt nothing)
//
// =========================================================================
// COUNTERPART HELPERS LIVE IN THE COMPANION REPOS
// =========================================================================
//
// The actual count-assembly logic lives in:
//   - integrations/src/lib/privacy/connections-export.ts
//   - recon/src/lib/privacy/recon-attribution.ts
//   - fa-amort/src/lib/privacy/fa-attribution.ts
//   - revenue-rec/src/lib/privacy/rr-attribution.ts
//
// All four were shipped in 2026-06-04's companion-attribution arc.
// Their type contracts are MIRRORED here as interfaces so ledger-core
// stays loosely coupled: changes to companion shapes require an
// explicit edit here.

/**
 * URLs of the four companion repos. Defaults to the development ports
 * documented in each companion's CLAUDE.md. Production URLs come from
 * env vars at use-time.
 */
const COMPANION_URLS = {
  integrations:
    process.env.INTEGRATIONS_URL ?? "http://localhost:3003",
  recon: process.env.RECON_URL ?? "http://localhost:3001",
  faAmort: process.env.FA_AMORT_URL ?? "http://localhost:3004",
  revenueRec: process.env.REVENUE_REC_URL ?? "http://localhost:3002",
} as const;

const REQUEST_TIMEOUT_MS = 5_000;

// ─────────────────────────────────────────────────────────────────────────────
// Mirrored interfaces — must stay in sync with companion-repo definitions
// ─────────────────────────────────────────────────────────────────────────────

/** Mirror of `integrations.ConnectionsAttribution`. */
export interface ConnectionsAttribution {
  connectionsCreated: number;
  connectionsByStatus: Record<string, number>;
  syncRunsInitiated: number;
  connectionsBySystem: Record<string, number>;
  snapshotAt: string;
}

/** Mirror of `recon.ReconAttribution`. */
export interface ReconAttribution {
  bankStatementsUploaded: number;
  reconciliationMatchesApproved: number;
  aiSuggestionsAccepted: number;
  aiSuggestionsRejected: number;
  snapshotAt: string;
}

/** Mirror of `fa-amort.FaAmortAttribution`. */
export interface FaAmortAttribution {
  fixedAssetsRegistered: number;
  depreciationRunsInitiated: number;
  aiAssetSuggestionsAccepted: number;
  aiAssetSuggestionsRejected: number;
  assetDisposalsAuthorized: number;
  snapshotAt: string;
}

/** Mirror of `revenue-rec.RevenueRecAttribution`. */
export interface RevenueRecAttribution {
  revenueContractsCreated: number;
  contractDocumentsUploaded: number;
  recognitionSchedulesApproved: number;
  aiExtractionsAccepted: number;
  aiExtractionsRejected: number;
  snapshotAt: string;
}

/**
 * Aggregate companion attribution. Each companion's section is wrapped
 * in `{ reachable, data?, error? }` so the bundle preserves visibility
 * into which companion contributed real data vs. defaulted to zeros.
 *
 * A regulator reading the export sees BOTH the counts AND whether a
 * given companion was queryable at export time — important for the
 * Privacy TSC audit trail.
 */
export interface CompanionAttribution {
  integrations:
    | { reachable: true; data: ConnectionsAttribution }
    | { reachable: false; error: string };
  recon:
    | { reachable: true; data: ReconAttribution }
    | { reachable: false; error: string };
  faAmort:
    | { reachable: true; data: FaAmortAttribution }
    | { reachable: false; error: string };
  revenueRec:
    | { reachable: true; data: RevenueRecAttribution }
    | { reachable: false; error: string };
  /** When the cross-repo fetch began (ISO 8601 UTC). */
  fetchedAt: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetcher
// ─────────────────────────────────────────────────────────────────────────────

interface FetchOptions {
  /**
   * Token for `Authorization: Bearer <token>`. Required.
   * Caller is responsible for resolving it from env. Letting the
   * caller pass it in (instead of reading process.env here) makes
   * the function testable + composable with the boot-time env-
   * validation pattern.
   */
  internalApiToken: string;
  /**
   * Optional override for fetch — injection seam for tests. Defaults
   * to global fetch.
   */
  fetchImpl?: typeof fetch;
}

async function fetchOne<T>(
  url: string,
  userId: string,
  opts: FetchOptions
): Promise<{ reachable: true; data: T } | { reachable: false; error: string }> {
  const f = opts.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await f(`${url}/api/internal/dsr/attribution`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.internalApiToken}`,
      },
      body: JSON.stringify({ userId }),
      signal: controller.signal,
    });
    if (!res.ok) {
      return {
        reachable: false,
        error: `HTTP ${res.status} ${res.statusText}`,
      };
    }
    const data = (await res.json()) as T;
    return { reachable: true, data };
  } catch (err) {
    const msg =
      err instanceof Error ? err.message : "unknown fetch error";
    return { reachable: false, error: msg };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fetch attribution counts from all four companion repos in parallel.
 *
 * Failure-tolerant: a companion that errors / times out / returns 5xx
 * contributes `{ reachable: false, error }` instead of crashing the
 * whole DSR. The Privacy TSC commitment is that the export gets
 * assembled; partial attribution is preferable to a failed request.
 *
 * @param userId - Subject user UUID, passed verbatim to each companion
 * @param opts - INTERNAL_API_TOKEN + optional fetch injection
 * @returns Aggregated companion attribution shape
 */
export async function fetchCompanionAttribution(
  userId: string,
  opts: FetchOptions
): Promise<CompanionAttribution> {
  const fetchedAt = new Date().toISOString();
  const [integrations, recon, faAmort, revenueRec] = await Promise.all([
    fetchOne<ConnectionsAttribution>(COMPANION_URLS.integrations, userId, opts),
    fetchOne<ReconAttribution>(COMPANION_URLS.recon, userId, opts),
    fetchOne<FaAmortAttribution>(COMPANION_URLS.faAmort, userId, opts),
    fetchOne<RevenueRecAttribution>(COMPANION_URLS.revenueRec, userId, opts),
  ]);

  return {
    integrations,
    recon,
    faAmort,
    revenueRec,
    fetchedAt,
  };
}
