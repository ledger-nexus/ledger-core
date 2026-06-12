# Customer trust artifacts

**Owner:** Founder (sales + privacy lead)
**Last updated:** 2026-06-03

This directory holds **sales-enablement artifacts** that turn the
internal SOC 2 framework into something a prospect can read.

## What lives here

| File | Purpose | Audience |
|---|---|---|
| `security-questionnaire-answers.md` | Pre-answered SIG-Lite / CAIQ-v4 covering 90% of the common enterprise procurement questions, with file-path citations | Prospect's CISO / GRC / procurement team |
| (future) `data-processing-addendum.md` | Our customer-facing DPA template | Enterprise customers requiring negotiated DPA |
| (future) `master-service-agreement.md` | MSA template citing the framework | Enterprise customers |
| (future) `trust-portal.html` | A static HTML version of the questionnaire for the marketing site | Public / prospect-facing |

## Why this directory exists

When an enterprise prospect asks "are you SOC 2 attested?", the
honest answer is "Type 1 audit-ready, target Q3 2026, here's our
gap analysis and our compensating controls." The artifacts in this
directory are how we communicate that honestly + comprehensively.

The internal framework (`docs/policies/`, `docs/SOC2_READINESS.md`,
`docs/SOC2_CONTROL_MATRIX.md`) is the authoritative source. These
artifacts are the customer-facing **derivation** of that source.

## Update cadence

- Annual review alongside the policy directory
- Out-of-cycle when:
  - A new major policy version ships (e.g., access-control v2.0 → v3.0)
  - A customer-trigger gated deficiency closes
  - A first paying customer signs (many "today's state" rows flip)
  - An auditor engagement begins

The change is recorded as an audit-log row
`CONFIG_CHANGE/customer_trust.review`.

## What this directory is NOT

- A substitute for an actual signed DPA — those are case-by-case
  negotiations triggered per `vendor-management.md` v2.0 procedure
- A SOC 2 report — Type 1 attestation comes from an accredited auditor
- A marketing surface — the artifacts are reference material, not
  ad copy

## Auditor-facing note

A SOC 2 auditor reviewing this directory should treat it as
**evidence of CC2.2 (External Communication)** — the controls
documented internally are actually communicated to customers,
not just sitting in internal repos.
