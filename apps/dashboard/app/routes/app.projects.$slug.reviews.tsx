// Review browser (#39): the project's reviews per environment as a keyset-
// paginated table with filters, bulk hide/unhide, and a row → detail link.
// The loader reads everything from the URL (env, filters, cursor) so a view
// is shareable and the back button walks pages; the action hides/unhides
// any number of rows in one statement and one cache-generation bump.
import { Inbox, SearchX } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  data,
  Form,
  Link,
  useFetcher,
  useLocation,
  useNavigation,
  useSubmit,
} from "react-router";

import { EnvToggle } from "~/components/reviews/env-toggle";
import {
  ReviewTable,
  type ReviewTableRow,
} from "~/components/reviews/review-table";
import { Button, buttonVariants } from "~/components/ui/button";
import { Label, Select } from "~/components/ui/form-controls";
import { Skeleton } from "~/components/ui/skeleton";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import {
  type Environment,
  HIDDEN_FILTERS,
  INDEXED_FILTERS,
  isUuid,
  listSearchParams,
  PAGE_SIZE,
  parseEnvironment,
  parseListParams,
  type ReviewListFilters,
  reviewStatus,
} from "~/lib/reviews";
import {
  listReviewSources,
  listReviews,
  type ReviewListRow,
  setReviewsHidden,
} from "~/lib/reviews.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.projects.$slug.reviews";

/** The CSV upload (#38) lands as its own tab; until then the issue is the link. */
export const CSV_IMPORT_HREF =
  "https://github.com/plattegruber/proofql/issues/38";
export const API_DOCS_HREF =
  "https://github.com/plattegruber/proofql/blob/main/docs/scope.md#ingest";

export function toTableRow(row: ReviewListRow): ReviewTableRow {
  return {
    id: row.id,
    source: row.source,
    rating: row.rating,
    text: row.text,
    authorName: row.authorName,
    occurredAt: row.occurredAt?.toISOString() ?? null,
    hidden: row.hiddenAt !== null,
    status: reviewStatus(row),
    sentiment: row.sentiment,
    sentimentSource: row.sentimentSource,
    chunkCount: row.chunkCount,
  };
}

export async function loader(args: Route.LoaderArgs) {
  const { account } = await requireAccount(args);
  const params = parseListParams(new URL(args.request.url).searchParams);

  const { project, list, sources } = await withRequestDb(
    args.context,
    async (db) => {
      const project = await findProjectBySlug(db, account.id, args.params.slug);
      if (!project) throw data(null, { status: 404 });
      const scope = { projectId: project.id, environment: params.environment };
      const [list, sources] = await Promise.all([
        listReviews(db, {
          ...scope,
          cursor: params.cursor,
          limit: PAGE_SIZE,
          filters: params.filters,
        }),
        listReviewSources(db, scope),
      ]);
      return { project, list, sources };
    },
  );

  return {
    project: { slug: project.slug, name: project.name },
    environment: params.environment,
    filters: params.filters,
    cursor: params.cursor,
    rows: list.rows.map(toTableRow),
    nextCursor: list.nextCursor,
    sources,
  };
}

export type BulkIntent = "hide" | "unhide";

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  const form = await args.request.formData();
  const intent = form.get("intent");
  if (intent !== "hide" && intent !== "unhide") {
    throw data("Unknown intent.", { status: 400 });
  }
  const ids = form
    .getAll("id")
    .filter((v): v is string => typeof v === "string");
  if (ids.length === 0 || !ids.every(isUuid)) {
    throw data("Select at least one review.", { status: 400 });
  }
  const environment: Environment = parseEnvironment(
    typeof form.get("env") === "string" ? (form.get("env") as string) : null,
  );
  const { env } = getCloudflare(args.context);

  const result = await withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    return setReviewsHidden(db, env.CACHE, {
      projectId: project.id,
      environment,
      ids,
      hidden: intent === "hide",
    });
  });

  return {
    ok: true as const,
    intent: intent as BulkIntent,
    changed: result.changed,
  };
}

export const meta: Route.MetaFunction = ({ data }) => [
  { title: data ? `Reviews · ${data.project.name} · ProofQL` : "ProofQL" },
];

export default function ProjectReviews({ loaderData }: Route.ComponentProps) {
  const { project, environment, filters, cursor, rows, nextCursor, sources } =
    loaderData;
  const base = `/app/projects/${project.slug}/reviews`;
  const location = useLocation();
  const navigation = useNavigation();
  const pending =
    navigation.state === "loading" &&
    navigation.location?.pathname === location.pathname;

  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const fetcher = useFetcher<typeof action>();
  // A bulk result clears the selection once; the ref stops a re-render
  // from clearing a fresh selection against the same stale result.
  const lastResult = useRef<unknown>(null);
  useEffect(() => {
    if (
      fetcher.state === "idle" &&
      fetcher.data &&
      fetcher.data !== lastResult.current
    ) {
      lastResult.current = fetcher.data;
      setSelected(new Set());
    }
  }, [fetcher.state, fetcher.data]);

  const filtersActive =
    filters.source !== undefined ||
    filters.minRating !== undefined ||
    filters.hidden !== "all" ||
    filters.indexed !== "all";
  const pageHref = (next: string | null) =>
    `${base}?${listSearchParams({ environment, filters, cursor: next })}`;

  return (
    <section aria-labelledby="reviews-heading" className="flex flex-col gap-4">
      <h2 id="reviews-heading" className="sr-only">
        Reviews
      </h2>

      <div className="flex flex-wrap items-end justify-between gap-4">
        <FilterBar
          base={base}
          environment={environment}
          filters={filters}
          sources={sources}
        />
        <EnvToggle environment={environment} />
      </div>

      {selected.size > 0 && (
        <fetcher.Form
          method="post"
          className="flex flex-wrap items-center gap-3 border border-ink-900 bg-surface-sunken px-4 py-2.5"
          aria-label="Bulk actions"
        >
          <input type="hidden" name="env" value={environment} />
          {[...selected].map((id) => (
            <input key={id} type="hidden" name="id" value={id} />
          ))}
          <span className="font-mono text-data tabular-nums text-ink-900">
            {selected.size} selected
          </span>
          <Button
            type="submit"
            name="intent"
            value="hide"
            size="sm"
            disabled={fetcher.state !== "idle"}
          >
            {fetcher.state !== "idle" &&
            fetcher.formData?.get("intent") === "hide"
              ? "Hiding…"
              : "Hide selected"}
          </Button>
          <Button
            type="submit"
            name="intent"
            value="unhide"
            variant="secondary"
            size="sm"
            disabled={fetcher.state !== "idle"}
          >
            {fetcher.state !== "idle" &&
            fetcher.formData?.get("intent") === "unhide"
              ? "Unhiding…"
              : "Unhide selected"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            Clear
          </Button>
        </fetcher.Form>
      )}
      {fetcher.data && fetcher.state === "idle" && selected.size === 0 && (
        <p role="status" className="m-0 font-mono text-label text-gray-600">
          {bulkSummary(fetcher.data)}
        </p>
      )}

      {pending ? (
        <TableSkeleton />
      ) : rows.length === 0 ? (
        filtersActive || cursor ? (
          <EmptyState
            icon={SearchX}
            title="No reviews match these filters"
            body="Loosen a filter, or switch environment. Hidden and unindexed reviews are still here — pick “all” to see them."
            action={
              <Link
                to={`${base}${environment === "test" ? "?env=test" : ""}`}
                className={cn(
                  buttonVariants({ variant: "secondary", size: "sm" }),
                  "no-underline",
                )}
              >
                Clear filters
              </Link>
            }
          />
        ) : (
          <EmptyState
            icon={Inbox}
            title="No reviews yet"
            body={
              <>
                Reviews arrive by CSV upload, the push API, or a connected
                Google account. Upload a CSV from the{" "}
                <a href={CSV_IMPORT_HREF}>import tab</a> or send a batch to{" "}
                <code className="font-mono text-data">POST /v1/reviews</code>{" "}
                with a {environment} secret key — see the{" "}
                <a href={API_DOCS_HREF}>API docs</a>.
              </>
            }
          />
        )
      ) : (
        <>
          <ReviewTable
            rows={rows}
            detailHref={(id) =>
              `${base}/${id}${environment === "test" ? "?env=test" : ""}`
            }
            selected={selected}
            onToggle={(id, checked) =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (checked) next.add(id);
                else next.delete(id);
                return next;
              })
            }
            onToggleAll={(checked) =>
              setSelected(checked ? new Set(rows.map((r) => r.id)) : new Set())
            }
          />
          <nav
            aria-label="Pagination"
            className="flex items-center justify-between gap-4 font-mono text-label text-gray-500"
          >
            <span>
              {rows.length} {rows.length === 1 ? "review" : "reviews"} on this
              page
              {cursor ? "" : nextCursor ? " · first page" : ""}
            </span>
            <span className="inline-flex gap-2">
              {cursor && (
                <Link
                  to={pageHref(null)}
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "sm" }),
                    "no-underline",
                  )}
                >
                  First page
                </Link>
              )}
              {nextCursor ? (
                <Link
                  to={pageHref(nextCursor)}
                  className={cn(
                    buttonVariants({ variant: "secondary", size: "sm" }),
                    "no-underline",
                  )}
                >
                  Next page
                </Link>
              ) : (
                <span className="px-3 py-2">Last page</span>
              )}
            </span>
          </nav>
        </>
      )}
    </section>
  );
}

function bulkSummary(result: { intent: BulkIntent; changed: number }): string {
  const verb = result.intent === "hide" ? "Hid" : "Unhid";
  if (result.changed === 0) {
    return result.intent === "hide"
      ? "Nothing to hide — those reviews were already hidden."
      : "Nothing to unhide — those reviews were already visible.";
  }
  const noun = result.changed === 1 ? "review" : "reviews";
  return `${verb} ${result.changed} ${noun}. The query cache for this project was purged.`;
}

function FilterBar({
  base,
  environment,
  filters,
  sources,
}: {
  base: string;
  environment: Environment;
  filters: ReviewListFilters;
  sources: string[];
}) {
  const submit = useSubmit();
  // Keep a source the user filtered on even if the page's distinct list
  // no longer includes it (the environment switched, say).
  const sourceOptions =
    filters.source && !sources.includes(filters.source)
      ? [...sources, filters.source]
      : sources;
  return (
    <Form
      method="get"
      action={base}
      className="flex flex-wrap items-end gap-3"
      aria-label="Filters"
      onChange={(e) => submit(e.currentTarget, { replace: true })}
    >
      {environment !== "live" && (
        <input type="hidden" name="env" value={environment} />
      )}
      <Label className="w-36">
        Source
        <Select name="source" defaultValue={filters.source ?? ""}>
          <option value="">All sources</option>
          {sourceOptions.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-36">
        Min rating
        <Select name="min_rating" defaultValue={filters.minRating ?? ""}>
          <option value="">Any rating</option>
          {[5, 4, 3, 2, 1].map((n) => (
            <option key={n} value={n}>
              {n === 5 ? "5 stars" : `${n}+ stars`}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-32">
        Hidden
        <Select name="hidden" defaultValue={filters.hidden}>
          {HIDDEN_FILTERS.map((h) => (
            <option key={h} value={h}>
              {h === "all" ? "All" : h === "visible" ? "Visible" : "Hidden"}
            </option>
          ))}
        </Select>
      </Label>
      <Label className="w-32">
        Indexed
        <Select name="indexed" defaultValue={filters.indexed}>
          {INDEXED_FILTERS.map((i) => (
            <option key={i} value={i}>
              {i === "all" ? "All" : i === "indexed" ? "Indexed" : "Pending"}
            </option>
          ))}
        </Select>
      </Label>
      <noscript>
        <Button type="submit" variant="secondary" size="sm">
          Apply
        </Button>
      </noscript>
    </Form>
  );
}

function EmptyState({
  icon: Icon,
  title,
  body,
  action,
}: {
  icon: typeof Inbox;
  title: string;
  body: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center border border-hairline bg-surface-card px-8 py-20 text-center">
      <Icon
        size={20}
        strokeWidth={1.75}
        className="text-gray-400"
        aria-hidden
      />
      <h3 className="mt-4.5 mb-0 text-title font-semibold">{title}</h3>
      <p className="mx-auto mt-2.5 mb-0 max-w-130 text-small text-gray-600">
        {body}
      </p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

/** Static placeholder keys — rows are never reordered. */
const SKELETON_ROWS = Array.from({ length: 8 }, (_, i) => `skeleton-${i}`);

function TableSkeleton() {
  return (
    <div
      className="border border-hairline bg-surface-card"
      role="status"
      aria-busy
      aria-label="Loading reviews"
    >
      <div className="border-b border-hairline bg-surface-sunken px-3 py-3">
        <Skeleton className="h-2.5 w-48" />
      </div>
      {SKELETON_ROWS.map((id) => (
        <div
          key={id}
          className="flex items-center gap-4 border-b border-hairline px-3 py-3.5 last:border-b-0"
        >
          <Skeleton className="h-3.5 w-4" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 flex-1" />
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-3 w-20" />
          <Skeleton className="h-3 w-8" />
          <Skeleton className="h-3 w-16" />
        </div>
      ))}
    </div>
  );
}
