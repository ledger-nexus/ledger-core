// The URL is the state.
//
// Every filterable surface declares its parameters once, as a spec, and gets
// four things from that one declaration: parsing with defaults, href building,
// filter chips, and a "is anything filtered" flag. The point is that they
// cannot drift from each other, because there is only one list.
//
// WHY THIS EXISTS (docs/design/campfire-product-surface.md §3). Reading
// Campfire's URLs — `?account=2001&account_rollup=true&start_date=…` — the
// structural finding was that their whole filter state round-trips through the
// query string, and that this is what makes three later features cheap rather
// than hard:
//
//   * Drill-down from a report cell is an <a href>. No modal, no shared client
//     store, no new endpoint — the cell knows its account and period, and the
//     destination reads both from the URL.
//   * A saved view is a stored query string plus a name.
//   * The back button works, including out of a drill-down.
//
// Before this file, every list page hand-rolled `searchParams.x ?? default`
// plus its own coercion. `/journal-entries` did it four times in six lines.
// The duplication is not the problem; the DRIFT is — a filter that is applied
// but has no chip, or a chip whose clear link forgets a sibling parameter.
//
// ⚠️ PARAM NAMES ARE camelCase. That is not a new rule, it is the one the
// codebase already follows — `asOf`, `bookFrom`, `bookTo`, `periodStart`, with
// zero snake_case anywhere in `src/app`. It is pinned in
// tests/url-state.test.ts because Campfire ships `start_date` on one screen and
// `startDate` on another, in the same product, and that is what unpinned
// conventions look like after two years.

/** One parameter: how to read it, how to write it, how to label its chip. */
export interface ParamSpec<T> {
  /** Raw query value (already de-arrayed) → typed value. Never throws. */
  parse: (raw: string | undefined) => T;
  /** Typed value → query value, or `undefined` to OMIT it from the URL. */
  serialize: (value: T) => string | undefined;
  /** Chip text, or `null` for a parameter that should not show a chip. */
  chip?: (value: T) => string | null;
}

/**
 * The constraint for a surface's spec map.
 *
 * ⚠️ `any` rather than `unknown`, deliberately. `ParamSpec<T>` is
 * CONTRAVARIANT in `T` through `serialize(value: T)`, so `ParamSpec<string>`
 * is not assignable to `ParamSpec<unknown>` and a heterogeneous map of typed
 * params cannot satisfy the stricter constraint. `unknown` here does not make
 * anything safer — it makes every real spec fail to compile, and the escape
 * people reach for next is a cast at the call site, which is worse.
 *
 * Precision is not lost: concrete specs keep their exact types, and `StateOf<S>`
 * infers each parameter's `T` back out, so callers get `state.page: number`
 * and `state.q: string`. The `any` is confined to this constraint.
 */
export type SurfaceSpec = Record<string, ParamSpec<any>>;

export type StateOf<S extends SurfaceSpec> = {
  [K in keyof S]: S[K] extends ParamSpec<infer T> ? T : never;
};

/** Next.js hands us `string | string[] | undefined`; first value wins. */
export type RawParams = Record<string, string | string[] | undefined>;

function first(raw: string | string[] | undefined): string | undefined {
  if (Array.isArray(raw)) return raw[0];
  return raw;
}

// ─── Spec builders ────────────────────────────────────────────────────────
//
// Each one takes its default and returns a ParamSpec. `serialize` returns
// undefined when the value equals the default, which is what keeps URLs clean:
// a surface at rest has no query string at all, so "share this link" does not
// paste twelve redundant parameters.

export function str(
  fallback = "",
  opts: { chip?: (v: string) => string | null } = {}
): ParamSpec<string> {
  return {
    parse: (raw) => (raw ?? fallback).trim(),
    serialize: (v) => (v === fallback || v === "" ? undefined : v),
    chip: opts.chip ?? ((v) => (v && v !== fallback ? v : null)),
  };
}

export function int(
  fallback: number,
  opts: { min?: number; max?: number; chip?: (v: number) => string | null } = {}
): ParamSpec<number> {
  const clamp = (n: number) => {
    if (opts.min !== undefined && n < opts.min) return fallback;
    if (opts.max !== undefined && n > opts.max) return fallback;
    return n;
  };
  return {
    // ⚠️ Garbage falls back to the default rather than throwing or yielding
    // NaN. A hand-edited URL is a normal thing for a user to do and must not
    // produce a 500 or a query for page NaN.
    parse: (raw) => {
      const n = Number.parseInt(raw ?? "", 10);
      return Number.isFinite(n) ? clamp(n) : fallback;
    },
    serialize: (v) => (v === fallback ? undefined : String(v)),
    chip: opts.chip ?? (() => null),
  };
}

/** ISO `YYYY-MM-DD`. Kept as a string — parsing to Date is the caller's job. */
export function isoDate(
  fallback: string,
  opts: { chip?: (v: string) => string | null } = {}
): ParamSpec<string> {
  const valid = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
  return {
    parse: (raw) => (raw && valid(raw) ? raw : fallback),
    serialize: (v) => (v === fallback || !valid(v) ? undefined : v),
    chip: opts.chip ?? (() => null),
  };
}

export function oneOf<T extends string>(
  values: readonly T[],
  fallback: T,
  opts: { chip?: (v: T) => string | null } = {}
): ParamSpec<T> {
  return {
    parse: (raw) => (values.includes(raw as T) ? (raw as T) : fallback),
    serialize: (v) => (v === fallback ? undefined : v),
    chip: opts.chip ?? ((v) => (v === fallback ? null : v)),
  };
}

export function bool(
  fallback = false,
  opts: { chip?: (v: boolean) => string | null } = {}
): ParamSpec<boolean> {
  return {
    parse: (raw) => (raw === undefined ? fallback : raw === "true" || raw === "1"),
    serialize: (v) => (v === fallback ? undefined : String(v)),
    chip: opts.chip ?? (() => null),
  };
}

// ─── The four things a spec gives you ─────────────────────────────────────

/** Read the whole surface state out of Next's `searchParams`. */
export function parseUrlState<S extends SurfaceSpec>(spec: S, raw: RawParams): StateOf<S> {
  const out = {} as Record<string, unknown>;
  for (const [key, param] of Object.entries(spec)) {
    out[key] = param.parse(first(raw[key]));
  }
  return out as StateOf<S>;
}

/**
 * Build an href for this surface. `patch` overrides individual keys, which is
 * how "next page" and "clear this one filter" are both expressed:
 *
 *   buildUrl("/journal-entries", SPEC, state, { page: state.page + 1 })
 *   buildUrl("/journal-entries", SPEC, state, { q: "" })
 */
export function buildUrl<S extends SurfaceSpec>(
  pathname: string,
  spec: S,
  state: StateOf<S>,
  patch: Partial<StateOf<S>> = {}
): string {
  const merged = { ...state, ...patch } as Record<string, unknown>;
  const qs = new URLSearchParams();
  // Object key order, so the same state always produces the same string —
  // which matters for cache keys and for eyeballing two links as equal.
  for (const [key, param] of Object.entries(spec)) {
    const encoded = param.serialize(merged[key]);
    if (encoded !== undefined && encoded !== "") qs.set(key, encoded);
  }
  const s = qs.toString();
  return s ? `${pathname}?${s}` : pathname;
}

export interface FilterChip {
  key: string;
  label: string;
  /** Href with just this filter reset to its default. */
  clearHref: string;
}

/**
 * The chips for the current state — §6's "the state is visible" rule.
 *
 * Derived from the same spec the parsing uses, so a filter can never be
 * applied without a chip, and a chip's clear link can never forget a sibling
 * parameter. That pairing is the whole reason this returns from here rather
 * than being assembled per page.
 */
export function filterChips<S extends SurfaceSpec>(
  pathname: string,
  spec: S,
  state: StateOf<S>,
  defaults: StateOf<S>
): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const [key, param] of Object.entries(spec)) {
    const value = (state as Record<string, unknown>)[key];
    const label = param.chip?.(value) ?? null;
    if (label === null) continue;
    chips.push({
      key,
      label,
      // Clearing a filter also returns to page 1 — a filtered page 7 that
      // becomes an unfiltered page 7 is a confusing place to land.
      clearHref: buildUrl(pathname, spec, state, {
        [key]: (defaults as Record<string, unknown>)[key],
        ...("page" in spec ? { page: (defaults as Record<string, unknown>).page } : {}),
      } as Partial<StateOf<S>>),
    });
  }
  return chips;
}

/** The defaults for a spec — i.e. the state of an untouched surface. */
export function defaultsOf<S extends SurfaceSpec>(spec: S): StateOf<S> {
  return parseUrlState(spec, {});
}
