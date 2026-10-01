// Adapted from the official React Router v7 Cloudflare template: streams
// the SSR render with web-standard APIs (renderToReadableStream) available
// in workerd, waiting for full content only for bots. Streaming render
// errors go through the request-bound structured logger (#30) so they
// carry the request_id minted at the worker edge.
import { createLogger } from "@proofql/core";
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext, RouterContextProvider } from "react-router";
import { ServerRouter } from "react-router";

import { cloudflareContext } from "~/lib/context";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
  loadContext?: Readonly<RouterContextProvider>,
) {
  const log = loggerFrom(loadContext);
  let shellRendered = false;
  let statusCode = responseStatusCode;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        statusCode = 500;
        // Errors during initial shell rendering reject and are handled by
        // the framework; only errors inside the streamed shell reach here.
        if (shellRendered) {
          log.log("ssr.stream_error", { error });
        }
      },
    },
  );
  shellRendered = true;

  // Ensure requests from bots and SPA Mode renders wait for all content to
  // load before responding.
  if ((userAgent && isbot(userAgent)) || routerContext.isSpaMode) {
    await body.allReady;
  }

  responseHeaders.set("Content-Type", "text/html");
  return new Response(body, {
    headers: responseHeaders,
    status: statusCode,
  });
}

/**
 * The request-bound logger from the worker edge; the fallback only fires
 * outside it (a harness calling handleRequest without a load context).
 */
function loggerFrom(loadContext?: Readonly<RouterContextProvider>) {
  try {
    const log = loadContext?.get(cloudflareContext).log;
    if (log) return log;
  } catch {
    // No cloudflareContext on this provider — fall through.
  }
  return createLogger({ service: "dashboard", environment: "unknown" });
}
