// Select — native <select> in the Input treatment (label, options, hint,
// error). A plain select is the right answer for five-option lists; a
// searchable control is a later, per-surface decision.
import { useId } from "react";

import { cn } from "~/lib/utils";
import { FieldDescription, fieldControlClass, fieldLabelClass } from "./input";

export interface SelectProps extends React.ComponentProps<"select"> {
  label?: string;
  hint?: React.ReactNode;
  error?: string;
  options: ReadonlyArray<{ value: string; label?: string }>;
}

export function Select({
  label,
  hint,
  error,
  options,
  id: idProp,
  className,
  ...props
}: SelectProps) {
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
      <select
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={descriptionId}
        className={cn(
          fieldControlClass,
          "appearance-none",
          error
            ? "border-status-negative"
            : "border-outline-strong focus:border-accent-600",
        )}
        {...props}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label ?? option.value}
          </option>
        ))}
      </select>
      {descriptionId && (
        <FieldDescription id={descriptionId} error={error} hint={hint} />
      )}
    </div>
  );
}
