// Input — design-system contract: label, hint, error. The label is a mono
// uppercase overline; the field is outlined in ink (interactive chrome is
// outlined in black), turning green on focus and red on error. The error
// line replaces the hint and is wired through aria-describedby.
import { useId } from "react";

import { cn } from "~/lib/utils";

export interface InputProps extends React.ComponentProps<"input"> {
  label?: string;
  hint?: React.ReactNode;
  error?: string;
}

export const fieldLabelClass =
  "font-mono text-label font-medium uppercase tracking-label text-gray-600";

export const fieldControlClass = cn(
  "border bg-surface-card px-3 py-2.5 font-sans text-body text-ink-900",
  "placeholder:text-gray-400",
  "transition-shadow duration-100 ease-out",
  "focus:shadow-focus-ring focus:outline-none",
  "disabled:bg-surface-sunken disabled:opacity-60",
);

export function FieldDescription({
  id,
  error,
  hint,
}: {
  id: string;
  error?: string;
  hint?: React.ReactNode;
}) {
  if (!error && !hint) return null;
  return (
    <span
      id={id}
      className={cn("text-small", error ? "text-danger" : "text-gray-500")}
    >
      {error || hint}
    </span>
  );
}

export function Input({
  label,
  hint,
  error,
  id: idProp,
  className,
  ...props
}: InputProps) {
  const generatedId = useId();
  const id = idProp ?? generatedId;
  const descriptionId = error || hint ? `${id}-description` : undefined;

  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {label && (
        <label htmlFor={id} className={fieldLabelClass}>
          {label}
        </label>
      )}
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          fieldControlClass,
          error
            ? "border-status-negative"
            : "border-outline-strong focus:border-accent-600",
        )}
        {...props}
      />
      {descriptionId && (
        <FieldDescription id={descriptionId} error={error} hint={hint} />
      )}
    </div>
  );
}
