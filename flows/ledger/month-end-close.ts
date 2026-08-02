/**
 * ledger-core hero tour — "Run the month-end close".
 *
 * The wedge narrative: close automation + controls. Five frames walking
 * the close pillars against the seeded Northwind demo tenant — dashboard
 * → close dashboard → task calendar → reconciliations → the month-end
 * review packet.
 *
 * LOCAL-ONLY capture. Run from a tourkit checkout:
 *
 *   1. ledger-core dev server on :3016 with HIDE_DEV_CHROME=1 in .env
 *      (frames are published assets; the DEV AUTH STUB card must not
 *      appear in them)
 *   2. CAPTURE_USER_ID=<Carla Controller's uuid> (see local-auth.ts)
 *   3. pnpm tourkit capture <abs path to this file>
 *   4. OCR-scan every frame before committing (tesseract; grep for
 *      real names) — the frames land in public/tours/month-end-close/
 *
 * Flux and balance assertions are deliberately NOT in this tour: the
 * seed has no rows for them yet, and an empty screen sells nothing.
 * Add those beats when the demo seed grows them.
 *
 * Tooltip rule (learned on RevRec): each frame is shot BEFORE its
 * click, so every tooltip describes what is ON SCREEN plus the action —
 * never the destination.
 */
import { defineFlow } from "../../../tourkit/src/capture/index.js";
import { APP, mintStorageState } from "./local-auth.js";

export default (async () =>
  defineFlow({
    id: "month-end-close",
    title: "Run the month-end close",
    start: `${APP}/`,
    storageState: await mintStorageState(),
    viewport: { width: 1440, height: 900 },
    frameFormat: "webp",
    // Written straight into the app's public assets; the tour is served
    // from /tours/month-end-close/ by the /how-it-works page.
    outDir: "/Users/hosungson/Code/ledger-core-je-approvals/public/tours/month-end-close",
    theme: { accent: "#0891b2" },
    cta: { label: "Explore the code", href: "https://github.com/ledger-nexus/ledger-core" },
    steps: [
      // 1 — the daily view, and where the close lives.
      {
        click: 'aside a[href="/close"]',
        tooltip:
          "The dashboard is the day-to-day view — balances, cash, what needs attention. The close has its own home. Open the **Close dashboard**.",
        zoom: 1.25,
      },
      { waitFor: 'h1:has-text("Close dashboard")' },

      // 2 — every pillar on one screen.
      {
        click: 'aside a[href="/close/tasks"]',
        tooltip:
          "Every pillar of this month's close on one screen — tasks, reconciliations, alerts — with the stragglers surfaced. Start where a close starts: **Close tasks**.",
      },
      { waitFor: 'h1:has-text("Close tasks")' },

      // 3 — the task calendar.
      {
        click: 'aside a[href="/close/reconciliations"]',
        tooltip:
          "A dependency-ordered checklist, not a spreadsheet: each task knows what it blocks, and state changes are append-only history. Next, tie the balances out — **Reconciliations**.",
      },
      { waitFor: 'h1:has-text("Reconciliations")' },

      // 4 — reconciliation sign-off.
      {
        click: 'aside a[href="/reports/month-end"]',
        tooltip:
          "Every account ties to something outside the ledger — sub-ledger pulls, sign-offs, attachments, a state machine to signed-off. When the pillars are green, assemble the packet: **Month-end review**.",
      },
      { waitFor: 'h1:has-text("Month-end review")' },

      // 5 — the deliverable.
      {
        click: 'a:has-text("Download PDF")',
        tooltip:
          "The whole month in one packet — statements, comparisons, the trail your reviewer actually reads. **One click, out the door.**",
        zoom: 1.25,
      },
    ],
  }))();
