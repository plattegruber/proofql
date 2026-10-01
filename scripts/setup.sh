#!/usr/bin/env bash
# One-command local environment: `pnpm run setup && pnpm dev`.
# Invoke via `pnpm run setup` — bare `pnpm setup` is shadowed by pnpm's
# built-in PNPM_HOME provisioning command.
#
# Not yet implemented. The real script (docker compose Postgres, migrations,
# demo seed) lands with #11. Until then `pnpm i` is the whole setup, and
# `pnpm lint && pnpm typecheck && pnpm test` need no services.
set -euo pipefail

printf '\033[1;34m[setup]\033[0m %s\n' "not yet implemented, see #11 (local Postgres via docker compose and scripts/setup.sh)"
exit 0
