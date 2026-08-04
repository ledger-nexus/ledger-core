# Bypass log

**Owner:** Founder · **Last reviewed:** 2026-06-03

This file records every time a SOC 2 control (branch protection,
pre-commit hook, CI gate, audit-log RULE) is **deliberately
circumvented**. Auditors read this file to verify (a) bypasses are
rare, (b) bypasses are documented, (c) each bypass has a remediation
plan.

If this file is empty, that means no bypasses have occurred since
the policy was adopted. That is the desired steady state.

## Format

Each entry below is a row:

```
## YYYY-MM-DD — short description

**Control bypassed:** [which gate from change-management.md]
**Reason:** [why the bypass was necessary]
**Authorized by:** [name, role]
**Audit-log row:** [the audit_log row id where this bypass was recorded]
**Remediation:** [what was done to prevent recurrence]
**Closed:** [YYYY-MM-DD when the remediation landed]
```

## Entries

*(none — steady state)*

## Review

This file is reviewed alongside `change-management.md` at the annual
review. Any entry without a `Closed:` date triggers a remediation
conversation.
