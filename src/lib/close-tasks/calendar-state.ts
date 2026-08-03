// Close-calendar readiness — which of the four real states a period is in.
//
// The close-task calendar is a two-step setup: a tenant-wide CATALOG of
// CloseTaskTemplate rows is seeded once (seedCloseTaskTemplatesAction),
// then each period's checklist is INSTANTIATED from that catalog
// (instantiateCalendarForPeriod). Those are different steps against
// different tables, and conflating them is what made the dashboard tell
// a controller with 50 seeded templates to "seed templates."
//
// "This period has no CloseTask rows" is NOT evidence that the catalog
// is empty — it usually means the catalog was never instantiated for
// this period. This resolver forces the caller to supply both counts so
// the distinction can't collapse again.
//
// PERIOD_CLOSED exists because instantiateCalendarForPeriod refuses a
// period that has any PeriodClose row (instantiating a checklist against
// a frozen period is a workflow error). Without this state the dashboard
// would offer a button that can only ever return an error.

export type CloseCalendarState =
  /** Tasks exist for this period — render progress. */
  | { kind: "INSTANTIATED" }
  /** Catalog is empty. Seeding is the missing step (admin-gated). */
  | { kind: "NO_TEMPLATES" }
  /** Catalog has templates, this period has none. Instantiate. */
  | { kind: "NOT_INSTANTIATED"; templateCount: number }
  /** Period is frozen — instantiation would be refused. */
  | { kind: "PERIOD_CLOSED" };

export function resolveCloseCalendarState(input: {
  /** Active CloseTaskTemplate rows for the tenant. */
  templateCount: number;
  /** CloseTask rows for THIS period, unfiltered by category/status/owner. */
  taskCount: number;
  /**
   * True when any (entity, book) has closed this period — mirrors the
   * `PeriodClose` probe inside instantiateCalendarForPeriod, which is
   * period-wide, not scoped to the viewer's (entity, book).
   */
  periodClosed?: boolean;
}): CloseCalendarState {
  // Tasks win over everything: a closed period that WAS instantiated
  // still shows its checklist and its progress. Freezing the period
  // doesn't hide the work that was done in it.
  if (input.taskCount > 0) return { kind: "INSTANTIATED" };
  if (input.periodClosed) return { kind: "PERIOD_CLOSED" };
  if (input.templateCount === 0) return { kind: "NO_TEMPLATES" };
  return { kind: "NOT_INSTANTIATED", templateCount: input.templateCount };
}
