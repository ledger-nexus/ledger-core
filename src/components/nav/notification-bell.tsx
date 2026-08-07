"use client";

// In-app notification bell — header dropdown.
//
// Loads the current user's recent unread + a few recently-read
// notifications via a Server Component prop (so the dropdown opens
// fast). Clicking a notification flips it to read AND navigates to
// the linked URL. "Mark all as read" wipes unread without navigating.
//
// Visual: small bell icon with a red dot when unread > 0. The full
// count appears on hover. Dropdown shows up to ~15 notifications;
// "see all" link points to a future /notifications page (not built
// in v1.10 — a card-deep notification history is polish).

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { markNotificationsReadAction } from "@/app/actions/mark-notifications-read";

export interface NotificationRow {
  id: string;
  category: "REASSIGNMENT" | "APPROVAL_NEEDED" | "ORPHAN_DETECTED" | "SYSTEM";
  title: string;
  body: string | null;
  link: string | null;
  recordType: string | null;
  recordId: string | null;
  seenAt: Date | null;
  createdAt: Date;
  actor: { displayName: string; email: string } | null;
}

interface Props {
  unread: NotificationRow[];
  recentRead: NotificationRow[];
  unreadCount: number;
}

const CATEGORY_TONE: Record<NotificationRow["category"], string> = {
  REASSIGNMENT: "bg-accent-500",
  APPROVAL_NEEDED: "bg-warning-500",
  ORPHAN_DETECTED: "bg-negative-500",
  SYSTEM: "bg-ink-400",
};

export function NotificationBell({ unread, recentRead, unreadCount }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);

  function onNotificationClick(notif: NotificationRow) {
    startTransition(async () => {
      if (!notif.seenAt) {
        await markNotificationsReadAction({ notificationIds: [notif.id] });
      }
      if (notif.link) {
        router.push(notif.link);
      }
      setOpen(false);
    });
  }

  function onMarkAllRead() {
    startTransition(async () => {
      await markNotificationsReadAction();
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="relative flex h-9 w-9 items-center justify-center rounded-md border border-ink-200 bg-white hover:bg-ink-50"
        aria-label={`Notifications (${unreadCount} unread)`}
      >
        <BellIcon />
        {unreadCount > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-negative-600 px-1 text-[11px] font-medium text-white">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <>
          {/* Click-away overlay */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="absolute right-0 z-50 mt-1 w-80 rounded-md border border-ink-200 bg-white shadow-lg">
            <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2">
              <span className="text-xs font-medium uppercase tracking-wider text-ink-500">
                Notifications
              </span>
              {unreadCount > 0 && (
                <button
                  type="button"
                  onClick={onMarkAllRead}
                  disabled={pending}
                  className="text-[11px] text-accent-600 hover:underline disabled:opacity-50"
                >
                  Mark all read
                </button>
              )}
            </div>
            <div className="max-h-96 overflow-y-auto">
              {unread.length === 0 && recentRead.length === 0 ? (
                <div className="px-3 py-6 text-center text-xs text-ink-500">
                  No notifications yet.
                </div>
              ) : (
                <>
                  {unread.map((n) => (
                    <NotificationItem
                      key={n.id}
                      notification={n}
                      onClick={() => onNotificationClick(n)}
                    />
                  ))}
                  {recentRead.length > 0 && (
                    <>
                      <div className="border-t border-ink-100 bg-ink-50 px-3 py-1 text-[11px] font-medium uppercase tracking-wider text-ink-500">
                        Recently read
                      </div>
                      {recentRead.map((n) => (
                        <NotificationItem
                          key={n.id}
                          notification={n}
                          onClick={() => onNotificationClick(n)}
                        />
                      ))}
                    </>
                  )}
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function NotificationItem({
  notification,
  onClick,
}: {
  notification: NotificationRow;
  onClick: () => void;
}) {
  const isUnread = !notification.seenAt;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex w-full items-start gap-2 border-b border-ink-100 px-3 py-2 text-left last:border-b-0 hover:bg-ink-50 ${
        isUnread ? "bg-white" : "bg-ink-50/30"
      }`}
    >
      <span
        className={`mt-1 inline-block h-2 w-2 shrink-0 rounded-full ${
          isUnread ? CATEGORY_TONE[notification.category] : "bg-ink-200"
        }`}
        aria-hidden
      />
      <div className="flex-1">
        <div className={`text-xs ${isUnread ? "font-medium text-ink-900" : "text-ink-600"}`}>
          {notification.title}
        </div>
        {notification.body && (
          <div className="mt-0.5 text-[11px] text-ink-500">{notification.body}</div>
        )}
        <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
          <span>{formatRelativeTime(notification.createdAt)}</span>
          {notification.actor && (
            <>
              <span>·</span>
              <span>by {notification.actor.displayName}</span>
            </>
          )}
        </div>
      </div>
    </button>
  );
}

function BellIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-ink-700"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </svg>
  );
}

function formatRelativeTime(date: Date | string): string {
  const d = typeof date === "string" ? new Date(date) : date;
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 30) return `${diffDay}d ago`;
  return d.toISOString().slice(0, 10);
}
