// Adapted from the official React Router v7 Cloudflare template: streams
// the SSR render with web-standard APIs (renderToReadableStream) available
// in workerd, waiting for full content only for bots.
import { isbot } from "isbot";
import { renderToReadableStream } from "react-dom/server";
import type { EntryContext } from "react-router";
import { ServerRouter } from "react-router";

export default async function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  let shellRendered = false;
  let statusCode = responseStatusCode;
  const userAgent = request.headers.get("user-agent");

  const body = await renderToReadableStream(
    <ServerRouter context={routerContext} url={request.url} />,
    {
      onError(error: unknown) {
        statusCode = 500;
        // Errors during initial shell rendering reject and are logged by the
        // framework; only errors inside the streamed shell reach here.
        if (shellRendered) {
          // biome-ignore lint/suspicious/noConsole: the structured logger lands with #30; until then a swallowed SSR stream error would be invisible
          console.error(error);
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
