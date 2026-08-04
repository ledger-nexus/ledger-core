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
        ink: {
          50: "#fafaf9",
          100: "#f5f5f4",
          200: "#e7e5e4",
          300: "#d6d3d1",
          400: "#a8a29e",
          500: "#78716c",
          600: "#57534e",
          700: "#44403c",
          800: "#292524",
          900: "#1c1917",
        },
        accent: {
          500: "#0891b2",  // cyan-600 — used sparingly for actions
          600: "#0e7490",
        },
        positive: "#15803d", // emerald-700 (debit-side balances, gains)
        negative: "#b91c1c", // red-700 (credit-side / losses on disposal)
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
