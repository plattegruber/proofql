// Review detail (#39): the whole review, its metadata, every chunk the
// pipeline cut from it (kind, offsets, embedded or not), and the inline
// Hide / Unhide. Hiding asks once, inline — it takes effect on the next
// query and the snippet, which is worth a second click; unhiding does not.
import type { ChunkKind } from "@proofql/core";
import { ArrowLeft } from "lucide-react";
import { useEffect, useState } from "react";
import { data, Link, useFetcher } from "react-router";

import { SentimentJudgment, StatusBadge } from "~/components/reviews/judgments";
import { Stars } from "~/components/reviews/stars";
import { Overline } from "~/components/shell/page-header";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import { requireAccount } from "~/lib/account.server";
import { findProjectBySlug } from "~/lib/accounts";
import { getCloudflare } from "~/lib/context";
import { withRequestDb } from "~/lib/db.server";
import {
  formatDateTime,
  isUuid,
  type ReviewStatus,
  reviewStatus,
} from "~/lib/reviews";
import {
  getReviewDetail,
  type ReviewChunkRow,
  type ReviewDetail,
  setReviewsHidden,
} from "~/lib/reviews.server";
import { cn } from "~/lib/utils";
import type { Route } from "./+types/app.projects.$slug.reviews.$id";

/** The wire shape of the page: dates as ISO strings, booleans resolved. */
export interface ReviewDetailData {
  project: { slug: string; name: string };
  review: {
    id: string;
    environment: "live" | "test";
    source: string;
    externalId: string;
    rating: number | null;
    text: string;
    authorName: string | null;
    authorAvatarUrl: string | null;
    occurredAt: string | null;
    url: string | null;
    language: string | null;
    metadata: Record<string, string>;
    sentiment: "positive" | "neutral" | "negative" | null;
    sentimentSource: "rating" | "model" | null;
    hidden: boolean;
    hiddenAt: string | null;
    status: ReviewStatus;
    indexedAt: string | null;
    indexAttempts: number;
    createdAt: string;
    updatedAt: string;
  };
  chunks: Array<{
    id: string;
    kind: ChunkKind;
    text: string;
    startOffset: number;
    endOffset: number;
    embedded: boolean;
    createdAt: string;
  }>;
}

export function toDetailData(
  project: { slug: string; name: string },
  detail: ReviewDetail,
): ReviewDetailData {
  const r = detail.review;
  return {
    project,
    review: {
      id: r.id,
      environment: r.environment,
      source: r.source,
      externalId: r.externalId,
      rating: r.rating,
      text: r.text,
      authorName: r.authorName,
      authorAvatarUrl: r.authorAvatarUrl,
      occurredAt: r.occurredAt?.toISOString() ?? null,
      url: r.url,
      language: r.language,
      metadata: r.metadata,
      sentiment: r.sentiment,
      sentimentSource: r.sentimentSource,
      hidden: r.hiddenAt !== null,
      hiddenAt: r.hiddenAt?.toISOString() ?? null,
      status: reviewStatus(r),
      indexedAt: r.indexedAt?.toISOString() ?? null,
      indexAttempts: r.indexAttempts,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    },
    chunks: detail.chunks.map((c: ReviewChunkRow) => ({
      id: c.id,
      kind: c.kind,
      text: c.text,
      startOffset: c.startOffset,
      endOffset: c.startOffset + c.text.length,
      embedded: c.embedded,
      createdAt: c.createdAt.toISOString(),
    })),
  };
}

export async function loader(
  args: Route.LoaderArgs,
): Promise<ReviewDetailData> {
  const { account } = await requireAccount(args);
  if (!isUuid(args.params.id)) throw data(null, { status: 404 });

  return withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const detail = await getReviewDetail(db, {
      projectId: project.id,
      id: args.params.id,
    });
    if (!detail) throw data(null, { status: 404 });
    return toDetailData({ slug: project.slug, name: project.name }, detail);
  });
}

export async function action(args: Route.ActionArgs) {
  const { account } = await requireAccount(args);
  if (!isUuid(args.params.id)) throw data(null, { status: 404 });
  const form = await args.request.formData();
  const intent = form.get("intent");
  if (intent !== "hide" && intent !== "unhide") {
    throw data("Unknown intent.", { status: 400 });
  }
  const { env } = getCloudflare(args.context);

  const result = await withRequestDb(args.context, async (db) => {
    const project = await findProjectBySlug(db, account.id, args.params.slug);
    if (!project) throw data(null, { status: 404 });
    const detail = await getReviewDetail(db, {
      projectId: project.id,
      id: args.params.id,
    });
    if (!detail) throw data(null, { status: 404 });
    return setReviewsHidden(db, env.CACHE, {
      projectId: project.id,
      environment: detail.review.environment,
      ids: [detail.review.id],
      hidden: intent === "hide",
    });
  });
  return { ok: true as const, intent, changed: result.changed };
}

export const meta: Route.MetaFunction = ({ data }) => [
  {
    title: data
      ? `${data.review.authorName ?? "Review"} · ${data.project.name} · ProofQL`
      : "ProofQL",
  },
];

export default function ReviewDetailPage({ loaderData }: Route.ComponentProps) {
  const { project, review, chunks } = loaderData;
  const listHref = `/app/projects/${project.slug}/reviews${
    review.environment === "test" ? "?env=test" : ""
  }`;

  return (
    <article className="flex flex-col gap-5" aria-labelledby="review-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link
            to={listHref}
            className="inline-flex items-center gap-1.5 font-mono text-label uppercase tracking-label text-gray-500 no-underline hover:text-ink-900"
          >
            <ArrowLeft size={13} strokeWidth={2} aria-hidden />
            All reviews
          </Link>
          <h2
            id="review-heading"
            className="mt-2 mb-0 flex flex-wrap items-center gap-3 text-title font-semibold"
          >
            <span>{review.authorName ?? "Unknown author"}</span>
            <Stars rating={review.rating} />
          </h2>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 font-mono text-label text-gray-500">
            <span>{review.source}</span>
            <span aria-hidden>·</span>
            <span>{formatDateTime(review.occurredAt)}</span>
            <span aria-hidden>·</span>
            <Badge tone={review.environment === "live" ? "brand" : "neutral"}>
              {review.environment}
            </Badge>
            {review.hidden && <Badge tone="caution">hidden</Badge>}
          </div>
        </div>
        <HideControl hidden={review.hidden} />
      </div>

      <Card sunken className={cn(review.hidden && "opacity-70")}>
        <Overline className="mb-3">Review text</Overline>
        <p className="m-0 whitespace-pre-wrap font-mono text-quote leading-relaxed text-ink-900">
          {review.text}
        </p>
      </Card>

      <div className="grid gap-5 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <Card title={`Chunks · ${chunks.length}`}>
          <p className="mt-0 mb-4 text-small text-gray-600">
            What the pipeline cut from this review, each a verbatim slice of the
            text above (scope §2 “Chunking”). The best-matching chunk is the
            excerpt a query returns.
          </p>
          {chunks.length === 0 ? (
            <p className="m-0 border border-dashed border-gray-300 p-4 text-small text-gray-600">
              No chunks yet — the pipeline has not indexed this review.
            </p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-3 p-0">
              {chunks.map((chunk) => (
                <li
                  key={chunk.id}
                  className="border border-hairline bg-surface-card p-3.5"
                >
                  <div className="mb-2 flex flex-wrap items-center gap-2 font-mono text-label text-gray-500">
                    <Badge tone={chunk.kind === "full" ? "brand" : "neutral"}>
                      {chunk.kind}
                    </Badge>
                    <span className="tabular-nums">
                      offsets {chunk.startOffset}–{chunk.endOffset}
                    </span>
                    <span aria-hidden>·</span>
                    <span className="tabular-nums">
                      {chunk.text.length} chars
                    </span>
                    <span aria-hidden>·</span>
                    {chunk.embedded ? (
                      <span className="text-accent-700">embedded</span>
                    ) : (
                      <span className="text-amber-700">not embedded</span>
                    )}
                    <span className="ml-auto" title={chunk.id}>
                      {chunk.id.slice(0, 8)}
                    </span>
                  </div>
                  <p className="m-0 whitespace-pre-wrap font-mono text-quote leading-relaxed text-ink-900">
                    {chunk.text}
                  </p>
                </li>
              ))}
            </ol>
          )}
        </Card>

        <Card title="Metadata">
          <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2.5">
            <Meta label="Status">
              <StatusBadge status={review.status} />
              {review.status !== "indexed" && review.indexAttempts > 0 && (
                <span className="ml-2 font-mono text-label text-gray-500">
                  {review.indexAttempts} attempts
                </span>
              )}
            </Meta>
            <Meta label="Sentiment">
              <SentimentJudgment
                sentiment={review.sentiment}
                sentimentSource={review.sentimentSource}
              />
            </Meta>
            <Meta label="Visibility">
              {review.hidden
                ? `Hidden since ${formatDateTime(review.hiddenAt)}`
                : "Visible to queries"}
            </Meta>
            <Meta label="External id" mono>
              {review.externalId}
            </Meta>
            <Meta label="Language" mono>
              {review.language ?? "—"}
            </Meta>
            <Meta label="URL" mono>
              {review.url ? (
                <a href={review.url} rel="noreferrer" target="_blank">
                  {review.url}
                </a>
              ) : (
                "—"
              )}
            </Meta>
            <Meta label="Indexed at" mono>
              {formatDateTime(review.indexedAt)}
            </Meta>
            <Meta label="Created" mono>
              {formatDateTime(review.createdAt)}
            </Meta>
            <Meta label="Updated" mono>
              {formatDateTime(review.updatedAt)}
            </Meta>
            <Meta label="Id" mono>
              {review.id}
            </Meta>
          </dl>
          <Overline className="mt-5 mb-2">Custom metadata</Overline>
          {Object.keys(review.metadata).length === 0 ? (
            <p className="m-0 text-small text-gray-500">None</p>
          ) : (
            <dl className="m-0 grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
              {Object.entries(review.metadata).map(([key, value]) => (
                <Meta key={key} label={key} mono>
                  {value}
                </Meta>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </article>
  );
}

function Meta({
  label,
  mono,
  children,
}: {
  label: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <>
      <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
        {label}
      </dt>
      <dd
        className={cn(
          "m-0 min-w-0 break-words text-small text-ink-900",
          mono && "font-mono text-data",
        )}
      >
        {children}
      </dd>
    </>
  );
}

/**
 * Hide / Unhide with an inline confirm for hide. A fetcher keeps the page
 * in place; the pending label replaces the button text (no spinner); the
 * result revalidates the loader, which flips the state.
 */
export function HideControl({ hidden }: { hidden: boolean }) {
  const fetcher = useFetcher<typeof action>();
  const [confirming, setConfirming] = useState(false);
  const busy = fetcher.state !== "idle";
  // Leave confirm mode once the submission has gone through.
  useEffect(() => {
    if (fetcher.state === "idle" && fetcher.data) setConfirming(false);
  }, [fetcher.state, fetcher.data]);

  if (hidden) {
    return (
      <fetcher.Form method="post" className="flex items-center gap-3">
        <span className="text-small text-gray-600">
          Hidden from every query.
        </span>
        <Button
          type="submit"
          name="intent"
          value="unhide"
          variant="secondary"
          size="sm"
          disabled={busy}
        >
          {busy ? "Unhiding…" : "Unhide"}
        </Button>
      </fetcher.Form>
    );
  }

  if (!confirming) {
    return (
      <Button
        type="button"
        variant="secondary"
        size="sm"
        onClick={() => setConfirming(true)}
      >
        Hide review
      </Button>
    );
  }

  return (
    <fetcher.Form
      method="post"
      className="flex flex-wrap items-center gap-3 border border-ink-900 bg-surface-sunken px-3.5 py-2.5"
      aria-label="Confirm hide"
    >
      <span className="text-small text-ink-900">
        Hide this review? It leaves query results and the snippet on the next
        request.
      </span>
      <Button
        type="submit"
        name="intent"
        value="hide"
        variant="danger"
        size="sm"
        disabled={busy}
      >
        {busy ? "Hiding…" : "Hide"}
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setConfirming(false)}
        disabled={busy}
      >
        Cancel
      </Button>
    </fetcher.Form>
  );
}
