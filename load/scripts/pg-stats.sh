#!/usr/bin/env bash
# Snapshot of the Postgres connection state, for run.sh to diff before and
# after a scenario. Uses `psql` when it is installed and DATABASE_URL is
# set; otherwise execs into the compose container (`docker compose exec db`).
#
# Lines are `name|value` so run.sh can awk them; the last block is the
# current backends grouped by state.
set -euo pipefail

SQL="
SELECT 'sessions|' || sessions FROM pg_stat_database WHERE datname = current_database()
UNION ALL SELECT 'numbackends|' || numbackends FROM pg_stat_database WHERE datname = current_database()
UNION ALL SELECT 'xact_commit|' || xact_commit FROM pg_stat_database WHERE datname = current_database()
UNION ALL SELECT 'sessions_abandoned|' || sessions_abandoned FROM pg_stat_database WHERE datname = current_database()
UNION ALL SELECT 'sessions_fatal|' || sessions_fatal FROM pg_stat_database WHERE datname = current_database()
UNION ALL SELECT 'max_connections|' || current_setting('max_connections')
UNION ALL SELECT 'backends_' || coalesce(state, 'none') || '|' || count(*) FROM pg_stat_activity
  WHERE datname = current_database() AND backend_type = 'client backend' GROUP BY state;
"

if command -v psql >/dev/null 2>&1 && [ -n "${DATABASE_URL:-}" ]; then
  psql "$DATABASE_URL" -Atc "$SQL"
else
  cd "$(dirname "$0")/../.."
  docker compose exec -T db psql -U proofql -d proofql -Atc "$SQL"
fi
