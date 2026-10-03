#!/usr/bin/env bash
# Run the k6 scenarios in sequence with a Postgres snapshot before and after
# each one (connection churn: pg_stat_database.sessions delta / requests).
#
#   pnpm load:run                 # all five scenarios
#   pnpm load:run warm cold       # a subset
#   BASE_URL=https://api-preview.example pnpm load:run
#
# Output: load/results/<scenario>.txt (k6 stdout), <scenario>.summary.json
# (k6 --summary-export), <scenario>.pg-before.txt / .pg-after.txt.
# Requires k6 (https://grafana.com/docs/k6/latest/set-up/install-k6/); set
# K6=/path/to/k6 if it is not on PATH.
set -euo pipefail
cd "$(dirname "$0")"

K6="${K6:-k6}"
SCENARIOS=("$@")
if [ ${#SCENARIOS[@]} -eq 0 ]; then SCENARIOS=(warm cold mixed multi large); fi

if ! command -v "$K6" >/dev/null 2>&1; then
  echo "k6 not found (looked for '$K6'). Install it or set K6=/path/to/k6." >&2
  exit 1
fi
if [ ! -f "${KEYS_FILE:-.keys.json}" ]; then
  echo "no keys file (${KEYS_FILE:-load/.keys.json}); run 'pnpm load:seed' first." >&2
  exit 1
fi

mkdir -p results
for s in "${SCENARIOS[@]}"; do
  echo "=== $s ==="
  ./scripts/pg-stats.sh > "results/$s.pg-before.txt" 2>/dev/null || true
  status=0
  "$K6" run -e "SCENARIO=$s" \
    --summary-export "results/$s.summary.json" \
    k6/query.js 2>&1 | tee "results/$s.txt" || status=$?
  ./scripts/pg-stats.sh > "results/$s.pg-after.txt" 2>/dev/null || true
  if [ -s "results/$s.pg-before.txt" ] && [ -s "results/$s.pg-after.txt" ]; then
    before=$(awk -F'|' '$1 == "sessions" {print $2}' "results/$s.pg-before.txt")
    after=$(awk -F'|' '$1 == "sessions" {print $2}' "results/$s.pg-after.txt")
    echo "postgres sessions opened during $s: $((after - before))"
  fi
  if [ "$status" -ne 0 ]; then
    echo "k6 exited $status for $s (thresholds crossed or error); see results/$s.txt" >&2
  fi
  echo
done
