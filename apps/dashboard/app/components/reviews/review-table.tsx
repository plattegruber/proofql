// The review browser's table (#39). Rows are links to the detail page; the
// checkbox column feeds the bulk hide/unhide form the route owns. Hidden
// reviews are muted (and say so under their status) rather than removed —
// the browser is the one place a hidden review is still visible, by design.
import { Link, useNavigate } from "react-router";

import { Checkbox } from "~/components/ui/form-controls";
import { excerptOf, formatDate, type ReviewStatus } from "~/lib/reviews";
import { cn } from "~/lib/utils";

import { SentimentJudgment, StatusBadge } from "./judgments";
import { Stars } from "./stars";

/** The wire shape of a list row: dates as ISO strings. */
export interface ReviewTableRow {
  id: string;
  source: string;
  rating: number | null;
  text: string;
  authorName: string | null;
  occurredAt: string | null;
  hidden: boolean;
  status: ReviewStatus;
  sentiment: "positive" | "neutral" | "negative" | null;
  sentimentSource: "rating" | "model" | null;
  chunkCount: number;
}

const head =
  "px-3 py-2.5 text-left font-mono text-label font-medium uppercase tracking-label text-gray-500 whitespace-nowrap";
const cell = "px-3 py-3 align-top";

export function ReviewTable({
  rows,
  detailHref,
  selected,
  onToggle,
  onToggleAll,
}: {
  rows: ReviewTableRow[];
  detailHref: (id: string) => string;
  selected: ReadonlySet<string>;
  onToggle: (id: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
}) {
  const navigate = useNavigate();
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const someSelected = rows.some((r) => selected.has(r.id));

  return (
    <div className="overflow-x-auto border border-hairline bg-surface-card">
      <table className="w-full border-collapse text-small">
        <thead className="border-b border-hairline bg-surface-sunken">
          <tr>
            <th scope="col" className={cn(head, "w-10")}>
              <Checkbox
                aria-label="Select all on this page"
                checked={allSelected}
                ref={(el) => {
                  if (el) el.indeterminate = someSelected && !allSelected;
                }}
                onChange={(e) => onToggleAll(e.currentTarget.checked)}
              />
            </th>
            <th scope="col" className={head}>
              Rating
            </th>
            <th scope="col" className={cn(head, "w-full")}>
              Review
            </th>
            <th scope="col" className={head}>
              Source
            </th>
            <th scope="col" className={head}>
              Author
            </th>
            <th scope="col" className={head}>
              Date
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              Chunks
            </th>
            <th scope="col" className={head}>
              Status
            </th>
            <th scope="col" className={head}>
              Sentiment
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const href = detailHref(row.id);
            const isSelected = selected.has(row.id);
            return (
              <tr
                key={row.id}
                data-hidden={row.hidden || undefined}
                aria-selected={isSelected}
                onClick={(e) => {
                  // Clicks on controls inside the row keep their own meaning.
                  const target = e.target as HTMLElement;
                  if (target.closest("a, input, button, label")) return;
                  navigate(href);
                }}
                className={cn(
                  "cursor-pointer border-b border-hairline last:border-b-0",
                  "transition-colors duration-100 ease-out hover:bg-gray-50",
                  isSelected && "bg-accent-50 hover:bg-accent-50",
                  row.hidden && "text-gray-500",
                )}
              >
                <td className={cell}>
                  <Checkbox
                    aria-label={`Select review by ${row.authorName ?? "unknown author"}`}
                    checked={isSelected}
                    onChange={(e) => onToggle(row.id, e.currentTarget.checked)}
                  />
                </td>
                <td className={cn(cell, "whitespace-nowrap")}>
                  <Stars
                    rating={row.rating}
                    className={row.hidden ? "opacity-50" : undefined}
                  />
                </td>
                <td className={cn(cell, "min-w-52")}>
                  <Link
                    to={href}
                    className={cn(
                      "font-mono text-quote leading-relaxed no-underline hover:text-accent-700",
                      row.hidden ? "text-gray-500" : "text-ink-900",
                    )}
                  >
                    {excerptOf(row.text)}
                  </Link>
                </td>
                <td className={cn(cell, "font-mono text-data")}>
                  {row.source}
                </td>
                <td className={cn(cell, "max-w-36")}>
                  {row.authorName ?? <span className="text-gray-400">—</span>}
                </td>
                <td
                  className={cn(
                    cell,
                    "whitespace-nowrap font-mono text-data tabular-nums",
                  )}
                >
                  {formatDate(row.occurredAt)}
                </td>
                <td
                  className={cn(
                    cell,
                    "text-right font-mono text-data tabular-nums",
                  )}
                >
                  {row.chunkCount}
                </td>
                <td className={cell}>
                  <span className="flex flex-col items-start gap-1.5">
                    <StatusBadge status={row.status} />
                    {row.hidden && (
                      <span
                        data-visibility="hidden"
                        className="font-mono text-label text-gray-500"
                      >
                        hidden
                      </span>
                    )}
                  </span>
                </td>
                <td className={cell}>
                  <SentimentJudgment
                    sentiment={row.sentiment}
                    sentimentSource={row.sentimentSource}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
