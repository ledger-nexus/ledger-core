import { InputHTMLAttributes, SelectHTMLAttributes, LabelHTMLAttributes, forwardRef } from "react";
import { cn } from "@/lib/utils/cn";

// Accent focus treatment: colored border + a soft 3px halo instead of the
// gray ring — the one place the accent color earns its keep on every page.
const fieldClasses =
  "h-9 w-full rounded-lg border border-ink-200 bg-white px-3 text-sm " +
  "transition-[border-color,box-shadow] duration-200 ease-snap " +
  "focus:outline-none focus:border-accent-500 focus:ring-[3px] focus:ring-accent-500/15";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(fieldClasses, "placeholder:text-ink-500", className)}
      {...props}
    />
  )
);
Input.displayName = "Input";

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(
  ({ className, children, ...props }, ref) => (
    <select ref={ref} className={cn(fieldClasses, className)} {...props}>
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
