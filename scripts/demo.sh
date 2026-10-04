#!/usr/bin/env bash
# scripts/demo.sh — the end-to-end curl demo (#31): ingest → indexed → query,
# with the policy gate, the cache, highlights, hide, and delete, each step
# asserted. The M1 exit, runnable against any deployment of the api worker.
#
#   pnpm demo                                    # local: pnpm run setup && pnpm dev
#   API_URL=https://proofql-api-preview.<subdomain>.workers.dev \
#   ORIGIN=https://proofql-cdn-preview.<subdomain>.workers.dev pnpm demo
#
# Parameters (environment):
#   API_URL             api worker origin            default http://localhost:8797
#   PQ_SECRET_KEY       pq_sk_… for the project      required (ingest, list, hide, delete)
#   PQ_PUBLISHABLE_KEY  pq_pk_… for the same project required (queries, like the snippet)
#   ORIGIN              an origin in the project's allowed_origins   default http://localhost:3000
#   WAIT_SECONDS        how long to wait for the pipeline to index  default 90
#   SIMILARITY_FLOOR    the project's relevance floor, for the score assertion   default 0.55
#
# Needs curl and python3 (JSON, timing, UTF-16 offsets). bash 3.2 compatible.
# Secrets are never printed: nothing is traced, and every failure dump is
# passed through `mask`, which redacts anything shaped like an API key.
#
# Steps (each printed with PASS/FAIL and timing; the first failure stops the
# run, the EXIT trap deletes whatever demo reviews are left, exit status 1):
#   1. GET /health
#   2. POST /v1/reviews — 6 synthetic reviews, external_id demo-<epoch>-<n>,
#      distinct topics, ratings 5/5/4/5/3/2 (the 2- and 3-star must never be
#      returned by a query: policy min_rating 4)
#   3. poll GET /v1/reviews?source=custom until all 6 are `indexed`
#   4. three queries with the publishable key + Origin:
#        a. must match the 5-star review 1 (top result, score ≥ floor)
#        b. matches only the 2-star's topic → match "none", results []
#        c. the same with fallback=recent → match "fallback", labelled rows
#   5. query a again → x-cache: HIT
#   6. query a with include=text → text.slice(highlight) === excerpt, every row
#   7. PATCH review 1 hidden → query a again: x-cache: MISS, review 1 gone
#   8. DELETE all 6 → 204, then GET each → 404
set -euo pipefail
set +x

API_URL="${API_URL:-http://localhost:8797}"
ORIGIN="${ORIGIN:-http://localhost:3000}"
WAIT_SECONDS="${WAIT_SECONDS:-90}"
SIMILARITY_FLOOR="${SIMILARITY_FLOOR:-0.55}"
API_URL="${API_URL%/}"
export SIMILARITY_FLOOR

# --- plumbing -----------------------------------------------------------------

mask() { sed -E 's/pq_(sk|pk)_(live|test)_[A-Za-z0-9_-]+/pq_\1_\2_****/g'; }

die() {
  printf '\033[1;31m[demo] error:\033[0m %s\n' "$1" | mask >&2
  exit 2
}

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v python3 >/dev/null 2>&1 || die "python3 is required"
[ -n "${PQ_SECRET_KEY:-}" ] || die "PQ_SECRET_KEY is not set (pq_sk_…; \`pnpm run setup\` prints the local demo keys)"
[ -n "${PQ_PUBLISHABLE_KEY:-}" ] || die "PQ_PUBLISHABLE_KEY is not set (pq_pk_…; same project as the secret key)"
case "$PQ_SECRET_KEY" in pq_sk_*) ;; *) die "PQ_SECRET_KEY does not look like a secret key (pq_sk_…)" ;; esac
case "$PQ_PUBLISHABLE_KEY" in pq_pk_*) ;; *) die "PQ_PUBLISHABLE_KEY does not look like a publishable key (pq_pk_…)" ;; esac

TMP="$(mktemp -d "${TMPDIR:-/tmp}/proofql-demo.XXXXXX")"
export BODY_FILE="$TMP/body" HDR_FILE="$TMP/headers" ERR_FILE="$TMP/curl.err" IDS_FILE="$TMP/ids.tsv"
: >"$IDS_FILE"

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }
urlenc() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }

# jget <python expression over d> — prints the value; d is the parsed body.
jget() {
  python3 -c '
import json, os, sys
d = json.load(open(os.environ["BODY_FILE"]))
v = eval(sys.argv[1])
if isinstance(v, bool) or v is None:
    print(json.dumps(v))
elif isinstance(v, (dict, list)):
    print(json.dumps(v))
else:
    print(v)
' "$1"
}

# hdr <name> — the last response's header value, lowercase-insensitive.
hdr() { tr -d '\r' <"$HDR_FILE" | awk -v n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" 'BEGIN{FS=": "} {k=tolower($1); if (k==n) v=substr($0, length($1)+3)} END{print v}'; }

# http <METHOD> <url> [curl args…] — status in HTTP_STATUS, body/headers in files.
http() {
  local method="$1" url="$2"
  shift 2
  : >"$BODY_FILE"
  : >"$HDR_FILE"
  if ! HTTP_STATUS="$(curl -sS -o "$BODY_FILE" -D "$HDR_FILE" -w '%{http_code}' -X "$method" "$url" "$@" 2>"$ERR_FILE")"; then
    HTTP_STATUS=000
  fi
}

auth_sk() { printf 'Authorization: Bearer %s' "$PQ_SECRET_KEY"; }

# query <q> [extra query string] — the snippet's GET with the publishable key.
query() {
  local q extra="${2:-}"
  q="$(urlenc "$1")"
  http GET "$API_URL/v1/query?key=$PQ_PUBLISHABLE_KEY&q=$q&limit=5${extra:+&$extra}" -H "Origin: $ORIGIN"
}

# --- step bookkeeping -----------------------------------------------------------

STEPS=8
STEP=0
PASSED=0
STEP_STARTED=0
RUN_STARTED="$(now_ms)"
CLEANED=0
COLD_TOOK_MS=
HIT_TOOK_MS=
INDEXED_SECONDS=

step() {
  STEP=$((STEP + 1))
  STEP_STARTED="$(now_ms)"
  printf '[%d/%d] %-56s ' "$STEP" "$STEPS" "$1"
}

step_pass() {
  local took=$(($(now_ms) - STEP_STARTED))
  PASSED=$((PASSED + 1))
  printf '\033[1;32mPASS\033[0m %6d ms  %s\n' "$took" "${1:-}" | mask
}

step_fail() {
  local took=$(($(now_ms) - STEP_STARTED))
  printf '\033[1;31mFAIL\033[0m %6d ms  %s\n' "$took" "$1" | mask
  if [ -s "$ERR_FILE" ]; then
    printf '       curl: %s\n' "$(tr -d '\n' <"$ERR_FILE")" | mask
  fi
  if [ -n "${HTTP_STATUS:-}" ] && [ "$HTTP_STATUS" != "000" ] && [ -s "$BODY_FILE" ]; then
    printf '       HTTP %s: %s\n' "$HTTP_STATUS" "$(head -c 600 "$BODY_FILE" | tr -d '\n')" | mask
  fi
  exit 1
}

# Assert the last response's status; the body goes into the failure line.
expect_status() {
  [ "$HTTP_STATUS" = "$1" ] || step_fail "${2:-request}: expected HTTP $1, got $HTTP_STATUS"
}

# assert_json <label> <python code> — d is the parsed body; env has the ids.
# Use `check(cond, msg)`; anything printed lands in DETAIL for the PASS line.
# Called at top level, never in a subshell, so a failure ends the run.
assert_json() {
  local label="$1" code="$2" out
  if ! out="$(python3 -c "
import json, os, sys
def check(cond, msg):
    if not cond:
        raise SystemExit(msg)
d = json.load(open(os.environ['BODY_FILE']))
ids = dict(line.split('\t')[:2] for line in open(os.environ['IDS_FILE']).read().splitlines())
rating = dict((line.split('\t')[0], int(line.split('\t')[3])) for line in open(os.environ['IDS_FILE']).read().splitlines())
by_id = dict((v, k) for k, v in ids.items())
blocked = {ids[n] for n in ids if rating[n] < 4}
$code
" 2>&1)"; then
    step_fail "$label: $out"
  fi
  DETAIL="$out"
}

# Results that must never contain the 2- and 3-star reviews, in any step.
POLICY_CHECK='
for r in d["results"]:
    check(r["review"]["id"] not in blocked, "policy gate: a review rated below 4 came back (%s)" % by_id.get(r["review"]["id"]))
    check(r["review"]["rating"] is None or r["review"]["rating"] >= 4, "policy gate: rating %s in results" % r["review"]["rating"])
'

cleanup() {
  local status=$? n id
  trap - EXIT
  if [ "$CLEANED" != 1 ] && [ -s "$IDS_FILE" ]; then
    while IFS="$(printf '\t')" read -r n id _rest; do
      curl -sS -o /dev/null -X DELETE "$API_URL/v1/reviews/$id" -H "$(auth_sk)" >/dev/null 2>&1 || true
    done <"$IDS_FILE"
    printf '[demo] cleanup: deleted the remaining demo reviews\n'
  fi
  rm -rf "$TMP"
  local total=$((($(now_ms) - RUN_STARTED) / 1000))
  if [ "$status" = 0 ] && [ "$PASSED" = "$STEPS" ]; then
    printf '\033[1;32mdemo: %d/%d steps passed\033[0m in %ds against %s — cold query %s ms, cache HIT %s ms, ingest→indexed %ss\n' \
      "$PASSED" "$STEPS" "$total" "$API_URL" "$COLD_TOOK_MS" "$HIT_TOOK_MS" "$INDEXED_SECONDS"
    exit 0
  fi
  printf '\033[1;31mdemo: %d/%d steps passed\033[0m in %ds against %s — FAILED at step %d\n' "$PASSED" "$STEPS" "$total" "$API_URL" "$STEP"
  exit "${status:-1}"
}
trap cleanup EXIT

# --- the demo reviews -----------------------------------------------------------
# Six topics with no shared vocabulary (so the bag-of-words local embedder and
# bge-m3 agree on who matches what), none of which the seeded Cedar Ridge
# corpus talks about. Review 6 (2 stars) and review 5 (3 stars) sit below the
# default policy (min_rating 4) and must never be returned. Review 6's topic
# is deliberately far from dentistry: with bge-m3, anything that merely
# *sounds* like a clinic complaint ("the lobby coffee kiosk ate my coins")
# scores 0.55–0.60 against unrelated dental reviews, right at the default
# floor, so the "none" assertion needs a topic the corpus cannot echo.
EPOCH="$(date +%s)"
PREFIX="demo-$EPOCH"
Q_MATCH="evening appointments so I never miss work"      # → review 1
Q_NONE="guest wifi password router kept dropping"      # → only review 6's topic

printf '[demo] %s · origin %s · reviews %s-1…6\n' "$API_URL" "$ORIGIN" "$PREFIX"

# 1. health ------------------------------------------------------------------------
step "GET /health"
http GET "$API_URL/health"
expect_status 200 "health"
[ "$(jget 'd.get("ok")')" = "true" ] || step_fail "health body is not {\"ok\":true}"
[ -n "$(hdr x-request-id)" ] || step_fail "no x-request-id header"
step_pass "ok, x-request-id $(hdr x-request-id)"

# 2. ingest --------------------------------------------------------------------------
step "POST /v1/reviews (6 reviews, $PREFIX-n)"
python3 - "$PREFIX" >"$TMP/ingest.json" <<'PY'
import json, sys
from datetime import datetime, timedelta, timezone
prefix = sys.argv[1]
now = datetime.now(timezone.utc).replace(microsecond=0)
reviews = [
    (5, "Evening appointments until eight, so I never miss work. Booked online in two minutes.", "Demo Patient One"),
    (5, "They sent the invoice before the visit and the final statement matched it to the penny.", "Demo Patient Two"),
    (4, "The playroom kept my toddler busy; the hygienist even let her hold the mirror.", "Demo Patient Three"),
    (5, "Noise-cancelling headphones and a weighted blanket made the drill a non-event.", "Demo Patient Four"),
    (3, "Decent cleaning, but the reminders arrived after the appointment had already passed.", "Demo Patient Five"),
    (2, "The guest wifi password on the wall was wrong and the router kept dropping my laptop.", "Demo Patient Six"),
]
body = []
for n, (rating, text, author) in enumerate(reviews, start=1):
    body.append({
        "external_id": "%s-%d" % (prefix, n),
        "source": "custom",
        "rating": rating,
        "text": text,
        "author_name": author,
        "occurred_at": (now - timedelta(minutes=n)).isoformat().replace("+00:00", "Z"),
        "metadata": {"demo": "scripts/demo.sh"},
    })
json.dump(body, sys.stdout)
PY
http POST "$API_URL/v1/reviews" -H "$(auth_sk)" -H "Content-Type: application/json" --data-binary "@$TMP/ingest.json"
expect_status 200 "ingest"
python3 -c '
import json, os, sys
d = json.load(open(os.environ["BODY_FILE"]))
req = json.load(open(sys.argv[1]))
rows = d.get("reviews", [])
if len(rows) != len(req):
    raise SystemExit("expected %d stored reviews, got %d" % (len(req), len(rows)))
with open(os.environ["IDS_FILE"], "w") as f:
    for n, (r, want) in enumerate(zip(rows, req), start=1):
        if r["external_id"] != want["external_id"]:
            raise SystemExit("row %d: external_id %s != %s" % (n, r["external_id"], want["external_id"]))
        if r["status"] not in ("indexing", "indexed"):
            raise SystemExit("row %d: status %r" % (n, r["status"]))
        f.write("%d\t%s\t%s\t%d\n" % (n, r["id"], r["external_id"], want["rating"]))
print(", ".join(r["status"] for r in rows))
' "$TMP/ingest.json" >"$TMP/ingest.out" 2>&1 || step_fail "ingest: $(cat "$TMP/ingest.out")"
id_of() { awk -F'\t' -v n="$1" '$1 == n { print $2 }' "$IDS_FILE"; }
ID1="$(id_of 1)"
export ID1
step_pass "stored 6: $(cat "$TMP/ingest.out")"

# 3. wait for indexed ----------------------------------------------------------------
step "GET /v1/reviews?source=custom until 6/6 indexed"
INDEX_STARTED="$(now_ms)"
indexed=0
while :; do
  http GET "$API_URL/v1/reviews?source=custom&limit=100" -H "$(auth_sk)"
  expect_status 200 "list"
  indexed="$(python3 -c '
import json, os
d = json.load(open(os.environ["BODY_FILE"]))
ids = {line.split("\t")[1] for line in open(os.environ["IDS_FILE"]).read().splitlines()}
print(sum(1 for r in d["reviews"] if r["id"] in ids and r["status"] == "indexed"))
')"
  elapsed_ms=$(($(now_ms) - INDEX_STARTED))
  [ "$indexed" = 6 ] && break
  if [ "$elapsed_ms" -ge $((WAIT_SECONDS * 1000)) ]; then
    step_fail "only $indexed/6 indexed after ${WAIT_SECONDS}s (is the pipeline worker running and consuming the ingest queue?)"
  fi
  sleep 2
done
INDEXED_SECONDS="$(python3 -c "print(round($elapsed_ms / 1000, 1))")"
# The pipeline marks the row indexed and purges the query cache; give the
# purge a moment so the cold query below is genuinely the first.
sleep 1
step_pass "6/6 indexed after ${INDEXED_SECONDS}s"

# 4. three queries -------------------------------------------------------------------
step "GET /v1/query (publishable key + Origin) ×3"
query "$Q_MATCH"
expect_status 200 "query a ($Q_MATCH)"
[ "$(hdr access-control-allow-origin)" = "$ORIGIN" ] || step_fail "query a: Access-Control-Allow-Origin is '$(hdr access-control-allow-origin)', want $ORIGIN"
[ "$(hdr x-cache)" = "MISS" ] || step_fail "query a: expected x-cache: MISS on the first query after indexing, got '$(hdr x-cache)'"
assert_json "query a ($Q_MATCH)" "
check(d['match'] == 'query', 'match is %r, want \"query\"' % d['match'])
check(len(d['results']) >= 1, 'no results')
top = d['results'][0]
check(top['review']['id'] == os.environ['ID1'], 'top result is %s, want review 1' % by_id.get(top['review']['id'], top['review']['id']))
check(top['matched'] is True, 'top result matched is not true')
check(top['score'] is not None and top['score'] >= float(os.environ['SIMILARITY_FLOOR']), 'top score %s is below the floor %s' % (top['score'], os.environ['SIMILARITY_FLOOR']))
check(d['cached'] is False, 'cached should be false on the cold query')
$POLICY_CHECK
print('a: %d result(s), top=review 1 score %.3f took_ms %d' % (len(d['results']), top['score'], d['took_ms']))
"
detail_a="$DETAIL"
COLD_TOOK_MS="$(jget 'd["took_ms"]')"

query "$Q_NONE"
expect_status 200 "query b ($Q_NONE)"
assert_json "query b ($Q_NONE)" "
check(d['match'] == 'none', 'match is %r, want \"none\" (the 2-star is the only review on this topic and policy hides it)' % d['match'])
check(d['results'] == [], 'results should be [] — empty beats irrelevant — got %d row(s)' % len(d['results']))
print('b: match none, results []')
"
detail_b="$DETAIL"

query "$Q_NONE" "fallback=recent"
expect_status 200 "query c ($Q_NONE, fallback=recent)"
assert_json "query c ($Q_NONE, fallback=recent)" "
check(d['match'] == 'fallback', 'match is %r, want \"fallback\"' % d['match'])
check(len(d['results']) >= 1, 'fallback returned no rows')
for r in d['results']:
    check(r['matched'] is False, 'fallback row has matched: true')
    check(r['score'] is None and r['highlight'] is None, 'fallback row has a score or highlight')
$POLICY_CHECK
print('c: match fallback, %d labelled row(s)' % len(d['results']))
"
detail_c="$DETAIL"
step_pass "$detail_a · $detail_b · $detail_c"

# 5. cache hit --------------------------------------------------------------------------
step "GET /v1/query (repeat a) → x-cache: HIT"
query "$Q_MATCH"
expect_status 200 "query a again"
[ "$(hdr x-cache)" = "HIT" ] || step_fail "expected x-cache: HIT, got '$(hdr x-cache)'"
assert_json "query a again" "
check(d['cached'] is True, 'cached should be true on a HIT')
check(d['match'] == 'query' and d['results'] and d['results'][0]['review']['id'] == os.environ['ID1'], 'HIT returned a different answer')
$POLICY_CHECK
print('took_ms %d' % d['took_ms'])
"
detail="$DETAIL"
HIT_TOOK_MS="$(jget 'd["took_ms"]')"
step_pass "HIT, $detail"

# 6. highlights ---------------------------------------------------------------------------
step "GET /v1/query (a, include=text) → highlights"
query "$Q_MATCH" "include=text"
expect_status 200 "query a include=text"
assert_json "include=text" "
check(d['match'] == 'query' and len(d['results']) >= 1, 'no results to check')
for r in d['results']:
    text = r['review'].get('text')
    check(isinstance(text, str), 'review.text missing with include=text')
    u16 = text.encode('utf-16-le')
    h = r['highlight']
    if h is None:
        check(r['excerpt'] == text, 'highlight is null but the excerpt is not the whole review')
        continue
    sliced = u16[2 * h['start']:2 * h['end']].decode('utf-16-le')
    check(sliced == r['excerpt'], 'text.slice(%d, %d) = %r != excerpt %r' % (h['start'], h['end'], sliced, r['excerpt']))
$POLICY_CHECK
print('%d result(s), every text.slice(highlight.start, highlight.end) === excerpt' % len(d['results']))
"
detail="$DETAIL"
step_pass "$detail"

# 7. hide ------------------------------------------------------------------------------------
step "PATCH /v1/reviews/{review 1} hidden → gone from a"
http PATCH "$API_URL/v1/reviews/$ID1" -H "$(auth_sk)" -H "Content-Type: application/json" --data-binary '{"hidden":true}'
expect_status 200 "hide"
[ "$(jget 'd["hidden"]')" = "true" ] || step_fail "hide: response hidden is not true"
query "$Q_MATCH"
expect_status 200 "query a after hide"
[ "$(hdr x-cache)" = "MISS" ] || step_fail "expected x-cache: MISS after the hide purged the cache, got '$(hdr x-cache)'"
assert_json "query a after hide" "
check(all(r['review']['id'] != os.environ['ID1'] for r in d['results']), 'the hidden review is still in the results')
$POLICY_CHECK
print('match %s, %d result(s), review 1 absent' % (d['match'], len(d['results'])))
"
detail="$DETAIL"
step_pass "hidden; MISS, $detail"

# 8. delete ------------------------------------------------------------------------------------
step "DELETE /v1/reviews/{id} ×6 → 204, GET → 404"
deleted=0
for n in 1 2 3 4 5 6; do
  id="$(id_of "$n")"
  http DELETE "$API_URL/v1/reviews/$id" -H "$(auth_sk)"
  expect_status 204 "delete review $n"
  deleted=$((deleted + 1))
done
for n in 1 2 3 4 5 6; do
  id="$(id_of "$n")"
  http GET "$API_URL/v1/reviews/$id" -H "$(auth_sk)"
  expect_status 404 "get deleted review $n"
done
CLEANED=1
step_pass "6 deleted, 6 × 404"
