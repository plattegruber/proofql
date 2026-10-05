// Keys tab (#37): list, mint, revoke, and the CORS allowlist for
// publishable keys. Every mutation is an action on this route, dispatched
// by `intent`, driven by fetchers so the page never leaves: the one thing a
// redirect could not carry is the minted plaintext, which exists only in the
// create fetcher's response and is rendered once in the reveal panel.
import {
  API_KEY_ENVIRONMENTS,
  API_KEY_KINDS,
  type ApiKeyEnvironment,
  type ApiKeyKind,
  safeBumpProjectGeneration,
} from "@proofql/core";
import { KeyRound } from "lucide-react";
import { useState } from "react";
import { data, useActionData, useFetcher } from "react-router";
import { z } from "zod";

import { Field, SelectField } from "~/components/form/field";
import { InlineConfirm } from "~/components/form/inline-confirm";
import { SubmitButton } from "~/components/form/submit-button";
import { Overline } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { CopyButton } from "~/components/ui/copy-button";
import {
  type ActionToast,
  actionToast,
  useFetcherToast,
} from "~/components/ui/toaster";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import {
  type ApiKeyListItem,
  createApiKey,
  listApiKeys,
  revokeApiKey,
} from "~/lib/api-keys.server";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import { type FieldErrors, parseFormData } from "~/lib/forms.server";
import { originSchema } from "~/lib/projects";
import { setAllowedOrigins } from "~/lib/projects.server";
import type { Route } from "./+types/app.projects.$slug.keys";

/** The embed tag and its attributes (packages/snippet, #32/#33). */
const SNIPPET_README_URL =
  "https://github.com/plattegruber/proofql/blob/main/packages/snippet/README.md#usage";

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const keys = await listApiKeys(db, project.id);
    return {
      project: { slug: project.slug, allowedOrigins: project.allowedOrigins },
      keys: keys.map(serializeKey),
    };
  });
}

/** Dates as ISO strings so the loader/fetcher data is identical on both sides. */
function serializeKey(key: ApiKeyListItem) {
  return {
    id: key.id,
    kind: key.kind,
    environment: key.environment,
    prefix: key.prefix,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
  };
}
type KeyRow = ReturnType<typeof serializeKey>;

const createKeySchema = z.object({
  kind: z.enum(API_KEY_KINDS, { message: "Pick a key kind." }),
  environment: z.enum(API_KEY_ENVIRONMENTS, {
    message: "Pick an environment.",
  }),
});

const revokeKeySchema = z.object({
  keyId: z.uuid("Unknown key."),
});

const removeOriginSchema = z.object({
  origin: z.string().min(1),
});

export type KeysActionData =
  | { fieldErrors: FieldErrors }
  | {
      created: {
        plaintext: string;
        prefix: string;
        kind: ApiKeyKind;
        environment: ApiKeyEnvironment;
      };
    }
  | { toast: ActionToast };

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const { env, log } = getCloudflare(args.context);
  const form = await args.request.formData();
  const intent = form.get("intent");

  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const ids = { projectId: project.id, accountId: account.id };

    switch (intent) {
      case "create-key": {
        const parsed = parseFormData(createKeySchema, form);
        if (!parsed.ok) {
          return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
        }
        const { key, plaintext } = await createApiKey(db, {
          projectId: project.id,
          ...parsed.data,
        });
        log.log("api_key.created", {
          project_id: project.id,
          api_key_id: key.id,
          kind: key.kind,
          environment: key.environment,
        });
        return data({
          created: {
            plaintext,
            prefix: key.prefix,
            kind: key.kind,
            environment: key.environment,
          },
        });
      }
      case "revoke-key": {
        const parsed = parseFormData(revokeKeySchema, form);
        if (!parsed.ok) {
          return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
        }
        const revoked = await revokeApiKey(db, {
          projectId: project.id,
          keyId: parsed.data.keyId,
        });
        if (!revoked) {
          return data(
            { fieldErrors: { keyId: ["This key is already revoked."] } },
            { status: 422 },
          );
        }
        // The api caches the resolved key in KV for up to a minute
        // (workers/api/src/auth-cache.ts, #108) and trusts the entry only
        // while the project's generation is unchanged — so the bump is what
        // makes the revocation take effect on /v1/query at once. It also
        // orphans the project's cached results, which is cheap and rare.
        await safeBumpProjectGeneration(env.CACHE, project.id, {
          log,
          site: "dashboard.generation_bump",
        });
        log.log("api_key.revoked", {
          project_id: project.id,
          api_key_id: revoked.id,
        });
        return data({
          toast: actionToast({
            tone: "positive",
            message: "Key revoked",
            detail: `${revoked.prefix}… no longer authenticates.`,
          }),
        });
      }
      case "add-origin": {
        const parsed = parseFormData(originSchema, form);
        if (!parsed.ok) {
          return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
        }
        if (project.allowedOrigins.includes(parsed.data.origin)) {
          return data(
            { fieldErrors: { origin: ["That origin is already listed."] } },
            { status: 422 },
          );
        }
        await setAllowedOrigins(db, ids, [
          ...project.allowedOrigins,
          parsed.data.origin,
        ]);
        // The allowlist rides in the api's cached auth context (#108).
        await safeBumpProjectGeneration(env.CACHE, project.id, {
          log,
          site: "dashboard.generation_bump",
        });
        log.log("project.origins_changed", {
          project_id: project.id,
          count: project.allowedOrigins.length + 1,
        });
        return data({
          toast: actionToast({ tone: "positive", message: "Origin added" }),
        });
      }
      case "remove-origin": {
        const parsed = parseFormData(removeOriginSchema, form);
        if (!parsed.ok) {
          return data({ fieldErrors: parsed.fieldErrors }, { status: 422 });
        }
        const next = project.allowedOrigins.filter(
          (origin) => origin !== parsed.data.origin,
        );
        await setAllowedOrigins(db, ids, next);
        await safeBumpProjectGeneration(env.CACHE, project.id, {
          log,
          site: "dashboard.generation_bump",
        });
        log.log("project.origins_changed", {
          project_id: project.id,
          count: next.length,
        });
        return data({
          toast: actionToast({ tone: "positive", message: "Origin removed" }),
        });
      }
      default:
        throw data("Unknown intent", { status: 400 });
    }
  });
}

// --- Component -------------------------------------------------------------

export default function ProjectKeys({ loaderData }: Route.ComponentProps) {
  const { project, keys } = loaderData;
  return (
    <div className="flex flex-col gap-6">
      <CreateKey keyCount={keys.length} />
      <KeysTable keys={keys} />
      <AllowedOrigins origins={project.allowedOrigins} />
    </div>
  );
}

const KIND_LABEL: Record<string, string> = {
  secret: "Secret",
  publishable: "Publishable",
};

const ENVIRONMENT_LABEL: Record<string, string> = {
  live: "Live",
  test: "Test",
};

function CreateKey({ keyCount }: { keyCount: number }) {
  const fetcher = useFetcher<KeysActionData>();
  // Before hydration the form posts as a document request and the result
  // arrives as route actionData instead of fetcher data; honour both so a
  // key minted by an early click is still revealed, never silently lost.
  const actionData = useActionData<KeysActionData>();
  const payload = fetcher.data ?? actionData;
  const [dismissed, setDismissed] = useState<string | null>(null);
  const created = payload && "created" in payload ? payload.created : null;
  const fieldErrors =
    payload && "fieldErrors" in payload ? payload.fieldErrors : undefined;
  const reveal = created && created.plaintext !== dismissed ? created : null;

  return (
    <Card
      title="Create a key"
      action={
        <span className="font-mono text-label text-gray-500">
          {keyCount === 1 ? "1 key" : `${keyCount} keys`}
        </span>
      }
    >
      <dl className="m-0 mb-5 grid gap-3 text-small text-gray-600 md:grid-cols-2">
        <div>
          <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
            Secret keys · pq_sk_
          </dt>
          <dd className="m-0 mt-1">
            Can ingest, manage and query reviews; keep them on your servers and
            never in a browser.
          </dd>
        </div>
        <div>
          <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
            Publishable keys · pq_pk_
          </dt>
          <dd className="m-0 mt-1">
            Can only query, and only from the allowed origins below, so they are
            safe in{" "}
            <a href={SNIPPET_README_URL} className="text-link">
              the snippet
            </a>{" "}
            and other browser code.
          </dd>
        </div>
      </dl>

      {reveal ? (
        <RevealPanel
          created={reveal}
          onDone={() => setDismissed(reveal.plaintext)}
        />
      ) : (
        <fetcher.Form
          method="post"
          className="flex flex-wrap items-end gap-3"
          aria-label="Create a key"
        >
          <input type="hidden" name="intent" value="create-key" />
          <SelectField
            name="kind"
            label="Kind"
            defaultValue="secret"
            options={API_KEY_KINDS.map((kind) => ({
              value: kind,
              label: KIND_LABEL[kind],
            }))}
            errors={fieldErrors}
            className="min-w-44"
          />
          <SelectField
            name="environment"
            label="Environment"
            defaultValue="live"
            options={API_KEY_ENVIRONMENTS.map((environment) => ({
              value: environment,
              label: ENVIRONMENT_LABEL[environment],
            }))}
            errors={fieldErrors}
            className="min-w-44"
          />
          <SubmitButton fetcher={fetcher} pendingLabel="Creating…">
            Create key
          </SubmitButton>
        </fetcher.Form>
      )}
    </Card>
  );
}

function RevealPanel({
  created,
  onDone,
}: {
  created: NonNullable<
    Extract<KeysActionData, { created: unknown }>["created"]
  >;
  onDone: () => void;
}) {
  return (
    <section
      aria-labelledby="reveal-heading"
      className="border border-ink-900 bg-surface-sunken p-4"
    >
      <div className="flex items-center gap-2">
        <KeyRound size={16} strokeWidth={1.75} aria-hidden />
        <h4 id="reveal-heading" className="m-0 text-title font-semibold">
          Your new {KIND_LABEL[created.kind]?.toLowerCase()} key
        </h4>
        <Badge tone={created.environment === "live" ? "positive" : "caution"}>
          {ENVIRONMENT_LABEL[created.environment]}
        </Badge>
      </div>
      <p className="mt-2 mb-3 text-small text-gray-600">
        Copy it now. For your safety it is stored hashed and{" "}
        <strong className="font-semibold text-ink-900">
          will not be shown again
        </strong>
        ; if you lose it, revoke it and create another.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <code
          data-testid="plaintext-key"
          className="select-all break-all border border-hairline bg-surface-card px-3 py-2.5 font-mono text-data text-ink-900"
        >
          {created.plaintext}
        </code>
        <CopyButton
          value={created.plaintext}
          label="Key copied"
          variant="primary"
          size="sm"
        >
          Copy key
        </CopyButton>
        <Button variant="ghost" size="sm" onClick={onDone}>
          Done
        </Button>
      </div>
    </section>
  );
}

function KeysTable({ keys }: { keys: KeyRow[] }) {
  return (
    <section aria-labelledby="keys-heading">
      <Overline id="keys-heading" className="mb-3">
        Keys
      </Overline>
      {keys.length === 0 ? (
        <div className="border border-hairline bg-surface-card px-6 py-12 text-center text-small text-gray-600">
          No keys yet. Create a secret key to start sending reviews, and a
          publishable key for the snippet.
        </div>
      ) : (
        <div className="overflow-x-auto border border-hairline bg-surface-card">
          <table className="w-full border-collapse text-small">
            <thead>
              <tr className="border-b border-hairline text-left">
                <Th>Key</Th>
                <Th>Kind</Th>
                <Th>Environment</Th>
                <Th>Created</Th>
                <Th>Last used</Th>
                <Th>Status</Th>
                <Th>
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {keys.map((key) => (
                <KeyRowView key={key.id} row={key} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th
      scope="col"
      className="px-4 py-2.5 font-mono text-label font-medium uppercase tracking-label text-gray-500"
    >
      {children}
    </th>
  );
}

function KeyRowView({ row }: { row: KeyRow }) {
  const fetcher = useFetcher<KeysActionData>();
  useFetcherToast(fetcher);
  const revoked = row.revokedAt !== null;
  const error =
    fetcher.data && "fieldErrors" in fetcher.data
      ? fetcher.data.fieldErrors.keyId?.[0]
      : undefined;
  return (
    <tr
      className={`border-b border-hairline last:border-b-0 ${revoked ? "text-gray-500" : ""}`}
    >
      <td className="px-4 py-3 font-mono text-data">
        {row.prefix}
        <span className="text-gray-400">…</span>
      </td>
      <td className="px-4 py-3">{KIND_LABEL[row.kind] ?? row.kind}</td>
      <td className="px-4 py-3">
        <Badge
          tone={
            revoked
              ? "neutral"
              : row.environment === "live"
                ? "positive"
                : "caution"
          }
        >
          {ENVIRONMENT_LABEL[row.environment] ?? row.environment}
        </Badge>
      </td>
      <td className="px-4 py-3 font-mono text-data tabular-nums">
        {formatDate(row.createdAt)}
      </td>
      <td className="px-4 py-3 font-mono text-data tabular-nums">
        {row.lastUsedAt ? formatDate(row.lastUsedAt) : "Never"}
      </td>
      <td className="px-4 py-3">
        {revoked ? (
          <Badge tone="negative">
            Revoked {formatDate(row.revokedAt ?? "")}
          </Badge>
        ) : (
          <Badge tone="positive">Active</Badge>
        )}
      </td>
      <td className="px-4 py-2 text-right">
        {!revoked && (
          <fetcher.Form method="post" className="inline-block text-left">
            <InlineConfirm
              trigger="Revoke"
              triggerVariant="ghost"
              message={`Revoking ${row.prefix}… is permanent. Anything still using this key stops working at once.`}
              confirmLabel="Revoke key"
              pendingLabel="Revoking…"
              fetcher={fetcher}
              error={error}
              className="min-w-72"
            >
              <input type="hidden" name="intent" value="revoke-key" />
              <input type="hidden" name="keyId" value={row.id} />
            </InlineConfirm>
          </fetcher.Form>
        )}
      </td>
    </tr>
  );
}

/** `2026-09-28` — UTC date only, identical on server and client. */
function formatDate(iso: string): string {
  return iso.slice(0, 10);
}

function AllowedOrigins({ origins }: { origins: string[] }) {
  const addFetcher = useFetcher<KeysActionData>();
  useFetcherToast(addFetcher);
  const fieldErrors =
    addFetcher.data && "fieldErrors" in addFetcher.data
      ? addFetcher.data.fieldErrors
      : undefined;
  // Remount the form after each successful add so the input clears.
  const formKey =
    addFetcher.data && "toast" in addFetcher.data
      ? addFetcher.data.toast.id
      : "idle";

  return (
    <Card title="Allowed origins">
      <p className="m-0 mb-4 text-small text-gray-600">
        Browsers may use a publishable key only from these origins — exact
        scheme, host and port, like{" "}
        <span className="font-mono">https://www.example.com</span>. Secret keys
        ignore this list. With no origins, publishable keys are refused from
        every browser.
      </p>
      {origins.length === 0 ? (
        <p className="m-0 mb-4 border border-dashed border-hairline px-4 py-6 text-center text-small text-gray-500">
          No origins yet.
        </p>
      ) : (
        <ul className="m-0 mb-4 list-none border border-hairline p-0">
          {origins.map((origin) => (
            <OriginRow key={origin} origin={origin} />
          ))}
        </ul>
      )}
      <addFetcher.Form
        method="post"
        className="flex flex-wrap items-end gap-3"
        aria-label="Add an origin"
        key={formKey}
      >
        <input type="hidden" name="intent" value="add-origin" />
        <Field
          name="origin"
          label="Add origin"
          placeholder="https://www.example.com"
          autoComplete="off"
          spellCheck={false}
          inputMode="url"
          errors={fieldErrors}
          className="min-w-80 flex-1 font-mono"
        />
        <SubmitButton
          variant="secondary"
          fetcher={addFetcher}
          pendingLabel="Adding…"
        >
          Add origin
        </SubmitButton>
      </addFetcher.Form>
    </Card>
  );
}

function OriginRow({ origin }: { origin: string }) {
  const fetcher = useFetcher<KeysActionData>();
  useFetcherToast(fetcher);
  const removing = fetcher.state !== "idle";
  return (
    <li
      className={`flex items-center justify-between gap-3 border-b border-hairline px-4 py-2.5 last:border-b-0 ${removing ? "opacity-40" : ""}`}
    >
      <span className="font-mono text-data text-ink-900">{origin}</span>
      <fetcher.Form method="post">
        <input type="hidden" name="intent" value="remove-origin" />
        <input type="hidden" name="origin" value={origin} />
        <SubmitButton
          variant="ghost"
          size="sm"
          fetcher={fetcher}
          pendingLabel="Removing…"
        >
          Remove
        </SubmitButton>
      </fetcher.Form>
    </li>
  );
}
