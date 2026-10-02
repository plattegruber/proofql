// UsageMeter — "used / limit" with a hairline bar. Numbers in mono, plain
// and honest; the bar turns caution at 80 % and negative at the limit,
// where the api starts refusing. `role="meter"` so the value is announced.
import { usagePercent, usageTone } from "~/lib/usage";
import { cn } from "~/lib/utils";

export interface UsageMeterProps {
  label: string;
  used: number;
  limit: number;
  /** Secondary line under the numbers (e.g. cache hits). */
  note?: React.ReactNode;
}

const FILL: Record<ReturnType<typeof usageTone>, string> = {
  normal: "bg-accent-600",
  caution: "bg-status-caution",
  full: "bg-status-negative",
};

export function UsageMeter({ label, used, limit, note }: UsageMeterProps) {
  const percent = usagePercent(used, limit);
  const tone = usageTone(used, limit);
  const fmt = (n: number) => n.toLocaleString("en-US");
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
          {label}
        </span>
        <span className="font-mono text-data tabular-nums text-ink-900">
          {fmt(used)}
          <span className="text-gray-500"> / {fmt(limit)}</span>
        </span>
      </div>
      {/* biome-ignore lint/a11y/useSemanticElements: a native <meter> cannot take the hairline track and the plan-tone fill the design system asks for; the ARIA meter semantics are complete below. */}
      <div
        role="meter"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(used, limit)}
        aria-valuetext={`${fmt(used)} of ${fmt(limit)} (${percent}%)`}
        className="mt-1.5 h-1.5 w-full bg-gray-100"
      >
        <div
          className={cn("h-full", FILL[tone])}
          style={{ width: `${percent}%` }}
        />
      </div>
      {note && (
        <div className="mt-1.5 font-mono text-label text-gray-500">{note}</div>
      )}
    </div>
  );
}
