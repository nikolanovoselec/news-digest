#!/usr/bin/env bash
# End-to-end smoke test against the deployed Worker.
#
# Uses the /api/dev/login bypass (gated by DEV_BYPASS_TOKEN) to acquire
# a session cookie for the owner, then exercises every user-facing page
# and every API endpoint. Checks status codes and, where cheap, a
# handful of response-body invariants.
#
# Required env:
#   BASE               e.g. https://news.graymatter.ch (default)
#   DEV_BYPASS_TOKEN   the value set as a Worker secret via `wrangler secret put`
#
# Optional env:
#   CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID  enables DB round-trip assertions
#
# Exit code: 0 if every check passes, non-zero otherwise. The script
# prints one line per check in the form "PASS|FAIL <method> <path> → <got>/<want>".

set -uo pipefail

BASE=${BASE:-https://news.graymatter.ch}
: "${DEV_BYPASS_TOKEN:?DEV_BYPASS_TOKEN must be set}"

COOKIE_JAR=$(mktemp)
trap 'rm -f "$COOKIE_JAR"' EXIT

PASSED=0
FAILED=0
FAIL_LINES=()

# ------------------------------------------------------------ helpers
# Usage: curl_status METHOD URL [extra curl args…]
curl_status() {
  local method=$1 url=$2
  shift 2
  curl -sS --max-time 20 -o /tmp/e2e-body.last -w '%{http_code}' \
    -X "$method" -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -H "Origin: $BASE" -H "Accept: application/json, text/html" \
    "$@" "$url"
}

# Usage: check METHOD PATH EXPECTED_CODES [extra curl args…]
# EXPECTED_CODES is a '|' separated list: "200" or "200|303".
check() {
  local method=$1 path=$2 want=$3
  shift 3
  local got
  got=$(curl_status "$method" "$BASE$path" "$@")
  if [[ "|$want|" == *"|$got|"* ]]; then
    PASSED=$((PASSED + 1))
    printf 'PASS %s %s → %s\n' "$method" "$path" "$got"
  else
    FAILED=$((FAILED + 1))
    local line
    line=$(printf 'FAIL %s %s → %s (want %s)' "$method" "$path" "$got" "$want")
    FAIL_LINES+=("$line")
    printf '%s\n' "$line"
    if [ -s /tmp/e2e-body.last ]; then
      printf '     body: %s\n' "$(head -c 300 /tmp/e2e-body.last)"
    fi
  fi
}

# Usage: check_body METHOD PATH GREP_PATTERN [extra curl args…]
check_body() {
  local method=$1 path=$2 pattern=$3
  shift 3
  curl -sS --max-time 20 -o /tmp/e2e-body.last \
    -X "$method" -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -H "Origin: $BASE" \
    "$@" "$BASE$path" || true
  if grep -q -E "$pattern" /tmp/e2e-body.last; then
    PASSED=$((PASSED + 1))
    printf 'PASS body %s %s matches /%s/\n' "$method" "$path" "$pattern"
  else
    FAILED=$((FAILED + 1))
    local line
    line=$(printf 'FAIL body %s %s does not match /%s/' "$method" "$path" "$pattern")
    FAIL_LINES+=("$line")
    printf '%s\n' "$line"
    printf '     body start: %s\n' "$(head -c 300 /tmp/e2e-body.last)"
  fi
}

# -------------------------------------------------------- acquire session
printf '\n=== acquire session via /api/dev/login ===\n'
got=$(curl -sS --max-time 20 -o /tmp/e2e-body.last -w '%{http_code}' \
  -X POST -c "$COOKIE_JAR" \
  -H "Authorization: Bearer $DEV_BYPASS_TOKEN" \
  -H "Origin: $BASE" "$BASE/api/dev/login")
if [ "$got" != "200" ]; then
  printf 'FAIL acquire session: HTTP %s — %s\n' "$got" "$(head -c 500 /tmp/e2e-body.last)"
  exit 1
fi
printf 'PASS acquired session: %s\n' "$(cat /tmp/e2e-body.last)"

# ---------------------------------------------------------- anonymous pages
# Landing page should exist. For a logged-in user hitting /, index.astro
# redirects to /digest (303), otherwise 200.
printf '\n=== anonymous / authenticated pages ===\n'
check GET  /                                200\|303
check GET  /digest                          200\|303
check GET  /settings                        200\|303
check GET  /history                         200
check GET  /digest/failed?code=llm_failed   200
check GET  /digest/no-stories               200
check GET  /offline                         200
check GET  /rate-limited                    200
check GET  /favicon.svg                     200
check GET  /manifest.webmanifest            200
check GET  /theme-init.js                   200

# ------------------------------------------------------------ API surface
printf '\n=== API endpoints ===\n'
# /api/auth/github/login — both methods work and 303 to GitHub.
check GET  /api/auth/github/login           303
check POST /api/auth/github/login           303

# /api/auth/account — DELETE-only in production; GET is 405 or 404.
check GET  /api/auth/account                404\|405

# /api/digest/today — returns JSON; 200 with { digest, ... }.
check GET  /api/digest/today                200
check_body GET /api/digest/today 'digest|next_scheduled_at'

# /api/history — returns JSON. Empty digests list is fine for a new account.
check GET  /api/history                     200
check GET  /api/history?offset=0            200

# /api/stats — returns JSON with { digests_generated, ... }.
check GET  /api/stats                       200
check_body GET /api/stats 'digests_generated|articles_read|tokens_in'

# /api/discovery/status — returns JSON with per-hashtag status (possibly empty).
check GET  /api/discovery/status            200

# PUT /api/settings — save schedule + model + email (hashtags managed
# separately at POST /api/tags since the tag editor moved to /digest).
printf '\n=== PUT /api/settings (save happy path) ===\n'
PAYLOAD='{"digest_hour":8,"digest_minute":30,"tz":"Europe/Zurich","model_id":"@cf/meta/llama-3.1-8b-instruct-fp8-fast","email_enabled":true}'
check PUT  /api/settings 200 -H 'Content-Type: application/json' --data "$PAYLOAD"
check_body GET /api/settings '"Europe/Zurich"'
check_body GET /api/settings '"digest_hour":8'

# POST /api/tags — replace the user's hashtag list. The /digest tag strip
# is the only editor for this now.
printf '\n=== POST /api/tags ===\n'
TAGS_PAYLOAD='{"tags":["llm","cloudflare","aws"]}'
check POST /api/tags 200 -H 'Content-Type: application/json' --data "$TAGS_PAYLOAD"
check_body GET /api/settings '"llm"'
# Empty tags is a 400.
check POST /api/tags 400 -H 'Content-Type: application/json' --data '{"tags":[]}'

# POST /api/auth/set-tz — auto-detect path. Send a valid zone.
TZ_PAYLOAD='{"tz":"America/New_York"}'
check POST /api/auth/set-tz 200 -H 'Content-Type: application/json' --data "$TZ_PAYLOAD"

# Restore zone to match the settings write (avoid polluting state for
# subsequent runs) — this also exercises a second set-tz call.
RESTORE_TZ='{"tz":"Europe/Zurich"}'
check POST /api/auth/set-tz 200 -H 'Content-Type: application/json' --data "$RESTORE_TZ"

# POST /api/digest/refresh — triggers a manual digest. 202 = queued,
# 409 = one already in progress, 429 = rate-limited. Any of these three
# proves the route is alive.
check POST /api/digest/refresh 202\|409\|429 -H 'Content-Type: application/json' --data '{}'

# POST /api/discovery/retry — requeue a specific tag. Needs a valid tag
# from the user's hashtags_json. "llm" was just set via /api/tags above.
check POST /api/discovery/retry 200 -H 'Content-Type: application/json' --data '{"tag":"llm"}'
# Unknown tag → 400 unknown_tag.
check POST /api/discovery/retry 400 -H 'Content-Type: application/json' --data '{"tag":"not-a-user-tag-xyz"}'

# /api/auth/github/logout — signing out should 303 back to `/`.
check POST /api/auth/github/logout 303 -H 'Content-Type: application/json'

# After logout, authenticated routes should now 303 to login.
printf '\n=== post-logout ===\n'
check GET  /digest   303

# ------------------------------------------------------------- summary
printf '\n=== summary ===\n'
printf 'passed: %d   failed: %d\n' "$PASSED" "$FAILED"
if [ "$FAILED" -gt 0 ]; then
  printf '\nFailures:\n'
  for line in "${FAIL_LINES[@]}"; do
    printf '  %s\n' "$line"
  done
  exit 1
fi
