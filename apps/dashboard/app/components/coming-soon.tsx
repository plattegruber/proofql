// Placeholder body for a routed-but-unbuilt section: names the issue that
// fills it and sketches the shape with skeleton blocks (never a spinner).
import { Skeleton } from "~/components/ui/skeleton";

export function ComingSoon({
  what,
  issue,
  rows = 3,
}: {
  what: string;
  issue: number;
  rows?: number;
}) {
  return (
    <section
      aria-label={`${what} — coming in #${issue}`}
      className="border border-hairline bg-surface-card p-5"
    >
      <p className="m-0 text-small text-gray-600">
        {what} is coming in{" "}
        <a
          href={`https://github.com/plattegruber/proofql/issues/${issue}`}
          className="font-mono text-data"
        >
          #{issue}
        </a>
        .
      </p>
      <div className="mt-5 flex flex-col gap-3" aria-hidden>
        {Array.from({ length: rows }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: static decorative rows, never reordered
          <div key={i} className="flex items-center gap-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-12" />
          </div>
        ))}
      </div>
    </section>
  );
}
