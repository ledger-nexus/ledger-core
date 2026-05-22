# Ownership, queues, and the reassignment rules engine

How ledger-nexus models who's responsible for a record, separately from who has access to it.

## The two-concept split

In ERP, "ownership" and "access" are distinct concerns that look like one. We split them:

| Concern | Question | Mechanism |
|---|---|---|
| **Audit** | Who touched this record, and when? | `createdBy` / `createdAt` (immutable) + `updatedBy` / `updatedAt` (mutable) + `RecordEvent` log |
| **Authority** | Whose desk is this on? Who should I notify? | `ownerId` + `ownerType` (USER or QUEUE), mutable only via explicit reassignment |
| **Access** | Can this user see this record? | Module/operation permissions + entity/book scope (NOT ownership) |

This is a deliberate departure from Salesforce, where OwnerId is the keystone of the sharing engine. In ERP modules, **owning a record does not grant access** — module permissions do. Owner is purely for workflow routing.

## When owner changes

- **At insert**: owner defaults to `createdBy` (the user who created the record), or to `system` for engine-generated records (recognition postings, posting-rules engine output, recurring depreciation runs).
- **On edit**: owner does NOT change. `updatedBy` records the editor; `ownerId` is unaffected. The senior who reviews a junior's draft does not become the owner.
- **On manual reassignment**: explicit call to `reassignRecord()`. Sets `reassignmentLockedAt` to block subsequent rule firings (a user's manual choice shouldn't be overridden by a rule).
- **On rule firing**: the reassignment rules engine fires per-trigger and may reassign. Does NOT set `reassignmentLockedAt`. Manual lock takes precedence.
- **On user lifecycle**: when a user is deactivated, role removed, or scope revoked, lifecycle rules (`ON_USER_LIFECYCLE`) fire to reassign their records before they orphan.

## Owner types: USER and QUEUE

A record's owner can be a specific User OR a Queue (group). Modeled via `ownerId` + `ownerType` discriminator.

| ownerType | Semantics |
|---|---|
| USER | A specific person is responsible. Shows up on their "my queue" view. Notifications go to them. |
| QUEUE | Any member of the queue can claim/work the record. Shows in the queue's view; on claim, ownership flips to the claiming user. |

The polymorphism is NOT modeled with a Prisma relation (which would force either User or Queue to be the canonical FK). Instead the application enforces the invariant — `ownerType=USER` rows must point to a User; `ownerType=QUEUE` rows must point to a Queue.

## The reassignment rules engine

Versioned, audited, declarative-first with code escape hatch. Same discipline as the posting-rules engine that already exists.

### Triggers

| Trigger | When it fires | Required fields |
|---|---|---|
| `ON_INSERT` | After record created | — |
| `ON_UPDATE` | After save, ONLY if one of `triggerFields` actually changed | `triggerFields` (strongly recommended) |
| `ON_STATE_TRANSITION` | When a state-machine column changes (DRAFT → POSTED, etc.) | `triggerStateFrom`, `triggerStateTo` |
| `ON_SCHEDULE` | Cron-driven scan (e.g., nightly aging check) | `triggerSchedule` (cron expression) |
| `ON_USER_LIFECYCLE` | User deactivated, role removed, scope revoked | `triggerLifecycleEvent` |

### Criteria DSL

Tree of clauses. Leaf clauses have `{ field, op, value }`; branch clauses have `{ op: AND/OR/NOT, clauses: [...] }`.

**Field paths** support one level of parent join:
- ✅ `amount`, `status`, `customer.creditRating`
- ❌ `customer.parent.industry.code` — rejected at validation time

**Operators**:

| Category | Operators |
|---|---|
| Equality | `EQ`, `NEQ` |
| Set | `IN`, `NOT_IN` (require array values) |
| Numeric/date | `GT`, `GTE`, `LT`, `LTE` |
| Null | `IS_NULL`, `IS_NOT_NULL` (no value) |
| String | `STARTS_WITH`, `CONTAINS` (string values only) |
| Date | `OLDER_THAN_DAYS`, `WITHIN_LAST_DAYS` (integer day count) |

**Composition**: `AND` / `OR` / `NOT`. Max depth 4. Beyond that, write a code rule.

### Priority + first-match-wins

Rules ordered by `priority` ASC (lower = earlier). The executor evaluates rules in priority order; the first matching rule's target is returned, subsequent rules are ignored.

Two ACTIVE rules with the same priority for the same `(recordType, trigger)` is a validation error. Force explicit ordering — no implicit precedence to debug.

### Code-rule escape hatch

For the 5% of cases the declarative DSL can't express, register a TS function in `src/lib/rules/registry.ts`:

```typescript
registerCodeRule("ar-routing-by-region-v1", (record, ctx) => {
  const region = record.customer?.region;
  if (region === "EMEA") return { type: "QUEUE", id: "<emea-queue-uuid>" };
  if (region === "APAC") return { type: "QUEUE", id: "<apac-queue-uuid>" };
  return { type: "QUEUE", id: "<americas-queue-uuid>" };
});
```

Reference by name from a `ruleType: "CODE"` rule. Code rules:
- Live in code (reviewed in PR, type-checked, unit-tested)
- Are NOT user-editable through the UI
- Have access to the same record + trigger context as declarative rules
- Return a `Target` or `null` (null = "this rule didn't match, try the next")
- Throwing is captured; execution continues with the next rule

### Examples

**AR aging escalation:**
```typescript
{
  ruleId: "ar-escalate-60-days",
  recordType: "ArOpenItem",
  trigger: "ON_UPDATE",
  triggerFields: ["daysOverdue", "status"],
  priority: 100,
  criteria: {
    op: "AND",
    clauses: [
      { field: "status", op: "EQ", value: "OPEN" },
      { field: "daysOverdue", op: "GT", value: 60 },
      { field: "daysOverdue", op: "LTE", value: 90 },
      { field: "amount", op: "GT", value: 1000 }
    ]
  },
  target: { type: "QUEUE", id: "ar-senior-collectors" }
}
```

**Large-amount JE routing:**
```typescript
{
  ruleId: "je-large-amount-to-controller",
  recordType: "JournalEntry",
  trigger: "ON_STATE_TRANSITION",
  triggerStateFrom: "DRAFT",
  triggerStateTo: "PENDING_APPROVAL",
  priority: 50,
  criteria: {
    op: "OR",
    clauses: [
      { field: "totalDebits", op: "GT", value: 100000 },
      { field: "bookCode", op: "EQ", value: "US_TAX" }
    ]
  },
  target: { type: "QUEUE", id: "controller-approval" }
}
```

**User-deactivation catch-all:**
```typescript
{
  ruleId: "deactivation-fallback-gl",
  recordType: "JournalEntry",
  trigger: "ON_USER_LIFECYCLE",
  triggerLifecycleEvent: "USER_DEACTIVATED",
  priority: 999,
  criteria: { op: "AND", clauses: [] },   // matches every record
  target: { type: "QUEUE", id: "gl-unassigned" }
}
```

## Reassignment lock semantics

When a user manually reassigns a record, the system sets `reassignmentLockedAt = now()`. Rules SKIP records with a lock — they're inert. This prevents the "user takes ownership, rule immediately reassigns back" failure mode.

The lock is cleared by:
- An explicit `clearReassignmentLock()` admin action
- (Future) state-machine transitions that "release" the record (e.g., re-opening a closed record clears its lock)

The lock is NOT cleared by:
- Time passage (no automatic expiration)
- Subsequent edits that don't touch ownership
- Rule firings (rules don't even touch locked records)

## Orphaned records

When a user's role/scope/permissions change such that they can no longer access modules they own records in, those records become **orphans**. The detection logic lives in `src/lib/ownership/orphan-detection.ts`. Causes:

| Cause | Meaning |
|---|---|
| `OWNER_USER_NOT_FOUND` | The user record was deleted (rare; users should be deactivated, not deleted) |
| `OWNER_USER_INACTIVE` | The user is deactivated |
| `OWNER_QUEUE_NOT_FOUND` | The queue was hard-deleted (also rare) |
| `OWNER_QUEUE_INACTIVE` | The queue exists but `isActive=false` |
| `OWNER_QUEUE_DELETED` | The queue is soft-deleted (`deletedAt` is set) |
| `OWNER_ID_NULL` | Defensive — should never happen if the schema invariant holds |

Three planned UX surfaces for orphan handling (NOT yet built — this is the v0.2 backlog):

1. **Admin dashboard at `/admin/orphans`** — periodic scan results, bulk reassign actions
2. **Role-change preflight check** — when an admin removes a permission, surface "Jane will own N orphans after this change; what do we do?"
3. **User-side banner** — "You currently own N records you can't access" with self-service request flow

## Audit: RecordEvent log

Every ownership-affecting action writes a row to `RecordEvent`:

```
recordType:     "JournalEntry"
recordId:       <uuid>
eventType:      OWNER_CHANGED | STATE_CHANGED | CREATED | REASSIGNMENT_LOCKED | etc.
previousValue:  Json — shape varies by eventType
newValue:       Json — shape varies by eventType
actorUserId:    <uuid> | null  (null = system)
actorReason:    "manual:Jane left" | "rule:ar-escalate-60-days:v1" | etc.
occurredAt:     <timestamp>
```

Append-only. Indexed by `(recordType, recordId, occurredAt)` for "show me the history of this record." Also indexed by `(actorUserId, occurredAt)` for "what did this user do recently."

## What's NOT in this initial cut

This commit ships the **engine + schema + tests + docs** in ledger-core. Deferred to follow-up batches:

| Deferred | Why |
|---|---|
| Real authentication / user session integration | The `User` model exists; Server Actions don't yet read identity from a session. Auth (NextAuth or similar) is a separate multi-week project. For now Server Actions take an explicit `actorUserId` parameter. |
| Mirror tables in recon + revenue-rec | Same pattern as the existing substrate-model mirror. To be applied when the companion repos adopt ownership. |
| Admin dashboard UI (`/admin/orphans`, role-change preflight) | Needs auth in place to be useful |
| User-side orphan banner | Same — needs auth |
| `ON_SCHEDULE` trigger scanner (cron) | Push-based; needs separate cron infrastructure |
| Notification system | Layer on top once owner + queue model is exercised |
| Adoption on additional models (ArOpenItem, ApOpenItem, FixedAsset, Lease, RevenueContract) | Schema migration per model is trivial; the engine is recordType-agnostic. Add them as their workflows need it. |

## Sharing semantics, restated

**In ERP modules**: `ownerId` is informational. Access is decided by:
1. Module access (does the feature exist in your UI?)
2. Operation permission (verb-level: view, post, approve, reassign)
3. Entity/book scope (which `(entityId, bookId)` tuples are you granted?)
4. Period state (is the record's period closed?)

Owner does NOT enter into any of those checks. If you don't have GL module access, owning a GL journal entry does not give you access to it. The orphan-detection system surfaces these cases.

**In future CRM modules**: ownership MAY be used as a sharing primitive (Salesforce-style). That's a per-module choice and must be documented when those modules land. Until then, do NOT use `ownerId` in access-control logic — only in workflow-routing logic.

## Build order summary

Phases completed:
- ✅ v1.3: Schema (User, Queue, QueueMember, RecordEvent, ReassignmentRule, owner columns on JournalEntry)
- ✅ v1.3: Rules engine: types + evaluator + validator + executor + registry
- ✅ v1.3: Reassign service + orphan detection query
- ✅ v1.3: 78 pure-function unit tests
- ✅ v1.4: Integration layer (`src/lib/rules/integration.ts`) — `fireRulesForRecord`, `fireInsertRules`, `fireUpdateRules`, `loadActiveRules`. Bridges the engine to record lifecycle events.
- ✅ v1.4: ArOpenItem adoption — second model with ownership; `openArItem` now fires `ON_INSERT` rules automatically and surfaces results to its caller
- ✅ v1.4: 9 additional integration tests covering rule loading, declarative firing, first-match-wins, lock-skip semantics, reassignment failures, and the convenience wrappers
- ✅ v1.5: Dev-only auth stub (`src/lib/auth/current-user.ts`) — HMAC-signed HTTP-only cookie, `getCurrentUser` / `requireCurrentUser` helpers. Replaceable: when real auth lands, the module body changes but the exports stay the same. **Not production auth** — clearly labeled in the UI as `DEV AUTH STUB`.
- ✅ v1.5: Test users + queues + memberships seeded by `seedTestUsersAndQueues` in Northwind. Four roles (Controller, GL Accountant, AR Clerk, External Auditor) and five queues (AR_COLLECTIONS, AR_SENIOR_COLLECTORS, AR_UNASSIGNED, GL_APPROVAL, GL_UNASSIGNED).
- ✅ v1.5: `UserSwitcher` Client Component in the layout header. Switching the cookie via Server Action; record events attribute to the picked user from there on.
- ✅ v1.5: `applyArPaymentAction` threads identity via `requireCurrentUser` → `postJournalEntry.createdBy`. `reassignArItemAction` added for manual AR reassignment with `RecordEvent` audit + reassignment-lock semantics.
- ✅ v1.5: AR list UI gains an Owner column + inline reassign control (`ReassignArRow`). Lock indicator (🔒) marks records that have been manually reassigned and are now skipped by rule firings.
- ✅ v1.5: `postJournalEntry` now accepts + persists `createdBy` (added to `JournalEntryInput`; existing schema column populated). Threaded through from Server Action callers.
- ✅ v1.5: 15 auth-stub unit tests (HMAC sign/verify, cookie encode/parse, tamper resistance, length checks)
- ✅ v1.6: Example reassignment rules seeded into Northwind. Two rules demonstrating priority-cascade semantics:
  - `ar-large-balance-to-senior` (priority 100) — currentBalance > $10K routes to AR_SENIOR_COLLECTORS
  - `ar-default-routing` (priority 999) — catch-all routes everything else to AR_COLLECTIONS
  Plus one $25K Globex invoice added to the AR seed so the large-balance rule visibly fires on a real record. Acme's $5K invoices land in AR_COLLECTIONS via the catch-all; Globex's $25K invoice lands in AR_SENIOR_COLLECTORS via the priority-100 rule. Demo viewers see both branches of the cascade on `/ar`.
- ✅ v1.7: **Admin orphan dashboard** at `/admin/orphans`. Surfaces records whose owner is no longer valid (deactivated users, deleted/inactive queues, null `ownerId`). Headline metrics by cause + type; per-row inline reassign to any active user or queue; age-coded display (>30 days red, >14 amber). Permission-gated by `requireAdmin` (email allowlist stub on `controller@northwind.test`). Generic `adminReassignAction` Server Action handles both `JournalEntry` and `ArOpenItem`. Sidebar gets an Admin section that only renders for admin users.
- ✅ v1.8: **Admin user-lifecycle page** at `/admin/users` — the prevention-side counterpart to `/admin/orphans`. Lists every user with active/deactivated status + owned-record counts. Per-user deactivate flow includes an inline preflight panel: pick a queue or user to bulk-reassign records to BEFORE flipping `isActive`, or skip and create orphans intentionally for the dashboard to triage. `deactivateUserAction` / `reactivateUserAction` Server Actions gated by `requireAdmin`. Self-deactivation blocked. This is the in-miniature version of the broader role-change preflight UX from this doc — same shape will scale when role/permission removal needs it.
- ✅ v1.9: **Engine now universal across the substrate**. Three coordinated additions:
  - **ApOpenItem ownership adoption** — mirror of v1.4's AR adoption. Schema columns + RecordEvent backref + reassign-service branch + orphan-detection extension + `openApItem` fires ON_INSERT rules. New `reassignApItemAction` Server Action + `ReassignApRow` Client Component + Owner column on `/ap`.
  - **JournalEntry rule firing** — `postJournalEntry` now accepts an explicit `ownerUserId` input (separate from `createdBy`, which stays audit-shaped). When set, ON_INSERT rules fire AFTER the transaction commits (deliberately outside the substrate write so rule failures can't roll back the entry). Rules see a synthetic record with `totalDebits` derived from the lines so amount-based criteria work. Seed paths (no `ownerUserId`) leave JEs ownerless and skip rule firing — appropriate for system-generated entries.
  - **Three new seeded rules**: `je-large-amount-to-controller` (priority 100, `totalDebits > 50000` → GL_APPROVAL), `je-default-routing` (priority 999, catch-all → GL_UNASSIGNED), `ap-default-routing` (priority 999, catch-all → GL_UNASSIGNED). `applyArPaymentAction` updated to pass `ownerUserId` so payment JEs hit the engine — small payments land in GL_UNASSIGNED, large ones auto-route to GL_APPROVAL.
- ✅ v1.10: **Notifications** — visible feedback loop for ownership changes. New `Notification` table; `notify()` helper in `src/lib/notifications/` fans out per-row notifications for USER recipients and one-per-member for QUEUE recipients (self-notification suppressed — the actor doesn't get notified about their own action). `reassignRecord` emits a `REASSIGNMENT` notification on every assignment (rule-fired OR manual); `silent: true` escape hatch suppresses emission for bulk operations like user-deactivation reassignments where a flood would be hostile. Bell icon in the header (only when a user is logged in) shows unread count + dropdown with recent unread + recently-read. Clicking a notification marks it seen + navigates. "Mark all read" wipes the queue. `markNotificationsReadAction` is anti-spoofing — only the recipient can mark their own. Categories: REASSIGNMENT, APPROVAL_NEEDED, ORPHAN_DETECTED, SYSTEM. Per-user channel preferences (mute, email, Slack) and a `/notifications` history page deferred — in-app bell only for v1.10.

Next phases (separate commits):
- Adoption on remaining record types (FixedAsset, Lease, RevenueContract)
- Full role-change preflight (current `deactivateUserAction` handles user deactivation specifically; the broader case is "role/permission removal" which needs the roles+permissions catalog to land first)
- Real auth integration (replace the stub) + real role/permission catalog (replace the email allowlist)
- Queue management UI (currently no way to delete/deactivate queues without SQL)
- Mirror to recon + revenue-rec
- `ON_SCHEDULE` cron scanner — orphan detection materialized into a daily-scanned table
- Notification polish: `/notifications` history page, user preferences (mute, batch, frequency), channel routing (email, Slack), real-time push via WebSocket / SSE

## How to wire a new record type into the rules engine

Pattern, distilled from the ArOpenItem adoption:

1. **Schema**: add `ownerId`, `ownerType`, `createdBy`, `updatedBy`, `reassignmentLockedAt` to the model. Add `RecordEvent` backref with a `@relation` name like `"<Model>Events"`. Add a corresponding nullable FK column on `RecordEvent`. Add `@@index([ownerId])`.

2. **Reassign service** (`src/lib/ownership/reassign.ts`): add the model to the `ReassignableRecordType` union; add a `reassignXxx()` branch with status-machine check + transaction-scoped update + `RecordEvent` write; extend `clearReassignmentLock` switch.

3. **Orphan detection** (`src/lib/ownership/orphan-detection.ts`): add scan block + extend `previewOrphansForUserChange` to query the new model.

4. **Creation path**: in the sub-ledger / Server Action that creates the record, accept an `actorUserId` parameter, default `ownerId` to the actor (or null for system actors), `createdBy = updatedBy = actor`, then call `fireInsertRules(prisma, "<Model>", id, record, actor)` after the create succeeds.

5. **Update path** (when adding): pass the changed-fields array to `fireUpdateRules`. The rules engine uses it to short-circuit ON_UPDATE rules that don't care about the changed fields — important for performance.

The rules engine itself doesn't need changes when adding a new model. It's recordType-agnostic; the addition is purely at the integration boundary.
