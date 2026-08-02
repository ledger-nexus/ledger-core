"use client";

// Modal — the in-app replacement for window.confirm() / window.prompt().
//
// Native dialogs aren't merely unstyled here, they're unavailable: Chrome
// suppresses prompt()/confirm() inside cross-origin iframes, and automation
// and preview panes reject prompt() outright ("Error: prompt() is not
// supported"). That unhandled throw aborted the period-reopen path in every
// embedded context. A control that gates the ledger has to render in our own
// DOM, where it can also validate its input and state the consequence.
//
// Conventions follow the ⌘K palette (src/components/nav/command-palette.tsx):
// a fixed inset-0 overlay at z-50 over bg-ink-900/30, aria-modal, backdrop
// mousedown to dismiss. Radius is 16px (rounded-2xl) per the radius language
// documented in ui/card.tsx — cards 12px, inputs 8px, modals 16px.

import { useEffect, useId, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils/cn";

export interface ModalProps {
  open: boolean;
  /** Fired on Esc, backdrop click, and any caller-supplied cancel control. */
  onClose: () => void;
  title: string;
  /** Consequence copy — what this action does once confirmed. */
  description?: ReactNode;
  /** Body content: the field(s) being collected, if any. */
  children?: ReactNode;
  /** Action row, rendered bottom-right. Cancel first, confirm last. */
  footer?: ReactNode;
  className?: string;
}

const FOCUSABLE = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descId = useId();

  // onClose is read through a ref so the effect below depends only on `open`.
  // Depending on the callback itself would re-run the effect on every parent
  // render, stealing focus back to the field mid-keystroke.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement as HTMLElement | null;

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      // aria-modal promises the rest of the page is inert, so the Tab trap
      // has to be real — otherwise focus walks out into the page behind.
      if (e.key !== "Tab") return;
      const nodes = panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!nodes || nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);

    // Land focus on the field the operator is meant to fill; fall back to the
    // first focusable control (a confirm-only dialog has no field).
    const target =
      panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") ??
      panelRef.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      restoreRef.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink-900/30 px-4 pt-[12vh]"
      onMouseDown={(e) => {
        // Backdrop only — a mousedown that started inside the panel must not
        // dismiss the work in progress.
        if (e.target === e.currentTarget) onCloseRef.current();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        className={cn(
          "w-full max-w-md rounded-2xl border border-ink-200 bg-white shadow-xl",
          className
        )}
      >
        <div className="px-6 pt-6">
          <h2
            id={titleId}
            className="font-display text-base font-semibold tracking-tight text-ink-900"
          >
            {title}
          </h2>
          {description ? (
            <div id={descId} className="mt-2 text-sm leading-relaxed text-ink-600">
              {description}
            </div>
          ) : null}
        </div>
        {children ? <div className="px-6 pt-4">{children}</div> : null}
        {footer ? (
          <div className="flex items-center justify-end gap-2 px-6 pb-6 pt-5">
            {footer}
          </div>
        ) : null}
      </div>
    </div>
  );
}
