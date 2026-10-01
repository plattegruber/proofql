// Form controls on the design system: square, ink-outlined, hairline when
// resting, signal-green focus ring, mono micro-labels. Native elements only
// — a <select> and an <input> are already accessible and the pages here are
// GET forms that must work before hydration.
import { cn } from "~/lib/utils";

const control = cn(
  "block w-full border border-gray-300 bg-surface-card px-2.5 py-2",
  "font-sans text-small text-ink-900 placeholder:text-gray-400",
  "transition-colors duration-100 ease-out",
  "hover:border-gray-400 focus:border-ink-900 focus:outline-none",
  "focus-visible:shadow-focus-ring",
  "disabled:cursor-default disabled:bg-surface-sunken disabled:text-gray-500",
  "aria-invalid:border-red-700",
);

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(control, className)} {...props} />;
}

export function Textarea({
  className,
  ...props
}: React.ComponentProps<"textarea">) {
  return <textarea className={cn(control, "resize-y", className)} {...props} />;
}

export function Select({
  className,
  children,
  ...props
}: React.ComponentProps<"select">) {
  return (
    <select
      className={cn(control, "appearance-auto pr-8", className)}
      {...props}
    >
      {children}
    </select>
  );
}

/** Mono uppercase label; `hint` renders the field's one error or help line. */
export function Label({
  className,
  children,
  hint,
  error,
  ...props
}: React.ComponentProps<"label"> & { hint?: string; error?: string }) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the control is passed as children and wrapped by this label
    <label className={cn("flex flex-col gap-1.5", className)} {...props}>
      <span className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
        {children}
      </span>
      {/* children of the label render the control via the parent */}
      {hint || error ? (
        <span
          className={cn(
            "order-last font-sans text-label",
            error ? "text-red-700" : "text-gray-500",
          )}
        >
          {error ?? hint}
        </span>
      ) : null}
    </label>
  );
}

/**
 * Checkbox: square, ink when checked (accent is for links and live data,
 * but "checked" is explicitly on the accent list — see app.css).
 */
export function Checkbox({
  className,
  ...props
}: React.ComponentProps<"input">) {
  return (
    <input
      type="checkbox"
      className={cn(
        "size-4 shrink-0 cursor-pointer appearance-none border border-gray-400 bg-surface-card",
        "checked:border-accent-700 checked:bg-accent-700",
        "checked:bg-[url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.2'%3E%3Cpath d='M3.5 8.5l3 3 6-7'/%3E%3C/svg%3E\")] checked:bg-center checked:bg-no-repeat",
        "focus-visible:shadow-focus-ring focus-visible:outline-none",
        "disabled:cursor-default disabled:opacity-40",
        className,
      )}
      {...props}
    />
  );
}
