// Query playground (#40): type a query, pick mode and filters, and see what
// `/v1/query` would return — plus what it would not. The loader runs the
// api's exact policy through `searchChunks` in its debug variant, so the
// page can draw the relevance floor and grey out the candidates that fell
// under it. A GET form keeps every run in the URL: shareable, reloadable,
// and the back button steps through experiments.

import { Play } from "lucide-react";
import { useState } from "react";
import { data, Form, useLocation, useNavigation } from "react-router";
import { CopyButton } from "~/components/playground/copy-button";
import { FloorLine } from "~/components/playground/floor-line";
import { ResultCard } from "~/components/playground/result-card";
import { EnvToggle } from "~/components/reviews/env-toggle";
import { Overline } from "~/components/shell/page-header";
import { Button } from "~/components/ui/button";
import { Input, Label, Select } from "~/components/ui/form-controls";
import { Skeleton } from "~/components/ui/skeleton";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import {
  curlFor,
  DEFAULT_LIMIT,
  type FieldErrors,
  MAX_SEARCH_LIMIT,
  PLAYGROUND_MODES,
  type PlaygroundRequest,
  parsePlaygroundParams,
  snippetFor,
} from "~/lib/playground";
import {
  getEmbedder,
  type PlaygroundOutcome,
  runPlayground,
} from "~/lib/playground.server";
import { listReviewSources } from "~/lib/reviews.server";
import type { Route } from "./+types/app.projects.$slug.playground";

/** `PlaygroundRequest` with `since` dropped: the string form travels. */
export type PlaygroundFormValues = Omit<PlaygroundRequest, "since">;

export interface PlaygroundData {
  project: {
    slug: string;
    name: string;
    minRating: number;
    similarityFloor: number;
  };
  apiUrl: string;
  request: PlaygroundFormValues;
  fieldErrors: FieldErrors;
  sources: string[];
  outcome: PlaygroundOutcome | null;
  curl: string;
  snippet: string;
}

export async function loader(args: Route.LoaderArgs): Promise<PlaygroundData> {
  const { account } = await requireAccount(args);
  const { env } = getCloudflare(args.context);
  const { request, fieldErrors } = parsePlaygroundParams(
    new URL(args.request.url).searchParams,
  );

  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const policy = {
      minRating: project.minRating,
      similarityFloor: project.similarityFloor,
    };
    const [sources, outcome] = await Promise.all([
      listReviewSources(db, {
        projectId: project.id,
        environment: request.environment,
      }),
      Object.keys(fieldErrors).length === 0
        ? runPlayground(db, getEmbedder(env), {
            projectId: project.id,
            project: policy,
            request,
          })
        : Promise.resolve(null),
    ]);
    const { since: _since, ...formValues } = request;
    return {
      project: {
        slug: project.slug,
        name: project.name,
        ...policy,
      },
      apiUrl: env.API_URL,
      request: formValues,
      fieldErrors,
      sources,
      outcome,
      curl: curlFor(request, env.API_URL),
      snippet: snippetFor(request, env.API_URL),
    };
  });
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Playground · ${data.project.name} · ProofQL` : "ProofQL" },
];

export default function ProjectPlayground({
  loaderData,
}: Route.ComponentProps) {
  const { project, request, fieldErrors, sources, outcome, curl, snippet } =
    loaderData;
  const base = `/app/projects/${project.slug}`;
  const location = useLocation();
  const navigation = useNavigation();
  const pending =
    navigation.state === "loading" &&
    navigation.location?.pathname === location.pathname;

  return (
    <section
      aria-labelledby="playground-heading"
      className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]"
    >
      <h2 id="playground-heading" className="sr-only">
        Query playground
      </h2>

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-4">
          <Overline>Query</Overline>
          <EnvToggle environment={request.environment} reset={[]} />
        </div>
        <QueryForm
          action={`${base}/playground`}
          request={request}
          fieldErrors={fieldErrors}
          sources={sources}
          pending={pending}
        />
        <div className="flex flex-col gap-3 border border-hairline bg-surface-card p-4">
          <div className="flex items-center justify-between gap-3">
            <Overline>As an api call</Overline>
            <CopyButton text={curl}>Copy as curl</CopyButton>
          </div>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all bg-surface-sunken p-3 font-mono text-label leading-relaxed text-ink-900">
            <code>{curl}</code>
          </pre>
          <div className="flex items-center justify-between gap-3 border-t border-hairline pt-3">
            <Overline>As the snippet</Overline>
            <CopyButton text={snippet}>Copy as snippet</CopyButton>
          </div>
          <pre className="m-0 overflow-x-auto whitespace-pre-wrap break-all bg-surface-sunken p-3 font-mono text-label leading-relaxed text-ink-900">
            <code>{snippet}</code>
          </pre>
          <p className="m-0 text-label text-gray-500">
            Keys are placeholders — the dashboard stores only hashes. Paste a
            real one from the Keys tab.
          </p>
        </div>
      </div>

      <div className="flex min-w-0 flex-col gap-3">
        {pending ? (
          <ResultsSkeleton />
        ) : outcome === null ? (
          <p className="m-0 border border-hairline bg-surface-card p-5 text-small text-gray-600">
            Fix the highlighted fields to run the query.
          </p>
        ) : (
          <Results
            outcome={outcome}
            request={request}
            projectFloor={project.similarityFloor}
            reviewHref={(id) =>
              `${base}/reviews/${id}${request.environment === "test" ? "?env=test" : ""}`
            }
          />
        )}
      </div>
    </section>
  );
}

function QueryForm({
  action,
  request,
  fieldErrors,
  sources,
  pending,
}: {
  action: string;
  request: PlaygroundFormValues;
  fieldErrors: FieldErrors;
  sources: string[];
  pending: boolean;
}) {
  const initialPairs = Object.entries(request.metadata);
  const [pairCount, setPairCount] = useState(Math.max(1, initialPairs.length));

  return (
    <Form
      method="get"
      action={action}
      className="flex flex-col gap-4 border border-hairline bg-surface-card p-4"
      aria-label="Query"
    >
      {request.environment !== "live" && (
        <input type="hidden" name="env" value={request.environment} />
      )}
      <Label
        error={fieldErrors.q}
        hint="Leave empty for the newest publishable reviews."
      >
        Query text
        <Input
          name="q"
          defaultValue={request.q ?? ""}
          placeholder="parking, implants, gentle with kids…"
          maxLength={500}
          aria-invalid={fieldErrors.q ? true : undefined}
          autoComplete="off"
        />
      </Label>

      <div className="grid grid-cols-2 gap-3">
        <Label error={fieldErrors.mode}>
          Mode
          <Select name="mode" defaultValue={request.mode}>
            {PLAYGROUND_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </Select>
        </Label>
        <Label error={fieldErrors.limit}>
          Limit
          <Input
            name="limit"
            type="number"
            min={1}
            max={MAX_SEARCH_LIMIT}
            step={1}
            defaultValue={request.limit === DEFAULT_LIMIT ? "" : request.limit}
            placeholder={String(DEFAULT_LIMIT)}
            aria-invalid={fieldErrors.limit ? true : undefined}
          />
        </Label>
        <Label
          error={fieldErrors.min_rating}
          hint="Tightens the project policy; never loosens it."
        >
          Min rating
          <Select name="min_rating" defaultValue={request.minRating ?? ""}>
            <option value="">Project default</option>
            {[5, 4, 3, 2, 1].map((n) => (
              <option key={n} value={n}>
                {n}+
              </option>
            ))}
          </Select>
        </Label>
        <Label error={fieldErrors.source}>
          Source
          <Select name="source" defaultValue={request.source ?? ""}>
            <option value="">Any source</option>
            {(request.source && !sources.includes(request.source)
              ? [...sources, request.source]
              : sources
            ).map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </Select>
        </Label>
        <Label error={fieldErrors.since} className="col-span-2">
          Since
          <Input
            name="since"
            type="date"
            defaultValue={request.sinceRaw ?? ""}
            aria-invalid={fieldErrors.since ? true : undefined}
          />
        </Label>
      </div>

      <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
        <legend className="mb-1.5 font-mono text-label font-medium uppercase tracking-label text-gray-500">
          Metadata filters
        </legend>
        {Array.from({ length: pairCount }, (_, i) => {
          const [key, value] = initialPairs[i] ?? ["", ""];
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: positional pairs, never reordered
            <div key={i} className="grid grid-cols-2 gap-2">
              <Input
                name="mk"
                defaultValue={key}
                placeholder="key, e.g. location"
                aria-label={`Metadata key ${i + 1}`}
                aria-invalid={fieldErrors.metadata ? true : undefined}
              />
              <Input
                name="mv"
                defaultValue={value}
                placeholder="value, e.g. north"
                aria-label={`Metadata value ${i + 1}`}
              />
            </div>
          );
        })}
        {fieldErrors.metadata && (
          <span className="font-sans text-label text-red-700">
            {fieldErrors.metadata}
          </span>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setPairCount((n) => n + 1)}
        >
          Add pair
        </Button>
      </fieldset>

      <div className="flex items-center justify-between gap-3 border-t border-hairline pt-4">
        <Button type="submit" disabled={pending}>
          <Play size={13} strokeWidth={2.25} aria-hidden />
          {pending ? "Running…" : "Run query"}
        </Button>
      </div>
    </Form>
  );
}

function Results({
  outcome,
  request,
  projectFloor,
  reviewHref,
}: {
  outcome: PlaygroundOutcome;
  request: PlaygroundFormValues;
  projectFloor: number;
  reviewHref: (id: string) => string;
}) {
  if (!outcome.ok) {
    return (
      <div
        role="alert"
        className="border border-red-700 bg-status-negative-bg p-5 text-small text-ink-900"
      >
        <Overline className="mb-2 text-red-700">embedding_unavailable</Overline>
        The embedding service is temporarily unavailable; retry the query
        shortly. This is the same 503 the api returns — there is no
        full-text-only fallback, by design.
      </div>
    );
  }

  const above = outcome.results.filter((r) => !r.belowFloor);
  const below = outcome.results.filter((r) => r.belowFloor);
  const hasQuery = request.q !== undefined;

  return (
    <>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <Overline>
          {hasQuery ? "Results" : "No query · newest publishable reviews"}
        </Overline>
        <dl className="m-0 flex flex-wrap gap-x-4 font-mono text-label text-gray-500">
          <Stat label="took_ms" value={outcome.tookMs} />
          {hasQuery && (
            <Stat label="embed" value={`${outcome.embeddingMs} ms`} />
          )}
          <Stat label="search" value={`${outcome.searchMs} ms`} />
          <Stat label="cached" value="no · direct" />
          <Stat label="min_rating" value={outcome.policy.minRating} />
          <Stat
            label="floor"
            value={outcome.policy.similarityFloor.toFixed(2)}
          />
        </dl>
      </header>

      {above.length === 0 && (
        <p className="m-0 border border-dashed border-gray-300 bg-surface-card p-5 text-small text-gray-600">
          {hasQuery
            ? "Nothing clears the floor. The api would return an empty list and the snippet would render nothing — empty beats irrelevant."
            : "No publishable reviews match. Hidden reviews, ratings under the minimum, and unindexed reviews never appear here."}
        </p>
      )}
      {above.map((r, i) => (
        <ResultCard
          key={r.chunkId}
          result={r}
          rank={i + 1}
          floor={outcome.policy.similarityFloor}
          mode={request.mode}
          reviewHref={reviewHref(r.reviewId)}
        />
      ))}

      {hasQuery && (
        <>
          <FloorLine
            floor={projectFloor}
            above={above.length}
            below={below.length}
          />
          {below.length === 0 ? (
            <p className="m-0 text-label text-gray-500">
              No candidates below the floor within this limit.
            </p>
          ) : (
            below.map((r, i) => (
              <ResultCard
                key={r.chunkId}
                result={r}
                rank={above.length + i + 1}
                floor={outcome.policy.similarityFloor}
                mode={request.mode}
                reviewHref={reviewHref(r.reviewId)}
              />
            ))
          )}
        </>
      )}
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex gap-1.5">
      <dt>{label}</dt>
      <dd className="m-0 text-ink-900 tabular-nums">{value}</dd>
    </span>
  );
}

/** Static placeholder keys — rows are never reordered. */
const SKELETON_CARDS = Array.from({ length: 3 }, (_, i) => `skeleton-${i}`);

function ResultsSkeleton() {
  return (
    <div
      role="status"
      className="flex flex-col gap-3"
      aria-busy
      aria-label="Running query"
    >
      <Skeleton className="h-2.5 w-40" />
      {SKELETON_CARDS.map((id) => (
        <div
          key={id}
          className="flex flex-col gap-3 border border-hairline bg-surface-card p-4"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-3 w-8" />
            <Skeleton className="h-3 w-12" />
            <Skeleton className="h-1.5 flex-1" />
          </div>
          <Skeleton className="h-3 w-full" />
          <Skeleton className="h-3 w-4/5" />
          <Skeleton className="h-3 w-48" />
        </div>
      ))}
    </div>
  );
}
