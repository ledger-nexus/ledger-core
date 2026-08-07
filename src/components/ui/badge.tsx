import { HTMLAttributes } from "react";
import { cn } from "@/lib/utils/cn";

type BadgeTone = "neutral" | "positive" | "negative" | "warning" | "info";

interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
}

// Tones resolve through the design tokens, not raw Tailwind. Reaching for
// `bg-amber-100` here is what let `warning` be used as a colour utility
// elsewhere while being absent from the config: the badge stayed amber on
// its own, so the untinted callout beside it still looked deliberate.
const toneClasses: Record<BadgeTone, string> = {
  neutral: "bg-ink-100 text-ink-700",
  positive: "bg-positive-100 text-positive",
  negative: "bg-negative-100 text-negative",
  warning: "bg-warning-100 text-warning",
  info: "bg-accent-100 text-accent-600",
};

export function Badge({ className, tone = "neutral", ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        toneClasses[tone],
        className
      )}
      {...props}
    />
  );
}
