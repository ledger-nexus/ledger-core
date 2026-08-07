import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Warm neutral palette (stone-leaning). Same semantic names as the
        // old slate scale so no className changes anywhere — the whole app
        // warms up in one token swap. Pure #000-on-#fff is deliberately
        // unreachable: 50 is warm off-white, 900 is warm near-black.
        // Steps 500 and darker are the only ones that may carry text; see
        // docs/design-system.md. 400 and lighter are borders, icons,
        // disabled controls and inert separators. tests/design-system.test.ts
        // derives that split from these values and enforces it.
        ink: {
          50: "#fafaf9",
          100: "#f5f5f4",
          200: "#e7e5e4",
          300: "#d6d3d1",
          400: "#a8a29e",
          // Was #78716c, which cleared AA on the page (4.59:1) but not on
          // bg-ink-100 panels (4.40:1) — and this is the muted-text step, so
          // it lands on both. Two notches darker along the same warm axis
          // buys 4.80:1 on the worst surface at no perceptible cost.
          500: "#726b66",
          600: "#57534e",
          700: "#44403c",
          800: "#292524",
          900: "#1c1917",
        },
        accent: {
          100: "#cffafe",  // cyan-100 — the status-surface step
          500: "#0891b2",  // cyan-600 — 3.53:1, so surfaces and borders only
          600: "#0e7490",  // cyan-700 — the text-legal step (5.13:1)
        },
        // Each tone is a pair: DEFAULT is the text-legal ink, 100 is the
        // surface it sits on. Before this, the 100s did not exist as tokens
        // and Badge reached straight for raw Tailwind — which is how the two
        // vocabularies drifted apart without anyone noticing. `positive` is
        // GREEN-700; Badge was using EMERALD-700, so a positive amount and a
        // positive badge were two different greens meaning the same thing.
        // (The comment here used to say emerald-700. It was wrong.)
        positive: { DEFAULT: "#15803d", 100: "#dcfce7" }, // green-700 / green-100
        negative: { DEFAULT: "#b91c1c", 100: "#fee2e2" }, // red-700 / red-100
        // Was never defined, while `text-warning`, `border-warning` and
        // `bg-warning/5` were all in use — Tailwind emits nothing for a token
        // it does not know, so the consolidation page's "FX translation not
        // active" callout rendered untinted with a fallback border, beside an
        // identically-built positive callout that was tinted green.
        warning: { DEFAULT: "#b45309", 100: "#fef3c7" }, // amber-700 / amber-100
      },
      fontFamily: {
        sans: ["ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Helvetica", "Arial"],
        // Display face for headings only — body stays system for speed and
        // data density. The variable is set by next/font in layout.tsx.
        display: ["var(--font-display)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Monaco", "Consolas", "monospace"],
      },
      // Named easing curves — no CSS keyword easings on interactive
      // elements. "snap" for hover/press, "out" for enter/exit.
      transitionTimingFunction: {
        snap: "cubic-bezier(0.22, 1, 0.36, 1)",
        out: "cubic-bezier(0.16, 1, 0.3, 1)",
      },
    },
  },
  plugins: [],
};

export default config;
