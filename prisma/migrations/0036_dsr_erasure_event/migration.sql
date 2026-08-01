-- DSR slice (#46 harvest ⑥): DATA_ERASURE audit event type.
-- GDPR Art. 17 erasure writes an append-only audit row a regulator can
-- query to verify the request was honored; it needs its own event type
-- so those rows are findable without string-matching action names.
-- Additive enum value; no rows change meaning.
ALTER TYPE "AuditEventType" ADD VALUE 'DATA_ERASURE';
