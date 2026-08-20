// Dimensions — the Layer 3 tagging engine, made visible.
//
// Campfire calls these Tag Groups (Region / Project / Location) and gives them
// a settings page; five of the eleven columns on their contracts list are
// dimensions (docs/design/campfire-product-surface.md §10.1). We have had the
// engine — Dimension, DimensionValue, DimensionSet with its stable hash — since
// v0.2, filled by the NetSuite importer and reachable from no screen at all.
//
// ⚠️ THE UI IS DELIBERATELY NARROWER THAN THE MODEL. `Dimension.isRequired` and
// `Dimension.appliesToAccountTypes` are not editable here, because nothing
// enforces them: `postJournalEntry` has zero dimension references, and the NS
// importer attaches `dimensionSetId` to line rows AFTER the entry is written.
// There is no point in the canonical write path where "this dimension is
// required" could be checked, so a Required toggle would be a control that does
// nothing. The banner below says so on the page rather than only in a comment.

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Input, Label } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import {
  createDimensionFormAction,
  createDimensionValueFormAction,
} from "@/app/actions/dimensions";

export default async function DimensionsPage() {
  const scope = await getCurrentScope();
  if (!scope) {
    return (
      <EmptyState
        title="No scope available"
        description="Sign in and select a tenant to manage dimensions."
      />
    );
  }

  const dimensions = await prisma.dimension.findMany({
    where: { tenantId: scope.tenantId },
    select: {
      id: true,
      code: true,
      name: true,
      description: true,
      isRequired: true,
      createdAt: true,
      values: { select: { id: true, code: true, name: true }, orderBy: { code: "asc" } },
      _count: { select: { bridges: true } },
    },
    orderBy: { code: "asc" },
  });

  const anyMarkedRequired = dimensions.some((d) => d.isRequired);

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Dimensions</h2>
        <p className="text-sm text-ink-500">
          Tag groups applied to journal lines — department, class, location, project.{" "}
          {dimensions.length} group{dimensions.length === 1 ? "" : "s"}.
        </p>
      </div>

      {/* An honest note, on the page, not just in the source. A reader who can
          see `isRequired` in an export and not on this screen deserves to know
          why rather than assume the screen is incomplete. */}
      <Card>
        <CardContent className="p-4">
          <p className="text-sm text-ink-700">
            <Badge tone="warning">Not enforced</Badge>{" "}
            <span className="ml-1">
              Dimensions are recorded on journal lines but are <strong>not required</strong> by
              posting. <code className="font-mono text-xs">postJournalEntry</code> takes no
              dimension input — the NetSuite importer attaches them after an entry is written — so
              a &ldquo;required dimension&rdquo; rule has nowhere to run. The{" "}
              <code className="font-mono text-xs">isRequired</code> column exists and is read by
              nothing.
              {anyMarkedRequired && (
                <>
                  {" "}
                  <strong>
                    Some groups below are flagged required; that flag currently has no effect.
                  </strong>
                </>
              )}
            </span>
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Groups</CardTitle>
        </CardHeader>
        <CardContent>
          {dimensions.length === 0 ? (
            <EmptyState
              title="No dimensions yet"
              description="Create one below, or import from NetSuite — the mapper creates them from class, department, location and custom segments."
            />
          ) : (
            <Table>
              <THead>
                <TR>
                  <TH>Code</TH>
                  <TH>Name</TH>
                  <TH>Values</TH>
                  <TH>Used on</TH>
                  <TH>Created</TH>
                </TR>
              </THead>
              <TBody>
                {dimensions.map((d) => (
                  <TR key={d.id}>
                    <TD className="font-mono text-xs">{d.code}</TD>
                    <TD>
                      {d.name}
                      {d.description && (
                        <span className="ml-2 text-xs text-ink-500">{d.description}</span>
                      )}
                      {d.isRequired && (
                        <Badge tone="warning" className="ml-2">
                          required (inert)
                        </Badge>
                      )}
                    </TD>
                    <TD>
                      {d.values.length === 0 ? (
                        <span className="text-ink-500">—</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          {d.values.map((v) => (
                            <span
                              key={v.id}
                              className="rounded border border-ink-200 px-1.5 py-0.5 text-xs"
                              title={v.name}
                            >
                              <span className="font-mono">{v.code}</span>{" "}
                              <span className="text-ink-500">{v.name}</span>
                            </span>
                          ))}
                        </span>
                      )}
                    </TD>
                    {/* How many dimension SETS reference this group — i.e.
                        whether it is actually in use on posted lines, which is
                        the question before anyone renames or removes one. */}
                    <TD className="text-ink-700">{d._count.bridges} set(s)</TD>
                    <TD className="whitespace-nowrap text-ink-500">{formatDate(d.createdAt)}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>New group</CardTitle>
          </CardHeader>
          <CardContent>
            <form action={createDimensionFormAction} className="flex flex-col gap-3">
              <div>
                <Label htmlFor="d-code">Code</Label>
                <Input
                  id="d-code"
                  name="code"
                  placeholder="DEPARTMENT"
                  required
                  maxLength={30}
                  // The code keys the DimensionSet hash, so it is an
                  // identifier rather than free text.
                  pattern="[A-Za-z][A-Za-z0-9_]*"
                  title="Letters, digits and underscores; starts with a letter"
                />
              </div>
              <div>
                <Label htmlFor="d-name">Name</Label>
                <Input id="d-name" name="name" placeholder="Department" required maxLength={60} />
              </div>
              <div>
                <Label htmlFor="d-desc">Description</Label>
                <Input id="d-desc" name="description" maxLength={200} />
              </div>
              <button
                type="submit"
                className="self-start rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
              >
                Create group
              </button>
            </form>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>New value</CardTitle>
          </CardHeader>
          <CardContent>
            {dimensions.length === 0 ? (
              <p className="text-sm text-ink-500">Create a group first.</p>
            ) : (
              <form action={createDimensionValueFormAction} className="flex flex-col gap-3">
                <div>
                  <Label htmlFor="v-dim">Group</Label>
                  <select
                    id="v-dim"
                    name="dimensionId"
                    required
                    className="w-full rounded-md border border-ink-200 px-3 py-2 text-sm focus:border-accent-500 focus:outline-none focus:ring-2 focus:ring-accent-500/15"
                  >
                    {dimensions.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.code} — {d.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <Label htmlFor="v-code">Code</Label>
                  <Input id="v-code" name="code" placeholder="20" required maxLength={30} />
                </div>
                <div>
                  <Label htmlFor="v-name">Name</Label>
                  <Input
                    id="v-name"
                    name="name"
                    placeholder="Engineering"
                    required
                    maxLength={60}
                  />
                </div>
                <button
                  type="submit"
                  className="self-start rounded-md border border-ink-200 px-3 py-1.5 text-sm hover:bg-ink-50"
                >
                  Add value
                </button>
              </form>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
