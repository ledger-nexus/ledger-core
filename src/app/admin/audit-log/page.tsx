// Audit-trail explorer.
//
// Surfaces rows from the audit_log table so admins can perform the
// quarterly access reviews SOC 2 CC4 expects. Also useful for incident
// triage ("what did the system do at 3am?") and customer-facing audit
// inquiries.
//
// Permissions: admin-only via requireAdmin (currently the email
// allowlist; retires when per-tenant RBAC lands).
//
// Tenant scope: only the current tenant's rows are visible. Audit
// events with NULL tenantId (e.g. pre-identity TOKEN_REJECTED for
// garbage Bearer tokens) are surfaced under a "Platform events"
// filter — visible only to the default-tenant owner.
//
// URL-driven filters so refresh + browser back/forward work naturally:
//   ?event=PRIVILEGED_ACTION  → only that event type
//   ?from=2026-05-01&to=2026-05-31  → date range (defaults to last 7 days)
//   ?actor=carla@example.com  → substring match on actorEmail
//   ?outcome=FAILURE  → SUCCESS | FAILURE | ANOMALOUS
//   ?cursor=<id>  → pagination
//
// We keep the page Server Component + URL params so we can render the
// filter form as a plain <form method="get">. No client JS required.

// React import is explicit so vitest's classic JSX runtime resolves
// React.createElement (Next.js production build uses the automatic
// runtime; tests don't).
import * as React from "react";
import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  getCurrentUser,
  isAdmin,
  NotAuthenticatedError,
  NotAuthorizedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, THead, TBody, TR, TH, TD } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Label, Select, Input } from "@/components/ui/input";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import type { AuditEventType, AuditOutcome, Prisma } from "@prisma/client";

const PAGE_SIZE = 50;

const EVENT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All event types" },
  { value: "LOGIN_SUCCESS", label: "Login success" },
  { value: "LOGIN_FAILURE", label: "Login failure" },
  { value: "LOGOUT", label: "Logout" },
  { value: "ACCESS_DENIED", label: "Access denied" },
  { value: "PRIVILEGED_ACTION", label: "Privileged action" },
  { value: "DATA_EXPORT", label: "Data export" },
  { value: "TOKEN_USED", label: "Token used (internal API)" },
  { value: "TOKEN_REJECTED", label: "Token rejected" },
  { value: "CONFIG_CHANGE", label: "Config change" },
  { value: "SECURITY_EVENT", label: "Security event" },
];

interface SearchParams {
  event?: string;
  from?: string;
  to?: string;
  actor?: string;
  outcome?: string;
  cursor?: string;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return <PermissionDenied reason={new NotAuthenticatedError().message} />;
  }
  if (!isAdmin(currentUser)) {
    return <PermissionDenied reason={new NotAuthorizedError().message} />;
  }

  const tenant = await getCurrentTenant();

  // Default to last 7 days when no range supplied.
  const today = new Date();
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  const from = searchParams.from || sevenDaysAgo.toISOString().slice(0, 10);
  const to = searchParams.to || today.toISOString().slice(0, 10);
  const fromDate = new Date(from);
  // Inclusive of the "to" day — bump to end-of-day so events on that day are included.
  const toDate = new Date(to);
  toDate.setHours(23, 59, 59, 999);

  // Build the where clause. Tenant scope is enforced unconditionally
  // (no admin can see other tenants' rows). NULL-tenant rows are
  // visible only when the admin is on the default tenant — those are
  // platform-level events (pre-identity TOKEN_REJECTED etc.).
  const where: Prisma.AuditLogWhereInput = {
    occurredAt: { gte: fromDate, lte: toDate },
  };
  if (tenant && tenant.slug === "default") {
    // Default-tenant admin sees their tenant's rows + the platform-level
    // (NULL-tenant) rows. The OR captures both.
    where.OR = [{ tenantId: tenant.id }, { tenantId: null }];
  } else if (tenant) {
    where.tenantId = tenant.id;
  } else {
    // No current tenant → no visible rows.
    where.tenantId = "00000000-0000-0000-0000-000000000000";
  }

  if (searchParams.event) {
    where.eventType = searchParams.event as AuditEventType;
  }
  if (searchParams.outcome) {
    where.outcome = searchParams.outcome as AuditOutcome;
  }
  if (searchParams.actor) {
    where.actorEmail = { contains: searchParams.actor, mode: "insensitive" };
  }

  // Cursor-based pagination — feed a row's id from the previous page's
  // "Next →" link. Keeps the result set stable as new rows arrive.
  const cursor = searchParams.cursor
    ? { id: searchParams.cursor }
    : undefined;

  const rows = await prisma.auditLog.findMany({
    where,
    take: PAGE_SIZE + 1, // peek one extra to detect "more"
    ...(cursor && { cursor, skip: 1 }),
    orderBy: { occurredAt: "desc" },
    select: {
      id: true,
      occurredAt: true,
      eventType: true,
      action: true,
      outcome: true,
      actorEmail: true,
      ipAddress: true,
      userAgent: true,
      resource: true,
      resourceId: true,
      metadata: true,
      tenantId: true,
    },
  });

  const hasMore = rows.length > PAGE_SIZE;
  const visible = hasMore ? rows.slice(0, PAGE_SIZE) : rows;
  const nextCursor = hasMore ? visible[visible.length - 1].id : null;

  // Total count for the header — capped at a reasonable bound for speed.
  // Quarterly access reviews want exact-ish numbers; over ~10k events
  // the actual count is less useful than the trend.
  const totalCount = await prisma.auditLog.count({ where });

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-xl font-semibold text-ink-900">Audit log</h2>
        <p className="text-xs text-ink-500">
          Every privileged action, login, token use, and data export. Filter,
          drill in, and export for SOC 2 quarterly access reviews.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Filter</CardTitle>
          <span className="text-xs text-ink-500">
            {totalCount.toLocaleString()} event{totalCount === 1 ? "" : "s"} match
            current filters · scope:{" "}
            {tenant ? (
              <span className="font-medium">{tenant.name}</span>
            ) : (
              <span className="text-ink-400">none</span>
            )}
          </span>
        </CardHeader>
        <CardContent>
          <form
            method="get"
            className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5"
          >
            <div>
              <Label htmlFor="event">Event type</Label>
              <Select id="event" name="event" defaultValue={searchParams.event ?? ""}>
                {EVENT_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="outcome">Outcome</Label>
              <Select id="outcome" name="outcome" defaultValue={searchParams.outcome ?? ""}>
                <option value="">All</option>
                <option value="SUCCESS">Success</option>
                <option value="FAILURE">Failure</option>
                <option value="ANOMALOUS">Anomalous</option>
              </Select>
            </div>
            <div>
              <Label htmlFor="from">From</Label>
              <Input
                id="from"
                name="from"
                type="date"
                defaultValue={from}
              />
            </div>
            <div>
              <Label htmlFor="to">To</Label>
              <Input id="to" name="to" type="date" defaultValue={to} />
            </div>
            <div>
              <Label htmlFor="actor">Actor email</Label>
              <Input
                id="actor"
                name="actor"
                placeholder="substring match"
                defaultValue={searchParams.actor ?? ""}
              />
            </div>
            <div className="flex items-end gap-2 sm:col-span-2 lg:col-span-5">
              <button
                type="submit"
                className="h-9 rounded-md bg-ink-900 px-3 text-xs font-medium text-white hover:bg-ink-800"
              >
                Apply filters
              </button>
              <Link
                href="/admin/audit-log"
                className="h-9 inline-flex items-center rounded-md border border-ink-200 px-3 text-xs font-medium text-ink-700 hover:bg-ink-100"
              >
                Reset
              </Link>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Events</CardTitle>
        </CardHeader>
        <CardContent>
          {visible.length === 0 ? (
            <EmptyState
              title="No events match the current filters"
              description="Widen the date range or clear filters with Reset."
            />
          ) : (
            <Table>
              <THead>
                <tr>
                  <TH>When</TH>
                  <TH>Event</TH>
                  <TH>Actor</TH>
                  <TH>Action</TH>
                  <TH>Resource</TH>
                  <TH>Outcome</TH>
                  <TH>IP</TH>
                  <TH>Metadata</TH>
                  <TH></TH>
                </tr>
              </THead>
              <TBody>
                {visible.map((row) => (
                  <AuditRow key={row.id} row={row} />
                ))}
              </TBody>
            </Table>
          )}

          {(hasMore || cursor) && (
            <div className="mt-4 flex items-center justify-between gap-2 border-t border-ink-100 pt-3">
              <span className="text-xs text-ink-500">
                Showing {visible.length} of {totalCount.toLocaleString()}.
              </span>
              <div className="flex gap-2">
                {cursor && (
                  <Link
                    href={cleanUrl(searchParams, { cursor: undefined })}
                    className="h-8 inline-flex items-center rounded-md border border-ink-200 px-3 text-xs font-medium text-ink-700 hover:bg-ink-100"
                  >
                    ← Newest
                  </Link>
                )}
                {nextCursor && (
                  <Link
                    href={cleanUrl(searchParams, { cursor: nextCursor })}
                    className="h-8 inline-flex items-center rounded-md border border-ink-200 px-3 text-xs font-medium text-ink-700 hover:bg-ink-100"
                  >
                    Older →
                  </Link>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ─── Row rendering ───────────────────────────────────────────────────────

interface AuditRowProps {
  row: {
    id: string;
    occurredAt: Date;
    eventType: AuditEventType;
    action: string;
    outcome: AuditOutcome;
    actorEmail: string | null;
    ipAddress: string | null;
    userAgent: string | null;
    resource: string | null;
    resourceId: string | null;
    metadata: unknown;
    tenantId: string | null;
  };
}

function AuditRow({ row }: AuditRowProps) {
  const tone = outcomeTone(row.outcome);
  const eventTone = eventTypeTone(row.eventType);
  // metadata-snippet: pick a few high-signal keys and stringify.
  const snippet = metadataSnippet(row.metadata);

  return (
    <TR>
      <TD className="text-ink-700 whitespace-nowrap text-xs">
        <div>{formatDate(row.occurredAt)}</div>
        <div className="text-[10px] text-ink-400">
          {row.occurredAt.toISOString().slice(11, 19)}
        </div>
      </TD>
      <TD>
        <Badge tone={eventTone}>{prettyEvent(row.eventType)}</Badge>
      </TD>
      <TD className="text-xs text-ink-700">
        {row.actorEmail ?? (
          <span className="text-ink-400">system</span>
        )}
      </TD>
      <TD className="text-xs text-ink-700 font-mono">{row.action}</TD>
      <TD className="text-xs text-ink-600">
        {row.resource ? (
          <>
            <span className="font-medium">{row.resource}</span>
            {row.resourceId && (
              <span className="text-ink-400">·{row.resourceId.slice(0, 8)}</span>
            )}
          </>
        ) : (
          <span className="text-ink-300">—</span>
        )}
      </TD>
      <TD>
        <Badge tone={tone}>{row.outcome}</Badge>
      </TD>
      <TD className="text-[11px] text-ink-500 font-mono whitespace-nowrap">
        {row.ipAddress ?? "—"}
      </TD>
      <TD className="text-[11px] text-ink-600 max-w-md">
        {snippet}
      </TD>
      <TD>
        <Link
          href={`/admin/audit-log/${row.id}`}
          className="text-[11px] font-medium text-accent-600 hover:underline whitespace-nowrap"
        >
          Open →
        </Link>
      </TD>
    </TR>
  );
}

function metadataSnippet(metadata: unknown): React.ReactNode {
  if (metadata == null) return <span className="text-ink-300">—</span>;
  if (typeof metadata !== "object") return String(metadata);
  // Show the first 3 key/value pairs, truncated. Full row is on detail.
  const obj = metadata as Record<string, unknown>;
  const keys = Object.keys(obj).slice(0, 4);
  if (keys.length === 0) return <span className="text-ink-300">—</span>;
  return (
    <span className="block truncate">
      {keys.map((k, i) => (
        <span key={k}>
          <span className="text-ink-500">{k}=</span>
          <span className="text-ink-700">{formatVal(obj[k])}</span>
          {i < keys.length - 1 && <span className="text-ink-300"> · </span>}
        </span>
      ))}
      {Object.keys(obj).length > 4 && (
        <span className="text-ink-400">
          {" "}
          (+{Object.keys(obj).length - 4} more)
        </span>
      )}
    </span>
  );
}

function formatVal(v: unknown): string {
  if (v == null) return "null";
  if (typeof v === "string") return v.length > 32 ? v.slice(0, 30) + "…" : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v).slice(0, 32);
}

function outcomeTone(outcome: AuditOutcome): "positive" | "negative" | "warning" {
  if (outcome === "SUCCESS") return "positive";
  if (outcome === "FAILURE") return "negative";
  return "warning"; // ANOMALOUS
}

function eventTypeTone(
  eventType: AuditEventType
):
  | "neutral"
  | "info"
  | "positive"
  | "negative"
  | "warning" {
  switch (eventType) {
    case "LOGIN_SUCCESS":
    case "LOGOUT":
      return "neutral";
    case "LOGIN_FAILURE":
    case "ACCESS_DENIED":
    case "TOKEN_REJECTED":
      return "negative";
    case "PRIVILEGED_ACTION":
    case "CONFIG_CHANGE":
      return "info";
    case "DATA_EXPORT":
    case "TOKEN_USED":
      return "positive";
    case "SECURITY_EVENT":
      return "warning";
    default:
      return "neutral";
  }
}

function prettyEvent(e: AuditEventType): string {
  return e
    .toLowerCase()
    .split("_")
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join(" ");
}

// Build a URL preserving existing search params with overrides.
function cleanUrl(
  current: SearchParams,
  overrides: Record<string, string | undefined>
): string {
  const params = new URLSearchParams();
  const merged: Record<string, string | undefined> = { ...current, ...overrides };
  for (const [k, v] of Object.entries(merged)) {
    if (v) params.set(k, v);
  }
  const qs = params.toString();
  return qs ? `/admin/audit-log?${qs}` : "/admin/audit-log";
}

// ─── Permission gate ─────────────────────────────────────────────────────

function PermissionDenied({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-ink-900">Admin only</h2>
        <p className="mt-1 text-sm text-ink-500">{reason}</p>
        <p className="mt-3 text-xs text-ink-400">
          Audit-log access requires the admin role. Pick an admin user from
          the switcher in the header.
        </p>
      </CardContent>
    </Card>
  );
}
