// Card — a flat, hairline-bordered surface: no shadow, square corners.
import { cn } from "~/lib/utils";

export interface CardProps extends React.ComponentProps<"div"> {
  /** Optional card title, rendered as an h3 in the title style. */
  title?: string;
  /** Optional right-aligned header slot (e.g. a ghost button). */
  action?: React.ReactNode;
  /** Sunken cards sit on the gray-50 ground (quoted content, wells). */
  sunken?: boolean;
}

export function Card({
  title,
  action,
  sunken = false,
  className,
  children,
  ...props
}: CardProps) {
  return (
    <div
      className={cn(
        "border border-hairline p-5",
        sunken ? "bg-surface-sunken" : "bg-surface-card",
        className,
      )}
      {...props}
    >
      {(title || action) && (
        <div className="mb-3.5 flex items-center justify-between gap-3">
          {title && (
            <h3 className="m-0 text-title font-semibold text-ink-900">
              {title}
            </h3>
          )}
          {action}
        </div>
      )}
      {children}
    </div>
  );
}
