// @vitest-environment jsdom

// The new-recurring-entry form in ALLOCATION mode.
//
// The bug this locks down: the submit button gated on `totals.balanced`,
// which requires debits == credits AND debits > 0. Allocation lines carry
// PERCENTS and no amounts, so those totals are structurally zero and the
// button was disabled forever — the allocation feature shipped complete on
// the engine side and unreachable from the UI. No engine test could see it;
// they all call the action directly.
//
// It is the same failure the repo's first DOM test was written for: a
// component standing between the operator and a working feature, with
// nothing else asserting it.
//
// DB-free by construction — the Server Actions module is mocked, so nothing
// here imports prisma and the suite runs without DATABASE_URL.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const createRecurringEntryAction = vi.fn(async () => ({ ok: true as const, id: "new-id" }));

vi.mock("@/app/actions/recurring-entries", () => ({
  createRecurringEntryAction: (...args: unknown[]) =>
    createRecurringEntryAction(...(args as [])),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

import NewRecurringForm from "@/app/recurring-entries/new/new-recurring-form";

const ACCOUNTS = [
  { code: "6000", name: "Overhead pool", type: "EXPENSE" },
  { code: "7000", name: "Dept 1", type: "EXPENSE" },
  { code: "8000", name: "Dept 2", type: "EXPENSE" },
];

function renderForm() {
  render(
    <NewRecurringForm
      accounts={ACCOUNTS}
      books={[{ code: "US_GAAP", name: "US GAAP" }]}
      entities={[{ code: "NORTHWIND", name: "Northwind Cloud, Inc." }]}
      defaultEntityCode="NORTHWIND"
      defaultBookCode="US_GAAP"
    />
  );
}

const submitButton = () =>
  screen.getByRole("button", { name: /Create template/ }) as HTMLButtonElement;

/** Switch to ALLOCATION and fill a valid 60/40 split off account 6000. */
function fillValidAllocation() {
  fireEvent.change(screen.getByLabelText(/Template kind/i), {
    target: { value: "ALLOCATION" },
  });
  fireEvent.change(screen.getByLabelText(/Source account/i), {
    target: { value: "6000" },
  });
  const selects = screen.getByRole("table").querySelectorAll("select");
  const percents = screen.getByRole("table").querySelectorAll('input[type="number"]');
  fireEvent.change(selects[0], { target: { value: "7000" } });
  fireEvent.change(percents[0], { target: { value: "60" } });
  fireEvent.change(selects[1], { target: { value: "8000" } });
  fireEvent.change(percents[1], { target: { value: "40" } });
}

afterEach(() => {
  cleanup();
  createRecurringEntryAction.mockClear();
});

describe("new recurring template — ALLOCATION mode", () => {
  it("is submittable once the targets total 100%", () => {
    renderForm();
    fillValidAllocation();
    // The regression: this was permanently disabled, because allocation
    // lines have no debit/credit amounts to balance.
    expect(submitButton().disabled).toBe(false);
  });

  it("stays disabled while the percents do not total 100", () => {
    renderForm();
    fillValidAllocation();
    const percents = screen.getByRole("table").querySelectorAll('input[type="number"]');
    fireEvent.change(percents[1], { target: { value: "30" } });
    expect(submitButton().disabled).toBe(true);
    expect(screen.getByText(/Must total 100%/)).toBeTruthy();
  });

  it("stays disabled until a source account is chosen", () => {
    renderForm();
    fillValidAllocation();
    fireEvent.change(screen.getByLabelText(/Source account/i), { target: { value: "" } });
    expect(submitButton().disabled).toBe(true);
  });

  it("reports allocation progress in percent, not debits and credits", () => {
    renderForm();
    fillValidAllocation();
    expect(screen.getByText(/Allocated/)).toBeTruthy();
    expect(screen.getByText(/100.00%/)).toBeTruthy();
    expect(screen.getByText(/Fully allocated/)).toBeTruthy();
    expect(screen.queryByText(/Debits/)).toBeNull();
    // One "+ Target line" control, not the debit/credit pair.
    expect(screen.getByRole("button", { name: /\+ Target line/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /\+ Debit line/ })).toBeNull();
  });

  it("sends percents and the source account to the action, with no amounts", async () => {
    renderForm();
    fireEvent.change(screen.getByLabelText(/^Code/i), { target: { value: "OVERHEAD" } });
    fireEvent.change(screen.getByLabelText(/Memo/i), { target: { value: "Monthly overhead" } });
    fillValidAllocation();
    fireEvent.click(submitButton());
    await vi.waitFor(() => expect(createRecurringEntryAction).toHaveBeenCalled());

    const payload = createRecurringEntryAction.mock.calls[0][0] as {
      kind: string;
      allocationSourceAccountCode: string;
      lines: Array<Record<string, unknown>>;
    };
    expect(payload.kind).toBe("ALLOCATION");
    expect(payload.allocationSourceAccountCode).toBe("6000");
    expect(payload.lines).toEqual([
      { accountCode: "7000", allocationPercent: "60", description: undefined },
      { accountCode: "8000", allocationPercent: "40", description: undefined },
    ]);
  });

  it("STANDARD mode still gates on balanced debits and credits", () => {
    renderForm();
    const selects = screen.getByRole("table").querySelectorAll("select");
    const amounts = screen.getByRole("table").querySelectorAll('input[type="number"]');
    // Account selects in STANDARD rows are the side/account pair, so index
    // by the account select specifically.
    const accountSelects = [...selects].filter((s) =>
      [...s.options].some((o) => o.value === "6000")
    );
    fireEvent.change(accountSelects[0], { target: { value: "6000" } });
    fireEvent.change(amounts[0], { target: { value: "100" } });
    fireEvent.change(accountSelects[1], { target: { value: "7000" } });
    expect(submitButton().disabled).toBe(true); // credit side still empty
    fireEvent.change(amounts[1], { target: { value: "100" } });
    expect(submitButton().disabled).toBe(false);
  });
});
