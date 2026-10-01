// CopyButton: writes a value to the clipboard and confirms with a quiet
// label swap ("Copied") plus a client toast — no navigation, so no flash.
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Button, type ButtonProps } from "~/components/ui/button";

export interface CopyButtonProps extends Omit<ButtonProps, "onClick"> {
  value: string;
  /** What was copied, for the toast: "Key copied". */
  label?: string;
}

export function CopyButton({
  value,
  label = "Copied",
  children = "Copy",
  ...props
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <Button
      {...props}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast(label);
        } catch {
          toast.error("Could not copy. Select the key and copy it by hand.");
        }
      }}
    >
      <span aria-live="polite">{copied ? "Copied" : children}</span>
    </Button>
  );
}
