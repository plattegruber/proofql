# Frontend conventions

How the dashboard (`apps/dashboard`) handles forms, validation errors,
toasts, error pages, and pending UI. Adopted from Well-Regarded's
`docs/frontend-conventions.md` (decided there in #141) with the pieces that
fit this codebase; every dashboard surface copies these patterns instead of
inventing its own. The living reference is **Project → Settings**
(`app/routes/app.projects.$slug.settings.tsx`) — it demonstrates the whole
loop (loader → form → action → zod → field errors → flash toast), and
**Project → Keys** (`app.projects.$slug.keys.tsx`) shows the fetcher
variants (stay-on-page mutations, inline confirmation, a result that must
be shown once).

Voice matters everywhere here: error messages, toasts, and empty states
follow the design tokens' rules (`app/app.css`) — sentence case, no
exclamation points, no emoji, understatement over hype.

## The action recipe

Every mutation follows the same steps, in order:

```ts
export async function action(args: Route.ActionArgs) {
  // 1. Permission check — in the action, always. Disabled buttons are not
  //    a security boundary. `requireAccount` is the gate, and every write
  //    is scoped by the account it returns.
  const { account } = await requireAccount(args);

  // 2. Parse. Validation failures are RETURNED (422 + fieldErrors), never
  //    thrown: thrown errors mean bugs, returned data means user mistakes.
  const parsed = await parseForm(projectSettingsSchema, args.request);
  if (!parsed.ok) {
    return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
  }

  // 3. Mutate through @proofql/db directly (same database as the api),
  //    never through the public API. Cache invalidation (bumpProjectGeneration)
  //    happens AFTER the write commits.
  const result = await withRequestDb(args.context, (db) => update(db, …));

  // 4 + 5. Flash, then redirect. The toast survives navigation via the
  //    flash cookie.
  return redirect(`/app/projects/${result.project.slug}/settings`, {
    headers: await setFlash(env, { tone: "positive", message: "Settings saved" }),
  });
}
```

Actions that serve several buttons on one page dispatch on an `intent`
hidden field and parse a schema per intent with `parseFormData`.

## Form parsing: `parseForm` / `parseFormData`

`app/lib/forms.server.ts`. Wraps `schema.safeParse` over the form data and
flattens zod issues into `{ fieldErrors: Record<string, string[]> }`.
Form-level issues (empty path) land under the `""` key. Schemas live in
`app/lib/projects.ts` (pure, shared with the browser for live slug
derivation) or `@proofql/core` when the api needs the same contract. Form
data arrives as strings; schemas own coercion (`z.coerce.*`) and
normalization.

No form library — the in-house convention is deliberately minimal.

## Field errors: `Field`, `SelectField`, `FormErrors`

`app/components/form/field.tsx` composes the design-system `Input` /
`Select` and resolves the right message from `fieldErrors` by field name —
`aria-invalid` and `aria-describedby` come along for free. Two wirings:

- Plain `<Form>`: `Field` reads `useActionData().fieldErrors` itself (or
  pass the route's `actionData?.fieldErrors`).
- Fetcher form: pass the fetcher's errors explicitly —
  `<Field name="origin" errors={fetcher.data?.fieldErrors} />` — because
  fetcher results never appear in `useActionData`.

One message renders per field; a calm form doesn't stack complaints.
`FormErrors` renders the `""` key for failures that belong to no field (a
plan limit, for example).

## Toasts

`sonner`, restyled to the design system (square, ink border, mono title)
in `app/components/ui/toaster.tsx`; `<Toaster />` is mounted once in the
protected layout (`app/routes/app.tsx`). Three ways to fire one:

- **Flash toast** (`setFlash` in `app/lib/flash.server.ts`): set by an
  action alongside a redirect; the `/app` layout loader reads-and-clears
  the cookie and forwards the clearing `Set-Cookie` through its `headers`
  export; `<FlashToasts />` fires it once per flash id. Use for any
  mutation that redirects — the default.
- **Fetcher toast** (`useFetcherToast(fetcher)`): the action returns
  `{ toast: actionToast({ tone, message }) }` and the hook fires it once
  per response id. Use for a mutation that stays on the page.
- **Client toast** (`toast(...)` from `sonner`): for non-navigation,
  non-server updates — a copy-to-clipboard.

The flash cookie is signed with `SESSION_SECRET` (`.dev.vars.example`;
empty locally means a fixed dev-only secret; `wrangler secret put
SESSION_SECRET` in deployed environments — `docs/secrets.md`).

## Destructive actions: `InlineConfirm`

Never the browser's `confirm()`. `app/components/form/inline-confirm.tsx`
swaps the trigger for an in-place explanation plus Confirm / Cancel, and
optionally a "type the slug to continue" field (`typeToConfirm`). The
server re-checks the typed value; the client gate is a courtesy.

## Error boundaries and 404s

The root `ErrorBoundary` (`app/root.tsx`) is the only boundary until a
surface needs a narrower one: a designed 404 (via the catch-all
`app/routes/not-found.tsx`, whose loader throws `data(null, { status: 404 })`),
status + message for other thrown `data(...)`, and a quiet apology for
unexpected errors with the stack in dev only.

## Pending UI

- **Navigation**: `NavigationProgress`
  (`app/components/shell/navigation-progress.tsx`), mounted once in the
  layout — a hairline accent bar after 150ms. No skeleton framework;
  skeletons are per-surface decisions.
- **Submission**: `SubmitButton` (`app/components/form/submit-button.tsx`)
  — disabled with a pending label ("Saving…") while its form submits.
  Pass the fetcher for fetcher forms. No spinner: "never bounce, never
  spin".

## Which tool when

| You want | Use | Not |
| --- | --- | --- |
| A mutation that navigates (create → detail, save → refresh) | `<Form>` + action + `redirect` | fetcher |
| A mutation that stays on the page (revoke, add/remove origin) | `useFetcher` + `useFetcherToast` | `<Form>` |
| A result that must be shown once (a minted key) | fetcher response rendered until dismissed | loader data |
| Success feedback after a redirect | flash toast (`setFlash`) | client `toast(...)` |
| "You typed something wrong" | returned `fieldErrors` (422) rendered by `Field` | throwing |
| "You may not do this" / "this doesn't exist" / bugs | `throw data(..., { status })` → ErrorBoundary | returned data |
| "Are you sure?" | `InlineConfirm` | `window.confirm` |

## Testing

- Loaders/actions are plain functions — call them with
  `createLoadContext` (`app/lib/context.ts`) and a fake env. Against the
  real schema, point `HYPERDRIVE.connectionString` at the harness database
  and `CACHE` at `MemoryKv` from `@proofql/core`
  (`app.projects.$slug.settings.integration.test.ts` is the model).
- Component/route rendering: `createRoutesStub` + Testing Library under
  happy-dom (`// @vitest-environment happy-dom`), with the stub's
  `loader`/`action` supplying data and the component reading
  `useLoaderData()` / `useActionData()`. happy-dom does not implicitly
  submit a form from a button click — `fireEvent.submit(form)` for plain
  `<Form>`s. Keep server code out of DOM-environment files.
