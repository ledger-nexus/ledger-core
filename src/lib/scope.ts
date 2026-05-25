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

/**
 * Resolve the effective scope from URL overrides, falling back to the
 * cookie. Lets pages and route handlers accept `?entity=X&book=Y` query
 * parameters that override the sidebar-switched scope cookie for a
 * single request. Critical for shareable demo URLs — paste the link,
 * see the right entity's data, no cookie surgery required.
 */
export function resolveScope(
  searchParams: URLSearchParams | Record<string, string | undefined>
): LedgerScope {
  const cookieScope = getScope();
  const get = (k: string): string | undefined =>
    searchParams instanceof URLSearchParams
      ? searchParams.get(k) ?? undefined
      : searchParams[k];
  return {
    entityCode: get("entity") ?? cookieScope.entityCode,
    bookCode: get("book") ?? cookieScope.bookCode,
  };
}

export const SCOPE_COOKIE_NAME = COOKIE_NAME;
