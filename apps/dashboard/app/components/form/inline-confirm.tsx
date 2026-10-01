// InlineConfirm: a destructive action's confirmation, rendered in place of
// the trigger (docs/frontend-conventions.md: never the browser's
// `confirm()`). The trigger swaps for a short explanation, an optional
// "type the slug to continue" field, and Confirm / Cancel buttons; the
// caller supplies the submitting form's hidden fields as children and the
// fetcher that drives it, so pending state and errors stay with the form.
import { useId, useState } from "react";
import type { Fetcher } from "react-router";

import { Button, type ButtonProps } from "~/components/ui/button";
import { Input } from "~/components/ui/input";

import { SubmitButton } from "./submit-button";

export interface InlineConfirmProps {
  /** Trigger label, e.g. "Revoke". */
  trigger: React.ReactNode;
  triggerVariant?: ButtonProps["variant"];
  triggerSize?: ButtonProps["size"];
  /** One or two plain sentences on what happens and that it is permanent. */
  message: React.ReactNode;
  confirmLabel: string;
  pendingLabel?: string;
  /** When set, the user must type exactly this to enable Confirm. */
  typeToConfirm?: { value: string; label: string; name: string };
  /** The fetcher whose form wraps this component (for pending state). */
  fetcher?: Fetcher;
  /** Error message to show beside the typed field or buttons. */
  error?: string;
  /** Hidden inputs (intent, ids) for the surrounding form. */
  children?: React.ReactNode;
  className?: string;
}

export function InlineConfirm({
  trigger,
  triggerVariant = "secondary",
  triggerSize = "sm",
  message,
  confirmLabel,
  pendingLabel = "Working…",
  typeToConfirm,
  fetcher,
  error,
  children,
  className,
}: InlineConfirmProps) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const messageId = useId();
  const armed = typeToConfirm ? typed === typeToConfirm.value : true;

  if (!open) {
    return (
      <Button
        variant={triggerVariant}
        size={triggerSize}
        className={className}
        onClick={() => setOpen(true)}
      >
        {trigger}
      </Button>
    );
  }

  return (
    <fieldset
      aria-describedby={messageId}
      className={`m-0 flex flex-col gap-3 border border-ink-900 bg-surface-sunken p-3.5 ${className ?? ""}`}
    >
      {children}
      <p id={messageId} className="m-0 text-small text-ink-900">
        {message}
      </p>
      {typeToConfirm && (
        <Input
          name={typeToConfirm.name}
          label={typeToConfirm.label}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          autoComplete="off"
          spellCheck={false}
          error={error}
          className="max-w-xs"
        />
      )}
      {!typeToConfirm && error && (
        <p role="alert" className="m-0 text-small text-danger">
          {error}
        </p>
      )}
      <div className="flex items-center gap-2">
        <SubmitButton
          variant="danger"
          size="sm"
          fetcher={fetcher}
          disabled={!armed}
          pendingLabel={pendingLabel}
        >
          {confirmLabel}
        </SubmitButton>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false);
            setTyped("");
          }}
        >
          Cancel
        </Button>
      </div>
    </fieldset>
  );
}
