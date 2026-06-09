# BlackLine arc — concrete design

**Status**: Phase 0 of 4. Code begins in Phase 1 (PR #205+).
**Scope**: Account Reconciliations → Close Task Calendar → Flux / Variance → Integration capstone.
**Out of scope**: JE preparer/reviewer workflow, bank transaction matching, IC mismatch detection, SOX 404 testing workpapers, disclosure management, AI/Smart Close routing. Each is its own arc.

This document is the canonical reference for the next ~17–21 PRs. It captures every architectural decision before any code lands, so the implementation can stay heads-down without re-litigating choices.

## Decisions locked in Phase 0

| # | Decision | Choice |
|---|---|---|
| 1 | Phase order | Recons → Calendar → Flux → Capstone |
| 2 | Reconciliation sign-off shape | **Configurable per-recon: single sign-off OR preparer→reviewer chain.** Schema supports both; default from a per-tenant setting, overridable per account |
| 3 | Period-close gate strength | **Hard block with admin override.** Override writes an audit row capturing the reason for skipping the gate |
| 4 | Close-task template count | **~50 BlackLine-standard tasks.** Lifted from the BlackLine F1000 starter set, lightly adapted for ledger-core's chart |

## Architecture principles

These hold across all three arcs:

1. **The GL is canon, unchanged.** Reconciliations, tasks, and flux are workflow shells that read from existing balance data. They never write to journal lines.
2. **Existing primitives get reused, not duplicated.** Ownership / queues / reassignment / notifications / audit log / `RecordEvent` / encryption extension all already exist. The new tables plug into them.
3. **Every mutation is audit-logged.** Recon sign-offs, task state changes, flux comments — each writes a `PRIVILEGED_ACTION` row via `auditPrivilegedAction`. Same pattern the Report Builder arc used for clone/edit/delete.
4. **Every Server Action is Zod-validated, tenant-scoped, and authorization-gated.** No exceptions. The global CLAUDE.md SOC 2 baseline applies.
5. **Each arc's period-close gate composes.** By end of Phase 3, `closePeriod()` runs three validators in sequence. Each returns a structured failure. Admin override skips ALL three but writes a single audit row capturing every gate that was skipped.
6. **Hard blocks with override beat warnings.** Warnings get ignored. The admin override exists as the CPA escape hatch when something exceptional needs to ship.

## Phase 1 — Account Reconciliations

### Schema

```prisma
enum ReconStatus {
  OPEN          // auto-created, not yet started
  IN_PROGRESS   // preparer is working
  PREPARED      // preparer signed; ready for reviewer
  RECONCILED    // signed off (terminal — closes the gate)
  EXCEPTION     // diff > tolerance; needs disposition
  WAIVED        // admin marked not-applicable for this period (audit row written)
}

model Reconciliation {
  id        String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String @db.Uuid
  tenant    Tenant @relation(fields: [tenantId], references: [id], onDelete: Restrict)

  // The scope tuple. Composite unique so re-running the auto-instantiator
  // is idempotent. Same shape as PeriodClose, mirrors the (entity, book,
  // period) discipline the rest of the GL uses.
  entityId  String      @db.Uuid
  entity    LegalEntity @relation(fields: [entityId], references: [id])
  bookId    String      @db.Uuid
  book      Book        @relation(fields: [bookId], references: [id])
  periodId  String      @db.Uuid
  period    Period      @relation(fields: [periodId], references: [id])
  accountId String      @db.Uuid
  account   Account     @relation(fields: [accountId], references: [id])

  // Frozen at sign-off time. The reviewer sees what the preparer saw
  // even if a JE backs into the period after the fact.
  glBalance         Decimal  @db.Decimal(20, 4)
  supportingBalance Decimal? @db.Decimal(20, 4)
  // Computed: glBalance - supportingBalance. Stored so the index +
  // ordering by "amount of disagreement" is fast.
  reconciledDiff    Decimal? @db.Decimal(20, 4)
  // Per-recon override of "is this within tolerance?" Default from the
  // operator's threshold setting (see ReconciliationConfig below).
  tolerance         Decimal  @db.Decimal(20, 4) @default(0)

  status ReconStatus @default(OPEN)
  // DECISION #2 wiring: when false, the single `preparedBy` + `preparedAt`
  // pair is the sign-off (status PREPARED → RECONCILED directly).
  // When true, both pairs must be set (PREPARED waits for reviewer).
  // Default supplied by the create-action from tenant/account config.
  requiresReview Boolean @default(true)

  preparedBy   String?   @db.Uuid
  preparedAt   DateTime?
  reviewedBy   String?   @db.Uuid
  reviewedAt   DateTime?

  // Encrypted via the existing PrismaExtension confidential-column path.
  notes        String?

  // Foreign-key reverse: every attachment + every state-change event.
  attachments  ReconciliationAttachment[]
  events       RecordEvent[] @relation("ReconciliationEvents")

  createdAt    DateTime  @default(now())
  updatedAt    DateTime  @updatedAt

  // Idempotency for auto-instantiation. Same (entity, book, period,
  // account) reused across renders.
  @@unique([entityId, bookId, periodId, accountId])
  @@index([tenantId, periodId, status])
  @@index([periodId, status]) // dashboard query
  @@map("reconciliation")
}

model ReconciliationAttachment {
  id               String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId         String         @db.Uuid
  reconciliationId String         @db.Uuid
  reconciliation   Reconciliation @relation(fields: [reconciliationId], references: [id], onDelete: Cascade)

  filename     String
  contentType  String
  // Encrypted bytes via PrismaExtension. The whole file lives in DB.
  // Self-contained, no S3 dependency. Worst case: a 5MB CSV per recon
  // = ~500MB per 100-account close. Acceptable at portfolio scale.
  payload      Bytes
  uploadedBy   String   @db.Uuid
  uploadedAt   DateTime @default(now())

  @@index([reconciliationId])
  @@map("reconciliation_attachment")
}

// Per-tenant config for the default sign-off shape. Per-account override
// stored as a new optional field on Account (added in PR 1).
model ReconciliationConfig {
  id       String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId String @unique @db.Uuid
  tenant   Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  // Tenant-level default. Overridable per-Account.
  defaultRequiresReview Boolean @default(true)
  // Default tolerance in dollars. 0 = must tie out exactly.
  defaultTolerance      Decimal @db.Decimal(20, 4) @default(0)

  updatedAt DateTime @updatedAt

  @@map("reconciliation_config")
}

// New field on existing Account model:
//   requiresReconReview Boolean? @default(null) - null = inherit tenant default
//   reconTolerance      Decimal? @db.Decimal(20, 4) @default(null) - inherit
```

### Sign-off resolution (decision #2 in detail)

When `openReconciliation` Server Action runs:

1. Look up `Account.requiresReconReview` for the account.
2. If null, fall back to `ReconciliationConfig.defaultRequiresReview` for the tenant.
3. If null, default to `true` (BlackLine standard).
4. Persist on the `Reconciliation` row at creation time. The flag is frozen for the life of the recon.

This lets operators flip the default per tenant ("we're small, single sign-off"), pin specific accounts to always-review ("cash always needs two eyes"), or pin specific accounts to never-review ("petty cash, one signature is fine").

### Server Actions

| Action | Auth | Gate | Audit row |
|---|---|---|---|
| `openReconciliation({periodId})` | requireCurrentUser + requireCurrentTenant | Idempotent — skips already-existing | `recon.open` |
| `markPrepared({reconId, glBalance, supportingBalance, notes, attachments})` | preparer = current user; recon must be OPEN or IN_PROGRESS | Status → PREPARED (or RECONCILED if !requiresReview AND diff within tolerance) | `recon.prepare` |
| `approveRecon({reconId})` | reviewer must differ from preparer (CPA segregation of duties) | Status must be PREPARED + requiresReview must be true | `recon.approve` |
| `sendBackToPreparer({reconId, comment})` | reviewer must differ from preparer | Status must be PREPARED | `recon.send-back` |
| `markException({reconId, comment})` | preparer or reviewer | Status not WAIVED or RECONCILED | `recon.exception` |
| `waiveRecon({reconId, reason})` | admin only | Any status | `recon.waive` |

### UI surfaces

- `/close/reconciliations?period=YYYY-MM` — list grid. Columns: account code, name, type, status badge, GL balance, supporting balance, diff, owner. Sortable by abs(diff) descending so unmatched items surface first.
- `/close/reconciliations/[id]` — detail page. Side-by-side GL + supporting + diff. Sign-off banner showing preparer + reviewer (or "single sign-off" badge). Evidence upload. Notes field. Action buttons gated by status.

### Period-close gate enhancement

```ts
// In closePeriod():
const openRecons = await prisma.reconciliation.count({
  where: {
    periodId, tenantId,
    status: { notIn: ["RECONCILED", "WAIVED"] },
  },
});
if (openRecons > 0 && !input.adminOverride) {
  throw new PeriodCloseError("RECONS_OPEN", `${openRecons} reconciliations not signed off`);
}
if (input.adminOverride) {
  await auditPrivilegedAction({
    actor, action: "period.close.override",
    metadata: { gate: "RECONS_OPEN", openCount: openRecons, reason: input.overrideReason },
    tenantId,
  });
}
```

### PR sequence (Phase 1)

| PR | Title | Files touched | Tests |
|---|---|---|---|
| 1 | Schema + migration 0014 | `prisma/schema.prisma`, `prisma/migrations/0014_reconciliations/migration.sql` | schema-fingerprint snapshot |
| 2 | Server Actions: open / prepare / approve / send-back / exception / waive | `src/app/actions/reconciliations.ts`, `src/lib/recon/*.ts` | ~15 happy + cross-tenant + idempotency |
| 3 | List page `/close/reconciliations` | `src/app/close/reconciliations/page.tsx`, sidebar nav | snapshot + tenant-isolation |
| 4 | Detail page with attachment upload | `src/app/close/reconciliations/[id]/page.tsx` | attachment encryption verified |
| 5 | Period-close gate enhancement | `src/lib/accounting/period-close.ts`, admin override audit row | gate-blocks-close test |
| 6 | Auto-instantiate on list-page first load | `src/app/close/reconciliations/page.tsx` lazy seed | idempotency, 1000-account perf test |
| 7 | Sub-ledger supporting-balance auto-pull (AR / AP / FA / Lease) | `src/lib/recon/supporting-balance.ts` | per-sub-ledger fixture tests |
| 8 | Doc + month-end packet integration + control-deficiency-log entry | `docs/reconciliations.md`, `src/lib/reports/month-end-pdf.tsx` | snapshot of expanded PDF |

**Sign-off gate (end of Phase 1)**: Run one full close cycle on a fixture company with ≥ 10 BS accounts. Loom walkthrough recorded.

## Phase 2 — Close Task Calendar

### Schema

```prisma
enum CloseTaskStatus {
  NOT_STARTED
  IN_PROGRESS
  BLOCKED
  DONE
  WAIVED
}

model CloseTask {
  id        String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String @db.Uuid

  entityId  String? @db.Uuid // null = applies to all entities
  bookId    String? @db.Uuid // null = applies to all books
  periodId  String  @db.Uuid

  // Links back to the template this was instantiated from.
  templateKey String? // e.g. "ACCRUE_PAYROLL"
  name        String
  description String?
  category    CloseTaskCategory // ACCRUAL | RECON | DEPRECIATION | FX | REVENUE | INVENTORY | TAX | REPORTING | ADMIN

  status        CloseTaskStatus @default(NOT_STARTED)
  // When true, period-close gate refuses if this isn't DONE.
  requiredForClose Boolean @default(true)

  ownerId       String? @db.Uuid
  ownerType     OwnerType? // USER | QUEUE — reuses existing enum
  dueOffsetDays Int? // -3 = 3 days BEFORE period end; +5 = 5 days after
  dueAt         DateTime?

  // Self-FK array. Cycle prevention enforced at write time.
  dependsOnIds  String[] @db.Uuid

  blockedReason String?
  completedBy   String?   @db.Uuid
  completedAt   DateTime?
  evidenceUrl   String?
  evidenceNote  String?

  comments      CloseTaskComment[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([tenantId, periodId, status])
  @@index([ownerId])
  @@map("close_task")
}

model CloseTaskTemplate {
  id          String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId    String @db.Uuid

  // Stable key for template-row identification across periods.
  // "ACCRUE_PAYROLL", "RUN_DEPRECIATION", etc.
  key         String
  name        String
  description String?
  category    CloseTaskCategory

  defaultOwnerId      String?   @db.Uuid
  defaultOwnerType    OwnerType?
  defaultDueOffsetDays Int?     // relative to period.endsOn
  requiredForClose    Boolean   @default(true)

  // Dependencies by KEY (resolved to ids at instantiation).
  defaultDependsOnKeys String[]

  active Boolean @default(true)

  @@unique([tenantId, key])
  @@map("close_task_template")
}

model CloseTaskComment {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId    String   @db.Uuid
  closeTaskId String   @db.Uuid
  closeTask   CloseTask @relation(fields: [closeTaskId], references: [id], onDelete: Cascade)

  body        String   // encrypted via PrismaExtension
  authorId    String   @db.Uuid
  createdAt   DateTime @default(now())

  @@index([closeTaskId])
  @@map("close_task_comment")
}
```

### 50-task template seed (BlackLine-standard)

Categorized to give the calendar page useful filter pills:

| Category | Count | Examples |
|---|---|---|
| ACCRUAL | 8 | Accrue payroll, accrue bonus, accrue interest, accrue rent, accrue utilities, AP cutoff, expense reports, vacation accrual |
| RECON | 9 | Reconcile cash, AR, AP, prepaid, fixed assets, accumulated depreciation, lease ROU + liability, deferred revenue, intercompany |
| DEPRECIATION | 3 | Run monthly depreciation, run amortization, post FA adjustments |
| FX | 3 | Post FX revaluation, post CTA, reconcile FX gain/loss |
| REVENUE | 6 | Run ASC 606 recognition, reconcile deferred revenue, run unbilled AR, close revenue subledger, post variable consideration, post true-ups |
| INVENTORY | 4 | Post inventory adjustments, run COGS allocation, reconcile cycle counts, post obsolescence reserve |
| TAX | 5 | Post tax provision, run BTD calc, file estimated payments, reconcile tax payable, post deferred tax |
| REPORTING | 7 | Run TB, run IS, run BS, run cash flow, run M-3 detail, generate month-end packet, send to leadership |
| ADMIN | 5 | Close period in GL, lock subledgers, send close-complete notification, archive evidence, post-mortem |

Total: **50 tasks**. Seeded once per tenant via `seedCloseTaskTemplates(prisma, tenantId)` — idempotent upsert by `(tenantId, key)`.

### Server Actions

| Action | Auth | Notes |
|---|---|---|
| `instantiateCalendarForPeriod({periodId})` | controller+ | Bulk-creates one CloseTask per active template, resolving dependsOnKeys → ids. Idempotent (skip if already instantiated). |
| `startTask({taskId})` | task owner or admin | Enforces dependency check |
| `blockTask({taskId, reason})` | task owner | Writes reason; notifies owner-chain |
| `completeTask({taskId, evidenceUrl?, evidenceNote?})` | task owner | Triggers dependents — if all deps done, surfaces "ready" badge |
| `reassignTask({taskId, newOwner})` | reuses existing `reassignRecord` service | RecordEvent + Notification fire automatically |
| `addTaskComment({taskId, body})` | tenant member | Encrypted; appended to thread |
| `waiveTask({taskId, reason})` | admin only | Status → WAIVED; audit row |

### UI surfaces

- `/close/calendar?period=YYYY-MM` — toggle between list view (sortable table) and Kanban (columns by status). Filter pills by category, owner, "blocking close" flag.
- `/close/calendar/[id]` — task detail. Dependency graph (which tasks block this; which this blocks). Comment thread (reuses `JournalEntryNote`-style component). Reassign / Block / Complete buttons gated by status + owner.

### Period-close gate (composes with Phase 1)

```ts
// In closePeriod():
const openRecons = /* from Phase 1 */;
const incompleteRequiredTasks = await prisma.closeTask.count({
  where: {
    periodId, tenantId,
    requiredForClose: true,
    status: { notIn: ["DONE", "WAIVED"] },
  },
});

const failures: PeriodCloseFailure[] = [];
if (openRecons > 0) failures.push({ gate: "RECONS_OPEN", count: openRecons });
if (incompleteRequiredTasks > 0) failures.push({ gate: "TASKS_INCOMPLETE", count: incompleteRequiredTasks });

if (failures.length > 0 && !input.adminOverride) {
  throw new PeriodCloseError("GATE_FAILED", failures);
}
if (input.adminOverride) {
  await auditPrivilegedAction({
    actor, action: "period.close.override",
    metadata: { gates: failures, reason: input.overrideReason },
    tenantId,
  });
}
```

### PR sequence (Phase 2)

| PR | Title |
|---|---|
| 1 | Schema (CloseTask + CloseTaskTemplate + CloseTaskComment) + migration 0015 |
| 2 | 50-task template seed + `seedCloseTaskTemplates` helper |
| 3 | Server Actions (instantiate / start / block / complete / reassign / comment / waive) + cycle-detection on dependencies |
| 4 | `/close/calendar` list + Kanban views |
| 5 | Task detail page with dependency graph + comments |
| 6 | Period-close gate composes with Phase 1 + admin override |

## Phase 3 — Flux / Variance Analysis

### Schema

```prisma
model FluxAnalysis {
  id           String @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId     String @db.Uuid
  entityId     String @db.Uuid
  bookId       String @db.Uuid
  periodId     String @db.Uuid

  // What's compared to. PRIOR = previous period; BUDGET = budget for this
  // period; YEAR_AGO = same period one year prior. Default PRIOR.
  comparedTo   FluxBaseline @default(PRIOR)

  computedAt   DateTime @default(now())
  computedBy   String   @db.Uuid

  // Frozen at computation time so the rows below match what the operator
  // saw when they reviewed.
  thresholdAbs Decimal  @db.Decimal(20, 4)
  thresholdPct Decimal  @db.Decimal(8, 4)

  rows         FluxRow[]

  @@unique([entityId, bookId, periodId, comparedTo])
  @@map("flux_analysis")
}

enum FluxBaseline { PRIOR | BUDGET | YEAR_AGO }

model FluxRow {
  id             String       @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId       String       @db.Uuid
  fluxAnalysisId String       @db.Uuid
  fluxAnalysis   FluxAnalysis @relation(fields: [fluxAnalysisId], references: [id], onDelete: Cascade)

  accountId      String       @db.Uuid
  account        Account      @relation(fields: [accountId], references: [id])

  currentBalance Decimal      @db.Decimal(20, 4)
  baselineBalance Decimal     @db.Decimal(20, 4)
  deltaAbs       Decimal      @db.Decimal(20, 4)
  deltaPct       Decimal      @db.Decimal(10, 4)

  flagged        Boolean
  // Encrypted via PrismaExtension. Required if flagged.
  commentary     String?
  commentedBy    String?      @db.Uuid
  commentedAt    DateTime?

  @@index([fluxAnalysisId, flagged])
  @@map("flux_row")
}
```

### Computation

`computeFlux(prisma, {entityCode, bookCode, periodId, comparedTo, thresholds})`:

1. Reads current-period trial balance via existing `getTrialBalance`.
2. Reads baseline trial balance (prior period: previous `Period` row; budget: from a `Budget` table to be added; year-ago: lookback 12).
3. Computes per-account delta (abs + pct).
4. Flags rows where `|deltaAbs| >= thresholdAbs OR |deltaPct| >= thresholdPct`.
5. Persists one `FluxAnalysis` parent + N `FluxRow` children.

Idempotent on `(entityId, bookId, periodId, comparedTo)` — re-running replaces the analysis.

### UI surfaces

- `/close/flux?period=YYYY-MM&comparedTo=PRIOR` — grid sorted by abs delta descending. Flagged rows surfaced first with red row-border. Inline commentary field per flagged row. Sidebar: thresholds editor + "Recompute" button.
- Commentary save: Server Action, audit-logged, encrypted via PrismaExtension.

### Period-close gate (composes with Phases 1 + 2)

```ts
const flaggedUncommented = await prisma.fluxRow.count({
  where: {
    tenantId,
    fluxAnalysis: { periodId },
    flagged: true,
    commentary: null,
  },
});
if (flaggedUncommented > 0) failures.push({ gate: "FLUX_UNCOMMENTED", count: flaggedUncommented });
```

### PR sequence (Phase 3)

| PR | Title |
|---|---|
| 1 | Schema (FluxAnalysis + FluxRow) + migration 0016 |
| 2 | `computeFlux` orchestrator + threshold defaults + tests |
| 3 | `/close/flux` page + commentary capture + threshold editor |
| 4 | Period-close gate composes with Phases 1 + 2 + admin override |

## Phase 4 — Integration capstone

| PR | Title |
|---|---|
| 1 | `/close` dashboard — single page summary card layout. Shows: % recons done, # in EXCEPTION, % required tasks done, # BLOCKED, # flagged flux rows, # uncommented. Links to each arc's page. |
| 2 | Month-end packet expansion — append recon summary table + open-tasks list + flux commentary appendix to existing PDF + CSV. |
| 3 | Documentation: `docs/month-end-runbook.md` (the new operator playbook). Loom walkthrough. Updates to `PROJECT_STATUS.md`, `docs/policies/control-deficiency-log.md` (#15/16/17/18 closed: no formal recons, no calendar, no flux, no integrated dashboard), `docs/policies/risk-register.md`. |

## Rejected alternatives

| Considered | Why rejected |
|---|---|
| BlackLine clone — port their whole module list | Wrong audience (F1000 not portfolio companies); 12+ month build |
| Single sign-off everywhere | Decision #2 calls for both; flexibility costs ~1 schema field |
| Warning-only gate | Warnings get ignored; defeats the SOC 1 evidence purpose |
| Per-account recon templates (BlackLine has these) | Adds complexity; Phase 2 follow-up if customers ask |
| Real-time recon recompute on JE post | Trigger storm at scale; recompute happens at recon open + on demand |
| S3 attachment storage | Adds vendor + secret; in-DB encrypted bytes are self-contained at portfolio scale |
| Postgres triggers for state changes | Application-level RecordEvent writes are easier to audit and easier to test |
| JE preparer/reviewer in same arc | Touches `postJournalEntry`; separate arc with its own design review |

## SOC 2 mapping

| Phase | Controls strengthened | New deficiency log entries |
|---|---|---|
| Phase 1 (Recons) | CC4 monitoring (detective recon), CC8.1 change mgmt (financial-close cycle), SOC 1 anchor | #15 — "No formal account-recon process" |
| Phase 2 (Calendar) | CC1 organizational structure (who owns what), CC8.1 (close-cycle change mgmt), CC4 monitoring | #16 — "No documented close calendar" |
| Phase 3 (Flux) | CC4 monitoring (variance investigation as detective control) | #17 — "No formal flux review" |
| Phase 4 (Capstone) | All above packaged | #18 — "No integrated close dashboard" → closed |

Each entry written when its phase opens, closed when the phase ships. PRs reference back to the deficiency entry.

## Estimated sizing

| Phase | PRs | Tests added | Schema migrations |
|---|---|---|---|
| Phase 0 (this doc) | 1 doc-only PR | n/a | none |
| Phase 1 (Recons) | 8 | ~50 | 0014_reconciliations |
| Phase 2 (Calendar) | 6 | ~35 | 0015_close_tasks |
| Phase 3 (Flux) | 4 | ~20 | 0016_flux_analysis |
| Phase 4 (Capstone) | 3 | ~10 | none |
| **Total** | **22 PRs** | **~115 tests** | **3 migrations** |

## What happens after this doc merges

PR #205 opens immediately on a fresh branch `blackline-arc-recons`. That PR is "Phase 1 PR 1 — schema + migration 0014_reconciliations + schema-fingerprint snapshot." From there, each PR is independent and reviewable in isolation.

Each phase ends with a sign-off gate run on a fixture company before the next phase opens. No phase starts until the prior phase's gate passes.

## Open follow-ups (logged for Phase 2+)

- **Budget data ingestion**: Phase 3's BUDGET baseline needs a `Budget` table + import path. Spec'd in Phase 2 design follow-up, built between Phases 2 and 3.
- **Per-account recon templates**: BlackLine has reusable per-account-type templates (cash always asks for "bank statement balance + outstanding checks + outstanding deposits"). Possible Phase 1.5 if customer ask emerges.
- **Recon supporting-balance auto-pull for non-sub-ledger accounts**: prepaid schedules, equity, accrued liabilities. Manual entry in Phase 1; auto-pull when there's a sub-ledger.
