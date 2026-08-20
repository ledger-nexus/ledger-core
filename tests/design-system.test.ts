// The design system's two numeric contracts, enforced.
//
// Both of these were violated in the shipped UI, and neither could be
// caught by reading a diff — you have to do the arithmetic.
//
// CONTRAST. The warm ink ramp was introduced as a token swap over an
// older slate scale, keeping the same step names so no className had to
// change. Nobody recomputed the ratios afterwards. `ink-400` (#a8a29e)
// lands at 2.41:1 on the page surface — a WCAG AA failure by a factor of
// nearly two — and it was carrying 120 pieces of real content: flux
// rationales, audit timestamps, "(you)", the M-3 hints. It read as
// "muted" in a mock and as "unreadable" on a laptop in a bright room.
//
// The fix is not to darken ink-400 into ink-500's value — that collapses
// a ramp deliberately shaped like Tailwind's stone scale. It is to say
// which steps are allowed to carry text at all, and enforce it. ink-400
// and lighter are now non-text: borders, icons, disabled controls, and
// inert separators.
//
// The token set is DERIVED from tailwind.config.ts rather than listed
// here. A hand-written list of "the bad colors" is a list that silently
// stops covering the palette the moment someone adds a color — it never
// fails, it just quietly checks less. Every color in the config gets its
// ratio computed; the ones that fail become the ones that may not appear
// as a `text-` class.
//
// SIZE. Tailwind's scale steps 12px -> 14px, so anything smaller is an
// arbitrary value. 161 of them had accumulated, 45 at 10px, and six of
// those 45 were validation errors — the one string on the page a user
// most needs to read, set smaller than anything around it.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import tailwindConfig from "../tailwind.config";

// --- WCAG 2.1 relative luminance / contrast -------------------------------

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

// --- The contract ---------------------------------------------------------

/** WCAG AA, normal-weight body text. */
const AA_BODY = 4.5;

/** Smallest size any functional text may be set at. */
const MIN_FUNCTIONAL_PX = 11;

/**
 * Every surface text actually sits on, worst case first. Dark text loses
 * contrast as the surface darkens, so a token has to clear the floor on
 * ALL of these to be usable as text anywhere in the app.
 */
const SURFACES = {
  "bg-ink-100": "#f5f5f4",
  "bg-ink-50": "#fafaf9",
  "bg-white": "#ffffff",
};

/**
 * Sites where a failing token is legitimately not text: inert separators
 * ("·", "—" standing in for an empty cell) and disabled pagination, both
 * of which WCAG exempts. Each entry is file:token — narrow on purpose, so
 * a new low-contrast usage cannot hide behind a broad path prefix.
 */
const NON_TEXT_EXEMPT = new Set([
  "src/app/layout.tsx:text-ink-300",
  "src/app/journal-entries/page.tsx:text-ink-300",
  // Disabled Prev/Next on the line-level transactions list — same pattern,
  // same justification, added with that page rather than inherited by a path
  // prefix. Adding the entry is deliberately a visible edit.
  "src/app/transactions/page.tsx:text-ink-300",
  "src/app/close/tasks/page.tsx:text-ink-300",
  "src/app/close/alerts/page.tsx:text-ink-300",
  "src/app/admin/audit-log/page.tsx:text-ink-300",
]);

// --- Source walk ----------------------------------------------------------

const SRC = path.join(__dirname, "..", "src");

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(full);
    return /\.(tsx|ts|css)$/.test(e.name) ? [full] : [];
  });
}

const FILES = sourceFiles(SRC).map((f) => ({
  rel: path.relative(path.join(__dirname, ".."), f),
  text: fs.readFileSync(f, "utf8"),
}));

/**
 * Flatten the config's nested color scales to `token -> hex`.
 *
 * A `DEFAULT` step maps to the BARE name, because that is the class
 * Tailwind emits: `{ positive: { DEFAULT, 100 } }` yields `text-positive`
 * and `bg-positive-100`. Flattening it to `positive-DEFAULT` instead would
 * leave no entry named `positive`, so every `text-positive` in the app
 * would match nothing here and the contrast check would skip it in
 * silence — the exact way a derived guard rots into a guard that passes
 * because it stopped looking.
 */
function paletteFromConfig(): Record<string, string> {
  const colors = (tailwindConfig.theme?.extend?.colors ?? {}) as Record<
    string,
    string | Record<string, string>
  >;
  const flat: Record<string, string> = {};
  for (const [name, value] of Object.entries(colors)) {
    if (typeof value === "string") flat[name] = value;
    else {
      for (const [step, hex] of Object.entries(value)) {
        flat[step === "DEFAULT" ? name : `${name}-${step}`] = hex;
      }
    }
  }
  return flat;
}

describe("the ink ramp's contrast contract", () => {
  const palette = paletteFromConfig();

  it("derives the palette from the config rather than a hand-written list", () => {
    // Guards the guard: if the config shape changes and the walk silently
    // yields {}, every check below would vacuously pass.
    expect(Object.keys(palette).length).toBeGreaterThan(8);
    expect(palette["ink-500"]).toMatch(/^#[0-9a-f]{6}$/i);

    // Every name used as a bare `text-`/`bg-` class must appear under that
    // bare name. Restructuring `positive` from a string to a
    // { DEFAULT, 100 } pair broke this once: the flatten produced
    // `positive-DEFAULT`, nothing matched `text-positive`, and the contrast
    // check quietly stopped covering it. Failing here is much louder than
    // a check that passes because it found nothing to look at.
    for (const bare of ["positive", "negative", "warning"]) {
      expect(palette[bare], `${bare} must flatten to its bare name`).toMatch(
        /^#[0-9a-f]{6}$/i
      );
    }
  });

  it("keeps every text-legal token at AA on every surface it can land on", () => {
    // A token is "text-legal" if it appears as a `text-` class anywhere
    // outside the exemptions. Derived, so adding a color to the config and
    // using it brings it under this check with no edit here.
    //
    // Where the same className names its own background — `bg-ink-900 …
    // text-ink-100` on the raw-payload block — that pairing is the surface
    // and the default light set does not apply. Without this the check
    // reports light-on-light for text that is deliberately light-on-dark.
    const failures: string[] = [];
    const surfaceLookup: Record<string, string> = { ...palette, white: "#ffffff" };

    for (const { rel, text } of FILES) {
      // The unit is one string literal, not one line. A className built by a
      // ternary — `active ? "bg-ink-900 text-white" : "text-ink-700 …"` —
      // puts two mutually exclusive states on one line, and pairing the
      // background of one branch with the text of the other reports
      // dark-on-dark for a combination that can never render.
      //
      // Double quotes and backticks only — every className here uses one of
      // those. Admitting single quotes as a delimiter means an apostrophe in
      // prose ("doesn't") opens a segment that runs to the next apostrophe,
      // swallowing hundreds of lines of unrelated code into one "string".
      for (const seg of text.matchAll(/"([^"]*)"|`([^`]*)`/g)) {
        const s = seg[1] ?? seg[2] ?? "";

        // Bare classes only. A variant-prefixed utility describes a
        // different element or state: `file:bg-ink-900 file:text-white` is
        // the file-picker BUTTON, sitting in a string whose own
        // `text-ink-700` is the input's text on the page surface.
        for (const m of s.matchAll(/(?<![\w:-])text-([a-z]+(?:-\d{2,3})?)\b/g)) {
          const token = m[1];
          const hex = palette[token];
          if (!hex) continue; // not one of ours (built-in Tailwind, or text-xs)
          if (NON_TEXT_EXEMPT.has(`${rel}:text-${token}`)) continue;

          // An opacity-modified background (`bg-positive/5`) is not that
          // color — it is a 5% wash over whatever is underneath, which is
          // one of the default surfaces. Only a solid background overrides
          // the surface set; a tint falls through to it.
          const own = s.match(/(?<![\w:-])bg-([a-z]+(?:-\d{2,3})?)(?![\w/-])/);
          const surfaces = own && surfaceLookup[own[1]]
            ? { [`bg-${own[1]}`]: surfaceLookup[own[1]] }
            : SURFACES;

          for (const [surfaceName, surfaceHex] of Object.entries(surfaces)) {
            const ratio = contrast(hex, surfaceHex);
            if (ratio < AA_BODY) {
              failures.push(
                `${rel}: text-${token} (${hex}) on ${surfaceName} = ` +
                  `${ratio.toFixed(2)}:1 (needs ${AA_BODY})`
              );
            }
          }
        }
      }
    }

    // Deduplicate — one line per distinct token/surface pair, so the report
    // reads as "which combinations are illegal", not 120 copies of one.
    expect([...new Set(failures.map((f) => f.replace(/^[^:]+: /, "")))]).toEqual([]);
  });
});

describe("semantic tone tokens", () => {
  // `warning` was used as `text-warning`, `border-warning` and `bg-warning/5`
  // while being absent from the config. Tailwind emits nothing for a token it
  // does not know, so those classes were silently inert — the consolidation
  // page's warning callout rendered with no tint at all, and the only reason
  // it still looked deliberate is that <Badge tone="warning"> hardcodes
  // `bg-amber-100` and carried the tone by itself.
  //
  // The tone list is read out of Badge's own union rather than retyped here:
  // a tone added there and used as a utility comes under this check for free.
  it("resolves every Badge tone that is also used as a color utility", () => {
    const badge = fs.readFileSync(
      path.join(SRC, "components", "ui", "badge.tsx"),
      "utf8"
    );
    const union = badge.match(/type BadgeTone\s*=\s*([^;]+);/);
    expect(union, "BadgeTone union not found — the derivation broke").not.toBeNull();

    const tones = [...union![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(tones.length).toBeGreaterThan(3);

    const palette = paletteFromConfig();
    const failures: string[] = [];

    for (const tone of tones) {
      const utility = new RegExp(`\\b(?:text|bg|border|ring)-${tone}(?:/\\d+)?\\b`);
      const users = FILES.filter((f) => utility.test(f.text));
      if (users.length > 0 && !(tone in palette)) {
        failures.push(
          `"${tone}" is used as a color utility in ${users.length} file(s) ` +
            `(e.g. ${users[0].rel}) but is not a token in tailwind.config.ts — ` +
            `those classes emit no CSS`
        );
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("the type scale's floor", () => {
  it("sets no functional text below the documented minimum", () => {
    const failures: string[] = [];

    for (const { rel, text } of FILES) {
      for (const line of text.split("\n")) {
        for (const m of line.matchAll(/text-\[(\d+)px\]/g)) {
          const px = Number(m[1]);
          if (px < MIN_FUNCTIONAL_PX) {
            failures.push(`${rel}: ${px}px — ${line.trim().slice(0, 80)}`);
          }
        }
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("the UI primitives' colour vocabulary", () => {
  // Two vocabularies were live at once: semantic tokens (`positive`,
  // `negative`, `warning`) and raw Tailwind (`emerald-700`, `red-700`,
  // `amber-700`). They did not even agree — `positive` is GREEN-700 while
  // Badge rendered EMERALD-700, so a positive amount and a positive badge
  // were two different greens meaning the same thing.
  //
  // That split is also what hid the `warning` bug: the token was missing
  // from the config, but Badge hardcoded `bg-amber-100` and carried the
  // tone by itself, so the untinted callout beside it still looked
  // deliberate.
  //
  // This began scoped to `src/components/ui/`, because the app still held
  // ~215 raw tone classes across steps 50-900 while the tokens defined only
  // DEFAULT and 100 — converting them needed new scale steps and shifted
  // greens, which was a design decision rather than a sweep. That decision
  // was taken: the tones are full scales now and all 219 occurrences are
  // converted, so the check covers every source file. Widening it is the
  // point — a rule enforced only where it was already easy is a rule that
  // never catches the next drift.
  it("uses design tokens, not raw Tailwind palette colours", () => {
    const raw = /(?:text|bg|border|ring|divide)-(?:red|green|emerald|amber|yellow|cyan|blue|indigo|violet|purple|pink|orange|teal|lime|sky|rose|fuchsia)-\d{2,3}/;
    const failures: string[] = [];

    for (const { rel, text } of FILES) {

      // Drop comment lines before scanning. A comment naming the class it
      // warns against is documentation, not a usage — and this guard caught
      // its OWN explanation the first time it ran, because the comment wrote
      // the class in markdown backticks and the literal scan below reads
      // backticks as a template string. Comment-only lines are dropped
      // rather than all `//` runs, so a URL inside a real string survives.
      const code = text
        .split("\n")
        .filter((line) => !/^\s*(\/\/|\/?\*)/.test(line))
        .join("\n");

      for (const seg of code.matchAll(/"([^"]*)"|`([^`]*)`/g)) {
        const s = seg[1] ?? seg[2] ?? "";
        const hit = s.match(raw);
        if (hit) failures.push(`${rel}: ${hit[0]}`);
      }
    }

    expect(failures).toEqual([]);
  });
});

describe("generated-UI tells", () => {
  it("marks emphasis without a thick accent border down one card edge", () => {
    // The single most recognizable signature of generated UI: a 4px
    // colored strip on one side of a card. Emphasis here comes from the
    // surface tint and the heading, not a racing stripe.
    const failures: string[] = [];

    for (const { rel, text } of FILES) {
      for (const line of text.split("\n")) {
        if (/border-[lrtb]-(?:4|8)\b/.test(line) && /border-(?:positive|negative|warning|accent)/.test(line)) {
          failures.push(`${rel}: ${line.trim().slice(0, 90)}`);
        }
      }
    }

    expect(failures).toEqual([]);
  });
});
