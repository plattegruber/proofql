// A slim rule under the project header (#53) while the project has no
// reviews yet: the way back into the guided setup from any project tab.
import { ArrowRight } from "lucide-react";
import { Link } from "react-router";

import { onboardingPath } from "~/lib/onboarding";

export function FinishSetupBanner({ slug }: { slug: string }) {
  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-center justify-between gap-3 border border-ink-900 bg-surface-sunken px-4 py-2.5"
    >
      <p className="m-0 text-small text-ink-900">
        <span className="font-mono text-label font-semibold uppercase tracking-label">
          Finish setup
        </span>
        <span className="ml-3 text-gray-600">
          This project has no reviews yet. Add some, then copy your snippet.
        </span>
      </p>
      <Link
        to={onboardingPath("reviews", slug)}
        className="inline-flex items-center gap-1.5 font-mono text-label font-semibold uppercase tracking-label text-ink-900 no-underline hover:text-accent-700"
      >
        Continue setup
        <ArrowRight size={13} strokeWidth={2.25} aria-hidden />
      </Link>
    </div>
  );
}
