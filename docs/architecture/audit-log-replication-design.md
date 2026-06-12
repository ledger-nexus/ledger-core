# Audit log replication — design

**Status:** Design proposal · **Owner:** Chris · **Created:** 2026-06-06 · **Closes:** Deficiency #9

## Problem

`audit_log` lives in the primary Neon Postgres database. If that database is lost (catastrophic corruption, accidental hard-delete of the project, Neon account compromise), the audit trail goes with it. SOC 2 CC4 (monitoring activities) + CC7.4 (system anomalies detection) both require an audit trail that survives substrate loss to be credible evidence.

The current append-only RULE on `audit_log` (DB-level, PR #10 / task #15) prevents tampering **within** the live database. It does not protect against **loss** of the database.

## Requirements

1. **Survives DB loss.** A complete-or-near-complete copy of `audit_log` must exist outside the primary Neon DB at any given moment.
2. **Append-only at the secondary store.** Same posture as the DB-level RULE — no `UPDATE` / `DELETE` paths.
3. **Tamper-evident.** Modifications to either the primary or the secondary should be detectable (hash chain or equivalent).
4. **Low-friction.** Cannot require manual operator action per audit row. Cannot require Neon-specific extensions (Postgres is portable).
5. **Cost-bounded.** v1.0 scale is tens of audit rows per day per tenant; v2 (post-customer-2) target is ≤ $50/mo at the replication layer.

## Non-requirements (out of scope for this design)

- **Cross-region replication.** Neon already handles AZ-level redundancy; full multi-region is a separate availability concern (deficiency #19 backup integrity).
- **Real-time querying of the secondary.** The secondary is for **survival**, not for queries. Audit log reads continue against the primary.
- **Replicating other tables.** This design is scoped to `audit_log`. Replicating `journal_entry` etc. is the substrate's own concern (backup + PITR).

## Options considered

### Option A — Append-only S3 bucket with object lock

Every audit row mirrors to an S3 object (key: `audit_log/<yyyy>/<mm>/<dd>/<uuid>.json`). Bucket has Object Lock enabled in compliance mode with a retention period of 7 years (matches the accounting record retention in `data-classification.md`).

**Pros:**
- Object Lock in compliance mode is hardware-enforced append-only at the AWS layer. No code path can mutate or delete a locked object before the retention expires — including AWS root.
- Cost: ~$0.023 / GB-month + $0.005 / 1000 PUT. At 100 rows/day × 1 KB/row = 3 MB/month. Negligible.
- Standard SOC 2 evidence shape — auditors recognize S3 + Object Lock immediately.
- Decouples from Neon entirely.

**Cons:**
- Latency: per-row PUT adds ~50-100ms to the audit emit path.
- Async replication needed to keep this off the hot path → adds queue infrastructure.
- AWS account becomes a secondary dependency (and a SOC 2 vendor receipt to chase — deficiency #8).

### Option B — Append-only secondary Postgres

Replicate `audit_log` to a separate Postgres instance via logical replication. The secondary is read-only for the application (no write credentials in app env); only the replication slot writes. Apply the same DB-level append-only RULE on the secondary.

**Pros:**
- Same data shape — no serialization layer to bug-test.
- Postgres-native tooling; no AWS dependency.
- Replication lag bounded to ~1 second under normal load.
- Can mirror to any provider (Neon, RDS, self-hosted) — vendor-neutral.

**Cons:**
- Second Postgres bill (~$20-50/mo on Neon Launch tier; ~$15/mo on RDS t4g.micro).
- Logical replication is operationally complex — slot management, conflict resolution, schema drift between primary and secondary.
- Secondary still requires its own backup story to actually survive provider loss.
- Doesn't break the Postgres-flavor dependency — if there's a Postgres-level vulnerability that compromises both, both go down together.

### Option C — Event stream to long-term storage (SQS + S3 / Kinesis Firehose)

Every audit emit publishes to a queue (SQS or Kinesis Firehose). The queue's downstream consumer batches into S3 Object-Locked archives.

**Pros:**
- Decouples emit from durability — emit just publishes to queue, queue handles batching + retries + delivery to S3.
- Batching cuts cost (single PUT for N rows instead of N PUTs).
- Replay-able: if S3 needs to be re-loaded, replay from the queue's archive.

**Cons:**
- More infrastructure than Option A — adds a queue dependency.
- Kinesis Firehose pricing is per-MB ingested; cheap at low volume but per-GB scales linearly.
- Queue itself can lose messages if not configured for FIFO + DLQ — adds a second tier of "did this actually get written?"
- Operational overhead for a substrate that doesn't have other event-stream patterns yet.

### Option D — Periodic snapshot export

Cron job runs every hour, exports new audit rows (where `id > last_exported_id`) to S3 as a CSV / JSONL file.

**Pros:**
- Trivially simple — single cron, single S3 PUT per hour.
- No new dependencies beyond S3.

**Cons:**
- **Up-to-1-hour data loss window.** A catastrophic primary loss between snapshots loses up to an hour of audit. Unacceptable for SOC 2 audit-trail integrity claims.
- Operator burden: monitoring cron health is its own thing.
- "Cron didn't run" is a silent failure — needs alerting.

## Recommendation

**Option A — Append-only S3 bucket with Object Lock**, with an explicit phased rollout:

1. **Phase 1 (Design — this doc).** Doc + decision capture. Closes the design surface of #9.
2. **Phase 2 (Implementation — sync inline emit).** Add `src/lib/audit/mirror.ts` — every `prisma.auditLog.create({ data })` writes to both DB and S3 in the same call. Synchronous, inline, blocking. Acceptable for v1 (low-volume); the 50-100ms latency tax is fine on a path that's already audit-trail-heavy. **DEFERRED** until customer #2 onboards.
3. **Phase 3 (Async emit via SQS).** When emit volume crosses ~1000 rows/day (or first customer complains about latency), introduce SQS between the app and S3. This is Option C grafted onto Option A; the S3 archive is unchanged.

**Why this phased approach:**
- The current scale (zero production customers) doesn't justify infrastructure spend. Documenting the design captures the SOC 2 readiness commitment without paying for it yet.
- When the first customer onboards, Phase 2 ships with that customer's go-live as a coordinated change.
- Phase 3 is a clean refactor of Phase 2 — Phase 2's `mirror.ts` becomes the consumer for the queue.

## SOC 2 control mapping

| Control | What this design satisfies |
|---|---|
| **CC4** monitoring activities | Audit trail survives substrate loss → monitoring evidence remains available for incident reconstruction |
| **CC7.2** system anomalies detection | The append-only secondary is itself anomaly detection: if primary and secondary diverge (hash chain breaks), that's an anomaly trip |
| **CC7.4** incident response | Incident reconstruction requires audit trail. This design ensures the trail exists outside the system being investigated |
| **CC6.7** transmission of confidential information | TLS in transit to S3 (always); SSE-KMS at rest in S3 (encryption-at-rest at the bucket layer) |
| **Availability TSC** | Audit trail integrity is an availability property of the audit subsystem |

## Open questions

1. **Hash chain implementation.** Do we hash-link audit rows (each row includes a hash of the prior row's row, forming a chain) before mirroring, so tampering at either the primary or the secondary breaks the chain? Recommendation: **yes, in Phase 2.** Adds ~32 bytes per row, ~20μs of SHA-256 work. Required for tamper-evidence claim.
2. **Tenant-scoped buckets vs single bucket.** Single bucket is simpler. Tenant-scoped buckets allow per-tenant retention policy customization (some industries require 10 years not 7). Recommendation: **single bucket, key-prefixed by tenant ID** — best balance of operational simplicity and per-tenant separation.
3. **Retention period.** 7 years is the IRS / SEC standard for accounting records. SOC 2 audit windows are typically 1-2 years. Recommendation: **7 years** — matches the longest applicable retention obligation and is the value already documented in `data-classification.md`.
4. **What about pre-identity events (TOKEN_REJECTED with garbage Bearer)?** These have `tenantId = NULL`. Key prefix becomes `audit_log/_platform/...`. Visible only to platform admins, matching the `audit_log` access policy.

## Cost estimate (Phase 2)

At v1.0 scale (100 audit rows / day):
- S3 Standard PUT: 100 × 30 = 3000 PUT/mo × $0.000005 = $0.015
- S3 Standard storage: 3 MB / mo × $0.023 = $0.0001
- Total: **~$0.02 / mo** at v1 scale.

At v2 scale (10 customers × 1000 rows / day / customer):
- 300K PUT/mo × $0.000005 = $1.50
- 300 MB / mo × $0.023 = $0.007
- Total: **~$1.50 / mo** at 10-customer scale.

Phase 3 (async via SQS):
- SQS standard: $0.40 / million requests. At 300K/mo: $0.12
- Adds $0.12 / mo at v2 scale. Negligible.

## Implementation skeleton (Phase 2)

```ts
// src/lib/audit/mirror.ts
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "crypto";

const s3 = new S3Client({ region: process.env.AUDIT_MIRROR_AWS_REGION });
const BUCKET = process.env.AUDIT_MIRROR_S3_BUCKET;
const ENABLED = !!BUCKET;  // off when env unset (dev/test/CI)

export async function mirrorAuditRow(row: AuditLog, priorHash: string | null) {
  if (!ENABLED) return;
  const payload = { ...row, priorHash };
  const body = JSON.stringify(payload);
  const hash = createHash("sha256").update(body).digest("hex");
  const tenantPrefix = row.tenantId ?? "_platform";
  const ymd = row.createdAt.toISOString().slice(0, 10).replace(/-/g, "/");
  const key = `audit_log/${tenantPrefix}/${ymd}/${row.id}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: body,
    ContentType: "application/json",
    Metadata: { "sha256": hash },
    // ObjectLockMode + ObjectLockRetainUntilDate set by bucket policy
    // (compliance mode, 7-year retention). Not specified here so the
    // bucket policy is the single source of truth.
  }));
  return hash;
}
```

```ts
// src/lib/audit/emit.ts — wraps Prisma audit insert
import { prisma } from "@/lib/prisma";
import { mirrorAuditRow } from "./mirror";

export async function emitAuditRow(data: Prisma.AuditLogCreateInput) {
  const priorHash = await prisma.auditLog.findFirst({
    where: { tenantId: data.tenantId ?? null },
    orderBy: { createdAt: "desc" },
    select: { sha256: true },
  }).then(r => r?.sha256 ?? null);

  const row = await prisma.auditLog.create({ data });
  const hash = await mirrorAuditRow(row, priorHash);
  if (hash && hash !== row.sha256) {
    // Update the row's sha256 column with the mirror's computed hash.
    // (Schema migration: add `sha256 String?` column to AuditLog.)
    await prisma.auditLog.update({
      where: { id: row.id },
      data: { sha256: hash },
    });
  }
  return row;
}
```

## Migration sequence

When Phase 2 ships:

1. **Schema migration**: add `audit_log.sha256 String?` + `audit_log.priorSha256 String?` columns.
2. **Bucket provisioning**: AWS account, IAM role with `s3:PutObject` only (no Get / Delete / GetObjectVersion), Object Lock compliance mode + 7-year retention default.
3. **Secrets**: `AUDIT_MIRROR_AWS_REGION`, `AUDIT_MIRROR_S3_BUCKET`, IAM access key in Vercel env. Boot-time validator (deficiency #13) enforces presence in production.
4. **Backfill (one-time)**: ETL existing audit rows into S3, computing hash chain per tenant. Idempotent — re-running mid-failure is safe.
5. **Cutover**: replace direct `prisma.auditLog.create` calls with `emitAuditRow` portfolio-wide. Mechanical search-and-replace; tsc + tests verify.
6. **Verification**: chaos drill — drop the test database, verify all audit rows for the test tenant are recoverable from S3.

## What this design does NOT do

- **Not a backup of the entire database.** Only `audit_log`. Other tables remain Neon's responsibility.
- **Not real-time query against S3.** Audit reads still hit Postgres. S3 is the survival store.
- **Not a defense against the application emitting falsified rows.** If the app code lies, the mirror happily archives the lies. Detection requires monitoring + log review (CC4 / CC7.2 — separate controls).

## Open follow-ups (not in this design)

- Operator runbook for "primary is gone, restore from S3" — separate doc when Phase 2 ships.
- Quarterly chaos-drill cadence (mirrors the backup-restore-drill cadence in `business-continuity.md`).
- Cross-region S3 replication (Object Lock supports it; out of scope until customer requests it).
