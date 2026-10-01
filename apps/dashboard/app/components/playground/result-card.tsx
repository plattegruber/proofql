// One playground result: rank, similarity as a number and a bar with the
// floor ticked on it, the excerpt (or the whole review with the excerpt
// marked, in reviews mode), and the review's attribution. Below-floor cards
// are the same card, muted, with the reason spelled out.
import { Link } from "react-router";

import { Stars } from "~/components/reviews/stars";
import { Badge } from "~/components/ui/badge";
import type { PlaygroundResult } from "~/lib/playground.server";
import { formatDate } from "~/lib/reviews";
import { cn } from "~/lib/utils";

export function SimilarityBar({
  similarity,
  floor,
  belowFloor,
}: {
  similarity: number;
  floor: number;
  belowFloor: boolean;
}) {
  const pct = Math.max(0, Math.min(1, similarity)) * 100;
  const floorPct = Math.max(0, Math.min(1, floor)) * 100;
  return (
    <div
      className="relative h-1.5 w-full bg-gray-100"
      aria-hidden
      title={`similarity ${similarity.toFixed(3)} · floor ${floor.toFixed(2)}`}
    >
      <div
        className={cn("h-full", belowFloor ? "bg-gray-400" : "bg-accent-600")}
        style={{ width: `${pct}%` }}
      />
      <div
        className="absolute top-[-3px] h-3 w-px bg-ink-900"
        style={{ left: `${floorPct}%` }}
        aria-hidden
        title={`floor ${floor.toFixed(2)}`}
      />
    </div>
  );
}

/** The review text with the excerpt emphasized, for `mode: "reviews"`. */
function MarkedText({
  text,
  excerpt,
  startOffset,
}: {
  text: string;
  excerpt: string;
  startOffset: number;
}) {
  const end = startOffset + excerpt.length;
  if (text.slice(startOffset, end) !== excerpt) return <>{text}</>;
  return (
    <>
      {text.slice(0, startOffset)}
      <mark className="bg-accent-100 text-ink-900">{excerpt}</mark>
      {text.slice(end)}
    </>
  );
}

export function ResultCard({
  result,
  rank,
  floor,
  mode,
  reviewHref,
}: {
  result: PlaygroundResult;
  rank: number;
  floor: number;
  mode: "excerpts" | "reviews";
  reviewHref: string;
}) {
  const { review } = result;
  return (
    <article
      data-below-floor={result.belowFloor || undefined}
      className={cn(
        "border border-hairline bg-surface-card p-4",
        result.belowFloor && "bg-surface-sunken text-gray-500",
      )}
      aria-label={`Result ${rank}${result.belowFloor ? ", below the floor" : ""}`}
    >
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="font-mono text-label text-gray-500 tabular-nums">
          #{rank}
        </span>
        {result.similarity !== null ? (
          <>
            <span
              className={cn(
                "font-mono text-data font-medium tabular-nums",
                result.belowFloor ? "text-gray-500" : "text-ink-900",
              )}
            >
              {result.similarity.toFixed(3)}
            </span>
            <div className="min-w-40 flex-1">
              <SimilarityBar
                similarity={result.similarity}
                floor={floor}
                belowFloor={result.belowFloor}
              />
            </div>
          </>
        ) : (
          <span className="font-mono text-label text-gray-500">
            no query · newest first
          </span>
        )}
        {result.belowFloor && (
          <Badge tone="neutral">below floor ({floor.toFixed(2)})</Badge>
        )}
      </div>

      <blockquote
        className={cn(
          "m-0 whitespace-pre-wrap font-mono text-quote leading-relaxed",
          result.belowFloor ? "text-gray-500" : "text-ink-900",
        )}
      >
        {mode === "reviews" ? (
          <MarkedText
            text={review.text}
            excerpt={result.excerpt}
            startOffset={result.startOffset}
          />
        ) : (
          result.excerpt
        )}
      </blockquote>

      <footer className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 font-mono text-label text-gray-500">
        <Stars
          rating={review.rating}
          className={result.belowFloor ? "opacity-60" : undefined}
        />
        <span className="text-ink-900">
          {review.authorName ?? "Unknown author"}
        </span>
        <span aria-hidden>·</span>
        <span>{review.source}</span>
        <span aria-hidden>·</span>
        <span>{formatDate(review.occurredAt)}</span>
        {Object.entries(review.metadata).map(([key, value]) => (
          <span key={key} className="border border-hairline px-1.5 py-0.5">
            {key}={value}
          </span>
        ))}
        <Link to={reviewHref} className="ml-auto text-label">
          Open review
        </Link>
      </footer>
    </article>
  );
}
