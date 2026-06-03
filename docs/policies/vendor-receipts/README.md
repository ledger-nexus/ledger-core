# Vendor SOC 2 receipts

**Owner:** Founder
**Last reviewed:** 2026-06-03

This directory holds **downloaded SOC 2 Type 2 reports** from every
vendor in the inventory in `docs/policies/vendor-management.md`.

## Why this directory exists

The SOC 2 auditor will ask:

> "Show me the SOC 2 Type 2 reports of the upstream services that
> handle your customers' data."

The vendor-management policy documents *which* vendors we use and
*what* we use them for. This directory holds the *evidence* —
the actual PDFs.

## File naming

```
{vendor}/{YYYY}.pdf
```

Example: `neon/2026.pdf`, `vercel/2026.pdf`.

One PDF per vendor per calendar year. The naming is the index;
no separate metadata file.

## What's in `.gitignore`

The PDFs themselves are gitignored. SOC 2 reports often carry
"do not distribute" clauses and the auditor's report is the trust
artifact — not its hosted location. We commit this README, the
download procedure, and the trail; the PDFs live in the directory
on the founder's machine + a 1Password attachment for resilience.

## Annual download procedure

On the first Monday of January (calendar reminder):

1. For each vendor in `docs/policies/vendor-management.md`:
2. Navigate to the vendor's trust portal (URLs in vendor-management.md).
3. Sign in with the founder's account.
4. Download the most recent SOC 2 Type 2 report.
5. Save to `docs/policies/vendor-receipts/{vendor}/{YYYY}.pdf`.
6. Verify the report covers the prior 12 months ending no earlier
   than 3 months before download (most are 12-month rolling with
   a 3-month publication lag).
7. Read the auditor's opinion + the management response on any
   qualifications.
8. If material qualifications: open a risk-register row.
9. Update the vendor's `Last reviewed` cell in vendor-management.md.
10. Audit-log row `CONFIG_CHANGE/vendor.reviewed` per vendor.

## What an auditor asks for, and where the answer lives

| Auditor question | Where the answer lives |
|---|---|
| "Show me your vendors' SOC 2 Type 2 reports" | This directory (paths above); share path with auditor at kickoff |
| "When did you last review each vendor's report?" | `docs/policies/vendor-management.md` "Vendor inventory" table |
| "Did you find any material qualifications?" | `docs/policies/risk-register.md` (any qualification triggers a row); each PDF's "Auditor's opinion" section |
| "Why isn't the PDF in git?" | This README — "do not distribute" clauses + auditor's report is the trust artifact, not the hosting |
