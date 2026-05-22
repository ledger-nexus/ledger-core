// Dev-only user-switcher. Renders a <select> of all active users; on
// change, fires the setCurrentUserAction Server Action which writes the
// signed cookie. The current user is shown above the dropdown.
//
// Mounted in the layout header, next to the BookSwitcher. Wraps the
// switcher in a "DEV STUB" label so portfolio viewers understand this
// isn't real auth.

"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { setCurrentUserAction } from "@/app/actions/set-current-user";

export interface UserOption {
  id: string;
  email: string;
  displayName: string;
}

interface Props {
  currentUserId: string | null;
  options: UserOption[];
}

export function UserSwitcher({ currentUserId, options }: Props) {
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function onChange(e: React.ChangeEvent<HTMLSelectElement>) {
    const value = e.target.value;
    startTransition(async () => {
      await setCurrentUserAction(value);
      router.refresh();
    });
  }

  const current = options.find((o) => o.id === currentUserId);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-medium uppercase tracking-wider text-amber-700">
          dev auth stub
        </span>
        {pending ? <span className="text-[10px] text-ink-400">switching…</span> : null}
      </div>
      <select
        value={currentUserId ?? "__none__"}
        onChange={onChange}
        disabled={pending}
        className="h-8 w-full rounded-md border border-ink-200 bg-white px-2 text-xs focus:outline-none focus:ring-2 focus:ring-ink-300"
        aria-label="Current user"
      >
        <option value="__none__">(no user — unauthenticated)</option>
        {options.map((o) => (
          <option key={o.id} value={o.id}>
            {o.displayName}
          </option>
        ))}
      </select>
      {current ? (
        <div className="text-[11px] text-ink-500">{current.email}</div>
      ) : (
        <div className="text-[11px] text-ink-500">
          Server Actions that require a user will fail. Pick one above.
        </div>
      )}
    </div>
  );
}
