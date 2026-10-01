// Toasts: sonner restyled to the design system — square corners, ink
// border, mono uppercase title, flat white surface with the raised hairline
// shadow. Mounted once in the protected layout (app/routes/app.tsx); fire
// with `toast(...)` for client-only updates, `useFetcherToast` for a
// fetcher that stays on the page, or `setFlash` in an action for
// post-redirect success (docs/frontend-conventions.md covers which).
import { useEffect, useRef } from "react";
import type { Fetcher } from "react-router";
import { Toaster as Sonner, toast } from "sonner";

import type { FlashMessage } from "~/lib/flash.server";
import { cn } from "~/lib/utils";

export function Toaster() {
  return (
    <Sonner
      position="bottom-right"
      // No icons: tone is carried by the title text, per the quiet register.
      icons={{ success: null, error: null, info: null }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast: cn(
            "flex w-89 flex-col gap-1 border border-ink-900 bg-surface-card",
            "px-3.5 py-3 shadow-raised",
          ),
          title:
            "font-mono text-label font-semibold uppercase tracking-label text-ink-900",
          description: "font-sans text-small text-gray-600",
        },
      }}
    />
  );
}

/** Fire a toast for a server flash message (layout loader → shell). */
export function showFlashToast(flash: Omit<FlashMessage, "id">) {
  const options = { description: flash.detail };
  switch (flash.tone) {
    case "positive":
      toast.success(flash.message, options);
      break;
    case "negative":
      toast.error(flash.message, options);
      break;
    default:
      toast(flash.message, options);
  }
}

/**
 * The shape a fetcher action returns when it wants a toast without a
 * redirect: `{ toast: { id, tone, message } }`. The id is random per
 * response so a re-render cannot replay it.
 */
export interface ActionToast extends Omit<FlashMessage, "id"> {
  id: string;
}

export function actionToast(flash: Omit<FlashMessage, "id">): ActionToast {
  return { ...flash, id: crypto.randomUUID() };
}

/** Show the toast a fetcher's action returned, once per response. */
export function useFetcherToast(fetcher: Fetcher<unknown>) {
  const shownId = useRef<string | undefined>(undefined);
  const payload = fetcher.state === "idle" ? fetcher.data : undefined;
  const pending =
    typeof payload === "object" && payload !== null && "toast" in payload
      ? (payload as { toast?: ActionToast }).toast
      : undefined;
  useEffect(() => {
    if (pending && shownId.current !== pending.id) {
      shownId.current = pending.id;
      showFlashToast(pending);
    }
  }, [pending]);
}
