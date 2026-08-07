"use client";

// ⌘K command palette — keyboard-first navigation over every destination.
//
// Why it exists (Laws of UX + the competitor read):
//   Jakob's Law — ⌘K is now a universal convention (Linear, Slack, GitHub,
//     Notion, and the "Slack for accounting" incumbents). Users arrive
//     already fluent; matching it costs a keystroke to learn and saves the
//     sidebar hunt on every navigation.
//   Fitts's Law — a keyboard shortcut is a zero-distance target: the fastest
//     possible way to reach a page is not to move the mouse at all.
//   Hick's Law — typing collapses ~30 destinations to the 1–3 that match, so
//     the choice you actually face is tiny even though the catalog is large.
//
// Reads from the shared nav catalog, so it can never list a page the sidebar
// doesn't, or miss one the sidebar has. Navigation only — it never posts.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { flattenCommands, type CommandItem } from "@/components/nav/catalog";
import { cn } from "@/lib/utils/cn";

const OPEN_EVENT = "lc:open-command-palette";

/**
 * Visible header affordance — a ⌘K chip mouse users can click. Server
 * Components can't hold the palette's open state, so it dispatches a window
 * event the palette listens for. Shows Ctrl on non-Mac.
 */
export function CommandPaletteHint() {
  const [isMac, setIsMac] = useState(true);
  useEffect(() => {
    setIsMac(/Mac|iPhone|iPad/.test(navigator.platform));
  }, []);
  return (
    <button
      type="button"
      title="Open the command palette"
      onClick={() => window.dispatchEvent(new Event(OPEN_EVENT))}
      className="flex h-9 items-center gap-1 rounded-md border border-ink-200 px-2 text-xs text-ink-500 transition-colors hover:border-ink-400 hover:text-ink-700"
    >
      <kbd className="font-sans">{isMac ? "⌘" : "Ctrl"}</kbd>
      <kbd className="font-sans">K</kbd>
    </button>
  );
}

export function CommandPalette({
  isAdmin = false,
  reviewCount = 0,
}: {
  isAdmin?: boolean;
  /** Bank lines awaiting review — surfaced as a count on that command. */
  reviewCount?: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const commands = useMemo(() => flattenCommands({ isAdmin }), [isAdmin]);

  // Substring match on label + group + hint; every whitespace-separated token
  // must appear somewhere. Cheap and predictable — no fuzzy surprises on a
  // catalog this small.
  const results = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return commands;
    return commands.filter((c) => {
      const hay = `${c.label} ${c.group} ${c.hint ?? ""}`.toLowerCase();
      return tokens.every((t) => hay.includes(t));
    });
  }, [commands, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setActive(0);
  }, []);

  const run = useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return;
      close();
      router.push(item.href);
    },
    [close, router]
  );

  // Global ⌘K / Ctrl+K toggles the palette; a custom event lets the visible
  // header affordance (below) open it for mouse users who don't know ⌘K.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((v) => !v);
      }
    }
    function onOpen() {
      setOpen(true);
    }
    document.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, []);

  // Focus the input on open; clamp the selection when results shrink.
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  // Keep the highlighted row in view as the user arrows down a long list.
  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-900/30 px-4 pt-[12vh]"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        // Click on the backdrop (not the panel) closes.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-ink-200 bg-white shadow-xl">
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              close();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => Math.min(a + 1, results.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              run(results[active]);
            }
          }}
          placeholder="Jump to… (type a page or action)"
          className="w-full border-b border-ink-200 px-4 py-3 text-sm text-ink-900 outline-none placeholder:text-ink-500"
        />
        <ul ref={listRef} className="max-h-80 overflow-y-auto py-1">
          {results.length === 0 ? (
            <li className="px-4 py-3 text-sm text-ink-500">No matches</li>
          ) : (
            results.map((c, i) => (
              <li key={c.href} data-idx={i}>
                <button
                  type="button"
                  onMouseEnter={() => setActive(i)}
                  onClick={() => run(c)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 px-4 py-2 text-left text-sm",
                    i === active ? "bg-ink-900 text-white" : "text-ink-800 hover:bg-ink-100"
                  )}
                >
                  <span className="flex items-center gap-2">
                    {c.isAction && <span aria-hidden="true">+</span>}
                    <span className={cn(c.isAction && "font-medium")}>{c.label}</span>
                    {c.href === "/banking" && reviewCount > 0 && (
                      <span
                        className={cn(
                          "rounded-full px-1.5 text-[11px] font-semibold tabular-nums",
                          i === active ? "bg-white text-ink-900" : "bg-amber-100 text-amber-900"
                        )}
                      >
                        {reviewCount}
                      </span>
                    )}
                  </span>
                  <span
                    className={cn(
                      "text-[11px] uppercase tracking-wide",
                      i === active ? "text-white/60" : "text-ink-500"
                    )}
                  >
                    {c.hint ?? c.group}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        <div className="flex items-center gap-3 border-t border-ink-200 px-4 py-2 text-[11px] text-ink-500">
          <span>↑↓ to move</span>
          <span>↵ to open</span>
          <span>esc to close</span>
        </div>
      </div>
    </div>
  );
}
