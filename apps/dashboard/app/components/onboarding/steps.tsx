// The four-step rail at the top of every onboarding screen (#53): done
// steps in ink, the current one in the accent, the rest in gray. Static —
// the steps advance by navigation, never by local state.
import { Check } from "lucide-react";

import {
  ONBOARDING_STEPS,
  type OnboardingStep,
  onboardingStepNumber,
} from "~/lib/onboarding";
import { cn } from "~/lib/utils";

export function OnboardingSteps({
  current,
  className,
}: {
  current: OnboardingStep;
  className?: string;
}) {
  const currentIndex = onboardingStepNumber(current) - 1;
  return (
    <ol
      aria-label="Setup steps"
      className={cn(
        "m-0 grid list-none grid-cols-2 gap-x-4 gap-y-3 p-0 sm:grid-cols-4",
        className,
      )}
    >
      {ONBOARDING_STEPS.map((step, index) => {
        const state =
          index < currentIndex
            ? "done"
            : index === currentIndex
              ? "current"
              : "upcoming";
        return (
          <li
            key={step.id}
            aria-current={state === "current" ? "step" : undefined}
            className="flex items-center gap-2.5 border-t-2 pt-2.5 data-[state=upcoming]:border-hairline data-[state=done]:border-ink-900 data-[state=current]:border-accent-600"
            data-state={state}
          >
            <span
              className={cn(
                "inline-flex size-5 shrink-0 items-center justify-center border font-mono text-2xs font-semibold",
                state === "done" && "border-ink-900 bg-ink-900 text-on-dark",
                state === "current" &&
                  "border-accent-600 bg-accent-50 text-accent-700",
                state === "upcoming" && "border-hairline text-gray-500",
              )}
              aria-hidden
            >
              {state === "done" ? (
                <Check size={11} strokeWidth={2.5} />
              ) : (
                index + 1
              )}
            </span>
            <span
              className={cn(
                "truncate font-mono text-label uppercase tracking-label",
                state === "current"
                  ? "font-semibold text-ink-900"
                  : state === "done"
                    ? "font-medium text-gray-600"
                    : "text-gray-500",
              )}
            >
              <span className="sr-only">Step {index + 1}: </span>
              {step.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
