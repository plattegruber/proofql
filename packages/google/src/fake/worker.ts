// Wrangler entry for `pnpm --filter @proofql/google dev:fake`: the fake
// Google server on http://localhost:8802 with the default fixtures. State is
// in-memory per isolate — restarting the dev server resets tokens and any
// reviews added through the store. See docs/google.md.
import { createFakeGoogle } from "./app.js";

const fake = createFakeGoogle();

export default {
  fetch: (request: Request) => fake.app.fetch(request),
};
