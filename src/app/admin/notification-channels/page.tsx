// Admin: notification channels list page.
//
// Tenant-scoped. Admin-only. Lists every channel in this tenant with:
//   - Name, type (Slack), masked webhook URL
//   - Severity filter (chips) / "all" if empty
//   - Enabled toggle
//   - Total dispatches sent + last sentAt
//   - Actions: test, edit, delete
//
// The masked-URL display is the only place an operator sees the URL
// after creation. The full URL is encrypted at rest and only ever
// decrypted at send time (cron dispatch + testChannel action).

import Link from "next/link";
import { prisma } from "@/lib/db";
import { getCurrentTenant, isTenantAdmin } from "@/lib/auth/tenant";
import { getCurrentUser } from "@/lib/auth/current-user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/ui/empty-state";
import { formatDate } from "@/lib/utils/format";
import { decryptWebhookUrl, maskWebhookUrl } from "@/lib/notifications/crypto";
import CreateChannelForm from "./create-channel-form";
import ChannelRowActions from "./channel-row-actions";

export default async function NotificationChannelsPage() {
  const user = await getCurrentUser();
  const tenant = await getCurrentTenant();
  if (!user || !tenant) {
    return (
      <EmptyState
        title="Sign in required"
        description="Notification channels are tenant-scoped admin config."
      />
    );
  }
  if (!isTenantAdmin(tenant)) {
    return (
      <EmptyState
        title="Admin only"
        description="Only tenant admins can manage notification channels."
      />
    );
  }

  const channels = await prisma.notificationChannel.findMany({
    where: { tenantId: tenant.id },
    orderBy: [{ enabled: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      type: true,
      name: true,
      webhookUrl: true,
      severityFilter: true,
      mode: true,
      enabled: true,
      createdAt: true,
      createdBy: { select: { displayName: true, email: true } },
      _count: { select: { dispatches: true } },
    },
  });

  // Decrypt → mask for display. Decryption failures (key rotated,
  // ciphertext corrupted) surface as a clear sentinel so the admin
  // knows the channel needs re-entry.
  type Row = (typeof channels)[number] & { maskedUrl: string };
  const rows: Row[] = channels.map((c) => {
    let maskedUrl = "***encrypted***";
    try {
      maskedUrl = maskWebhookUrl(decryptWebhookUrl(c.webhookUrl));
    } catch {
      maskedUrl = "***decrypt-failed***";
    }
    return { ...c, maskedUrl };
  });

  // Last-sent-at per channel for the "Last activity" column. One
  // aggregate per channel, sub-second at portfolio scale.
  const lastSentList =
    rows.length > 0
      ? await prisma.notificationDispatch.groupBy({
          by: ["channelId"],
          where: { channelId: { in: rows.map((r) => r.id) } },
          _max: { sentAt: true },
        })
      : [];
  const lastSentByChannel = new Map<string, Date | null>();
  for (const row of lastSentList) {
    lastSentByChannel.set(row.channelId, row._max.sentAt);
  }

  return (
    <div className="flex flex-col gap-4">
      <header>
        <div className="text-xs text-ink-500">
          <Link
            href="/admin/users"
            className="text-accent-600 hover:underline"
          >
            ← Admin
          </Link>
        </div>
        <h1 className="mt-1 text-xl font-semibold text-ink-900">
          Notification channels
        </h1>
        <p className="text-sm text-ink-500">
          Slack webhooks that receive close alerts. <em>Immediate</em>{" "}
          channels ping every 15 minutes during business hours;{" "}
          <em>Daily digest</em> channels get one batched message per day
          at 09:00 UTC.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>Add a Slack channel</CardTitle>
          <span className="text-xs text-ink-500">
            The webhook URL is encrypted at rest and never re-displayed.
            Rotate by editing the channel and pasting a new URL.
          </span>
        </CardHeader>
        <CardContent>
          <CreateChannelForm />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>
            Channels in this tenant ({rows.length})
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <EmptyState
              title="No channels yet"
              description="Add a Slack webhook above to start receiving close alerts."
            />
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-ink-500">
                  <th className="py-1 font-medium">Name</th>
                  <th className="py-1 font-medium">Webhook</th>
                  <th className="py-1 font-medium">Severity</th>
                  <th className="py-1 font-medium">Cadence</th>
                  <th className="py-1 font-medium">Status</th>
                  <th className="py-1 font-medium">Sent</th>
                  <th className="py-1 font-medium">Last</th>
                  <th className="py-1 font-medium">Created</th>
                  <th className="py-1 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id} className="border-t border-ink-100">
                    <td className="py-1.5 font-medium text-ink-900">
                      {c.name}
                    </td>
                    <td className="py-1.5 font-mono text-[10px] text-ink-500">
                      {c.maskedUrl}
                    </td>
                    <td className="py-1.5">
                      {c.severityFilter.length === 0 ? (
                        <Badge tone="neutral">all</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {c.severityFilter.map((s) => (
                            <Badge key={s} tone="neutral">
                              {s}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="py-1.5">
                      <Badge tone={c.mode === "DIGEST_DAILY" ? "info" : "neutral"}>
                        {c.mode === "DIGEST_DAILY" ? "daily digest" : "immediate"}
                      </Badge>
                    </td>
                    <td className="py-1.5">
                      <Badge tone={c.enabled ? "positive" : "neutral"}>
                        {c.enabled ? "enabled" : "disabled"}
                      </Badge>
                    </td>
                    <td className="py-1.5 text-right font-mono">
                      {c._count.dispatches}
                    </td>
                    <td className="py-1.5 text-ink-600">
                      {lastSentByChannel.get(c.id)
                        ? formatDate(lastSentByChannel.get(c.id)!)
                        : "—"}
                    </td>
                    <td className="py-1.5 text-ink-600">
                      {formatDate(c.createdAt)}
                      {c.createdBy?.displayName && (
                        <span className="ml-1 text-ink-400">
                          · {c.createdBy.displayName}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      <ChannelRowActions
                        channelId={c.id}
                        enabled={c.enabled}
                        name={c.name}
                        severityFilter={c.severityFilter}
                        mode={c.mode}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
