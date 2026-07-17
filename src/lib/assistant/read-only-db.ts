// Read-only Prisma port for the assistant.
//
// The "ask your ledger" tools only ever read — but today that's a
// CONVENTION (the tool executors happen not to call writes), not a
// capability. Codex's review asked for the read-only guarantee to be
// enforced, not assumed. This wraps a PrismaClient / TransactionClient in
// a Proxy that makes every mutation physically unreachable: model write
// methods (create/update/delete/upsert families), raw execution, and
// interactive transactions throw. Reads (findMany/findFirst/findUnique/
// count/aggregate/groupBy and $queryRaw) pass straight through, so the
// deterministic report builders the tools call still work unchanged.
//
// A future tool that tried `prisma.journalEntry.create(...)` would throw
// here instead of silently posting to the ledger — the whole point of the
// "AI suggests, humans approve, the system posts" boundary.

/** Model-delegate methods that write. */
const WRITE_METHODS = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "delete",
  "deleteMany",
  "upsert",
]);

/** Top-level client methods that can write or run arbitrary SQL. */
const BLOCKED_ROOT = new Set([
  "$executeRaw",
  "$executeRawUnsafe",
  "$transaction",
]);

export class ReadOnlyViolationError extends Error {
  constructor(op: string) {
    super(
      `Read-only assistant DB: '${op}' is a mutation and is not permitted. ` +
        `The assistant may only read; posting flows through postJournalEntry ` +
        `after human approval.`
    );
    this.name = "ReadOnlyViolationError";
  }
}

/**
 * Wrap a Prisma client so the assistant cannot mutate. Returns the same
 * type it was given (works for PrismaClient or a TransactionClient).
 */
export function readOnlyDb<T extends object>(db: T): T {
  return new Proxy(db, {
    get(target, prop) {
      const key = typeof prop === "string" ? prop : "";

      // Block raw execution + interactive transactions at the root.
      if (BLOCKED_ROOT.has(key)) {
        return () => {
          throw new ReadOnlyViolationError(key);
        };
      }

      const value = Reflect.get(target, prop) as unknown;

      // Model delegates (prisma.account, prisma.journalEntry, …) are
      // objects, not functions, and don't start with `$`/`_`. Wrap them so
      // their write methods throw while reads pass through.
      if (
        value &&
        typeof value === "object" &&
        key &&
        !key.startsWith("$") &&
        !key.startsWith("_")
      ) {
        return new Proxy(value as object, {
          get(model, method) {
            const m = typeof method === "string" ? method : "";
            if (WRITE_METHODS.has(m)) {
              return () => {
                throw new ReadOnlyViolationError(`${key}.${m}`);
              };
            }
            const fn = Reflect.get(model, method) as unknown;
            return typeof fn === "function" ? fn.bind(model) : fn;
          },
        });
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}
