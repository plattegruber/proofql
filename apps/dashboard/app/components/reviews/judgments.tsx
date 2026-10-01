// The table's judgment cells: index status and sentiment-with-source. Both
// are Badges in the design system's tones; the words carry the meaning,
// the tone only underlines it.
import { Badge } from "~/components/ui/badge";
import {
  type ReviewStatus,
  type Sentiment,
  type SentimentSource,
  STUCK_INDEX_ATTEMPTS,
  sentimentJudgment,
} from "~/lib/reviews";

export function StatusBadge({ status }: { status: ReviewStatus }) {
  if (status === "indexed") return <Badge tone="positive">indexed</Badge>;
  if (status === "stuck") {
    return (
      <Badge
        tone="negative"
        title={`Not indexed after ${STUCK_INDEX_ATTEMPTS} attempts`}
      >
        stuck
      </Badge>
    );
  }
  return <Badge tone="caution">indexing</Badge>;
}

export function SentimentJudgment({
  sentiment,
  sentimentSource,
}: {
  sentiment: Sentiment;
  sentimentSource: SentimentSource;
}) {
  const label = sentimentJudgment({ sentiment, sentimentSource });
  if (label === null || sentiment === null) {
    return <span className="font-mono text-label text-gray-400">pending</span>;
  }
  const tone =
    sentiment === "positive"
      ? "positive"
      : sentiment === "negative"
        ? "negative"
        : "neutral";
  const provenance = label.includes(" · ") ? label.split(" · ")[1] : null;
  return (
    <span
      className="inline-flex items-center gap-1.5 whitespace-nowrap"
      title={label}
    >
      <Badge tone={tone}>{sentiment}</Badge>
      {provenance && (
        <span className="font-mono text-label text-gray-500">
          · {provenance}
        </span>
      )}
    </span>
  );
}
