# Data subject request procedure

**Owner:** Privacy lead (currently the founder, hand-off documented in
`docs/policies/access-control.md`)
**Last reviewed:** 2026-06-02
**Applies to:** GDPR Articles 15–22, California CPRA §§1798.100–.130,
the equivalents in CO, CT, VA, UT, and any future US state privacy law
that grants individuals data-subject rights.

This is the operational procedure for handling requests from
individuals who have personal data in the ledger-nexus portfolio. The
**executable artifacts** are documented at the bottom; this document is
what an auditor reads to confirm the procedure exists.

The data-classification policy
(`docs/policies/data-classification.md`) defines *what* personal data
we hold; this document defines *how we respond when a person asks
about it*.

---

## What we offer

| Right | GDPR | CPRA | Status |
|---|---|---|---|
| Right of access ("show me what you have") | Art. 15 | §1798.110 | Mitigated — code-backed, audit-logged |
| Right to erasure ("delete what you have") | Art. 17 | §1798.105 | Mitigated — code-backed, with legal-retention exemption documented |
| Right to rectification ("update incorrect data") | Art. 16 | §1798.106 | Mitigated — self-serve via `/settings`; admin path via support |
| Right to data portability | Art. 20 | (covered by §1798.110) | Mitigated — export bundle is machine-readable JSON |
| Right to object to processing | Art. 21 | — | Mitigated — opt out by deactivating the account |
| Right to restrict processing | Art. 18 | — | **Manual** — see "Edge cases" |
| Right to know third parties | — | §1798.115 | Mitigated — `docs/policies/vendor-management.md` lists subprocessors |

---

## Request channel

Subjects submit requests one of three ways:

1. **Self-serve UI** at `/admin/data-subject-requests`. The subject
   signs into their own account and clicks "Export my data" or "Erase
   my account". This is the **default and preferred path** because
   identity verification is implicit in the signed-in session.
2. **Email** to `privacy@<your-domain>`. Used when the subject can
   no longer sign in (account locked, forgot credentials, never
   onboarded) or when a legal guardian / representative is filing on
   their behalf.
3. **Postal mail** at the address on the marketing site privacy page.
   Required for accessibility compliance; in practice we receive zero
   per year.

We do **not** accept requests via support chat, Twitter, or third-party
data-broker tools (e.g., DoNotPay). The reason: those channels don't
let us verify identity. We reply directing the requester to one of the
channels above.

---

## Identity verification

Different channels have different defaults:

### UI path (self-serve)

The user's signed-in session IS the verification. The Server Action
checks `requireCurrentUser()` and confirms the requested subject id
matches the actor's id (for self-export) or that the actor is `ADMIN+`
in the subject's tenant (for cross-user requests).

**No additional verification required.** This is the recommended
path. The audit row records `selfRequest: true` when the actor
exported their own data.

### Email/postal path

When the subject can't sign in or isn't a current user (rare —
typically a former member whose tenant has since deactivated the
account):

1. **Confirm the email matches a known account.** A Postgres query
   against `User` table by encrypted email (use
   `emailLookupKeyForUser` from `@/lib/soc2`). No match → reply
   "we don't have a record matching that email; no further action
   needed."
2. **Send a verification link** to the *email on file* (NOT the email
   they emailed from — that's the spoofable surface). The link
   points at a new `/dsr-verify/<token>` page which, when clicked,
   collects the request type + records the request.
3. **30-day SLA clock starts** when verification is complete, NOT
   when the email arrived. GDPR's "without undue delay and in any
   event within one month" is interpreted as one month from
   verification.
4. **For guardians/representatives:** require a written authorization
   from the subject (notarized for postal, signed PDF for email).
   Verify the authorization with the subject directly before acting.

---

## Per-request procedure

### Right of access (export)

1. UI path: subject clicks "Export my data" → Server Action
   `exportUserDataAction(userId)` → file downloaded as
   `data-export-{userId}-{date}.json`.
2. Email path: privacy lead runs `pnpm tsx scripts/dsr-export.ts <userId>`
   (script reads the same `buildUserDataExport()` helper), encrypts
   the JSON with the subject's verification token, and emails it back.
3. The `data_subject.export` audit row captures attribution counts.
4. **Retention of the export:** keep the export in the privacy lead's
   1Password vault for 30 days in case the subject asks for a re-send,
   then delete.

**Timeline:** Same day for UI path; within 30 days for email/postal
path.

### Right to erasure

This is the highest-stakes action. The procedure has multiple gates:

1. **Identity verified** (see above).
2. **Authorization gate.** Erasure requires `OWNER` role of the
   subject's tenant. In single-OWNER tenants (typical solo-founder
   case) the OWNER themselves must approve — there is no self-approval
   override.
3. **What gets erased** (documented in `src/lib/privacy/user-data.ts`):
   - `User.email` → `redacted-{userId}@deleted.local`
   - `User.displayName` → `[Redacted User]`
   - `User.isActive` → `false`, `User.deactivatedAt` → `now()`
   - `EmailDelivery.toEmail` matching the old email → redacted form
4. **What does NOT get erased** (legal-retention exemption under GDPR
   Art. 17(3)(b/e); see also IRS §6001 + state corp-law parallels):
   - `JournalEntry.createdById/submittedById/approvedById/rejectedById`
   - `JournalLine` (no user reference, but content is preserved)
   - `AuditLog` rows (append-only at the DB level; deletion is
     impossible regardless of intent)
   - `Notification` rows that reference the user
   - Historical sign-in records
5. **Communication to the subject.** Send a written response stating
   what was erased, what was preserved and why, and the legal basis
   for each preservation (Art. 17(3)(b) for tax records, (e) for
   audit trail).
6. **Audit row** `data_subject.erase` captures the redaction summary.

**Timeline:** Within 30 days. The erasure itself is atomic (one
transaction); the bottleneck is the verification + authorization path.

### Right to rectification (data correction)

For "my email is wrong" or "my display name is wrong":

1. **UI path:** the subject updates via `/settings`. No procedure
   needed — it's a normal account-management action.
2. **Email path:** support replies pointing the subject at the UI;
   if the subject genuinely can't sign in, we treat it as an erasure
   + re-invite request.

For rectification of data *about* the subject that lives in a
tenant's books (e.g., "I'm listed as the AP vendor contact, but the
phone number is wrong"): this is the TENANT's data, not the subject's.
The procedure is to reach out to the tenant directly. We do not
unilaterally modify tenant data on behalf of third parties.

### Right to portability

The export bundle is JSON, schema-versioned, and self-describing —
that's the portability format. If a subject asks for a specific
format (CSV, XML), we direct them to use a converter; the JSON is
the canonical export.

### Right to object / restrict processing

Practical implementation: account deactivation. We don't have a
"processing flag" to flip independently of activation. Acknowledge
the request, deactivate the account, document in audit.

---

## Edge cases

### Subject is a former employee of a tenant that no longer subscribes

We still hold their `User` row + their attribution edges on JEs they
posted. The procedure is the same as a current user.

### Tenant requests erasure on behalf of a former member

This is allowed if the requester is `OWNER` of the relevant tenant.
The audit row records the requesting actor distinct from the subject.

### Subject requests erasure but is still the OWNER of an active tenant

We refuse the erasure and respond: "Your account is the designated
OWNER of tenant X. Please transfer ownership first (via the OWNER
transfer flow in `/admin/tenant`) or close the tenant. After that we
can proceed with erasure."

The transfer flow is in `src/app/actions/transfer-owner.ts`.

### Conflicting requests from a tenant and from the subject

The subject's right takes precedence for personal data (User.email,
User.displayName). Tenant-owned data (journal entries, ledger
balances) is the tenant's; the subject has no right to alter or
delete it. We respond to each requester separately, citing the
distinction.

### Subject under 13 (COPPA territory)

Out of scope — the marketing site Terms forbid use by anyone under 18.
If we discover an underage account, we deactivate and erase it
proactively.

---

## SLA + escalation

| Request type | Standard SLA | Extension allowed | Audit row |
|---|---|---|---|
| Access (UI path) | Same day (synchronous Server Action) | — | `data_subject.export` |
| Access (email path) | 30 days | Up to 60 days with written notification (GDPR Art. 12(3)) | `data_subject.export` |
| Erasure | 30 days | Up to 60 days with written notification | `data_subject.erase` |
| Rectification | 30 days for non-self-serve | Up to 60 days | (depends on Server Action) |

The audit_log table is append-only at the DB level
(`prisma/sql/audit-log-append-only.sql`); a regulator can verify
that a request was honored by the presence of the corresponding
row.

---

## What an auditor asks for, and where it lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me your data-subject request procedure" | This file |
| "Show me an example request that was honored" | `audit_log` rows with `action='data_subject.export'` or `action='data_subject.erase'` |
| "Show me the code that actually executes the export" | `src/lib/privacy/user-data.ts` `buildUserDataExport()` |
| "Show me the code that actually executes the erasure" | `src/lib/privacy/user-data.ts` `eraseUserPii()` |
| "Show me the authorization gate" | `src/app/actions/data-subject-request.ts` — `requireCurrentUser` + cohabitation + `canManageMemberships` check |
| "Show me the UI surface" | `src/app/admin/data-subject-requests/page.tsx` |
| "Show me retention of the export itself" | "Right of access" section above — 30-day vault retention |
| "How do you handle requests when the subject can't sign in?" | "Email/postal path" section above |
| "Show me where preserved-data-and-why is documented for the subject" | "Right to erasure" → step 5 (Communication to the subject) |

---

## Tests covering the executable layer

| Test file | What it proves |
|---|---|
| `tests/data-subject-request.test.ts` | Export bundle has the documented shape; erasure preserves financial attribution; audit row is written |
| `tests/audit-log-append-only.test.ts` | `audit_log` cannot be UPDATEd or DELETEd — proves the auditor's evidence trail is durable |

---

## Annual procedure review

Re-read this document on January 1 of each year. Update if:

- The export bundle schema has changed (`DataExportBundle.schemaVersion` bumped)
- A new US state has passed a comprehensive privacy law that grants new rights
- The portfolio has added a new customer-data table (the data-classification doc gets updated first, then this doc)
- The OWNER-only erasure gate has been changed
- We've received and honored ≥ 5 requests, in which case re-evaluate the SLAs

The review itself goes in the audit log as a `CONFIG_CHANGE/policy.review` row by the privacy lead.
