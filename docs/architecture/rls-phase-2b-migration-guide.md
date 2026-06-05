# RLS Phase 2b — migration guide

**Status:** Guide complete; migrations pending operator scheduling
**Prereq:** Phase 1 (PR #66) + Phase 2a (PR #67) merged
**Closes:** the broad call-site refactor portion of deficiency #12

## What Phase 2b does

Wires every Server Action, internal HTTP endpoint, and cron job to issue `SET LOCAL app.current_tenant_id = '<tenant.id>'` before any DB work — via the `withTenantContext` helper shipped in Phase 2a.

**Production effect today (Phase 1 + 2a + 2b):** Zero. RLS policies aren't FORCED yet (Phase 3 ships that). The `SET LOCAL` is a no-op against unenforced policies.

**Effect after Phase 3:** every query inherits the correct tenant context automatically. Queries without context return 0 rows (fail closed).

## Why a guide instead of a single PR

The migration touches **18 Server Actions + 3 internal HTTP endpoints + several cron jobs**. Ranges from 21 lines (`set-scope.ts`) to 402 lines (`recurring-entries.ts`). Each migration:

- Wraps existing prisma calls in a `withTenantContext` callback
- Threads `tx` through helper functions (some helpers take `prisma`; they need a `tx` parameter)
- Preserves existing transaction semantics (some actions already use `prisma.$transaction`; need to nest properly)
- Updates tests (existing tenant-scope assertions still hold; new tests pin the GUC is correctly set)

This is ~20-30 hours of focused work across multiple PRs. The guide makes it shippable as a planned sprint rather than a one-shot scramble.

## Migration order (recommended)

Migrate in order of simplicity → complexity. Each PR migrates one Server Action (or a small cluster) so review stays manageable.

### Group A — Trivial / no-op (re-verified 2026-06-05 night)

**Re-verification: `set-scope.ts` has ZERO prisma calls — it only writes a cookie and calls `revalidatePath`. It should NOT be migrated; no DB work occurs.** Similar audit findings for the others below; the actual "migration-needed" set is smaller than the initial guide enumerated.

Per-action prisma-call audit:

| Action | Direct prisma calls | Helper-passed prisma | Migration needed? |
|---|---|---|---|
| `set-scope.ts` | 0 | 0 | **No** — cookie + revalidatePath only |
| `set-current-user.ts` | 0 | 0 (membership read via helper) | Audit helper first |
| `set-tenant.ts` | 0 | helper call | Audit helper first |
| `mark-notifications-read.ts` | 0 | `markRead(prisma, ...)` | **Yes** — widen `markRead` helper |

**Lesson:** the "21 callsites" estimate in the original guide is an upper bound. Actual migration scope is smaller because several actions are pure UI state (cookies) with no DB work.

**Pre-migration audit step (NEW, recommended):** run `grep -c "prisma\." src/app/actions/*.ts` to get direct-call counts. Then `grep -c "markRead\|postJournalEntry\|reassignTo\|widening-candidate-helpers" src/app/actions/*.ts` for helper-passed counts. Group A should be the actions with **0 direct + 0 helper** calls — these are pure UI state and need NO migration.

**Per-PR effort:** 30 min each for the genuinely-needs-migration actions in this group.

### Group B — Single-table mutations (50-100 lines)

5. `reassign-ap-item.ts`
6. `reassign-ar-item.ts`
7. `admin-reassign.ts`
8. `apply-ar-payment.ts`
9. `apply-ap-payment.ts`

**Per-PR effort:** 45 min each. Likely 2-3 PRs (group by domain).

### Group C — Multi-table mutations (100-250 lines)

10. `create-journal-entry.ts` — uses existing `postJournalEntry` helper
11. `paste-journal-entry.ts` — calls into postJournalEntry
12. `user-lifecycle.ts` — multi-step user changes
13. `reverse-journal-entry.ts` — reverses a posted JE
14. `setup-first-entity.ts` — onboarding flow
15. `journal-entry-notes.ts` — note CRUD

**Per-PR effort:** 90 min each. These need careful test coverage updates because they wrap `postJournalEntry` which is the substrate's load-bearing primitive.

### Group D — Complex multi-step (250+ lines)

16. `period-close.ts` — period close + validation
17. `accounts.ts` — chart of accounts CRUD with hierarchy
18. `recurring-entries.ts` — recurring entry definition + line management

**Per-PR effort:** 2-3 hours each. These are the highest-risk migrations because they're the largest existing test surface.

### Internal HTTP endpoints (3 routes)

- `/api/internal/journal-entries/route.ts` — the cross-repo JE-posting entry point
- `/api/internal/fixed-asset/route.ts` — fixed asset CRUD
- `/api/internal/fixed-asset/record-depreciation/route.ts` — the transactional depreciation endpoint

**Per-PR effort:** 60-90 min each. Cross-repo critical — companion repos depend on these endpoints' contracts.

## The canonical migration pattern

### Before (raw prisma)

```ts
"use server";

import { prisma } from "@/lib/db";
import { requireCurrentTenant } from "@/lib/auth/tenant";

export async function markNotificationsReadAction(input: { ids: string[] }) {
  const tenant = await requireCurrentTenant();

  const result = await prisma.notification.updateMany({
    where: {
      id: { in: input.ids },
      tenantId: tenant.id,
    },
    data: { readAt: new Date() },
  });

  return { ok: true, count: result.count };
}
```

### After (withTenantContext)

```ts
"use server";

import { withTenantContext } from "@/lib/db/tenant-context";
import { requireCurrentTenant } from "@/lib/auth/tenant";

export async function markNotificationsReadAction(input: { ids: string[] }) {
  const tenant = await requireCurrentTenant();

  return withTenantContext(tenant.id, async (tx) => {
    const result = await tx.notification.updateMany({
      where: {
        id: { in: input.ids },
        // Belt-and-suspenders: keep the tenantId predicate even after RLS.
        // If Phase 3's FORCE gets accidentally reverted, this still works.
        tenantId: tenant.id,
      },
      data: { readAt: new Date() },
    });
    return { ok: true, count: result.count };
  });
}
```

**Key changes:**
1. Import `withTenantContext` from `@/lib/db/tenant-context` (not raw `prisma`)
2. Wrap the entire DB-work block in the callback
3. Replace `prisma.X` with `tx.X` inside the callback
4. **Keep the existing `tenantId:` predicate** — defense in depth survives Phase 3 rollback

### Helper functions that take `prisma`

Many existing helpers accept `prisma: PrismaClient | TransactionClient`. They already work inside a transaction:

```ts
// Helper — already works for both PrismaClient and TransactionClient
export async function postJournalEntry(
  db: PrismaClient | Prisma.TransactionClient,
  input: PostJournalEntryInput
) {
  // ...
}
```

Migrating callers is mechanical:

```ts
// Before
await postJournalEntry(prisma, input);

// After
return withTenantContext(tenant.id, async (tx) => {
  await postJournalEntry(tx, input);  // pass `tx`, not `prisma`
});
```

Helpers that only accept `PrismaClient` need to be widened. That's an additional 1-line change per helper.

### Helpers that need widening

Audit + widen these in a precursor PR before Group C migration:

```bash
grep -rln "prisma: PrismaClient" src/lib/accounting/ src/lib/notifications/
```

The widening pattern is:
```ts
import type { PrismaClient, Prisma } from "@prisma/client";

// Before
export async function helper(prisma: PrismaClient, ...) { ... }

// After
export async function helper(
  db: PrismaClient | Prisma.TransactionClient,
  ...
) { ... }
```

### Nested transactions

If an action already uses `prisma.$transaction`, nest it inside `withTenantContext`:

```ts
return withTenantContext(tenant.id, async (tx) => {
  // tx IS the transaction client — no need to wrap again
  await tx.party.create({ ... });
  await tx.account.create({ ... });
  // ... etc
});
```

The outer `withTenantContext` is itself a `$transaction` — don't nest a second one inside it. Just use `tx` directly.

## Test updates

For each migrated action, add ONE test that verifies the GUC is correctly set:

```ts
import { withTenantContext, getCurrentTenantGuc } from "@/lib/db/tenant-context";

it("sets app.current_tenant_id for the duration of the action", async () => {
  let observedGuc: string | null = null;
  // Mock the action's internal call to withTenantContext OR
  // use an integration test that observes via getCurrentTenantGuc.
  // ... assertion details depend on the action's test infrastructure.
});
```

Existing tenant-scope assertions (`expect(party.tenantId).toBe(tenant.id)`) keep passing because the migration preserves the `tenantId:` predicate.

## Common pitfalls

| Pitfall | Symptom | Fix |
|---|---|---|
| Helper function accepts only `PrismaClient` | TypeScript error: `tx` isn't assignable | Widen helper signature to `PrismaClient \| TransactionClient` |
| Action uses `prisma.$transaction` inside `withTenantContext` | Nested-transaction error | Use the outer `tx` directly; drop the inner `$transaction` |
| Action does NOT have a tenant (boot scripts, demos) | `withTenantContext` throws on empty `tenantId` | Use raw `prisma` for genuinely-system queries; document why with a comment |
| Action sends notifications to multiple tenants in one call | Single GUC can't cover multiple tenants | Loop with one `withTenantContext` per tenant |
| Existing `assertTenantScope()` check | Still works — defense in depth | Keep it; it's an additional layer |

## Verification

After each migrated action lands, verify:

```sql
-- Connect to dev Neon branch via Prisma Studio or psql
-- Inside a session where the action just ran:
SELECT current_setting('app.current_tenant_id', true);
-- Should match the calling tenant's UUID
```

The Phase 2a `getCurrentTenantGuc(tx)` helper is the programmatic equivalent for tests.

## When Phase 2b is "done"

- All 18 Server Actions migrated
- All 3 internal HTTP endpoints migrated
- All cron jobs migrated (audit before — there may be more than the obvious retention cron)
- All helpers widened to accept `TransactionClient`
- Every action's test suite verifies the GUC is set
- Schema-fingerprint CI captures the migrated state in the next fingerprint

After Phase 2b lands, Phase 3 becomes safe to ship:

1. Run `ALTER TABLE <each> FORCE ROW LEVEL SECURITY;` migration
2. Ship the cross-tenant test suite that proves enforcement
3. Update deficiency #12 status: Remediated → **Closed**
4. Update risk register #17 (multi-tenant data leakage): Mitigated → "Mitigated end-to-end (RLS + assertTenantScope)"

## Estimated total effort

| Group | Actions/Endpoints | Estimated hours |
|---|---|---|
| A — Trivial | 4 | 2 hours (1 PR) |
| B — Single-table | 5 | 4 hours (2-3 PRs) |
| C — Multi-table | 6 | 9 hours (4-5 PRs) |
| D — Complex | 3 | 7 hours (3 PRs) |
| Internal HTTP | 3 | 4 hours (3 PRs) |
| Helper widening (precursor) | — | 2 hours (1 PR) |
| **Total** | **21 callsites (upper bound; actual smaller per Group A audit)** | **~28 hours / 13-16 PRs (upper bound)** |

This is a planned sprint, not a one-turn migration. Schedule when the operator has continuous focus + time for incremental review.
