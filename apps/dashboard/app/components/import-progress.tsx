// The import "spin" (#38): two flat progress rules — rows processed, then
// reviews indexed by the pipeline — over the run's counts. No spinner, by
// the design system; the numbers moving are the motion. Exported on its own
// because the guided onboarding (#53) shows the same thing after its first
// import; `useImportPolling` is the matching 2-second revalidation loop.
import { useEffect } from "react";
import { useRevalidator } from "react-router";

import { Badge } from "~/components/ui/badge";
import { cn } from "~/lib/utils";

export type ImportStatus = "running" | "succeeded" | "failed";

export interface ImportProgressData {
  status: ImportStatus;
  /** Rows in the file; 0 until the run starts. */
  received: number;
  created: number;
  updated: number;
  skipped: number;
  failed: number;
  /** `created + updated + skipped + failed`. */
  processed: number;
  /** Reviews from this run the pipeline has indexed / still has to. */
  indexed: number;
  indexing: number;
  error: string | null;
}

/** Everything settled: the run finished and nothing is left to index. */
export function importSettled(p: ImportProgressData): boolean {
  return p.status !== "running" && p.indexing === 0;
}

export function useImportPolling(active: boolean, intervalMs = 2_000): void {
  const revalidator = useRevalidator();
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => {
      if (revalidator.state === "idle") void revalidator.revalidate();
    }, intervalMs);
    return () => clearInterval(id);
  }, [active, intervalMs, revalidator]);
}

const STATUS_LABEL: Record<ImportStatus, string> = {
  running: "Importing",
  succeeded: "Imported",
  failed: "Failed",
};

export function ImportProgress({
  progress,
  className,
}: {
  progress: ImportProgressData;
  className?: string;
}) {
  const p = progress;
  const written = p.created + p.updated;
  const toIndex = p.indexed + p.indexing;
  const indexingDone = p.status !== "running" && p.indexing === 0;
  const tone =
    p.status === "failed"
      ? "negative"
      : p.status === "running" || !indexingDone
        ? "caution"
        : "positive";
  const label =
    p.status === "succeeded" && !indexingDone
      ? "Indexing"
      : STATUS_LABEL[p.status];

  return (
    <section
      aria-label="Import progress"
      aria-live="polite"
      className={cn("border border-hairline bg-surface-card p-5", className)}
    >
      <div className="flex items-center justify-between gap-3">
        <h2 className="m-0 text-title font-semibold text-ink-900">Progress</h2>
        <Badge tone={tone}>{label}</Badge>
      </div>

      <Meter
        className="mt-5"
        label="Rows processed"
        value={p.processed}
        total={p.received}
      />
      <Meter
        className="mt-4"
        label="Reviews indexed"
        value={p.indexed}
        total={Math.max(toIndex, written)}
        hint={
          p.indexing > 0
            ? `${p.indexing.toLocaleString("en-US")} waiting on the pipeline — searchable within seconds.`
            : undefined
        }
      />

      <dl className="mt-5 grid grid-cols-2 gap-3 border-t border-hairline pt-4 sm:grid-cols-4">
        <Stat label="Created" value={p.created} />
        <Stat label="Updated" value={p.updated} />
        <Stat label="Skipped" value={p.skipped} />
        <Stat label="Failed" value={p.failed} negative={p.failed > 0} />
      </dl>

      {p.error && (
        <p className="mt-4 mb-0 border-l-2 border-status-negative bg-status-negative-bg px-3 py-2 text-small text-status-negative">
          {p.error}
        </p>
      )}
    </section>
  );
}

/** One flat progress rule with its count; the onboarding's indexing step (#53) reuses it. */
export function Meter({
  label,
  value,
  total,
  hint,
  className,
}: {
  label: string;
  value: number;
  total: number;
  hint?: string;
  className?: string;
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
          {label}
        </span>
        <span className="font-mono text-data tabular-nums text-ink-900">
          {value.toLocaleString("en-US")} / {total.toLocaleString("en-US")}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={value}
        className="mt-2 h-1.5 w-full bg-gray-100"
      >
        <div
          className="h-full bg-accent-600 transition-[width] duration-300 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      {hint && <p className="m-0 mt-1.5 text-small text-gray-500">{hint}</p>}
    </div>
  );
}

function Stat({
  label,
  value,
  negative = false,
}: {
  label: string;
  value: number;
  negative?: boolean;
}) {
  return (
    <div>
      <dt className="font-mono text-label font-medium uppercase tracking-label text-gray-500">
        {label}
      </dt>
      <dd
        className={cn(
          "m-0 mt-1 font-mono text-data tabular-nums",
          negative ? "text-status-negative" : "text-ink-900",
        )}
      >
        {value.toLocaleString("en-US")}
      </dd>
    </div>
  );
}
