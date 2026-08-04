# Runbook — capturing a product tour

Tours on `/how-it-works` are [tourkit](https://github.com/chrissoncpa/tourkit)
captures: screenshots of the running app with click hotspots, played by
the vendored zero-dependency `<tour-player>` web component.

**Frames are published marketing assets in a public repo.** Everything
below exists to keep that true.

## Rules

1. **Seeded synthetic data only.** Never capture a real tenant.
2. **`HIDE_DEV_CHROME=1` before the dev server starts.** It hides the
   dev auth-stub card. Without it, every frame carries a box labeled
   DEV AUTH STUB — the ledger-core twin of the dev badge that forced a
   full recapture of 15 published RevRec frames.
3. **OCR-scan every frame before committing** (below). The Northwind
   seed contains a real firm name (`Devon Auditor (Deloitte)`) and 300+
   fixture users; any of them can surface in a switcher or table.
4. **Each frame is shot BEFORE its click.** Tooltips describe what is
   on screen plus the action — never the destination.
5. **Never wait on a nav link to prove navigation.** The sidebar is
   persistent, so the link exists before and after; frames race
   client-side routing and silently re-shoot the previous page. Wait on
   page-unique content: `h1:has-text("Reconciliations")`.

## Prerequisites

- A tourkit checkout as a sibling of this repo, built (`pnpm build`).
- `tesseract` for the OCR pass: `brew install tesseract`.
- The capture persona's user id. The flow can't reach Prisma, so resolve
  it first:

```bash
npx tsx -e 'import { prisma } from "@/lib/db"; prisma.user.findFirst({ where: { email: "controller@northwind.test" } }).then(u => { console.log(u.id); return prisma.$disconnect(); })'
```

## Capture

Start the dev server with the capture flag set in `.env`:

```bash
HIDE_DEV_CHROME=1 npm run dev -- --port 3016
```

Then, from the tourkit checkout:

```bash
APP_URL=http://localhost:3016 CAPTURE_USER_ID=<uuid> pnpm tourkit capture /abs/path/to/ledger-core/flows/ledger/month-end-close.ts
```

Frames and `tour.json` land in `public/tours/<id>/`.

> `HIDE_DEV_CHROME=1` also hides the user switcher, which is the only
> way to sign in during local dev. Set it for the capture run and remove
> it afterward, or set the `lc-user` cookie by hand (the flow does this
> itself via `flows/ledger/local-auth.ts`).

## Scan before committing

Two passes. **Run both** — the first one cannot catch what the second does.

**1. Name leaks.** The repo is public and the Northwind seed contains a
real firm name.

```bash
for f in public/tours/*/steps/*.webp; do tesseract "$f" - --psm 6 2>/dev/null | grep -inE "deloitte|@.*\.test|DEV AUTH|STUB" && echo "  ^^ in $f"; done
```

**2. Empty states.** A frame can be perfectly clean and still show an
empty product.

```bash
for f in public/tours/*/steps/*.webp; do tesseract "$f" - --psm 6 2>/dev/null | grep -inE "no journal entries|not seeded yet|nothing to show|Post your first" && echo "  ^^ EMPTY in $f"; done
```

**Then open every frame and look at it.** Both greps are heuristics; the
eye is the actual gate.

This is not hypothetical. A reshoot shipped with an empty frame 1 —
"No journal entries in this scope yet" — because the shared dev database
had been wiped by a concurrent test run between the first capture and the
second. The name-leak scan passed (nothing leaked), only frames 3 and 4
were eyeballed (the ones expected to change), and the regression reached
`main`. **Verifying the frames you expected to change is not verifying
the frames.**

## The dev database is shared and gets wiped

`npm test` clears the ledger by design (see CLAUDE.md → Testing). Any
concurrent session running the suite will empty Northwind mid-session.

So, immediately before capturing:

```bash
npm run db:seed
```

and confirm the entity actually has data — the tour's first frame is the
dashboard, which is the fastest place to spot an empty book:

```bash
npx tsx -e 'import { prisma } from "@/lib/db"; prisma.journalEntry.count().then(n => { console.log("JEs:", n); return prisma.$disconnect(); })'
```

Re-seeding resets the ledger but leaves close tasks intact, so an
instantiated close calendar survives.

Do not crop or edit frames by hand; the hotspot coordinates in
`tour.json` are normalized against the captured image.

## Publishing

`/how-it-works` ships **dark**: `robots: { index: false, follow: false }`
in the page metadata, and no entry in `src/components/nav/catalog.ts`.
The flip, after frame review, is exactly two edits — drop the `robots`
block, add a catalog row.

The route is in `PUBLIC_PATH_PATTERNS` (and the Clerk-mode twin) in
`src/middleware.ts` so it survives the fail-closed 503 that guards every
other route when Clerk is configured. Keep those two lists in lockstep.
