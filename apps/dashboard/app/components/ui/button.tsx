// Button — design-system contract: variant primary | secondary | ghost |
// danger; size sm | md | lg. Labels are mono uppercase by component design —
// write children in sentence case ("New project"); the component renders
// them uppercase. shadcn/ui shape (cva + cn), design-system styling.
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "~/lib/utils";

const buttonVariants = cva(
  cn(
    "inline-flex cursor-pointer items-center justify-center",
    "font-mono font-semibold uppercase leading-none tracking-label",
    "transition-colors duration-100 ease-out",
    "focus-visible:shadow-focus-ring focus-visible:outline-none",
    "disabled:cursor-default disabled:opacity-40",
  ),
  {
    variants: {
      variant: {
        primary: cn(
          "border border-ink-900 bg-ink-900 text-on-dark",
          "hover:bg-ink-700 active:bg-black",
          "disabled:hover:bg-ink-900 disabled:active:bg-ink-900",
        ),
        secondary: cn(
          "border border-ink-900 bg-surface-card text-ink-900",
          "hover:bg-gray-50 active:bg-gray-100",
          "disabled:hover:bg-surface-card disabled:active:bg-surface-card",
        ),
        ghost: cn(
          "border border-transparent bg-transparent text-ink-900",
          "hover:bg-gray-100 active:bg-gray-200",
          "disabled:hover:bg-transparent disabled:active:bg-transparent",
        ),
        danger: cn(
          "border border-red-700 bg-red-700 text-on-dark",
          "hover:bg-ink-900 active:bg-black",
          "disabled:hover:bg-red-700 disabled:active:bg-red-700",
        ),
      },
      size: {
        sm: "gap-1.5 px-3 py-2 text-label leading-none",
        md: "gap-2 px-4.5 py-3 text-xs leading-none",
        lg: "gap-2 px-6.5 py-3.75 text-data leading-none",
      },
    },
    defaultVariants: {
      variant: "primary",
      size: "md",
    },
  },
);

export interface ButtonProps
  extends React.ComponentProps<"button">,
    VariantProps<typeof buttonVariants> {}

export function Button({
  className,
  variant,
  size,
  type = "button",
  ...props
}: ButtonProps) {
  return (
    <button
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  );
}

export { buttonVariants };
