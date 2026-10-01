// Catch-all splat route: any URL no other route claims throws a 404 that
// the root ErrorBoundary renders as the designed "This page doesn't exist"
// state — with the correct status code on the document response.
import { data } from "react-router";

export function loader() {
  throw data(null, { status: 404 });
}

// Never reached — the loader always throws — but route modules need a
// default export for the route tree to be well-formed.
export default function NotFound() {
  return null;
}
