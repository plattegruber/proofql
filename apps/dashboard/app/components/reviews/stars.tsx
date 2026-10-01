// Star rating: five glyphs, filled in the accent (the design system's
// `--accent-star`), plus the number so it is readable without color.
// Unrated reviews say so in words rather than drawing five empty stars.
import { cn } from "~/lib/utils";

export function Stars({
  rating,
  className,
}: {
  rating: number | null;
  className?: string;
}) {
  if (rating === null) {
    return (
      <span
        role="img"
        className={cn("font-mono text-label text-gray-500", className)}
        aria-label="Unrated"
      >
        unrated
      </span>
    );
  }
  return (
    <span
      role="img"
      className={cn("inline-flex items-center gap-1.5", className)}
      aria-label={`${rating} out of 5 stars`}
    >
      <span
        className="font-mono text-data leading-none tracking-tight"
        aria-hidden
      >
        {Array.from({ length: 5 }, (_, i) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: five fixed slots
            key={i}
            className={i < rating ? "text-accent-600" : "text-gray-300"}
          >
            ★
          </span>
        ))}
      </span>
      <span className="font-mono text-data tabular-nums text-ink-900">
        {rating}
      </span>
    </span>
  );
}
