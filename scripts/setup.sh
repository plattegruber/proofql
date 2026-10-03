#!/usr/bin/env bash
# One-command local environment: `pnpm run setup && pnpm dev`.
# Invoke via `pnpm run setup` — bare `pnpm setup` is shadowed by pnpm's
# built-in PNPM_HOME provisioning command.
#
# Idempotent by design — safe to run any number of times:
#   1. copies every .env.example / .dev.vars.example to its real file where
#      missing (never overwrites an existing file), and fills an empty
#      CREDENTIALS_KEY in every .dev.vars with one shared random key,
#   2. starts the docker compose Postgres and waits for its healthcheck,
#   3. applies database migrations when @proofql/db has a `db:migrate` script
#      (re-running is a no-op; skipped with a note until #15 lands),
#   4. seeds the demo project when @proofql/db has a `seed` script (same guard).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Canonical local connection string — must match docker-compose.yml and every
# .env.example verbatim.
LOCAL_DATABASE_URL="postgres://proofql:proofql@localhost:54323/proofql"

info() { printf '\033[1;34m[setup]\033[0m %s\n' "$1"; }
skip() { printf '\033[1;33m[setup] skipped:\033[0m %s\n' "$1"; }
fail() {
  printf '\033[1;31m[setup] error:\033[0m %s\n' "$1" >&2
  exit 1
}

# --- 1. Local env files --------------------------------------------------------
# .env       -> process config for tooling: DATABASE_URL at the root (migrations,
#               integration tests) and, per worker, the wrangler Hyperdrive
#               local connection string (wrangler reads that ONLY from .env /
#               the process environment, never from .dev.vars).
# .dev.vars  -> worker runtime vars/secrets for `wrangler dev`.
# Every committed *.example file is discovered, so adding one to a new
# workspace needs no change here.
info "Copying example env files where missing (existing files are never touched)..."
copy_if_missing() {
  local example="$1" target="${1%.example}"
  if [ -f "$target" ]; then
    info "  $target already exists — leaving it alone"
  else
    cp "$example" "$target"
    info "  created $target"
  fi
}
while IFS= read -r example; do
  copy_if_missing "${example#./}"
done < <(find . \( -name node_modules -o -name .git -o -name .wrangler \) -prune -o \
  \( -name .env.example -o -name .dev.vars.example \) -type f -print | sort)

# --- 1b. CREDENTIALS_KEY ---------------------------------------------------------
# The Google connector encrypts connections.credentials with AES-256-GCM under
# CREDENTIALS_KEY (docs/secrets.md). Every worker that touches the table must
# hold the SAME key, so: reuse a value already present in any .dev.vars, else
# generate one (`openssl rand -base64 32`), then fill every .dev.vars whose
# CREDENTIALS_KEY line is empty. Existing non-empty values are never touched.
dev_vars_files() {
  find . \( -name node_modules -o -name .git -o -name .wrangler \) -prune -o \
    -name .dev.vars -type f -print | sort
}
existing_key=""
while IFS= read -r file; do
  value="$(sed -n 's/^CREDENTIALS_KEY=\(.*\)$/\1/p' "$file" | head -n 1)"
  if [ -n "$value" ]; then
    existing_key="$value"
    break
  fi
done < <(dev_vars_files)
while IFS= read -r file; do
  if grep -q '^CREDENTIALS_KEY=$' "$file"; then
    if [ -z "$existing_key" ]; then
      if ! command -v openssl >/dev/null 2>&1; then
        fail "openssl is needed to generate CREDENTIALS_KEY (or paste a base64 32-byte value into $file)."
      fi
      existing_key="$(openssl rand -base64 32)"
      info "Generated a local CREDENTIALS_KEY (base64, 32 bytes)"
    fi
    # Use a delimiter that cannot appear in base64 (`|`).
    sed -i.bak "s|^CREDENTIALS_KEY=$|CREDENTIALS_KEY=${existing_key}|" "$file" && rm -f "$file.bak"
    info "  set CREDENTIALS_KEY in $file"
  fi
done < <(dev_vars_files)

# --- 2. Postgres via docker compose -------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  fail "Docker is not installed (the \`docker\` command was not found).
        Local dev needs Docker to run Postgres. Install Docker Desktop
        (https://docs.docker.com/get-docker/), then re-run \`pnpm run setup\`."
fi

if ! docker info >/dev/null 2>&1; then
  fail "The Docker daemon is not running (\`docker info\` failed).
        Start Docker Desktop (or your Docker daemon) and wait for it to finish
        starting, then re-run \`pnpm run setup\`."
fi

info "Starting Postgres (docker compose up -d --wait; blocks until the healthcheck passes)..."
# --wait exits non-zero if the healthcheck never passes — exactly what we want.
docker compose up -d --wait

# --- 3. Migrations -------------------------------------------------------------
# @proofql/db grows `db:migrate` and `seed` scripts with #15 and the seed issue.
# Until then the steps are skipped with a note rather than failing, so a fresh
# clone still gets a healthy database out of `pnpm run setup`.
db_has_script() {
  node -e "process.exit(require('./packages/db/package.json').scripts?.['$1'] ? 0 : 1)"
}

if db_has_script db:migrate; then
  info "Applying database migrations..."
  DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --filter @proofql/db db:migrate
else
  skip "migrations — @proofql/db has no \`db:migrate\` script yet (lands with #15)"
fi

# --- 4. Seed -------------------------------------------------------------------
if db_has_script seed; then
  info "Seeding the demo project..."
  DATABASE_URL="$LOCAL_DATABASE_URL" pnpm --filter @proofql/db seed
else
  skip "seed — @proofql/db has no \`seed\` script yet"
fi

info "Done. Postgres is listening on $LOCAL_DATABASE_URL"
info "Next: \`pnpm dev\` boots the workers (ports: see README Quickstart)."
