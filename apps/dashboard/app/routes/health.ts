// Resource route for deploy verification — the smoke step in
// .github/workflows/deploy.yml curls it, like the api and pipeline workers'
// /health. Touches no bindings on purpose: it answers whether the worker is
// up, not whether Postgres is.
export function loader() {
  return Response.json({ ok: true, worker: "dashboard" });
}
