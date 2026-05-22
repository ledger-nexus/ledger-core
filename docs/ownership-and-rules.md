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
- ✅ Schema (User, Queue, QueueMember, RecordEvent, ReassignmentRule, owner columns on JournalEntry)
- ✅ Rules engine: types + evaluator + validator + executor + registry
- ✅ Reassign service + orphan detection query
- ✅ Tests (78 unit tests; pure-function, no DB needed)

Next phases (separate commits):
- Adoption on additional record types (add `ownerId`/`ownerType`/audit columns)
- Server Action wrappers that fire `execute()` on insert/update/transition
- Admin dashboard + role-change preflight UI
- Auth integration
- Mirror to recon + revenue-rec
