// What a Server Action is allowed to tell the caller when it doesn't
// recognise the error.
//
// Every action ends the same way: a catch-all that had no idea what it
// caught and did this with it —
//
//   return { ok: false, message: e instanceof Error ? e.message : "..." };
//
// For an error WE authored that is correct and wanted. The refusal
// messages in this codebase are deliberate user-facing copy — "Debits
// must equal credits", "Allocation percents must sum to exactly 100
// (got 99.5)", "This reconciliation is signed off — reopen it to change
// matches". Replacing those with a generic apology would be a
// regression, not a hardening.
//
// The problem is the OTHER thing that reaches that line. A Prisma error
// carries the schema in its text: table names, column names, the
// constraint that fired, sometimes a fragment of the failing input.
// That is internal structure, and a toast is not the place for it. This
// is not hypothetical — #345 was exactly this defect in
// createRecurringEntryAction, where an unvalidated `cadence` reached
// prisma.create and the driver's complaint went straight to the user.
// It was fixed in that one file while 27 others kept the same shape.
//
// So the rule is narrow on purpose: sanitize DRIVER errors, pass
// authored ones through untouched. A blanket "never show e.message"
// would have been easier to write and would have thrown away the good
// half.
//
// The real error is not lost — it goes to the server log, where the
// operator can see it and the customer cannot.

import { Prisma } from "@prisma/client";

import { captureError } from "@/lib/monitoring";

/**
 * True when the error came out of the database driver rather than our
 * own code.
 *
 * Both checks are deliberate. `instanceof` is the precise test but can
 * fail when two copies of the client end up loaded (the same dual-package
 * hazard that made `Decimal.set()` a no-op for 99 files — see
 * `@/lib/utils/decimal`). The name/code check catches that case, and
 * costs nothing when instanceof already worked.
 */
export function isDriverError(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError ||
    e instanceof Prisma.PrismaClientUnknownRequestError ||
    e instanceof Prisma.PrismaClientValidationError ||
    e instanceof Prisma.PrismaClientInitializationError ||
    e instanceof Prisma.PrismaClientRustPanicError
  ) {
    return true;
  }
  if (!(e instanceof Error)) return false;
  if (e.name.startsWith("PrismaClient")) return true;
  // Known-request errors carry a Pnnnn code even when the class identity
  // is lost across client copies.
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && /^P\d{4}$/.test(code);
}

/**
 * The message a catch-all may return.
 *
 * Authored errors keep their wording — that copy was written for the
 * person reading it. Driver errors are replaced by the caller's own
 * fallback and logged server-side instead.
 */
export function sanitizeActionError(e: unknown, fallback: string): string {
  if (isDriverError(e)) {
    // Through the house error path, not a bare console.error: it
    // redacts context before transmission and reaches Sentry when
    // configured. A helper whose whole purpose is to stop 27 files
    // improvising should not improvise its own logging.
    //
    // `extra` carries the Prisma code and the constraint target — which
    // table and columns failed. Both are schema facts, not row values,
    // so an operator can find the cause without any customer data
    // leaving the process. The error object itself is passed for the
    // stack; deliberately nothing is added from its message, because a
    // validation error renders the failing call arguments into it.
    captureError(e, {
      context: "action",
      extra: {
        prismaCode: (e as { code?: unknown }).code,
        target: (e as { meta?: { target?: unknown } }).meta?.target,
      },
    });
    return fallback;
  }
  return e instanceof Error ? e.message : fallback;
}
