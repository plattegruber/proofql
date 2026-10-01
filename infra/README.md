# infra

Repository settings that live in GitHub, not in the tree, kept here so they are reproducible after a transfer or fork and diffable in review.

## Branch protection on `main`

The canonical payload is [`branch-protection.json`](branch-protection.json). It requires the five CI checks from [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) — `lint`, `typecheck`, `test`, `integration`, `migration-check` — in strict mode (the branch must be up to date with `main`), requires every review conversation to be resolved, requires linear history (squash merges satisfy it), forbids force-pushes and deletion, and enforces all of it for admins too. `required_pull_request_reviews` with a count of 0 means changes must arrive through a PR but no approval is needed — this is a solo repo with agents opening PRs.

The protection API is a **replace, not a patch**, so always re-apply the whole file:

```sh
# Apply (or re-apply after editing the JSON):
gh api -X PUT repos/plattegruber/proofql/branches/main/protection \
  --input infra/branch-protection.json

# Repo merge settings: squash-only, auto-delete head branches:
gh api -X PATCH repos/plattegruber/proofql \
  -F allow_squash_merge=true -F allow_merge_commit=false \
  -F allow_rebase_merge=false -F delete_branch_on_merge=true

# Verify:
gh api repos/plattegruber/proofql/branches/main/protection \
  --jq '.required_status_checks.contexts'
```

Apply it only after the CI workflow has run at least once on `main`; required contexts that have never reported leave every PR stuck on "Expected — waiting for status". Renaming a job in `ci.yml` must update the `contexts` array and re-run the `PUT` in the same PR.

## Deploy secrets, variables, and the `production` environment

The deploy workflow (`.github/workflows/deploy.yml`) reads repository
secrets (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`,
`NEON_PREVIEW_DATABASE_URL`), one environment secret on the GitHub
environment `production` (`NEON_PROD_DATABASE_URL`, behind a required
reviewer), and the repository variables `DEPLOY_ENABLED` (the switch every
job is gated on) and `WORKERS_SUBDOMAIN` (smoke check). The exact `gh
secret set` / `gh variable set` / `gh api ... environments/production`
commands are steps 9 and 12 of [`provisioning.md`](provisioning.md); the
inventory and rotation notes are [`docs/secrets.md`](../docs/secrets.md).
Cloud resource names per environment: [`environments.md`](environments.md).
