#!/usr/bin/env bash
# Open, update or close the GitHub issue that tracks a failing acceptance
# environment. Called by the `alert` job of .github/workflows/acceptance.yml
# once per environment, after its job finished:
#
#   failed (or timed out / cancelled) → comment on the open issue titled
#       "Acceptance failing on <env>" with the label acceptance-failure, or
#       open it if there is none. One issue per environment, so a daily
#       failure adds a comment, not a new issue.
#   green (and the tests actually ran) → comment and close that issue.
#   anything else (skipped)           → nothing.
#
# The body quotes the run's `[at] FAILED at …` line, which the spec has
# already redacted (e2e/tests/customer-journey.spec.ts `describeFailure`),
# and links the run. Needs `gh` with GH_TOKEN (the workflow's GITHUB_TOKEN,
# `issues: write`).
#
# Env: AT_ENV (preview|prod), AT_RESULT (the job's needs.<job>.result),
# AT_RAN (true when the journey ran; prod skips while its secret is empty),
# AT_FAILURE_LINE (may be empty), RUN_URL, EVENT, GITHUB_REPOSITORY.
# Backticks in the printf formats are Markdown, not command substitution.
# shellcheck disable=SC2016
set -euo pipefail

label="acceptance-failure"
title="Acceptance failing on ${AT_ENV:?}"
result="${AT_RESULT:?}"
ran="${AT_RAN:-true}"
run_url="${RUN_URL:?}"
event="${EVENT:-unknown}"
repo="${GITHUB_REPOSITORY:?}"

# The open issue for this environment, if any (exact title match).
existing="$(
  TITLE="$title" gh issue list --repo "$repo" --label "$label" --state open \
    --limit 50 --json number,title \
    --jq '.[] | select(.title == env.TITLE) | .number' | head -n 1
)"

body_file="$(mktemp)"
trap 'rm -f "$body_file"' EXIT

case "$result" in
  failure | cancelled)
    line="${AT_FAILURE_LINE:-}"
    # Keep the quote a quote: no fence breakouts, one line.
    line="$(printf '%s' "$line" | tr '\n' ' ' | sed 's/~~~/~ ~ ~/g')"
    {
      printf 'The acceptance run against **%s** ended `%s` (trigger: `%s`).\n\n' \
        "$AT_ENV" "$result" "$event"
      printf 'Run: %s\n\n' "$run_url"
      if [ -n "$line" ]; then
        printf 'Failing step (redacted):\n\n~~~\n%s\n~~~\n' "$line"
      else
        printf 'No `[at] FAILED at` line was recorded (setup, cleanup or a timeout); see the run log.\n'
      fi
    } > "$body_file"
    if [ -n "$existing" ]; then
      gh issue comment "$existing" --repo "$repo" --body-file "$body_file"
      echo "Commented on #$existing"
    else
      # The label must exist before an issue can carry it; creating it
      # again is a harmless error.
      gh label create "$label" --repo "$repo" --color B60205 \
        --description "Opened and closed by the Acceptance workflow" \
        >/dev/null 2>&1 || true
      {
        printf '\n---\nThis issue is managed by `.github/workflows/acceptance.yml`: '
        printf 'later failures on %s comment here, and the next green run closes it.\n' "$AT_ENV"
      } >> "$body_file"
      gh issue create --repo "$repo" --title "$title" --label "$label" \
        --body-file "$body_file"
    fi
    ;;
  success)
    if [ "$ran" != "true" ]; then
      echo "Acceptance ($AT_ENV) skipped its journey; leaving any issue open."
      exit 0
    fi
    if [ -n "$existing" ]; then
      printf 'Green again: %s\n' "$run_url" > "$body_file"
      gh issue comment "$existing" --repo "$repo" --body-file "$body_file"
      gh issue close "$existing" --repo "$repo" --reason completed
      echo "Closed #$existing"
    else
      echo "Acceptance ($AT_ENV) green; no open issue."
    fi
    ;;
  *)
    echo "Acceptance ($AT_ENV) result '$result'; nothing to do."
    ;;
esac
