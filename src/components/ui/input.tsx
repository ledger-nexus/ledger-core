import { InputHTMLAttributes, SelectHTMLAttributes, LabelHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-ink-200 bg-white px-3 text-sm",
        "placeholder:text-ink-400",
        "focus:outline-none focus:ring-2 focus:ring-ink-300 focus:border-ink-400",
        className
      )}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(
        "h-9 w-full rounded-md border border-ink-200 bg-white px-3 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-ink-300 focus:border-ink-400",
        className
      )}
      {...props}
    >
      {children}
    </select>
  )
);
Select.displayName = "Select";

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn("mb-1 block text-xs font-medium uppercase tracking-wide text-ink-500", className)}
      {...props}
    />
  );
}
