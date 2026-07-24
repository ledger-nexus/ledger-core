import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

// Radius language: cards sit at 12px (rounded-xl); inputs/badges at 8px;
// modals at 16px. Shadows are none at rest — the warm border carries the
// edge, per the "no dropped shadows at rest" rule.
export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "rounded-xl border border-ink-200 bg-white",
        className
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-between px-6 pt-6 pb-3", className)}
      {...props}
    />
  );
}

export function CardTitle({ className, ...props }: HTMLAttributes<HTMLHeadingElement>) {
  return (
    <h2
      className={cn(
        "text-[11px] font-medium uppercase tracking-[0.1em] text-ink-500",
        className
      )}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("px-6 pb-6", className)} {...props} />;
}
