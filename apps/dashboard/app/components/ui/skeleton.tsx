// Skeleton — the pending state. The design system never spins: a flat
// gray-100 block with a slow opacity pulse stands in for content whose
// shape is known. Size it with the same utilities the real content uses.
import { cn } from "~/lib/utils";

export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse bg-gray-100", className)}
      {...props}
    />
  );
}
