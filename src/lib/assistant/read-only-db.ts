// Read-only Prisma port for the assistant — ALLOWLIST design.
//
// The "ask your ledger" tools only ever read. This wraps a PrismaClient /
// TransactionClient in a Proxy that makes every mutation physically
// unreachable, so the read-only contract is enforced by capability, not
// convention. A future tool that tried `prisma.journalEntry.create(...)`
// throws here instead of posting — the "AI suggests, humans approve, the
// system posts" boundary.
//
// This is default-DENY, not a blacklist. An earlier blacklist version was
// unsound: `$extends` returns an UNWRAPPED client (writes bypass the port
// entirely), and raw-SQL variants keep appearing ($executeRawInternal,
// $queryRawTyped, …). So instead:
//
//   1. EVERY root property beginning with `$` is rejected — $extends,
//      $transaction, and the whole $execute*/$query* family, including any
//      future one. The assistant's deterministic report builders need none.
//   2. On a model delegate, ONLY the pure read methods below are callable;
//      every other delegate function (writes today, anything new tomorrow)
//      throws.

/** The ONLY delegate methods the assistant may call — pure reads. */
const READ_METHODS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "count",
  "aggregate",
  "groupBy",
]);

export class ReadOnlyViolationError extends Error {
  constructor(op: string) {
    super(
      `Read-only assistant DB: '${op}' is not an allowed read and is not ` +
        `permitted. The assistant may only read via ${[...READ_METHODS].join(", ")}; ` +
        `posting flows through postJournalEntry after human approval.`
    );
    this.name = "ReadOnlyViolationError";
  }
}

const throwing = (op: string) => () => {
  throw new ReadOnlyViolationError(op);
};

/**
 * Wrap a Prisma client so the assistant cannot mutate. Returns the same
 * type it was given (works for PrismaClient or a TransactionClient).
 */
export function readOnlyDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      // Reject ALL client-level `$` methods outright ($extends, $transaction,
      // $executeRaw*, $queryRaw*, $executeRawInternal, $queryRawTyped, and any
      // future addition). Default-deny is what makes this robust.
      if (typeof prop === "string" && prop.startsWith("$")) {
        return throwing(prop);
      }

      const value = Reflect.get(target, prop) as unknown;

      // Model delegates (prisma.account, prisma.journalEntry, …) are non-`$`
      // objects. Wrap each so only allowlisted read methods are callable and
      // any other function throws. Non-string keys (symbols) and internal
      // (`_`-prefixed) props pass through untouched — Prisma's machinery needs
      // them and they are not a delegate write surface.
      if (
        value &&
        typeof value === "object" &&
        typeof prop === "string" &&
        !prop.startsWith("_")
      ) {
        return new Proxy(value as object, {
          get(model, method) {
            const fn = Reflect.get(model, method) as unknown;
            if (typeof fn !== "function") return fn; // fields metadata, etc.
            if (typeof method === "string" && READ_METHODS.has(method)) {
              return fn.bind(model);
            }
            return throwing(
              typeof method === "string" ? `${prop}.${method}` : prop
            );
          },
        });
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
