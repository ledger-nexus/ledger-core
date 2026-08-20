// The reports catalog — a front door for twelve reports that had none.
//
// Until now you either knew the URL or hunted the sidebar. This is the shell
// Campfire puts over the same problem (docs/design/campfire-product-surface.md
// §9): category tabs, cards with a one-line description, and a provenance badge
// separating what ships from what a customer built.
//
// The category tab is a URL parameter like every other filter on the site
// (src/lib/url-state.ts), so a link to "the tax reports" is a link.

import Link from "next/link";

import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { buildUrl, defaultsOf, oneOf, parseUrlState, type RawParams, type SurfaceSpec } from "@/lib/url-state";
import {
  REPORTS,
  populatedCategories,
  reportsByCategory,
  type ReportEntry,
} from "@/lib/surfaces/reports-catalog";

const TABS = ["all", ...populatedCategories().map((c) => c.toLowerCase()), "custom"] as const;

const SPEC = {
  // No chip: a tab is navigation, not a filter someone forgot they applied.
  category: oneOf(TABS, "all", { chip: () => null }),
} satisfies SurfaceSpec;

export default async function ReportsCatalogPage({
  searchParams,
}: {
  searchParams: RawParams;
}) {
  const scope = await getCurrentScope();
  const { category } = parseUrlState(SPEC, searchParams);

  // Custom reports are the tenant's own saved definitions. Tenant-pinned in
  // the query, not merely on the column.
  const custom = scope
    ? await prisma.reportTemplate.findMany({
        where: { tenantId: scope.tenantId },
        select: { id: true, code: true, name: true, createdBy: true },
        orderBy: { name: "asc" },
      })
    : [];

  const showCategory = (c: string) => category === "all" || category === c.toLowerCase();
  const showCustom = category === "all" || category === "custom";
  const visibleBuiltIns = category === "custom" ? [] : REPORTS.filter((r) => showCategory(r.category));

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Reports</h2>
        <p className="text-sm text-ink-500">
          {REPORTS.length} built-in report{REPORTS.length === 1 ? "" : "s"}
          {custom.length > 0 && ` · ${custom.length} custom`}
        </p>
      </div>

      {/* Tabs. Server-rendered links, so each is a real URL. */}
      <nav aria-label="Report categories" className="flex flex-wrap gap-1 border-b border-ink-200">
        {(["all", ...populatedCategories().map((c) => c.toLowerCase()), "custom"] as const).map(
          (tab) => {
            const active = category === tab;
            return (
              <Link
                key={tab}
                href={buildUrl("/reports", SPEC, { ...defaultsOf(SPEC), category: tab })}
                aria-current={active ? "page" : undefined}
                className={[
                  "-mb-px border-b-2 px-3 py-2 text-sm capitalize transition-colors duration-150 ease-snap",
                  active
                    ? "border-ink-900 font-medium text-ink-900"
                    : "border-transparent text-ink-500 hover:text-ink-900",
                ].join(" ")}
              >
                {tab === "all" ? "All reports" : tab}
              </Link>
            );
          }
        )}
      </nav>

      {category === "all" ? (
        // Grouped by category, which is how someone browsing rather than
        // searching actually reads it.
        populatedCategories().map((c) => (
          <section key={c} className="flex flex-col gap-3">
            <h3 className="text-sm font-medium uppercase tracking-wide text-ink-500">{c}</h3>
            <CardGrid reports={reportsByCategory(c)} />
          </section>
        ))
      ) : visibleBuiltIns.length > 0 ? (
        <CardGrid reports={visibleBuiltIns} />
      ) : null}

      {showCustom && (
        <section className="flex flex-col gap-3">
          <h3 className="text-sm font-medium uppercase tracking-wide text-ink-500">Custom</h3>
          {custom.length === 0 ? (
            <EmptyState
              title="No custom reports yet"
              description="Compose one in the report builder and it appears here for the whole tenant."
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {custom.map((t) => (
                <Card key={t.id}>
                  <CardContent className="flex flex-col gap-2 p-4">
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/reports/builder/${t.code}`}
                        className="font-medium text-ink-900 hover:underline"
                      >
                        {t.name}
                      </Link>
                      {/* Provenance: the badge separates what ships from what
                          a customer built, which is the distinction a reviewer
                          asks about first. */}
                      <Badge tone="neutral">Custom</Badge>
                    </div>
                    <p className="text-sm text-ink-500">
                      <span className="font-mono text-xs">{t.code}</span>
                      {t.createdBy && ` · created by ${t.createdBy}`}
                    </p>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function CardGrid({ reports }: { reports: ReportEntry[] }) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {reports.map((r) => (
        <Card key={r.slug}>
          <CardContent className="flex h-full flex-col gap-2 p-4">
            <div className="flex items-start justify-between gap-2">
              <Link
                href={`/reports/${r.slug}`}
                className="font-medium text-ink-900 hover:underline"
              >
                {r.title}
              </Link>
              <Badge tone="neutral">Built-in</Badge>
            </div>
            {/* Card heights vary with description length rather than being
                padded to a uniform box — a fixed height would either clip the
                longer sentences or leave the short ones floating. */}
            <p className="text-sm text-ink-500">{r.description}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
