// @vitest-environment jsdom

// Period close/reopen dialog — the in-app replacement for window.prompt().
//
// This is the repo's first DOM test. It exists because the reopen reason is
// SOC 2 evidence (period_reopen_log.reason + the reopen audit row) and the
// only thing standing between "operator clicked Reopen" and that row is this
// component. The bug it locks down: the reason used to be collected with
// window.prompt(), which throws "prompt() is not supported" in sandboxed and
// embedded browser contexts, so reopen was simply unusable there.
//
// DB-free by construction — the Server Actions module is mocked, so nothing
// here imports prisma and the suite runs without DATABASE_URL.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const reopenPeriodAction = vi.fn(async () => ({ ok: true as const }));
const closePeriodAction = vi.fn(async () => ({ ok: true as const }));

vi.mock("@/app/actions/period-close", () => ({
  reopenPeriodAction: (...args: unknown[]) => reopenPeriodAction(...(args as [])),
  closePeriodAction: (...args: unknown[]) => closePeriodAction(...(args as [])),
}));

import PeriodActions from "@/app/periods/period-actions";

const SCOPE = {
  entityCode: "ACME",
  bookCode: "US_GAAP",
  periodCode: "2026-05",
};

/**
 * Render the closed-period row — whose only control is Reopen — and open its
 * dialog. Renders on first call; reuses the mounted row afterwards so a test
 * can cancel and reopen to assert the draft reason was discarded.
 */
function openReopenDialog() {
  if (screen.queryAllByRole("button", { name: "Reopen" }).length === 0) {
    render(<PeriodActions {...SCOPE} isClosed />);
  }
  fireEvent.click(screen.getByRole("button", { name: "Reopen" }));
  return screen.getByRole("dialog");
}

/** Let the useTransition callback settle so "was not called" means it. */
async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  reopenPeriodAction.mockClear();
  closePeriodAction.mockClear();

  // Reproduce the sandboxed/embedded browser contract: native dialogs are not
  // merely unstyled there, they throw. Any regression back to window.prompt()
  // or window.confirm() fails the suite instead of silently shipping.
  vi.stubGlobal("prompt", () => {
    throw new Error("prompt() is not supported");
  });
  vi.stubGlobal("confirm", () => {
    throw new Error("confirm() is not supported");
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("period reopen — reason collection", () => {
  it("collects the reason in-app, never via a native dialog", () => {
    openReopenDialog();
    // The field exists in our own DOM, labelled and focused.
    const field = screen.getByLabelText("Reason (required)");
    expect(field).toBeDefined();
    expect(document.activeElement).toBe(field);
    // Consequence copy the operator could not have gotten from prompt().
    expect(screen.getByRole("dialog").textContent).toContain(
      "allows new posts"
    );
  });

  it("cancel aborts — no action fired", async () => {
    openReopenDialog();
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "Auditor found an unrecorded accrual" },
    });

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();

    expect(reopenPeriodAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Escape aborts — no action fired", async () => {
    openReopenDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    await flush();

    expect(reopenPeriodAction).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("discards the draft reason on cancel, so it cannot attach to a later reopen", async () => {
    openReopenDialog();
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "wrong period, ignore me" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();

    openReopenDialog();
    expect(
      (screen.getByLabelText("Reason (required)") as HTMLInputElement).value
    ).toBe("");
  });

  it("empty reason is refused — no action fired, dialog stays open", async () => {
    openReopenDialog();
    fireEvent.click(screen.getByRole("button", { name: "Reopen period" }));
    await flush();

    expect(reopenPeriodAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "A reason is required to reopen a period."
    );
    // Still open, so the operator can correct it rather than losing the click.
    expect(screen.queryByRole("dialog")).not.toBeNull();
  });

  it("whitespace-only reason is refused — no action fired", async () => {
    openReopenDialog();
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "   \t  \n " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen period" }));
    await flush();

    expect(reopenPeriodAction).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toBeDefined();
  });

  it("valid reason fires the action once with the trimmed string", async () => {
    openReopenDialog();
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "  Auditor found an unrecorded accrual in AP  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen period" }));
    await flush();

    expect(reopenPeriodAction).toHaveBeenCalledTimes(1);
    expect(reopenPeriodAction).toHaveBeenCalledWith({
      ...SCOPE,
      reason: "Auditor found an unrecorded accrual in AP",
    });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("Enter in the reason field submits, same trimming", async () => {
    openReopenDialog();
    const field = screen.getByLabelText("Reason (required)");
    fireEvent.change(field, { target: { value: " reclass per controller " } });
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();

    expect(reopenPeriodAction).toHaveBeenCalledWith({
      ...SCOPE,
      reason: "reclass per controller",
    });
  });

  it("surfaces a server-side refusal next to the button", async () => {
    reopenPeriodAction.mockResolvedValueOnce({
      ok: false,
      message: "Period reopen requires admin permission.",
    } as never);

    openReopenDialog();
    fireEvent.change(screen.getByLabelText("Reason (required)"), {
      target: { value: "reclass" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Reopen period" }));
    await flush();

    expect(
      screen.getByText("Period reopen requires admin permission.")
    ).toBeDefined();
  });
});

describe("period close — confirmation", () => {
  it("cancel aborts — no action fired", async () => {
    render(<PeriodActions {...SCOPE} isClosed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();

    expect(closePeriodAction).not.toHaveBeenCalled();
  });

  it("confirming fires the action with the period scope", async () => {
    render(<PeriodActions {...SCOPE} isClosed={false} />);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close period" }));
    await flush();

    expect(closePeriodAction).toHaveBeenCalledTimes(1);
    expect(closePeriodAction).toHaveBeenCalledWith(SCOPE);
  });
});
