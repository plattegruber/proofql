// Site footer (docs/launch.md "Support"): the support address, the legal
// pages and the docs, in one quiet mono line under the app shell and the
// auth screens. The address comes from the `SUPPORT_EMAIL` var through the
// loader (`supportEmailFrom` in @proofql/core) so the placeholder is one
// edit away from the real mailbox; the legal URLs are core constants.
import { PRIVACY_URL, TERMS_URL } from "@proofql/core";

import { cn } from "~/lib/utils";

export const DOCS_URL = "https://docs.proofql.dev";

export interface SiteFooterProps extends React.ComponentProps<"footer"> {
  supportEmail: string;
}

const linkClass =
  "text-gray-500 no-underline hover:text-ink-900 hover:underline";

export function SiteFooter({
  supportEmail,
  className,
  ...props
}: SiteFooterProps) {
  return (
    <footer
      className={cn(
        "flex flex-wrap items-center gap-x-5 gap-y-1.5 font-mono text-label text-gray-500",
        className,
      )}
      {...props}
    >
      <span>
        Support:{" "}
        <a href={`mailto:${supportEmail}`} className={linkClass}>
          {supportEmail}
        </a>
      </span>
      <a href={DOCS_URL} className={linkClass}>
        Docs
      </a>
      <a href={PRIVACY_URL} className={linkClass}>
        Privacy
      </a>
      <a href={TERMS_URL} className={linkClass}>
        Terms
      </a>
    </footer>
  );
}
