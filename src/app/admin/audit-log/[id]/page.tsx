// Audit-log detail page — full record for one event.
//
// Shows everything the list view truncates: full metadata JSON, the
// complete user-agent string, the IP address, the actor's full user
// row (if still extant), and related audit events for the same
// resource (e.g. all events tied to a specific JE id).
//
// Linked from the list page. Tenant-scoped + admin-gated, same as
// the list page.

import * as React from "react";
import { notFound } from "next/navigation";
import Link from "next/link";
import { prisma } from "@/lib/db";
import {
  getCurrentUser,
  NotAuthenticatedError,
} from "@/lib/auth/current-user";
import { getCurrentTenant } from "@/lib/auth/tenant";
import { canViewAuditLog } from "@/lib/auth/policy";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { formatDate } from "@/lib/utils/format";

export default async function AuditLogDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const currentUser = await getCurrentUser();
  if (!currentUser) {
    return <PermissionDenied reason={new NotAuthenticatedError().message} />;
  }
  const tenant = await getCurrentTenant();
  if (!canViewAuditLog(tenant?.role)) {
    return <PermissionDenied reason="This page requires admin access" />;
  }

  const row = await prisma.auditLog.findUnique({
    where: { id: params.id },
    include: {
      actor: { select: { id: true, email: true, displayName: true, isActive: true } },
    },
  });
  if (!row) notFound();

  // Tenant scope enforcement: an admin viewing a row in another tenant
  // is a privacy violation. Default-tenant admin can see NULL-tenant
  // platform events.
  const allowedTenants = new Set<string | null>(
    tenant && tenant.slug === "default"
      ? [tenant.id, null]
      : tenant
        ? [tenant.id]
        : []
  );
  if (!allowedTenants.has(row.tenantId)) {
    notFound();
  }

  // Related events: same resource + resourceId (e.g. "everything that
  // happened to this JournalEntry"). Capped to keep the page tight.
  const related = row.resource && row.resourceId
    ? await prisma.auditLog.findMany({
        where: {
          resource: row.resource,
          resourceId: row.resourceId,
          id: { not: row.id },
          tenantId: row.tenantId, // same tenant scope as the focused row
        },
        orderBy: { occurredAt: "desc" },
        take: 20,
        select: {
          id: true,
          occurredAt: true,
          eventType: true,
          action: true,
          outcome: true,
          actorEmail: true,
        },
      })
    : [];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <Link
          href="/admin/audit-log"
          className="text-xs font-medium text-accent-600 hover:underline"
        >
          ← All events
        </Link>
        <h2 className="mt-2 text-xl font-semibold text-ink-900">
          {row.action}
        </h2>
        <p className="text-xs text-ink-500">
          {row.eventType} · {row.occurredAt.toISOString()}
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Event</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Event ID" value={row.id} mono />
            <Field label="Event type" value={row.eventType} />
            <Field
              label="Outcome"
              valueNode={
                <Badge
                  tone={
                    row.outcome === "SUCCESS"
                      ? "positive"
                      : row.outcome === "FAILURE"
                        ? "negative"
                        : "warning"
                  }
                >
                  {row.outcome}
                </Badge>
              }
            />
            <Field label="Action" value={row.action} mono />
            <Field
              label="Occurred at"
              value={`${formatDate(row.occurredAt)} ${row.occurredAt.toISOString().slice(11, 19)} UTC`}
            />
            <Field
              label="Tenant"
              value={row.tenantId ?? "(platform — pre-identity event)"}
              mono
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Actor</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field
              label="Email"
              value={row.actorEmail ?? "(system / no actor)"}
              mono
            />
            <Field
              label="User ID"
              value={row.actorUserId ?? "—"}
              mono
            />
            {row.actor && (
              <>
                <Field
                  label="Display name"
                  value={row.actor.displayName}
                />
                <Field
                  label="User status"
                  valueNode={
                    <Badge tone={row.actor.isActive ? "positive" : "negative"}>
                      {row.actor.isActive ? "Active" : "Deactivated"}
                    </Badge>
                  }
                />
              </>
            )}
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Network</CardTitle>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-1 gap-3">
            <Field
              label="IP address"
              value={row.ipAddress ?? "—"}
              mono
            />
            <Field
              label="User agent"
              value={row.userAgent ?? "—"}
              mono
            />
          </dl>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Resource</CardTitle>
        </CardHeader>
        <CardContent>
          {row.resource ? (
            <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="Type" value={row.resource} />
              <Field
                label="ID"
                value={row.resourceId ?? "(none)"}
                mono
              />
            </dl>
          ) : (
            <p className="text-sm text-ink-500">
              No resource attached. This is typically a session-level event
              (login / logout) or a system-level event.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Metadata</CardTitle>
          <span className="text-xs text-ink-500">
            Free-form structured fields. Shape varies by event type.
          </span>
        </CardHeader>
        <CardContent>
          {row.metadata ? (
            <pre className="overflow-x-auto rounded-md bg-ink-50 p-3 text-[11px] text-ink-800 leading-relaxed font-mono">
              {JSON.stringify(row.metadata, null, 2)}
            </pre>
          ) : (
            <p className="text-sm text-ink-500">No metadata.</p>
          )}
        </CardContent>
      </Card>

      {related.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Related events</CardTitle>
            <span className="text-xs text-ink-500">
              Other audit rows touching the same {row.resource} ({row.resourceId})
            </span>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-2">
              {related.map((r) => (
                <li key={r.id}>
                  <Link
                    href={`/admin/audit-log/${r.id}`}
                    className="flex items-center justify-between gap-3 rounded-md border border-ink-100 px-3 py-2 hover:bg-ink-50"
                  >
                    <span className="flex items-center gap-2 text-xs">
                      <Badge tone="neutral">{r.eventType}</Badge>
                      <span className="text-ink-700 font-mono">{r.action}</span>
                      {r.actorEmail && (
                        <span className="text-ink-500">by {r.actorEmail}</span>
                      )}
                    </span>
                    <span className="text-[11px] text-ink-400 whitespace-nowrap">
                      {formatDate(r.occurredAt)}{" "}
                      {r.occurredAt.toISOString().slice(11, 19)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ─── Small helpers ───────────────────────────────────────────────────────

function Field({
  label,
  value,
  valueNode,
  mono,
}: {
  label: string;
  value?: string;
  valueNode?: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div>
      <dt className="text-[11px] font-medium uppercase tracking-wider text-ink-500">
        {label}
      </dt>
      <dd className={mono ? "mt-0.5 text-sm text-ink-800 font-mono" : "mt-0.5 text-sm text-ink-800"}>
        {valueNode ?? value ?? "—"}
      </dd>
    </div>
  );
}

function PermissionDenied({ reason }: { reason: string }) {
  return (
    <Card>
      <CardContent className="px-6 py-10 text-center">
        <h2 className="text-base font-semibold text-ink-900">Admin only</h2>
        <p className="mt-1 text-sm text-ink-500">{reason}</p>
      </CardContent>
    </Card>
  );
}
