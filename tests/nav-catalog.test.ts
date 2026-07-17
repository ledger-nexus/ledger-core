// The ⌘K palette and the sidebar share one catalog so they can't drift.
// These pure tests pin that contract: every sidebar destination is a
// palette command, admin is gated, and nothing appears twice. DB-free —
// runs in every environment.

import { describe, expect, it } from "vitest";
import {
  ADMIN_SECTION,
  NAV_SECTIONS,
  PRIMARY_ACTION,
  flattenCommands,
} from "@/components/nav/catalog";

const hrefs = (sections: typeof NAV_SECTIONS) =>
  sections.flatMap((s) => [...s.items, ...(s.more ?? [])].map((i) => i.href));

describe("flattenCommands", () => {
  it("leads with the primary action, flagged and in the Actions group", () => {
    const [first] = flattenCommands({ isAdmin: false });
    expect(first.href).toBe(PRIMARY_ACTION.href);
    expect(first.isAction).toBe(true);
    expect(first.group).toBe("Actions");
  });

  it("covers every sidebar destination — the palette can't miss a page", () => {
    const commands = new Set(flattenCommands({ isAdmin: false }).map((c) => c.href));
    for (const href of hrefs(NAV_SECTIONS)) {
      expect(commands.has(href)).toBe(true);
    }
  });

  it("gates admin destinations on isAdmin", () => {
    const asUser = new Set(flattenCommands({ isAdmin: false }).map((c) => c.href));
    const asAdmin = new Set(flattenCommands({ isAdmin: true }).map((c) => c.href));
    for (const href of hrefs([ADMIN_SECTION])) {
      expect(asUser.has(href)).toBe(false);
      expect(asAdmin.has(href)).toBe(true);
    }
  });

  it("never lists the same href twice", () => {
    const list = flattenCommands({ isAdmin: true }).map((c) => c.href);
    expect(new Set(list).size).toBe(list.length);
  });

  it("tags every command with the group it came from (palette context)", () => {
    for (const c of flattenCommands({ isAdmin: true })) {
      expect(c.group).toBeTruthy();
    }
  });
});
