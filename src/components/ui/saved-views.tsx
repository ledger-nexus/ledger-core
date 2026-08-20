// Saved-view picker: load one, save the current filters as one, delete yours.
//
// Server-rendered links and plain forms — no client state. Loading a view is
// an <a href> to the stored query string, which works because the surface
// keeps its whole state in the URL (src/lib/url-state.ts). That is the same
// property that makes report-cell drill-down a link, and it is why this
// component is 60 lines instead of a client store.

import Link from "next/link";

import { saveViewFormAction, deleteViewFormAction } from "@/app/actions/saved-views";
import { Input } from "@/components/ui/input";

export interface SavedViewItem {
  id: string;
  name: string;
  query: string;
  shared: boolean;
  ownerId: string;
}

export function SavedViews({
  surface,
  views,
  currentQuery,
  currentUserId,
}: {
  /** Route slug — must match the surface the views were saved against. */
  surface: string;
  views: SavedViewItem[];
  /** The surface's current state, serialized. No leading "?". */
  currentQuery: string;
  currentUserId: string;
}) {
  const basePath = `/${surface}`;

  return (
    <div className="flex flex-wrap items-end gap-3">
      {views.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-ink-500">Views</span>
          {views.map((v) => {
            const href = v.query ? `${basePath}?${v.query}` : basePath;
            const isActive = v.query === currentQuery;
            // Only the owner gets a delete cap, so only the owner's chip is
            // squared off on the right.
            const canDelete = v.ownerId === currentUserId;
            return (
              <span key={v.id} className="inline-flex items-center">
                <Link
                  href={href}
                  aria-current={isActive ? "true" : undefined}
                  className={[
                    canDelete ? "rounded-l-md" : "rounded-md",
                    "border px-2 py-1 text-xs transition-colors duration-150 ease-snap",
                    isActive
                      ? "border-ink-300 bg-ink-100 text-ink-900"
                      : "border-ink-200 text-ink-700 hover:bg-ink-50",
                  ].join(" ")}
                  title={v.shared ? `${v.name} — shared with the team` : v.name}
                >
                  {v.name}
                  {v.shared && (
                    <span className="ml-1 text-ink-500" aria-label="shared">
                      ·
                    </span>
                  )}
                </Link>
                {/* Only the owner may delete. A shared view others depend on
                    is not something a passer-by should be able to remove.
                    ⚠️ A non-owner gets NOTHING here, not a greyed-out stub. The
                    first version rendered a `·` in text-ink-300 as a spacer and
                    the contrast guard (#359) failed it at 1.37:1. Recolouring
                    it would have satisfied the guard while keeping a character
                    that says nothing; the rule is that 400-and-lighter is for
                    borders and inert separators, and this was neither — it was
                    text pretending to be furniture. */}
                {canDelete && (
                  <form action={deleteViewFormAction}>
                    <input type="hidden" name="id" value={v.id} />
                    <button
                      type="submit"
                      title={`Delete view "${v.name}"`}
                      className="rounded-r-md border border-l-0 border-ink-200 px-1.5 py-1 text-xs text-ink-500 hover:bg-negative-50 hover:text-negative"
                    >
                      ×<span className="sr-only">Delete view {v.name}</span>
                    </button>
                  </form>
                )}
              </span>
            );
          })}
        </div>
      )}

      <form action={saveViewFormAction} className="flex items-end gap-2">
        <input type="hidden" name="surface" value={surface} />
        <input type="hidden" name="query" value={currentQuery} />
        <div className="w-40">
          <Input
            name="name"
            placeholder="Save current filters as…"
            aria-label="Name for the saved view"
            maxLength={60}
            required
          />
        </div>
        <label className="flex items-center gap-1.5 pb-2 text-xs text-ink-500">
          <input type="checkbox" name="shared" className="accent-accent-600" />
          Share
        </label>
        <button
          type="submit"
          className="rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
        >
          Save view
        </button>
      </form>
    </div>
  );
}
