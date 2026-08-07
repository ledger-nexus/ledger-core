# Design system: ledger-core

The visual contract. `docs/DESIGN.md` is the *architecture* design doc — goals,
schema decisions, alternatives considered. This file is the other kind: what the
interface is made of, and which values are legal.

It exists because the first four checks anyone would want to run on a UI are
"is this font / colour / radius / size one we decided on?", and none of them can
be answered without a written scale. Values drift toward whatever the last
person typed. Everything below is **derived from what the code actually uses**,
not from an aspiration, and the numeric parts are enforced by
`tests/design-system.test.ts`.

## What kind of surface this is

An **operate** surface: a working instrument for someone reconciling accounts on
a Tuesday afternoon, not a landing page. Scanability and density beat
expression. The interface should be legible at a glance, boring on purpose, and
completely uninteresting to look at after the fiftieth time.

Concretely, that means the things a marketing page reaches for are absent here
by intent, not by omission — no gradients, no glassmorphism or backdrop blur, no
decorative motion, no hero type, no drop shadows at rest. A warm hairline
carries every edge. If a change adds one of those, it is a change of category,
not a polish pass.

## Colour

A warm neutral ramp (stone-leaning). Pure `#000` on `#fff` is deliberately
unreachable: `ink-50` is a warm off-white and `ink-900` a warm near-black.

### The text contract

**`ink-500` and darker may carry text. `ink-400` and lighter may not.**

This is the load-bearing rule, and it was being broken 120 times. The ramp was
introduced as a token swap over an older slate scale, keeping the step names so
no className had to change — and nobody recomputed the contrast ratios
afterwards. `ink-400` sits at **2.41:1** on the page, a WCAG AA failure by
nearly a factor of two, and it was carrying real content: flux rationales, audit
timestamps, aging-bucket labels, "(you)".

| Token | Hex | on `ink-50` | on `ink-100` | on white | Text? |
|---|---|---:|---:|---:|---|
| `ink-300` | `#d6d3d1` | 1.43 | 1.37 | 1.49 | no |
| `ink-400` | `#a8a29e` | 2.41 | 2.31 | 2.52 | no |
| `ink-500` | `#726b66` | 5.01 | 4.80 | 5.24 | yes — muted |
| `ink-600` | `#57534e` | 7.30 | 6.99 | 7.63 | yes |
| `ink-700` | `#44403c` | 9.84 | 9.42 | 10.27 | yes |
| `ink-900` | `#1c1917` | 16.74 | 16.03 | 17.49 | yes — primary |

`ink-500` was `#78716c`, which cleared AA on the page (4.59:1) but not on
`bg-ink-100` panels (4.40:1) — and it is the *muted text* step, so it lands on
both. Two notches darker along the same warm axis buys 4.80:1 at no perceptible
cost.

`ink-400` and lighter remain in the palette for what they are good at: borders,
icons, disabled controls, and inert separators (the `·` between metadata, the
`—` standing in for an empty cell). Those are exempt from the contrast rule and
listed explicitly in the test, per-file, so a new low-contrast *content* use
cannot hide behind a broad path prefix.

### Accent and tones

| Token | Hex | on `ink-50` | Use |
|---|---|---:|---|
| `accent-500` | `#0891b2` | 3.53 | surfaces and borders only — fails as text |
| `accent-600` | `#0e7490` | 5.13 | the text-legal accent |
| `positive` | `#15803d` | 4.80 | debit-side balances, gains |
| `negative` | `#b91c1c` | 6.19 | credit-side, losses on disposal |
| `warning` | `#b45309` | 4.81 | caution callouts |

`warning` was **missing from the config entirely** while `text-warning`,
`border-warning` and `bg-warning/5` were all in use. Tailwind emits no CSS for a
token it does not know, so those classes were inert: the consolidation page's
"FX translation not active" callout rendered with no tint and a fallback border,
directly beneath an identically-built positive callout that *was* tinted green.
It looked intentional because `<Badge tone="warning">` hardcodes `bg-amber-100`
and was carrying the tone by itself.

### Known drift

`Badge` maps its tones to raw Tailwind (`bg-emerald-100 text-emerald-700`)
rather than to these semantic tokens, so two colour vocabularies are live at
once — `positive` (#15803d, emerald-700) and `emerald-700` are the same colour
reached two ways. Unifying them is a real cleanup and is **not** done here; it
touches every badge and status pill in the app.

## Type

One family for the interface (system sans), a display face for headings only,
and mono for money — `.amount-cell` adds `tabular-nums`, because column
alignment is the whole point when scanning figures.

| Step | px | Use |
|---|---:|---|
| `text-[11px]` | 11 | micro-labels, table eyebrows, badge counts |
| `text-xs` | 12 | dense table cells, secondary text, **validation errors** |
| `text-sm` | 14 | body |
| `text-base` | 16 | emphasis in prose |
| `text-lg` – `text-3xl` | 18–30 | page and section headings |

**11px is the floor for functional text**, enforced by test. Tailwind's scale
steps 12 → 14, so anything below is an arbitrary value, and 45 of them had
settled at 10px — including six validation errors. The one string on the page a
user most needs to read was set smaller than everything around it. Those six now
sit at `text-xs`; a message that reports a failure should not be the quietest
thing on screen.

Headings default to `-0.02em` tracking and `text-wrap: balance` via element
selectors in `globals.css`, so a utility on any specific heading still wins.

## Shape

`rounded-md` (6px) is the working default at 142 uses, with `rounded` (4px) and
`rounded-full` for pills and dots.

`card.tsx` documents a different language in a comment — "cards at 12px
(`rounded-xl`); inputs/badges at 8px; modals at 16px" — which only about twelve
elements in the app actually follow. **The comment is the aspiration; 6px is the
practice.** Recorded here as drift rather than silently resolved either way,
because picking one is a design call.

Nothing rounds past 16px. Over-rounding cards and inputs collapses everything
into the same soft blob and reads as decoration in a tool where the shape should
be carrying grouping.

## Motion

Two named easings, no CSS keyword easings on interactive elements:

- `snap` — `cubic-bezier(0.22, 1, 0.36, 1)`, hover and press
- `out` — `cubic-bezier(0.16, 1, 0.3, 1)`, enter and exit

`globals.css` gives every `a`, `button`, `select`, `summary` and `[role=button]`
a uniform transition on background, border, colour and shadow — scoped to
`prefers-reduced-motion: no-preference`, so reduced-motion environments get
instant state changes rather than a slower version of the same animation.

Motion conveys state. It does not decorate. No pulsing status dots, no
marquees, no bounce or elastic easing, and nothing animates `width`, `height`,
`padding` or `margin` — those thrash layout.

## Emphasis

Emphasis comes from surface tint, weight, and the semantic `Badge`. **Not from a
thick accent border down one edge of a card** — that was in the consolidation
callouts and is now caught by test. A 4px coloured strip beside a badge that
already names the tone is a second, louder voice saying the same thing.

## What the tests enforce

`tests/design-system.test.ts`, DB-free:

1. **Contrast** — every palette token used as a `text-` class clears 4.5:1
   against every surface it can land on. The palette is read out of
   `tailwind.config.ts` rather than restated, so a colour added there and used
   comes under the check with no edit to the test.
2. **Type floor** — no `text-[Npx]` below 11px.
3. **Tone resolution** — every tone in `Badge`'s own `BadgeTone` union that is
   also used as a colour utility exists in the config. Read from the union, so
   a new tone is covered for free.
4. **No side-tab accent borders.**

The pairing logic is narrower than it first looks, and deliberately so. It reads
one *string literal* at a time rather than one line, because a ternary
(`active ? "bg-ink-900 text-white" : "text-ink-700 …"`) puts two mutually
exclusive states on one line and pairing across them reports dark-on-dark for a
combination that can never render. It ignores variant-prefixed classes, because
`file:bg-ink-900 file:text-white` describes the file-picker button, not the
input it sits on. And it treats `bg-positive/5` as a tint over the default
surface rather than as solid `positive`, which it plainly is not.
