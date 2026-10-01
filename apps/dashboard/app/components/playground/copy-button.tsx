// Copy-to-clipboard button with a quiet "Copied" confirmation in place of a
// toast (no toaster is mounted in the dashboard yet; the label change is
// the feedback). Falls back to selecting nothing but still says "Copy
// failed" when the Clipboard API is unavailable (http origins, old
// browsers), so the person knows to copy by hand from the <pre>.
import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

import { Button, type ButtonProps } from "~/components/ui/button";

export function CopyButton({
  text,
  children,
  ...props
}: { text: string } & Omit<ButtonProps, "onClick" | "type">) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 1800);
    return () => clearTimeout(timer);
  }, [state]);

  return (
    <Button
      type="button"
      variant="secondary"
      size="sm"
      {...props}
      aria-live="polite"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? (
        <Check size={13} strokeWidth={2.25} aria-hidden />
      ) : (
        <Copy size={13} strokeWidth={2} aria-hidden />
      )}
      {state === "copied"
        ? "Copied"
        : state === "failed"
          ? "Copy failed"
          : children}
    </Button>
  );
}
