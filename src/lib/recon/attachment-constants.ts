// Display constants for reconciliation attachments.
//
// These live outside the Server Action module on purpose. Next.js only
// permits async function exports from a "use server" file — every export
// there becomes a callable server endpoint — so a plain string constant
// exported from src/app/actions/recon-attachments.ts fails the
// production build ("Only async functions are allowed to be exported in
// a 'use server' file"), even though tsc and the test suite are perfectly
// happy with it. Both the action and the client upload form import the
// hint from here instead.

/** Human-readable summary of the accepted upload formats + size cap. */
export const ATTACHMENT_ACCEPT_HINT = "PDF, PNG, JPEG, CSV, XLSX up to 10 MB";
