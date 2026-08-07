// Automations control center (Phase 0 — read-only).
//
// The "everything acting on your behalf" surface the field doesn't have:
// one page listing every standing automation, what it does, whether it
// posts unattended (AUTO) or only pre-fills (SUGGEST), and its live status.
// Nothing here toggles anything yet — that's Phase 1. See
// docs/design/automation-library.md.

import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/db";
import { getCurrentScope } from "@/lib/scope";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  AUTOMATIONS,
  resolveAutomationStatuses,
  type GovernanceLevel,
} from "@/lib/automation/registry";

const LEVEL_TONE: Record<GovernanceLevel, "warning" | "info" | "neutral"> = {
  AUTO: "warning", // posts unattended — the one to notice
  REVIEW: "info",
  SUGGEST: "neutral",
};

const LEVEL_LABEL: Record<GovernanceLevel, string> = {
  AUTO: "Posts automatically",
  REVIEW: "Acts, then holds for review",
  SUGGEST: "Suggests only",
};

export default async function AutomationsPage() {
  const scope = await getCurrentScope();
  if (!scope) return notFound();

  const statuses = await resolveAutomationStatuses(prisma, {
    tenantId: scope.tenantId,
    entityCode: scope.entityCode,
    bookCode: scope.bookCode,
  });

  const autoCount = AUTOMATIONS.filter(
    (a) => a.governanceLevel === "AUTO" && statuses[a.id]?.active
  ).length;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Automations</h2>
        <p className="text-sm text-ink-500">
          Everything acting on your behalf in {scope.entityCode} / {scope.bookCode}.{" "}
          {autoCount === 0
            ? "Nothing posts to your books without you right now."
            : `${autoCount} ${autoCount === 1 ? "automation posts" : "automations post"} to your books on their own — the rest only suggest.`}
        </p>
      </div>

      {/* Legend — teaches the one distinction that matters: what posts on
          its own vs. what waits for you. */}
      <div className="flex flex-wrap gap-4 rounded-md border border-ink-200 bg-ink-50 px-4 py-3 text-xs">
        <span className="flex items-center gap-1.5">
          <Badge tone="warning">Posts automatically</Badge>
          <span className="text-ink-600">acts on your books without review</span>
        </span>
        <span className="flex items-center gap-1.5">
          <Badge tone="neutral">Suggests only</Badge>
          <span className="text-ink-600">pre-fills a choice; you still decide</span>
        </span>
      </div>

      <div className="flex flex-col gap-3">
        {AUTOMATIONS.map((a) => {
          const status = statuses[a.id];
          return (
            <Card key={a.id}>
              <CardHeader>
                <div className="flex items-center justify-between gap-3">
                  <CardTitle>{a.name}</CardTitle>
                  <div className="flex items-center gap-2">
                    <Badge tone={LEVEL_TONE[a.governanceLevel]}>
                      {LEVEL_LABEL[a.governanceLevel]}
                    </Badge>
                    <Badge tone={status?.active ? "positive" : "neutral"}>
                      {status?.active ? "On" : "Off"}
                    </Badge>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <p className="text-sm text-ink-700">{a.description}</p>
                <p className="text-xs text-ink-500">{status?.detail}</p>
                {a.provenance && (
                  <p className="text-xs text-ink-500">{a.provenance}</p>
                )}
                {a.href && (
                  <Link
                    href={a.href}
                    className="text-xs font-medium text-accent-600 hover:underline"
                  >
                    Open →
                  </Link>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-ink-500">
        This is a read-only view. Turning automations on and off from here —
        and bundling them into presets — is coming.
      </p>
    </div>
  );
}
