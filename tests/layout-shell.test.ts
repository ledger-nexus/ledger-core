// The app shell's grid track must refuse to grow for its content.
//
// `grid-cols-[260px_1fr]` reads as "sidebar, then the rest", and that is
// what it does until something inside the second track is wider than the
// space available. `1fr` is shorthand for `minmax(auto, 1fr)`, and an
// `auto` minimum resolves to the track's MIN-CONTENT width — so the track
// grows past the viewport rather than constraining what is inside it, and
// the whole page picks up a horizontal scrollbar.
//
// That is what was happening. The header's right-hand control row holds
// three switchers at fixed widths (w-48 / w-56 / w-64), each wrapping a
// <select> whose min-content width is its widest <option>. Measured at
// 1024x768: the page reported scrollWidth 1223 against clientWidth 1024,
// a 199px overflow, with the dev-auth stub pushing it to 431px. At 1280
// production fitted exactly and only the dev chrome overflowed, which is
// why this survived — the developer sees a worse version of a real bug
// and reads it as dev-only noise.
//
// `minmax(0, 1fr)` sets the floor to zero, so the track takes the space
// it is given. Everything else then works as already written: `min-w-0`
// lets the switchers shrink (flex items also default to a min-content
// floor), `shrink-0` keeps the small fixed controls intact so the loss
// lands on the switchers, and `Table` already wraps every table in
// `overflow-x-auto` so a wide trial balance scrolls inside its own
// container instead of dragging the page.
//
// Verified in the browser after the change: 0 page overflow at both 1024
// and 1280, 0 elements escaping the viewport on /journal-entries, and the
// consolidated trial balance scrolling internally at 650 visible / 801
// content.
//
// This is a string check because layout is the thing being asserted and
// vitest has no layout engine — jsdom computes no box sizes, so the only
// honest guard at this level is on the declaration itself.
//
// DB-free.

import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const LAYOUT = path.join(__dirname, "..", "src", "app", "layout.tsx");

describe("the app shell grid", () => {
  const source = fs.readFileSync(LAYOUT, "utf8");

  it("gives the content track a zero minimum so it cannot be pushed wider", () => {
    const grid = source.match(/grid-cols-\[[^\]]+\]/);
    expect(grid, "no grid-cols-[...] found in layout.tsx").not.toBeNull();
    // The sidebar is a fixed track; the content track must be minmax(0,...).
    expect(grid![0]).toMatch(/minmax\(0,\s*1fr\)/);
    expect(grid![0]).not.toMatch(/_1fr\]/);
  });

  it("keeps the header's control row shrinkable", () => {
    // Without min-w-0 the row inherits a min-content floor from the
    // switchers and the zero-minimum track above buys nothing.
    expect(source).toMatch(/<div className="flex min-w-0 items-center gap-2">/);
  });
});
