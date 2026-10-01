// Badge — design-system contract: tone neutral | brand | positive | caution
// | negative. Mono uppercase micro-label on a flat tinted ground; square
// corners.
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const badgeVariants = cva(
  cn(
    "inline-flex items-center gap-1.25 whitespace-nowrap",
    "px-2 py-1.25 font-mono text-2xs font-medium uppercase tracking-label",
  ),
  {
    variants: {
      tone: {
        neutral: "bg-gray-100 text-gray-600",
        brand: "bg-ink-900 text-on-dark",
        positive: "bg-status-positive-bg text-accent-800",
        caution: "bg-status-caution-bg text-status-caution",
        negative: "bg-status-negative-bg text-status-negative",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

export interface BadgeProps
  extends React.ComponentProps<"span">,
    VariantProps<typeof badgeVariants> {}

export function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { badgeVariants };
