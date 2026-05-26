import Link from "next/link";
import { cn } from "@/lib/utils/cn";

interface EmptyStateProps {
  title: string;
  description?: string;
  className?: string;
  /** Optional call-to-action link rendered below the description. */
  action?: { href: string; label: string };
}

export function EmptyState({ title, description, className, action }: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-ink-200 bg-ink-50/50 px-6 py-10 text-center",
        className
      )}
    >
      <p className="text-sm font-medium text-ink-700">{title}</p>
      {description && <p className="text-xs text-ink-500">{description}</p>}
      {action && (
        <Link
          href={action.href}
          className="mt-2 inline-flex h-8 items-center rounded-md bg-ink-900 px-3 text-xs font-medium text-white hover:bg-ink-800"
        >
          {action.label}
        </Link>
      )}
    </div>
  );
}
