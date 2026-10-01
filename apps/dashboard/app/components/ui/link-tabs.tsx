// LinkTabs — the design system's Tabs (2px signal-green rule over the
// hairline baseline) as navigation: each tab is a NavLink, so the browser
// owns the active state and the back button walks the tabs.
import { NavLink } from "react-router";

import { cn } from "~/lib/utils";

export interface LinkTab {
  to: string;
  label: string;
  /** Match exactly (index-like tabs) instead of by prefix. */
  end?: boolean;
}

export function LinkTabs({
  tabs,
  className,
  ...props
}: { tabs: LinkTab[] } & React.ComponentProps<"nav">) {
  return (
    <nav
      aria-label="Sections"
      className={cn("flex gap-1 border-b border-hairline", className)}
      {...props}
    >
      {tabs.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end={tab.end}
          className={({ isActive }) =>
            cn(
              "-mb-px inline-flex items-center gap-1.75 border-b-2 px-3.5 py-2.5",
              "font-sans text-sm no-underline transition-colors duration-100 ease-out",
              "focus-visible:shadow-focus-ring focus-visible:outline-none",
              isActive
                ? "border-accent-600 font-semibold text-ink-900 hover:text-ink-900"
                : "border-transparent font-normal text-gray-600 hover:text-ink-900",
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
