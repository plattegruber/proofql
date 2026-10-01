// Field: the design-system Input (or Select) wired to action field errors
// by name (docs/frontend-conventions.md). By default it reads
// `useActionData()` — the plain <Form> path; a fetcher-driven form passes
// the fetcher's errors explicitly, because fetcher results never appear in
// useActionData:
//
//   <Field name="name" label="Name" errors={fetcher.data?.fieldErrors} />
//
// One message renders per field: a calm form doesn't stack complaints.
import { useActionData } from "react-router";

import { Input, type InputProps } from "~/components/ui/input";
import { Select, type SelectProps } from "~/components/ui/select";
import type { FieldErrors } from "~/lib/forms.server";

function useFieldError(name: string, errors?: FieldErrors) {
  const actionData = useActionData<{ fieldErrors?: FieldErrors }>();
  const fieldErrors = errors ?? actionData?.fieldErrors;
  return fieldErrors?.[name]?.[0];
}

export interface FieldProps extends Omit<InputProps, "error" | "name"> {
  /** The form-data field name — also the key into fieldErrors. */
  name: string;
  /** Fetcher-provided errors; defaults to useActionData().fieldErrors. */
  errors?: FieldErrors;
}

export function Field({ name, errors, ...props }: FieldProps) {
  const error = useFieldError(name, errors);
  return <Input name={name} error={error} {...props} />;
}

export interface SelectFieldProps extends Omit<SelectProps, "error" | "name"> {
  name: string;
  errors?: FieldErrors;
}

export function SelectField({ name, errors, ...props }: SelectFieldProps) {
  const error = useFieldError(name, errors);
  return <Select name={name} error={error} {...props} />;
}

/**
 * Form-level errors (the "" key) — for failures that belong to no one
 * field, like a plan limit. Renders nothing when there are none.
 */
export function FormErrors({
  errors,
  className,
}: {
  errors?: FieldErrors;
  className?: string;
}) {
  const actionData = useActionData<{ fieldErrors?: FieldErrors }>();
  const message = (errors ?? actionData?.fieldErrors)?.[""]?.[0];
  if (!message) return null;
  return (
    <p role="alert" className={`m-0 text-small text-danger ${className ?? ""}`}>
      {message}
    </p>
  );
}
