// Provenance badge — the Trust-Label lesson from the incumbent study
// (docs/design/competitive-landscape-xero-sage.md): trust disclosure
// belongs ON the row it describes, not only in the /automations control
// center. Sage ships this as an in-product "AI Trust Label"; JAX shows
// "full visibility" markers on auto-reconciled lines. Law of Proximity:
// the who-posted-this signal sits beside the posting itself.
//
// Wording is the user's language, not the enum's (Mental Model): a CPA
// reads "posted automatically", not "SYSTEM".

import { Badge } from "@/components/ui/badge";

const SOURCE_DISPLAY: Record<
  string,
  { label: string; tone: "neutral" | "positive" | "negative" | "warning" | "info"; title: string }
> = {
  MANUAL: {
    label: "manual",
    tone: "neutral",
    title: "Entered by hand.",
  },
  SYSTEM: {
    label: "posted automatically",
    tone: "warning",
    title:
      "Posted by an automation you configured (e.g. a recurring template). Governed on the Automations page.",
  },
  AI_APPROVED: {
    label: "AI · you approved",
    tone: "info",
    title: "AI suggested this entry; a human approved it before it posted.",
  },
  IMPORT: {
    label: "imported",
    tone: "neutral",
    title: "Imported from a source system; original payload preserved.",
  },
  SEED: {
    label: "seed",
    tone: "neutral",
    title: "Demo / seed data.",
  },
};

export function SourceBadge({ source }: { source: string }) {
  const d = SOURCE_DISPLAY[source] ?? {
    label: source.toLowerCase(),
    tone: "neutral" as const,
    title: source,
  };
  return (
    <span title={d.title}>
      <Badge tone={d.tone}>{d.label}</Badge>
    </span>
  );
}
