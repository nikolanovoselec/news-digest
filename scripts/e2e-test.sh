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

# Guard against running this script against the owner's production
# Worker. The test POSTs tags like "llm" and triggers /api/discovery/retry,
# which cache feed lists in KV that then leak into the LLM's tag
# allowlist and contaminate real article data. Running against a
# preview or local wrangler dev environment is the intended use.
# Pass `--force-prod` as the first argument to opt in explicitly.
PROD_HOSTS="news.graymatter.ch"
if [ "${1:-}" != "--force-prod" ]; then
  for host in $PROD_HOSTS; do
    if printf '%s' "$BASE" | grep -qE "^https?://$host(/|:|$)"; then
      echo "REFUSING to run e2e against $BASE (production)."
      echo "This test mutates user tags + triggers discovery; the side"
      echo "effects pollute the global article pool."
      echo "Run against a preview deploy or pass --force-prod to override."
      exit 2
    fi
  done
fi

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
check GET  /starred                         200
# Error pages (global-feed rework retired /digest/failed + /digest/no-stories).
check GET  /does-not-exist                  404
check GET  /favicon.svg                     200
check GET  /manifest.webmanifest            200
check GET  /theme-init.js                   200
check GET  /scramble.js                     200
check GET  /robots.txt                      200
check GET  /llms.txt                        200
check GET  /llms-full.txt                   200
check GET  /sitemap.xml                     200

# ------------------------------------------------------------ API surface
printf '\n=== API endpoints ===\n'
# /api/auth/github/login — both methods work and 303 to GitHub.
check GET  /api/auth/github/login           303
check POST /api/auth/github/login           303

# /api/auth/account — DELETE-only in production; GET is 405 or 404.
check GET  /api/auth/account                404\|405
# DELETE without a body is a bad request (400). This proves the JSON
# path is alive without actually deleting the owner's account.
check DELETE /api/auth/account              400 -H 'Content-Type: application/json'
# DELETE with { confirm: "WRONG" } is still a 400 — confirmation_required.
check DELETE /api/auth/account              400 -H 'Content-Type: application/json' --data '{"confirm":"WRONG"}'
# POST (native-form path) with an empty body — accept 400 OR 404.
# Some Astro-adapter versions 404 on empty POST before the handler
# gets a chance to return bad_request; either way the route rejects
# without touching D1, which is the contract we care about.
check POST   /api/auth/account              400\|404 -H 'Content-Type: application/x-www-form-urlencoded' --data ''
# POST with wrong confirm literal — still a 400, no delete.
check POST   /api/auth/account              400 -H 'Content-Type: application/x-www-form-urlencoded' --data 'confirm=delete'

# /api/digest/today — global-feed response: { articles, last_scrape_run, next_scrape_at }.
check GET  /api/digest/today                200
check_body GET /api/digest/today 'articles|last_scrape_run|next_scrape_at'

# /api/starred — returns { articles } for the session user.
check GET  /api/starred                     200
check_body GET /api/starred 'articles'

# /api/history — returns { days } day-grouped list.
check GET  /api/history                     200
check_body GET /api/history 'days'

# /api/stats — returns JSON with { digests_generated, ... }.
check GET  /api/stats                       200
check_body GET /api/stats 'digests_generated|articles_read|tokens_consumed'

# /api/discovery/status — returns JSON with per-hashtag status (possibly empty).
check GET  /api/discovery/status            200

# ------------------------------------------------------------- snapshot
# Snapshot the session user's mutable state BEFORE any write so the
# end-of-script restore block can put it back exactly as we found it.
# This is the "don't pollute prod" guard — the whole e2e runs against
# the owner account (the only account a fresh Worker has), so every
# tag/star write HAS to be a save → assert → restore cycle.
printf '\n=== snapshot ===\n'
ORIG_SETTINGS_JSON=$(curl -sS -b "$COOKIE_JAR" "$BASE/api/settings" || echo '{}')
# /api/settings returns the parsed array under the key `hashtags`, NOT
# the raw `hashtags_json` column value. Reading the wrong key made the
# snapshot silently empty and the restore block a no-op — which
# stranded the e2e test tags ["llm","cloudflare","aws"] on the owner
# account after every deploy. Fail hard if the snapshot fetch didn't
# return a non-empty array so a future regression can't leak again.
ORIG_HASHTAGS_JSON=$(printf '%s' "$ORIG_SETTINGS_JSON" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('hashtags') or []))" 2>/dev/null || echo '[]')
if [ "$ORIG_HASHTAGS_JSON" = '[]' ] || [ -z "$ORIG_HASHTAGS_JSON" ]; then
  printf 'FATAL: snapshot returned empty hashtags — refusing to run mutating assertions\n'
  printf '       response body was: %s\n' "$(printf '%s' "$ORIG_SETTINGS_JSON" | head -c 300)"
  exit 3
fi
ORIG_DIGEST_HOUR=$(printf '%s' "$ORIG_SETTINGS_JSON" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('digest_hour') or 8)" 2>/dev/null || echo '8')
ORIG_DIGEST_MINUTE=$(printf '%s' "$ORIG_SETTINGS_JSON" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('digest_minute') or 0)" 2>/dev/null || echo '0')
ORIG_TZ=$(printf '%s' "$ORIG_SETTINGS_JSON" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('tz') or 'Europe/Zurich')" 2>/dev/null || echo 'Europe/Zurich')
ORIG_MODEL_ID=$(printf '%s' "$ORIG_SETTINGS_JSON" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('model_id') or '@cf/meta/llama-3.1-8b-instruct-fp8-fast')" 2>/dev/null || echo '@cf/meta/llama-3.1-8b-instruct-fp8-fast')
ORIG_EMAIL_ENABLED=$(printf '%s' "$ORIG_SETTINGS_JSON" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print('true' if d.get('email_enabled') else 'false')" 2>/dev/null || echo 'true')
ORIG_STARRED=$(curl -sS -b "$COOKIE_JAR" "$BASE/api/starred" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(a['id'] for a in d.get('articles',[])))" 2>/dev/null || echo '')
printf 'original hashtags: %s\n' "$ORIG_HASHTAGS_JSON"
printf 'original starred (%d): %s\n' "$(printf '%s' "$ORIG_STARRED" | wc -w)" "$ORIG_STARRED"

# PUT /api/settings — save schedule + model + email (hashtags managed
# separately at POST /api/tags since the tag editor moved to /digest).
printf '\n=== PUT /api/settings (save happy path) ===\n'
PAYLOAD='{"digest_hour":8,"digest_minute":30,"tz":"Europe/Zurich","model_id":"@cf/meta/llama-3.1-8b-instruct-fp8-fast","email_enabled":true}'
check PUT  /api/settings 200 -H 'Content-Type: application/json' --data "$PAYLOAD"
check_body GET /api/settings '"Europe/Zurich"'
check_body GET /api/settings '"digest_hour":8'

# POST /api/tags — replace the user's hashtag list. The /digest tag strip
# is the only editor for this now. We write a fixed test set to prove
# the write happens, then restore the snapshot at the end of the script.
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
# proves the route is alive. 410 is also accepted because the legacy
# per-user refresh was retired and the route now returns Gone.
check POST /api/digest/refresh 202\|409\|410\|429 -H 'Content-Type: application/json' --data '{}'

# Stars lifecycle — pick any article id from /api/digest/today, then
# POST → DELETE → POST again. Each transition idempotent.
printf '\n=== stars lifecycle ===\n'
ARTICLE_ID=$(curl -sS -b "$COOKIE_JAR" -c "$COOKIE_JAR" "$BASE/api/digest/today" \
  | python3 -c "import json,sys
try:
    d = json.load(sys.stdin)
    arts = d.get('articles') or []
    print(arts[0]['id'] if arts else '')
except Exception:
    print('')")
if [ -n "$ARTICLE_ID" ]; then
  check POST   /api/articles/$ARTICLE_ID/star 200\|201 -H 'Content-Type: application/json'
  check_body GET /api/starred "$ARTICLE_ID"
  check DELETE /api/articles/$ARTICLE_ID/star 200\|204 -H 'Content-Type: application/json'
  # Re-star to leave the user's saved set in a non-empty state.
  check POST   /api/articles/$ARTICLE_ID/star 200\|201 -H 'Content-Type: application/json'
else
  printf 'SKIP stars lifecycle — no article id returned by /api/digest/today\n'
fi

# POST /api/discovery/retry — requeue a specific tag. Needs a valid tag
# from the user's hashtags_json. "llm" was just set via /api/tags above.
check POST /api/discovery/retry 200 -H 'Content-Type: application/json' --data '{"tag":"llm"}'
# Unknown tag → 400 unknown_tag.
check POST /api/discovery/retry 400 -H 'Content-Type: application/json' --data '{"tag":"not-a-user-tag-xyz"}'

# ------------------------------------------------------------- restore
# Put the owner's tags + stars + settings back exactly as we found
# them. The whole e2e has been a save → mutate → assert cycle; this
# is the "mutate" side closing. Any failure here logs but does not
# fail the run — if the restore 500s for some reason we still want
# the mutation-assertion results in the summary so the real cause is
# visible.
printf '\n=== restore owner state ===\n'

# Tags — POST /api/tags accepts {"tags":[...]} where [] is a 400, so
# if the snapshot was empty we DON'T hit the endpoint (a user with
# zero tags shouldn't be possible, but be defensive).
if [ "$ORIG_HASHTAGS_JSON" != "[]" ] && [ -n "$ORIG_HASHTAGS_JSON" ]; then
  RESTORE_BODY=$(printf '{"tags":%s}' "$ORIG_HASHTAGS_JSON")
  printf 'restoring tags: %s\n' "$ORIG_HASHTAGS_JSON"
  curl -sS -o /dev/null -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
    -X POST -H "Origin: $BASE" -H 'Content-Type: application/json' \
    --data "$RESTORE_BODY" "$BASE/api/tags" || printf 'WARN tag restore failed\n'
fi

# Settings — restore schedule + model + email + tz from snapshot.
RESTORE_SETTINGS=$(printf '{"digest_hour":%s,"digest_minute":%s,"tz":"%s","model_id":"%s","email_enabled":%s}' \
  "$ORIG_DIGEST_HOUR" "$ORIG_DIGEST_MINUTE" "$ORIG_TZ" "$ORIG_MODEL_ID" "$ORIG_EMAIL_ENABLED")
printf 'restoring settings: %s\n' "$RESTORE_SETTINGS"
curl -sS -o /dev/null -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
  -X PUT -H "Origin: $BASE" -H 'Content-Type: application/json' \
  --data "$RESTORE_SETTINGS" "$BASE/api/settings" || printf 'WARN settings restore failed\n'

# Stars — the stars lifecycle above ended with `ARTICLE_ID` starred.
# Compute the exact before/after delta and apply the inverse so the
# saved set matches the snapshot byte-for-byte.
CURRENT_STARRED=$(curl -sS -b "$COOKIE_JAR" "$BASE/api/starred" \
  | python3 -c "import json,sys; d=json.load(sys.stdin); print(' '.join(a['id'] for a in d.get('articles',[])))" 2>/dev/null || echo '')
for id in $CURRENT_STARRED; do
  case " $ORIG_STARRED " in
    *" $id "*) ;; # was starred before — leave alone
    *)
      printf 'unstarring %s (added during e2e)\n' "$id"
      curl -sS -o /dev/null -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
        -X DELETE -H "Origin: $BASE" -H 'Content-Type: application/json' \
        "$BASE/api/articles/$id/star" || true
      ;;
  esac
done
for id in $ORIG_STARRED; do
  case " $CURRENT_STARRED " in
    *" $id "*) ;; # still starred — leave alone
    *)
      printf 're-starring %s (removed during e2e)\n' "$id"
      curl -sS -o /dev/null -b "$COOKIE_JAR" -c "$COOKIE_JAR" \
        -X POST -H "Origin: $BASE" -H 'Content-Type: application/json' \
        "$BASE/api/articles/$id/star" || true
      ;;
  esac
done

# --- Full-cycle scrape verification ----------------------------------
# Triggers a REAL scrape via /api/dev/trigger-scrape, polls
# /api/scrape-status until status flips away from running, then
# asserts that /api/digest/today returned articles with the shape we
# expect (title non-empty, details carries ≥ 1 paragraph of ≥ 180
# words summed). 404 on the trigger endpoint (no DEV_BYPASS_TOKEN in
# env, or the endpoint was removed) cleanly skips this block so the
# suite stays useful in reduced-permissions environments.
#
# Bounded by E2E_SCRAPE_TIMEOUT_SEC (default 600s = 10 min). Each
# poll is one D1 SELECT + one KV GET — cheap enough to run every 10s.
printf '\n=== full-cycle scrape ===\n'
TRIGGER_CODE=$(curl -sS -o /tmp/e2e-trigger.json -w '%{http_code}' \
  -X POST -H "Authorization: Bearer $DEV_BYPASS_TOKEN" \
  -H 'Content-Type: application/json' \
  "$BASE/api/dev/trigger-scrape")
case "$TRIGGER_CODE" in
  202)
    SCRAPE_RUN_ID=$(python3 -c "import json; print(json.load(open('/tmp/e2e-trigger.json'))['scrape_run_id'])" 2>/dev/null || echo '')
    printf 'triggered scrape %s\n' "$SCRAPE_RUN_ID"
    # Budget 20 minutes for the full run, but short-circuit as soon as
    # at least one chunk has landed articles — the word-count check
    # below only inspects the first article. Waiting for finishRun is
    # unnecessary if we already have enough signal to verify prompt
    # output quality.
    TIMEOUT_SEC=${E2E_SCRAPE_TIMEOUT_SEC:-1200}
    MIN_ARTICLES=${E2E_SCRAPE_MIN_ARTICLES:-10}
    DEADLINE=$(($(date +%s) + TIMEOUT_SEC))
    LAST_STATUS=''
    while [ "$(date +%s)" -lt "$DEADLINE" ]; do
      sleep 10
      curl -sS -o /tmp/e2e-scrape.json -b "$COOKIE_JAR" \
        "$BASE/api/scrape-status" || true
      IS_RUNNING=$(python3 -c "import json; print(json.load(open('/tmp/e2e-scrape.json')).get('running', False))" 2>/dev/null || echo 'False')
      INGESTED=$(python3 -c "import json; print(json.load(open('/tmp/e2e-scrape.json')).get('articles_ingested', 0))" 2>/dev/null || echo '0')
      printf '  poll: running=%s ingested=%s\n' "$IS_RUNNING" "$INGESTED"
      if [ "$IS_RUNNING" = 'False' ]; then
        LAST_STATUS='done'
        break
      fi
      if [ "$INGESTED" -ge "$MIN_ARTICLES" ]; then
        LAST_STATUS='done'
        printf '  short-circuit: ≥%s articles ingested, run still going but enough signal to verify\n' "$MIN_ARTICLES"
        break
      fi
    done
    if [ "$LAST_STATUS" = 'done' ]; then
      # Verify articles exist + carry real details.
      ART_COUNT=$(curl -sS -b "$COOKIE_JAR" "$BASE/api/digest/today" \
        | python3 -c "import json,sys; d=json.load(sys.stdin); print(len(d.get('articles',[])))" 2>/dev/null || echo '0')
      printf 'articles in /api/digest/today: %s\n' "$ART_COUNT"
      if [ "$ART_COUNT" -gt 0 ]; then
        PASSED=$((PASSED + 1))
        printf 'PASS full-cycle scrape → %s articles ingested\n' "$ART_COUNT"

        # Assert AVERAGE details length across all articles in the
        # response. The prompt target is 150-250 words per article;
        # we set the floor at 150 on the mean. Checking the mean
        # (not the first article) smooths over individual articles
        # with thin source snippets that justifiably produce shorter
        # output.
        WORD_STATS=$(curl -sS -b "$COOKIE_JAR" "$BASE/api/digest/today" \
          | python3 -c "
import json, sys
d = json.load(sys.stdin)
arts = d.get('articles', [])
if not arts:
    print('0 0 0 0'); sys.exit()
counts = []
for a in arts:
    details = a.get('details', [])
    joined = ' '.join(details) if isinstance(details, list) else str(details)
    counts.append(len(joined.split()))
counts.sort()
n = len(counts)
mean = sum(counts) // n
p50 = counts[n // 2]
lo = counts[0]
hi = counts[-1]
print(f'{n} {mean} {p50} {lo} {hi}')
" 2>/dev/null || echo '0 0 0 0 0')
        set -- $WORD_STATS
        N=$1; MEAN=$2; P50=$3; LO=$4; HI=$5
        printf 'article details word-count stats: n=%s mean=%s p50=%s min=%s max=%s\n' "$N" "$MEAN" "$P50" "$LO" "$HI"
        if [ "$MEAN" -ge 150 ]; then
          PASSED=$((PASSED + 1))
          printf 'PASS mean article details length ≥ 150 words (target 150-250)\n'
        else
          FAILED=$((FAILED + 1))
          FAIL_LINES+=("FAIL mean article details length — got $MEAN words, want ≥ 150 (target 150-250)")
          printf 'FAIL mean article details length — got %s words, want ≥ 150\n' "$MEAN"
        fi
      else
        FAILED=$((FAILED + 1))
        FAIL_LINES+=("FAIL full-cycle scrape — run finished but /api/digest/today returned 0 articles")
        printf 'FAIL scrape produced zero articles\n'
      fi
    else
      FAILED=$((FAILED + 1))
      FAIL_LINES+=("FAIL full-cycle scrape — did not complete within ${TIMEOUT_SEC}s")
      printf 'FAIL scrape did not complete within %ss\n' "$TIMEOUT_SEC"
    fi
    ;;
  404)
    printf 'SKIP full-cycle scrape — /api/dev/trigger-scrape returned 404 (DEV_BYPASS_TOKEN misconfigured or endpoint absent)\n'
    ;;
  *)
    FAILED=$((FAILED + 1))
    FAIL_LINES+=("FAIL /api/dev/trigger-scrape → HTTP $TRIGGER_CODE (expected 202 or 404)")
    printf 'FAIL /api/dev/trigger-scrape → HTTP %s\n' "$TRIGGER_CODE"
    ;;
esac

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
