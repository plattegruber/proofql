#!/usr/bin/env bash
# scripts/signup-switch.sh — the launch-day switch for public sign-up on prod
# (docs/launch.md §13 "Go", docs/go-live.md "Launch-day runbook").
#
#   bash scripts/signup-switch.sh status   # read-only: where both switches are now
#   bash scripts/signup-switch.sh open     # Go: Clerk Public first, then SIGNUP_OPEN=true
#   bash scripts/signup-switch.sh close    # roll back: SIGNUP_OPEN=false, then Clerk Restricted
#
# Public sign-up is two switches that must move together:
#
#   1. Clerk → production instance → Configure → Restrictions → Sign-up mode
#      (Public / Restricted). Only a person can change it, in the Clerk
#      dashboard; this script reads it from the instance's public
#      environment endpoint (https://clerk.proofql.dev/v1/environment) and
#      never writes it.
#   2. The dashboard worker's SIGNUP_OPEN secret on prod (app/lib/signup-gate.ts):
#      "true" renders Clerk's <SignUp/> at app.proofql.dev/sign-up, anything
#      else the waitlist. Read per request, so it flips without a deploy.
#
# SIGNUP_OPEN=true with Clerk still Restricted renders a blank sign-up card,
# so `open` refuses to set the secret until Clerk reports "public". Clerk
# Public with SIGNUP_OPEN unset still lets people sign up through Clerk's
# Account Portal (accounts.proofql.dev/sign-up), so keep the gap between the
# two steps to minutes. `close` reverses the order: the waitlist comes back
# on the next request, then Clerk stops accepting sign-ups.
#
# The secret value is piped on stdin (`printf true | wrangler secret put`),
# never passed as an argument and never echoed. Every step is gated on its
# exit code; the first failure stops the run with status 1.
#
# Environment:
#   APP_URL    default https://app.proofql.dev
#   CLERK_FAPI default https://clerk.proofql.dev
#   YES=1      skip the confirmation prompts (for a rehearsed run)
#
# Needs bash, curl, node (JSON) and pnpm (the repo's pinned wrangler).
set -euo pipefail

APP_URL="${APP_URL:-https://app.proofql.dev}"
CLERK_FAPI="${CLERK_FAPI:-https://clerk.proofql.dev}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DASHBOARD="$ROOT/apps/dashboard"
WAITLIST_MARKER="not open yet"

say() { printf '%s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

confirm() {
  [ "${YES:-}" = "1" ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  [ "$answer" = "y" ] || [ "$answer" = "Y" ] || fail "stopped at: $1"
}

# Clerk's sign-up mode as the production instance reports it publicly.
clerk_mode() {
  curl -fsS --max-time 15 "$CLERK_FAPI/v1/environment" |
    node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s)?.user_settings?.sign_up?.mode;if(!m){process.exit(2)}process.stdout.write(m)})'
}

# "waitlist" when /sign-up renders the waitlist, "open" otherwise.
page_state() {
  local body
  body="$(curl -fsS --max-time 15 -H 'cache-control: no-cache' "$APP_URL/sign-up")" ||
    return 1
  if printf '%s' "$body" | grep -q "$WAITLIST_MARKER"; then
    printf 'waitlist'
  else
    printf 'open'
  fi
}

# set | absent | unknown: whether the prod dashboard has a SIGNUP_OPEN
# secret (names only; values are never readable). wrangler's config warning
# about SIGNUP_OPEN missing from env.prod.vars is expected and discarded.
secret_state() {
  local out
  out="$(cd "$DASHBOARD" && pnpm exec wrangler secret list --env prod 2>/dev/null)" || {
    printf 'unknown (wrangler secret list failed; run wrangler login)'
    return 0
  }
  if printf '%s' "$out" | grep -q '"name": "SIGNUP_OPEN"'; then
    printf 'set'
  else
    printf 'absent'
  fi
}

put_signup_open() {
  local value="$1"
  (cd "$DASHBOARD" && printf '%s' "$value" | pnpm exec wrangler secret put SIGNUP_OPEN --env prod 2>/dev/null) ||
    fail "wrangler secret put SIGNUP_OPEN --env prod (run it by hand from apps/dashboard to see wrangler's error)"
}

# Poll until /sign-up shows `want` (open | waitlist); the secret is read per
# request but a new value can take a few seconds to reach every isolate.
wait_for_page() {
  local want="$1" state=""
  for _ in $(seq 1 20); do
    state="$(page_state || true)"
    [ "$state" = "$want" ] && return 0
    sleep 3
  done
  fail "/sign-up still shows '${state:-unreachable}', expected '$want'"
}

status() {
  local mode state secret
  mode="$(clerk_mode)" || fail "could not read $CLERK_FAPI/v1/environment"
  state="$(page_state)" || fail "could not load $APP_URL/sign-up"
  secret="$(secret_state)"
  say "Clerk sign-up mode:     $mode"
  say "app /sign-up renders:   $state"
  say "SIGNUP_OPEN secret:     $secret (value not readable)"
  if [ "$mode" = "public" ] && [ "$state" = "open" ]; then
    say "=> OPEN: public sign-up is live."
  elif [ "$mode" != "public" ] && [ "$state" = "waitlist" ]; then
    say "=> CLOSED: waitlist page, Clerk $mode."
  elif [ "$mode" = "public" ]; then
    say "=> MISMATCH: Clerk is public but the page shows the waitlist; Clerk's Account Portal (accounts.proofql.dev/sign-up) accepts sign-ups. Run 'open' or set Clerk back to Restricted."
    return 3
  else
    say "=> MISMATCH: the page is open but Clerk is $mode, so the sign-up card renders blank. Run 'close', or set Clerk to Public."
    return 3
  fi
}

open_signup() {
  say "Go: open public sign-up on prod."
  local mode
  mode="$(clerk_mode)" || fail "could not read $CLERK_FAPI/v1/environment"
  if [ "$mode" != "public" ]; then
    say "Step 1 (you, in the browser): Clerk dashboard -> ProofQL -> Production ->"
    say "  Configure -> Restrictions -> Sign-up mode -> Public -> Save."
    confirm "Done?"
    mode="$(clerk_mode)" || fail "could not read $CLERK_FAPI/v1/environment"
    [ "$mode" = "public" ] ||
      fail "Clerk still reports sign-up mode '$mode'; SIGNUP_OPEN left untouched"
  fi
  say "PASS Clerk sign-up mode is public"
  confirm "Step 2: set SIGNUP_OPEN=true on proofql-dashboard-prod?"
  put_signup_open true
  wait_for_page open
  say "PASS $APP_URL/sign-up renders Clerk's sign-up"
  say "Now, in a private window: $APP_URL/sign-up shows email and password"
  say "fields (a blank card means Clerk is not Public); sign up with an address"
  say "that is not on the allowlist and reach /app/onboarding."
}

close_signup() {
  say "Roll back: close public sign-up on prod."
  confirm "Step 1: set SIGNUP_OPEN=false on proofql-dashboard-prod?"
  put_signup_open false
  wait_for_page waitlist
  say "PASS $APP_URL/sign-up renders the waitlist again"
  say "Step 2 (you, in the browser): Clerk dashboard -> ProofQL -> Production ->"
  say "  Configure -> Restrictions -> Sign-up mode -> Restricted -> Save."
  confirm "Done?"
  local mode
  mode="$(clerk_mode)" || fail "could not read $CLERK_FAPI/v1/environment"
  [ "$mode" != "public" ] || fail "Clerk still reports sign-up mode 'public'"
  say "PASS Clerk sign-up mode is $mode. Signed-in accounts are unaffected."
}

case "${1:-}" in
  status) status ;;
  open) open_signup ;;
  close) close_signup ;;
  *)
    say "usage: bash scripts/signup-switch.sh status|open|close"
    exit 64
    ;;
esac
