// Per-request scope: which (entity, book) the UI is viewing.
//
// Stored in a single cookie `lc-scope`. Defaults to NORTHWIND / US_GAAP
// (matching the seed). Read by Server Components via getScope(); written
// via the setScope Server Action in src/app/actions/set-scope.ts.

import { cookies } from "next/headers";

export interface LedgerScope {
  entityCode: string;
  bookCode: string;
}

export const DEFAULT_SCOPE: LedgerScope = {
  entityCode: "NORTHWIND",
  bookCode: "US_GAAP",
};

const COOKIE_NAME = "lc-scope";

export function getScope(): LedgerScope {
  const raw = cookies().get(COOKIE_NAME)?.value;
  if (!raw) return DEFAULT_SCOPE;
  try {
    const parsed = JSON.parse(raw) as Partial<LedgerScope>;
    return {
      entityCode: parsed.entityCode ?? DEFAULT_SCOPE.entityCode,
      bookCode: parsed.bookCode ?? DEFAULT_SCOPE.bookCode,
    };
  } catch {
    return DEFAULT_SCOPE;
  }
}

export const SCOPE_COOKIE_NAME = COOKIE_NAME;
