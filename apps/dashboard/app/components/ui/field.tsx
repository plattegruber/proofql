// Form primitives in the design system's shape: mono uppercase labels,
// black-outlined controls on a white ground, square corners, the shared
// focus ring. Native <select>/<input> on purpose — the import wizard is
// forms first, and native controls keep it keyboard- and test-friendly.
import { cn } from "~/lib/utils";

export function Label({ className, ...props }: React.ComponentProps<"label">) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: htmlFor arrives through props
    <label
      className={cn(
        "block font-mono text-label font-medium uppercase tracking-label text-gray-600",
        className,
      )}
      {...props}
    />
  );
}

const controlClass = cn(
  "block w-full border border-outline-strong bg-surface-card px-3 py-2",
  "font-sans text-small text-ink-900",
  "focus-visible:shadow-focus-ring focus-visible:outline-none",
  "disabled:cursor-default disabled:opacity-40",
);

export function Select({
  className,
  ...props
}: React.ComponentProps<"select">) {
  return <select className={cn(controlClass, "pr-8", className)} {...props} />;
}

export function Input({ className, ...props }: React.ComponentProps<"input">) {
  return <input className={cn(controlClass, className)} {...props} />;
}

export function Help({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      className={cn("m-0 mt-1.5 text-small text-gray-500", className)}
      {...props}
    />
  );
}

/** A field: label over control over help, stacked with the house gaps. */
export function Field({
  label,
  htmlFor,
  help,
  children,
  className,
}: {
  label: React.ReactNode;
  htmlFor: string;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label htmlFor={htmlFor} className="mb-1.5">
        {label}
      </Label>
      {children}
      {help && <Help>{help}</Help>}
    </div>
  );
}

/** Inline error/notice under a form, in the voice: plain, no exclamation. */
export function FormNotice({
  tone = "negative",
  children,
}: {
  tone?: "negative" | "caution" | "neutral";
  children: React.ReactNode;
}) {
  return (
    <p
      role={tone === "negative" ? "alert" : "status"}
      className={cn(
        "m-0 border-l-2 px-3 py-2 text-small",
        tone === "negative" &&
          "border-status-negative bg-status-negative-bg text-status-negative",
        tone === "caution" &&
          "border-status-caution bg-status-caution-bg text-status-caution",
        tone === "neutral" && "border-gray-300 bg-surface-sunken text-gray-600",
      )}
    >
      {children}
    </p>
  );
}
