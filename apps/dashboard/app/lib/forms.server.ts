// Form parsing for actions (docs/frontend-conventions.md). Actions never
// throw for validation — thrown errors mean bugs, returned data means user
// mistakes — so every action parses with `parseForm`/`parseFormData` and
// returns `{ fieldErrors }` with status 422 via `data()` when parsing fails.
import { z } from "zod";

/** Field name → messages, the shape `Field` consumes by name. */
export type FieldErrors = Record<string, string[]>;

export type ParseFormResult<T extends z.ZodType> =
  | { ok: true; data: z.infer<T> }
  | { ok: false; fieldErrors: FieldErrors };

/**
 * Parse already-read form data against a zod schema. Use this when the
 * action has to read the `intent` field first and pick a schema from it.
 *
 * `Object.fromEntries` keeps the last value of a repeated field name; none
 * of our forms repeat names. Form data arrives as strings; schemas own
 * coercion (`z.coerce.*`) and empty-string normalization.
 */
export function parseFormData<T extends z.ZodType>(
  schema: T,
  formData: FormData,
): ParseFormResult<T> {
  const result = schema.safeParse(Object.fromEntries(formData));
  if (result.success) return { ok: true, data: result.data };

  // z.flattenError puts each issue under its top-level field name — the
  // right granularity for flat HTML forms. Form-level issues (empty path)
  // land under "" so callers can render them above the form.
  const flattened = z.flattenError(result.error);
  const fieldErrors: FieldErrors = {};
  for (const [name, messages] of Object.entries(flattened.fieldErrors)) {
    if (Array.isArray(messages) && messages.length > 0) {
      fieldErrors[name] = messages as string[];
    }
  }
  if (flattened.formErrors.length > 0) fieldErrors[""] = flattened.formErrors;
  return { ok: false, fieldErrors };
}

/** Parse a request's form data against a zod schema. */
export async function parseForm<T extends z.ZodType>(
  schema: T,
  request: Request,
): Promise<ParseFormResult<T>> {
  return parseFormData(schema, await request.formData());
}
