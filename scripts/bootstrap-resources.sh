#!/usr/bin/env bash
# Idempotent Cloudflare resource bootstrap for fork-friendly deploys.
#
# For each resource declared in wrangler.toml (D1 database, KV namespace,
# Queue), this script:
#   1. Checks whether the id currently pinned in wrangler.toml exists in
#      this account. If so, keep it (owner's primary deploy path).
#   2. Otherwise, looks the resource up by name. If found, reuse its id.
#   3. Otherwise, creates the resource and captures the new id.
#
# Finally, it patches wrangler.toml in-place with the resolved ids. The
# CI workspace is ephemeral so this does not modify the committed file.
#
# Required env:
#   CLOUDFLARE_API_TOKEN
#   CLOUDFLARE_ACCOUNT_ID

set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN must be set}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID must be set}"

API="https://api.cloudflare.com/client/v4"
AUTH_HEADER="Authorization: Bearer $CLOUDFLARE_API_TOKEN"

# ---------------------------------------------------------------- helpers
cf_get() { curl -fsS -H "$AUTH_HEADER" "$API$1"; }
cf_post() {
  curl -fsS -X POST -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    "$API$1" -d "$2"
}

# Extract a scalar string value under a named [[table]] section in
# wrangler.toml. Reads from the first exact-match section header until
# the next [ section or EOF. Portable: works with mawk, gawk, busybox awk.
#
# Usage: toml_scalar '[[d1_databases]]' 'database_name'
toml_scalar() {
  awk -v section="$1" -v key="$2" '
    $0 == section { in_section = 1; next }
    /^\[/ && in_section { in_section = 0 }
    in_section && $1 == key {
      # Extract the value between the first pair of double quotes.
      n = split($0, parts, "\"")
      if (n >= 2) { print parts[2]; exit }
    }
  ' wrangler.toml
}

# ---------------------------------------------------- resource: D1 database
D1_NAME=$(toml_scalar '[[d1_databases]]' 'database_name')
D1_CURRENT=$(toml_scalar '[[d1_databases]]' 'database_id')
if [ -z "$D1_NAME" ]; then
  echo "ERROR: could not parse database_name from wrangler.toml"
  exit 1
fi

D1_ID=""
# Step 1: is the pinned id present in this account?
if [ -n "$D1_CURRENT" ]; then
  if cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database/$D1_CURRENT" \
      > /dev/null 2>&1; then
    D1_ID="$D1_CURRENT"
    echo "D1: reusing pinned id $D1_ID"
  fi
fi
# Step 2: lookup by name
if [ -z "$D1_ID" ]; then
  D1_ID=$(cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database?name=$D1_NAME" \
    | jq -r --arg n "$D1_NAME" '.result[] | select(.name==$n) | .uuid' \
    | head -n1)
  if [ -n "$D1_ID" ]; then
    echo "D1: found existing '$D1_NAME' → $D1_ID"
  fi
fi
# Step 3: create
if [ -z "$D1_ID" ]; then
  echo "D1: creating database '$D1_NAME'..."
  CREATE_BODY=$(jq -cn --arg n "$D1_NAME" '{name:$n}')
  D1_ID=$(cf_post "/accounts/$CLOUDFLARE_ACCOUNT_ID/d1/database" "$CREATE_BODY" \
    | jq -r '.result.uuid // empty')
  if [ -z "$D1_ID" ]; then
    echo "ERROR: D1 create returned no uuid"
    exit 1
  fi
  echo "D1: created $D1_NAME → $D1_ID"
fi

# ---------------------------------------------------- resource: KV namespace
# wrangler.toml has no explicit name for the KV namespace (only the id +
# binding). Derive a canonical title from the worker name so fork deploys
# create a reusable namespace.
WORKER_NAME=$(awk -F'"' '/^name[[:space:]]*=/ { print $2; exit }' wrangler.toml)
KV_TITLE="${WORKER_NAME}-kv"
KV_CURRENT=$(toml_scalar '[[kv_namespaces]]' 'id')

KV_ID=""
if [ -n "$KV_CURRENT" ]; then
  # Listing is the only read path for KV; check the id appears in the list.
  if cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" \
      | jq -e --arg id "$KV_CURRENT" '.result | any(.id == $id)' > /dev/null; then
    KV_ID="$KV_CURRENT"
    echo "KV: reusing pinned id $KV_ID"
  fi
fi
if [ -z "$KV_ID" ]; then
  KV_ID=$(cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces?per_page=100" \
    | jq -r --arg t "$KV_TITLE" '.result[] | select(.title==$t) | .id' \
    | head -n1)
  if [ -n "$KV_ID" ]; then
    echo "KV: found existing '$KV_TITLE' → $KV_ID"
  fi
fi
if [ -z "$KV_ID" ]; then
  echo "KV: creating namespace '$KV_TITLE'..."
  BODY=$(jq -cn --arg t "$KV_TITLE" '{title:$t}')
  KV_ID=$(cf_post "/accounts/$CLOUDFLARE_ACCOUNT_ID/storage/kv/namespaces" "$BODY" \
    | jq -r '.result.id // empty')
  if [ -z "$KV_ID" ]; then
    echo "ERROR: KV create returned no id"
    exit 1
  fi
  echo "KV: created $KV_TITLE → $KV_ID"
fi

# ----------------------------------------------------------- resource: Queue
QUEUE_NAME=$(toml_scalar '[[queues.producers]]' 'queue')
if [ -z "$QUEUE_NAME" ]; then
  echo "ERROR: could not parse queue name from wrangler.toml"
  exit 1
fi
if cf_get "/accounts/$CLOUDFLARE_ACCOUNT_ID/queues" \
    | jq -e --arg n "$QUEUE_NAME" '.result | any(.queue_name == $n)' > /dev/null; then
  echo "Queue: '$QUEUE_NAME' already exists"
else
  echo "Queue: creating '$QUEUE_NAME'..."
  BODY=$(jq -cn --arg n "$QUEUE_NAME" '{queue_name:$n}')
  cf_post "/accounts/$CLOUDFLARE_ACCOUNT_ID/queues" "$BODY" \
    | jq -r '.result.queue_name' > /dev/null
  echo "Queue: created $QUEUE_NAME"
fi

# -------------------------------------------------- patch wrangler.toml ids
# Only touch the specific id lines inside [[d1_databases]] / [[kv_namespaces]]
# so we don't accidentally rewrite anything else. The CI checkout is
# ephemeral — this does not land back in the repo.

# database_id (first occurrence under [[d1_databases]])
awk -v new="$D1_ID" '
  BEGIN { in_sec=0; done=0 }
  $0 == "[[d1_databases]]" { in_sec=1; print; next }
  /^\[/ && in_sec && $0 != "[[d1_databases]]" { in_sec=0 }
  in_sec && !done && $1 == "database_id" {
    print "database_id = \"" new "\""
    done=1
    next
  }
  { print }
' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml

# id (first occurrence under [[kv_namespaces]])
awk -v new="$KV_ID" '
  BEGIN { in_sec=0; done=0 }
  $0 == "[[kv_namespaces]]" { in_sec=1; print; next }
  /^\[/ && in_sec && $0 != "[[kv_namespaces]]" { in_sec=0 }
  in_sec && !done && $1 == "id" {
    print "id = \"" new "\""
    done=1
    next
  }
  { print }
' wrangler.toml > wrangler.toml.tmp && mv wrangler.toml.tmp wrangler.toml

echo ""
echo "Resolved resource ids:"
echo "  D1:    $D1_NAME = $D1_ID"
echo "  KV:    $KV_TITLE = $KV_ID"
echo "  Queue: $QUEUE_NAME"
