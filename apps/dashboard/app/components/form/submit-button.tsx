// SubmitButton: disabled with a pending label while its form is submitting.
// Plain <Form> submissions are detected via useNavigation; fetcher forms
// pass their fetcher so the button tracks the right submission. No spinner:
// the design system's motion rules ("never bounce, never spin") make
// pending state a quiet label swap ("Saving…").
import { type Fetcher, useNavigation } from "react-router";

import { Button, type ButtonProps } from "~/components/ui/button";

export interface SubmitButtonProps extends ButtonProps {
  /** Label shown while submitting. */
  pendingLabel?: string;
  /** The fetcher driving this form, when it isn't a plain <Form>. */
  fetcher?: Fetcher;
}

export function SubmitButton({
  pendingLabel = "Saving…",
  fetcher,
  children,
  disabled,
  ...props
}: SubmitButtonProps) {
  const navigation = useNavigation();
  const submitting = fetcher
    ? fetcher.state !== "idle"
    : navigation.state === "submitting";

  return (
    <Button type="submit" disabled={disabled || submitting} {...props}>
      {/* aria-live so screen readers hear the state change. */}
      <span aria-live="polite">{submitting ? pendingLabel : children}</span>
    </Button>
  );
}
