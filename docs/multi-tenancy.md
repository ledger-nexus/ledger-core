# Multi-tenancy design

**Status:** Phases 1, 2, 3, 4a, 4c, 5, 6, 7, 8 shipped. Phase 4b (NOT NULL + composite uniques) deferred. Read this before touching any query in `src/lib/accounting/`.

## Phase status (as of 2026-05-26)

| Phase | What | Status |
|---|---|---|
| 1 | Tenant + TenantMembership + TenantApiToken models; `tenantId String?` added to every tenant-scoped table; default tenant created; backfill migration | ✅ Shipped (`d557795`) |
| 2 | Tenant context helpers + Server Actions (`setTenantAction`, `createMyFirstTenantAction`) | ✅ Shipped (`0ff682f`) |
| 3 | Clerk integration — env-gated dispatch, JIT user provisioning by email, middleware, sign-in/sign-up routes | ✅ Shipped (`274f033`) |
| 4a | Substrate write enforcement — `postJournalEntry` auto-resolves `tenantId`; `TenantScopeMismatchError` for cross-tenant attempts | ✅ Shipped (`06d185c`) |
| 4b | `ALTER COLUMN tenantId SET NOT NULL` + composite unique constraints | ⏳ Deferred — forces every entity-by-code lookup to update |
| 4c | Read scoping — high-leverage list queries filter by tenant | ✅ Shipped (`fcb20f8`) |
| 5 | HTTP boundary — `/api/internal/*` resolves Bearer to TenantApiToken row; legacy env path as fallback | ✅ Shipped (`c411c80`) |
| 6 | Per-tenant isolation tests | ✅ Folded into Phase 4c |
| 7 | UI — tenant switcher in header + onboarding flow + dashboard CTA | ✅ Shipped (`2dc931b`) |
| 8 | Companion repos — Clerk dispatch + middleware + sign-in/sign-up mirrored to recon, revenue-rec, integrations, fa-amort | ✅ Shipped (one commit per repo) |

## What's deferred (and why)

**Phase 4b (NOT NULL + composite uniques):** applying `ALTER COLUMN tenantId SET NOT NULL` forces every `legalEntity.findUnique({ where: { code } })` call to update because the unique constraint becomes `[tenantId, code]`. ~20 cross-cutting call sites; mechanical but reviewable as its own phase.

**Per-tenant token rotation in companion repos:** Phase 5 ships the backward-compat env path so companion repos keep working unchanged. When the platform goes multi-tenant, `bin/deploy.sh` will provision per-tenant tokens via `scripts/provision-tenant-token.ts` and inject into each Vercel env. Until then, every companion repo authenticates as the default tenant — correct in a single-tenant world.

**Companion repo tenant context UI:** companion repos don't own a User table — they share ledger-core's DB. Resolving a Clerk session to a `TenantMembership` requires duplicating or extracting ledger-core's `getCurrentTenant` logic. Revisit when a real multi-tenant customer is onboarded.

## What "tenant" means here

A **Tenant** is the firm or company using ledger-nexus. Examples:

- A CPA firm using ledger-nexus to manage 30 client engagements → one Tenant, 30 LegalEntities
- A holding company with 5 subsidiaries → one Tenant, 5 LegalEntities + consolidation parent
- A solo founder running their own books → one Tenant, 1 LegalEntity

A tenant owns N `LegalEntity` rows. Cross-tenant data is invisible — no query, report, or HTTP request can return rows from another tenant.

**Tenant is NOT:**
- Equivalent to LegalEntity (a tenant can have many entities, including a consolidation hierarchy)
- A separate database (we use a shared Postgres with row-level scoping)
- A pricing tier (orthogonal — billing happens above this layer)

## The new models

```prisma
model Tenant {
  id          String   @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  slug        String   @unique  // url-safe, e.g. "acme-co"
  name        String
  ownerUserId String   @db.Uuid

  memberships TenantMembership[]

  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@map("tenant")
}

model TenantMembership {
  id        String         @id @default(dbgenerated("gen_random_uuid()")) @db.Uuid
  tenantId  String         @db.Uuid
  userId    String         @db.Uuid
  role      TenantRole     // OWNER, ADMIN, MEMBER

  tenant    Tenant         @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user      User           @relation(fields: [userId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now())

  @@unique([tenantId, userId])
  @@index([userId])
  @@map("tenant_membership")
}

enum TenantRole {
  OWNER    // Cannot be removed; can delete the tenant
  ADMIN    // Full read+write+admin
  MEMBER   // Read+write, no admin actions (period close, user mgmt)
}
```

## What's tenant-scoped vs global

### Tenant-scoped (gets `tenantId` column)

Every domain model that holds customer data:

| Model | Why |
|---|---|
| `LegalEntity` | The entry point of the tenant tree. `(tenantId, code)` becomes the natural key. |
| `FiscalCalendar` | Each tenant defines their own fiscal year |
| `Period`, `PeriodClose` | Inherits via FiscalCalendar, but explicit for query speed |
| `Account` | Inherits via LegalEntity, but explicit. `(tenantId, entityId, code)` natural key. |
| `JournalEntry`, `JournalLine` | The core. Every JE belongs to one tenant. |
| `Party`, `PartyRole`, `Item` | Customer/vendor/item data is tenant-private |
| `ArOpenItem`, `ApOpenItem`, all sub-ledger | Per-tenant working capital |
| `FixedAsset`, `Lease`, `RevenueContract` (+ BookAttributes) | Per-tenant asset registry |
| `Dimension`, `DimensionValue`, `DimensionSet` | Each tenant defines their own classes/departments |
| `PostingRule` | Per-tenant GL mapping rules |
| `CustomFieldDefinition` | Per-tenant custom field registry |
| `ReassignmentRule`, `Notification` | Per-tenant queue config |
| `AuditLog` | Per-tenant security log (cross-tenant audit visibility = privacy leak) |
| `RecordEvent` | Per-tenant record history |
| `Queue`, `QueueMember` | Per-tenant queue config |

### Global (no `tenantId`)

Reference data that's the same for everyone:

| Model | Why |
|---|---|
| `Currency` | ISO 4217 — universal |
| `FxRate` | Exchange rates are universal data |
| `Book` | US_GAAP / US_TAX / IFRS are well-known global definitions. **If a tenant needs a custom book, platform admins add it.** |
| `User` | Users can belong to multiple Tenants via `TenantMembership` |

> **Why Book is global**: a "US_GAAP book" means the same thing for every tenant — US GAAP basis, USD reporting currency, debits/credits rules. Letting tenants create custom Books would mean 100 different "US_GAAP" rows. The downside: a tenant can't have a fully private book like "ACME_INTERNAL." If that's needed, we add it platform-side per request. Revisit in v2.

## Scoping invariant

> **Every query that touches a tenant-scoped table MUST filter by `tenantId`.**

This is non-negotiable. Forgetting `tenantId` is the multi-tenant equivalent of forgetting `bookId` — it returns cross-tenant data. CodeQL CI weekly + per-tenant isolation tests catch it; code review (CC8) is the primary control.

### Three patterns

```ts
// 1. Server Component / Server Action reading current tenant
const { tenantId } = await requireCurrentTenant();
const entries = await prisma.journalEntry.findMany({
  where: { tenantId, entityId, bookId },
});

// 2. postJournalEntry — tenant becomes a required input
await postJournalEntry(prisma, {
  tenantId,        // NEW — required
  entityCode: "ACME",
  bookCode: "US_GAAP",
  ...
});

// 3. Internal HTTP endpoint — tenant comes from the bearer token's scope
// (each INTERNAL_API_TOKEN is bound to one tenant; see "Token-tenant binding" below)
const tenantId = await tenantFromToken(authHeader);
```

## How a user becomes a tenant member

1. **Sign-up** (Clerk hosted UI) → `currentUser` JIT-creates a `User` row.
2. **First sign-in for a user with no `TenantMembership`** → onboarding page asks them to either:
   - Create a new Tenant (they become OWNER), OR
   - Accept an invitation from an existing Tenant
3. **Existing membership** → user is dropped at the dashboard scoped to their default tenant.
4. **Multi-tenant user** → tenant switcher in the sidebar.

The `tenantId` for the current request lives in a cookie (`lc-tenant`), similar to the existing scope cookie. Server Components read it via `getCurrentTenant()`.

## Token-tenant binding (HTTP boundary)

Each tenant gets its own `INTERNAL_API_TOKEN`. Companion repos that post to ledger-core's `/api/internal/journal-entries` send their tenant's token; the endpoint maps token → tenantId and rejects mismatches.

```
TenantApiToken {
  id        UUID
  tenantId  UUID
  tokenHash String   // hash, not the plaintext token
  label     String   // "recon-prod", "fa-amort-staging"
  createdAt DateTime
  lastUsedAt DateTime?
  revokedAt  DateTime?
}
```

Companion repos store their token in their own Vercel env. The token never leaves the env. On every internal API call:
1. Repo X sends `Authorization: Bearer <token>`
2. ledger-core hashes the token, looks up `TenantApiToken`, retrieves `tenantId`
3. The JE post is scoped to that tenant
4. AuditLog row captures the tenantId + token label

This is a breaking change to the HTTP boundary. Recon / revenue-rec / integrations / fa-amort all need their token format updated.

## Migration plan

### For the existing single-tenant deployment

1. Create one default Tenant — slug `default`, name `Default Tenant`, ownerUserId = the founder's User ID.
2. Backfill every tenant-scoped table: `UPDATE table SET tenantId = <default tenant id>`.
3. Add `tenantId NOT NULL` to every tenant-scoped table.
4. Update unique constraints — e.g. `LegalEntity.code UNIQUE` becomes `(tenantId, code) UNIQUE`.
5. Add composite indices on `(tenantId, ...)` for every frequent query path.
6. Backfill `TenantMembership` for every existing User row to the default Tenant with OWNER role.

### For new signups

1. Clerk JIT-creates User on first sign-in.
2. User has no TenantMembership → onboarding flow.
3. User creates Tenant → server creates Tenant + TenantMembership(OWNER) atomically.
4. Default empty state: no demo data unless user clicks "Load Northwind demo" / "Load DEMO_CO" / "Load consolidation demo."

## RLS (Row-Level Security)

Postgres RLS is **not in v1 of multi-tenancy**. Application-level scoping is the only enforcement initially. RLS is tracked in `control-deficiency-log.md` as a follow-up.

Why deferred: RLS requires every Prisma connection to `SET app.current_tenant_id = '<uuid>'` before each query batch. Prisma 5.x supports this via middleware but it's non-trivial to get right, especially with Prisma's connection pool. Adding it during the initial multi-tenancy work risks two compounding sources of bugs.

V2 plan: enable RLS, write policies on every tenant-scoped table, add connection-level tenant setter.

## Isolation tests

The single most important test of multi-tenancy is: can tenant A read tenant B's data, by any path?

```ts
// tests/multi-tenant-isolation.test.ts
describe("tenant isolation", () => {
  it("cannot read another tenant's journal entries", async () => {
    const tenantA = await createTenant({ name: "Tenant A" });
    const tenantB = await createTenant({ name: "Tenant B" });
    await postJournalEntry(prisma, { tenantId: tenantA.id, ... });

    // Direct query scoped to tenant B
    const entries = await prisma.journalEntry.findMany({
      where: { tenantId: tenantB.id },
    });
    expect(entries).toHaveLength(0);

    // Attempted cross-tenant read via tenant B's session
    await expect(
      readJournalEntries({ tenantId: tenantB.id, entityCode: "TENANT_A_ENTITY" })
    ).rejects.toThrow(/not found/);
  });

  it("cannot post a JE to another tenant's entity", async () => { ... });
  it("cannot read another tenant's audit log", async () => { ... });
  it("cannot reuse an entity code across tenants", async () => { ... }); // Now allowed
  // ...
});
```

Every new query / endpoint / report gets a corresponding cross-tenant isolation test.

## Open questions

- **Tenant deletion**: cascading delete is expensive on large tenants. Likely needs to be a soft delete + background purger.
- **Cross-tenant data sharing for accountants who advise multiple firms**: punted to v2 (probably handled by inviting the accountant to N tenants).
- **Per-tenant rate limiting**: tracked separately under the CC7 monitoring umbrella.
- **Tenant onboarding wizard**: who creates the first LegalEntity? Suggested: the tenant chooses "I'm a single company" (one entity auto-created) or "I'm a firm with multiple clients" (entity creation moved to a separate page).

## Order of work

1. Schema changes + migration (`prisma db execute` raw SQL; not `db push`)
2. Tenant context helpers (`getCurrentTenant`, cookie, scoped Prisma wrapper if we go that route)
3. Clerk integration per `auth-swap.md`
4. Sign-up + onboarding flow
5. Query scoping in `src/lib/accounting/` (the long tail)
6. HTTP boundary updates + token-tenant binding
7. Per-tenant isolation tests
8. UI — tenant switcher + onboarding pages
9. Mirror to companion repos (recon, revenue-rec, integrations, fa-amort)

This is roughly 1.5–2 weeks of work end-to-end. Step 5 is the longest.
