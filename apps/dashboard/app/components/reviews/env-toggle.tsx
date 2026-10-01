// Live / test environment toggle: two links, so the choice lives in the URL
// (`?env=test`) and survives reloads, sharing, and the back button. Every
// row the dashboard shows carries an environment (scope.md §3 "Keys"), so
// this is the first filter on every tenant-scoped page.
import { Link, useSearchParams } from "react-router";

import { ENVIRONMENTS, type Environment } from "~/lib/reviews";
import { cn } from "~/lib/utils";

export function EnvToggle({
  environment,
  /** Query keys to drop when switching (a page cursor belongs to one env). */
  reset = ["cursor"],
  className,
}: {
  environment: Environment;
  reset?: string[];
  className?: string;
}) {
  const [searchParams] = useSearchParams();
  return (
    <nav
      aria-label="Environment"
      className={cn("inline-flex border border-ink-900", className)}
    >
      {ENVIRONMENTS.map((env) => {
        const next = new URLSearchParams(searchParams);
        for (const key of reset) next.delete(key);
        if (env === "live") next.delete("env");
        else next.set("env", env);
        const search = next.toString();
        const active = env === environment;
        return (
          <Link
            key={env}
            to={{ search: search ? `?${search}` : "" }}
            aria-current={active ? "true" : undefined}
            className={cn(
              "px-3 py-1.75 font-mono text-label font-semibold uppercase tracking-label no-underline",
              "transition-colors duration-100 ease-out",
              "focus-visible:shadow-focus-ring focus-visible:outline-none",
              active
                ? "bg-ink-900 text-on-dark hover:text-on-dark"
                : "bg-surface-card text-ink-900 hover:bg-gray-50 hover:text-ink-900",
            )}
          >
            {env}
          </Link>
        );
      })}
    </nav>
  );
}
