import { ButtonHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

type Variant = "default" | "ghost" | "outline";
type Size = "default" | "sm";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

const variantClasses: Record<Variant, string> = {
  default:
    "bg-ink-900 text-white hover:bg-ink-800 hover:shadow-md focus-visible:ring-ink-700",
  ghost: "text-ink-700 hover:bg-ink-100 focus-visible:ring-ink-300",
  outline:
    "border border-ink-200 bg-white text-ink-700 hover:bg-ink-50 hover:shadow-sm focus-visible:ring-ink-300",
};

const sizeClasses: Record<Size, string> = {
  default: "h-9 px-5 text-sm",
  sm: "h-8 px-3.5 text-xs",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "default", size = "default", ...props }, ref) => (
    <button
      ref={ref}
      className={cn(
        // Pill shape + snap-eased hover physics: a hair of lift on hover,
        // gentle compress on press. motion-safe keeps it out of
        // prefers-reduced-motion environments.
        "inline-flex items-center justify-center rounded-full font-medium",
        "transition-[background-color,border-color,box-shadow,transform] duration-200 ease-snap",
        "motion-safe:hover:-translate-y-px motion-safe:active:translate-y-0 motion-safe:active:scale-[0.98]",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
        "disabled:pointer-events-none disabled:opacity-50",
        variantClasses[variant],
        sizeClasses[size],
        className
      )}
      {...props}
    />
  )
);
Button.displayName = "Button";
