#!/usr/bin/env bash
# Provisions and deploys dshgo-share on our Cloudflare account. Touches only
# its own resources:
#   R2 bucket dshgo-share (+ its lifecycle rules), KV namespace
#   dshgo-share-quota, Worker dshgo-share (+ its ADMIN_KEY secret and its
#   cron), one Workers Custom Domain (go.<zone>, else s.<zone>), which creates
#   its own DNS record, and one zone Redirect Rule, found by its description
#   (the plugin market's files to the public bucket, below). Never reads or
#   changes other Workers, DNS records, rules or zone settings.
#
#   CF_TOKEN_FILE=<file> scripts/provision.sh check    read-only: what exists, which domain
#   CF_TOKEN_FILE=<file> scripts/provision.sh apply    create what's missing, deploy, e2e
#   CF_TOKEN_FILE=<file> scripts/provision.sh deploy   redeploy the code only (+ the redirect rule)
#   … apply|deploy --no-analytics   without the Analytics Engine datasets (wrangler.jsonc), for
#                                   an account that hasn't enabled it; DSH_ANALYTICS=0 does the same
#
# Works from the public tree: the account id and the KV namespace id come from
# the environment or files outside it (scripts/cloudflare.sh; apply writes the
# KV id's file), are checked against the account, and only go into a temporary
# copy of wrangler.jsonc that wrangler deploys with. The tracked file never changes.
#
# The token is only ever passed as `$(cat "$CF_TOKEN_FILE")` straight into
# curl / wrangler: never echoed, stored or put in a URL. Don't add `set -x`.
set -euo pipefail

cd "$(dirname "$0")/.."
die() { echo "provision: $*" >&2; exit 1; }
mode=${1:-check}
ANALYTICS=${DSH_ANALYTICS:-1}
case "${2:-}" in --no-analytics) ANALYTICS=0 ;; --analytics) ANALYTICS=1 ;; '') ;; *) mode=usage ;; esac
[[ "$mode" =~ ^(check|apply|deploy)$ ]] || { echo "usage: CF_TOKEN_FILE=<file> $0 check|apply|deploy [--no-analytics]" >&2; exit 2; }
: "${CF_TOKEN_FILE:?set CF_TOKEN_FILE to the API token file}"
[[ -r "$CF_TOKEN_FILE" ]] || die "can't read CF_TOKEN_FILE"
source scripts/cloudflare.sh
# The placeholders are refused before anything runs; apply may still make the KV namespace.
real_id "$ACCOUNT" || die "no Cloudflare account id: set CF_ACCOUNT_ID or write it to $ACCOUNT_FILE (wrangler.jsonc has only a placeholder in the public tree)"
real_id "$KV_ID" || KV_ID=
[[ -n "$KV_ID" || "$mode" != deploy ]] || die "no KV namespace id: set CF_KV_QUOTA_ID or write it to $KV_ID_FILE (provision.sh apply does)"
ZONE_NAME=${ZONE_NAME:-dshtui.com}
WORKER=dshgo-share
BUCKET=dshgo-share
KV_TITLE=dshgo-share-quota
ADMIN_FILE=${ADMIN_FILE:-$HOME/.config/keys/dshgo-share-admin.txt}
CANDIDATES=("go.$ZONE_NAME" "s.$ZONE_NAME")
API=${CF_API:-https://api.cloudflare.com/client/v4}

cf() { # METHOD PATH [JSON]
  local args=(-sS -X "$1" "$API$2" -H "Authorization: Bearer $(cat "$CF_TOKEN_FILE")" -H 'Content-Type: application/json')
  [[ $# -ge 3 ]] && args+=(--data "$3")
  curl "${args[@]}"
}

ok() { jq -e '.success == true' >/dev/null <<<"$1"; }

# ── Read-only discovery ──────────────────────────────────────────────────
zone_json=$(cf GET "/zones?name=$ZONE_NAME")
ok "$zone_json" || die "zone lookup failed: $(jq -c '.errors' <<<"$zone_json")"
ZONE=$(jq -r '.result[0].id // empty' <<<"$zone_json")
[[ -n "$ZONE" ]] || die "zone $ZONE_NAME is not on this account"
[[ "$(jq -r '.result[0].account.id' <<<"$zone_json")" == "$ACCOUNT" ]] || die "zone $ZONE_NAME is on another account than $ACCOUNT (CF_ACCOUNT_ID / $ACCOUNT_FILE)"
echo "zone $ZONE_NAME: $ZONE (account $ACCOUNT)"

scripts=$(cf GET "/accounts/$ACCOUNT/workers/scripts")
ok "$scripts" || die "listing Workers failed"
WORKER_EXISTS=$(jq -r --arg w "$WORKER" '[.result[] | select(.id == $w)] | length' <<<"$scripts")

domains=$(cf GET "/accounts/$ACCOUNT/workers/domains?zone_id=$ZONE")
ok "$domains" || die "listing Workers custom domains failed"
routes=$(cf GET "/zones/$ZONE/workers/routes")
ok "$routes" || die "listing Worker routes failed"

# A host is free when no DNS record has its name, no custom domain claims it
# and no Worker route pattern would catch it. Re-runs keep our own domain.
host_state() {
  local host=$1
  local owner
  owner=$(jq -r --arg h "$host" '[.result[] | select(.hostname == $h) | .service] | first // empty' <<<"$domains")
  if [[ -n "$owner" ]]; then
    [[ "$owner" == "$WORKER" ]] && echo ours || echo "taken (custom domain of $owner)"
    return
  fi
  local records
  records=$(cf GET "/zones/$ZONE/dns_records?name=$host")
  ok "$records" || { echo "unknown (DNS lookup failed)"; return; }
  if [[ $(jq '.result | length' <<<"$records") != 0 ]]; then
    echo "taken (DNS: $(jq -r '[.result[] | .type] | join(",")' <<<"$records"))"
    return
  fi
  local route
  route=$(jq -r --arg h "$host" '[.result[] | .pattern | select(
      (split("/")[0]) as $p | $p == $h or ($p | startswith("*") and ($h | endswith($p[1:]))))] | first // empty' <<<"$routes")
  [[ -n "$route" ]] && { echo "taken (route $route)"; return; }
  echo free
}

HOST=
for h in "${CANDIDATES[@]}"; do
  state=$(host_state "$h")
  echo "  $h: $state"
  if [[ -z "$HOST" && ( "$state" == free || "$state" == ours ) ]]; then HOST=$h; fi
done
wildcard=$(cf GET "/zones/$ZONE/dns_records?name=*.$ZONE_NAME")
if ok "$wildcard" && [[ $(jq '.result | length' <<<"$wildcard") != 0 ]]; then
  echo "  note: *.$ZONE_NAME has a wildcard record; the custom domain takes precedence for its own host"
fi
[[ -n "$HOST" ]] || die "neither ${CANDIDATES[*]} is free; stopping"
echo "domain: $HOST"
echo "worker $WORKER exists: $([[ $WORKER_EXISTS != 0 ]] && echo yes || echo no)"

bucket=$(cf GET "/accounts/$ACCOUNT/r2/buckets/$BUCKET")
BUCKET_EXISTS=$(ok "$bucket" && echo 1 || echo 0)
echo "bucket $BUCKET exists: $([[ $BUCKET_EXISTS == 1 ]] && echo yes || echo no)"

kv_list=$(cf GET "/accounts/$ACCOUNT/storage/kv/namespaces?per_page=100")
ok "$kv_list" || die "listing KV namespaces failed"
FOUND_KV=$(jq -r --arg t "$KV_TITLE" '[.result[] | select(.title == $t) | .id] | first // empty' <<<"$kv_list")
echo "kv $KV_TITLE: ${FOUND_KV:-missing}$([[ -n "$KV_ID" ]] || echo " (no id in CF_KV_QUOTA_ID / $KV_ID_FILE yet)")"
[[ -z "$KV_ID" || -z "$FOUND_KV" || "$KV_ID" == "$FOUND_KV" ]] || die "$KV_TITLE is $FOUND_KV, not $KV_ID (CF_KV_QUOTA_ID / $KV_ID_FILE)"

[[ "$mode" == check ]] && exit 0

# ── Writes: only our own resources ───────────────────────────────────────
if [[ "$mode" == apply ]]; then
  if [[ $WORKER_EXISTS != 0 && "$(host_state "$HOST")" != ours && "${ALLOW_EXISTING_WORKER:-}" != 1 ]]; then
    die "a Worker named $WORKER already exists and isn't on $HOST; not touching it (ALLOW_EXISTING_WORKER=1 if it is ours)"
  fi

  if [[ $BUCKET_EXISTS == 0 ]]; then
    res=$(cf POST "/accounts/$ACCOUNT/r2/buckets" "{\"name\":\"$BUCKET\"}")
    ok "$res" || die "creating bucket failed: $(jq -c '.errors' <<<"$res") (R2 may need enabling in the dashboard first)"
    echo "created bucket $BUCKET"
  fi
  # Our bucket only: replaces its rule set with exactly these.
  res=$(cf PUT "/accounts/$ACCOUNT/r2/buckets/$BUCKET/lifecycle" '{"rules":[
    {"id":"expire-7d","enabled":true,"conditions":{"prefix":"7d/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":604800}}},
    {"id":"expire-30d","enabled":true,"conditions":{"prefix":"30d/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":2592000}}},
    {"id":"abort-multipart","enabled":true,"conditions":{"prefix":""},"abortMultipartUploadsTransition":{"condition":{"type":"Age","maxAge":86400}}}]}')
  ok "$res" || die "setting lifecycle failed: $(jq -c '.errors' <<<"$res")"
  echo "lifecycle: 7d/ → 7 days, 30d/ → 30 days"

  if [[ -z "$FOUND_KV" ]]; then
    res=$(cf POST "/accounts/$ACCOUNT/storage/kv/namespaces" "{\"title\":\"$KV_TITLE\"}")
    ok "$res" || die "creating KV failed: $(jq -c '.errors' <<<"$res")"
    FOUND_KV=$(jq -r '.result.id' <<<"$res")
    echo "created kv $KV_TITLE: $FOUND_KV"
  fi
  if [[ -z "$KV_ID" ]]; then
    mkdir -p "$(dirname "$KV_ID_FILE")"
    printf '%s\n' "$FOUND_KV" >"$KV_ID_FILE"
    KV_ID=$FOUND_KV
    echo "kv id written to $KV_ID_FILE"
  fi

  if [[ ! -s "$ADMIN_FILE" ]]; then
    mkdir -p "$(dirname "$ADMIN_FILE")"
    (umask 077; openssl rand -base64 33 | tr '+/' '-_' | tr -d '=\n' >"$ADMIN_FILE")
    chmod 600 "$ADMIN_FILE"
    echo "admin key written to $ADMIN_FILE"
  fi
fi

[[ -n "$FOUND_KV" ]] || die "KV namespace $KV_TITLE is missing: run apply"
# Our ids and the chosen host, in a copy of wrangler.jsonc next to it.
wrangler_config "$HOST"
echo "analytics: $([[ $ANALYTICS == 1 ]] && echo 'on (DOWNLOADS, CHECKS, USAGE)' || echo 'off (--no-analytics)')"
wr deploy
if [[ "$mode" == apply ]]; then
  wr secret put ADMIN_KEY <"$ADMIN_FILE"
fi

echo "waiting for https://$HOST …"
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "https://$HOST/robots.txt" || true)
  [[ "$code" == 200 ]] && break
  sleep 5
done
node scripts/e2e.mjs "https://$HOST" --admin-key-file "$ADMIN_FILE"

# ── The plugin market off the Worker ─────────────────────────────────────
# The cron puts the market's files on the public bucket every 10 minutes
# (src/market.ts); apps read them there (docs/design/plugin-market.md §3).
# Apps that ask go.<zone>/market/… get a 302 there from one zone Redirect
# Rule, created once the bucket serves what the Worker does. A request with
# an Origin header (a web page's fetch, which needs the Worker's CORS header)
# still reaches the Worker, and so does every other path.
DL_BASE=$(wrangler_json | jq -r '.vars.DL_BASE_URL // empty')
[[ -n "$DL_BASE" ]] || { echo "market redirect: skipped (no DL_BASE_URL)"; exit 0; }
DL_BASE=${DL_BASE%/}
echo "market: waiting for $DL_BASE/market/ to serve what https://$HOST/market/ does (the cron runs every 10 minutes) …"
tmp=$(mktemp -d)
trap 'rm -f "$WRANGLER_CONFIG"; rm -rf "$tmp"' EXIT
same=0
for _ in $(seq 1 30); do
  same=1
  for f in index.json dsh-go.json; do
    curl -sf -o "$tmp/dl" "$DL_BASE/market/$f" && curl -sf -H "Origin: https://$HOST" -o "$tmp/worker" "https://$HOST/market/$f" \
      && jq -e . "$tmp/dl" >/dev/null && cmp -s "$tmp/dl" "$tmp/worker" || same=0
  done
  [[ $same == 1 ]] && break
  sleep 30
done
[[ $same == 1 ]] || die "$DL_BASE/market/ doesn't serve the Worker's market yet; deploy again in a few minutes for the redirect"
echo "  same files"

DESCRIPTION="dshgo-share: plugin market from the public bucket"
rule=$(jq -nc --arg d "$DESCRIPTION" --arg host "$HOST" --arg base "$DL_BASE" '{
  description: $d,
  expression: "(http.host eq \"\($host)\" and http.request.uri.path in {\"/market/index.json\" \"/market/dsh-go.json\"} and not any(http.request.headers.names[*] eq \"origin\"))",
  action: "redirect",
  action_parameters: {from_value: {status_code: 302, preserve_query_string: true,
    target_url: {expression: "concat(\"\($base)\", http.request.uri.path)"}}},
  enabled: true}')
PHASE=/zones/$ZONE/rulesets/phases/http_request_dynamic_redirect/entrypoint
entry=$(cf GET "$PHASE")
if ! ok "$entry"; then
  [[ "$(jq -r '.errors[0].code' <<<"$entry")" == 10003 ]] || die "reading the zone's redirect rules failed: $(jq -c '.errors' <<<"$entry")"
  res=$(cf PUT "$PHASE" "$(jq -nc --argjson r "$rule" '{rules: [$r]}')")
  ok "$res" || die "creating the redirect rule failed: $(jq -c '.errors' <<<"$res")"
  echo "market redirect: created"
else
  RULESET=$(jq -r '.result.id' <<<"$entry")
  current=$(jq -c --arg d "$DESCRIPTION" '[.result.rules[] | select(.description == $d)] | first // empty' <<<"$entry")
  if [[ -z "$current" ]]; then
    res=$(cf POST "/zones/$ZONE/rulesets/$RULESET/rules" "$rule")
    ok "$res" || die "adding the redirect rule failed: $(jq -c '.errors' <<<"$res")"
    echo "market redirect: added"
  elif [[ "$(jq -cS '{expression, action, action_parameters, enabled}' <<<"$current")" != "$(jq -cS '{expression, action, action_parameters, enabled}' <<<"$rule")" ]]; then
    res=$(cf PATCH "/zones/$ZONE/rulesets/$RULESET/rules/$(jq -r .id <<<"$current")" "$rule")
    ok "$res" || die "updating the redirect rule failed: $(jq -c '.errors' <<<"$res")"
    echo "market redirect: updated"
  else
    echo "market redirect: up to date"
  fi
fi
for _ in $(seq 1 12); do
  [[ "$(curl -s -o /dev/null -w '%{http_code} %{redirect_url}' "https://$HOST/market/index.json")" == "302 $DL_BASE/market/index.json" ]] && { echo "  https://$HOST/market/index.json → 302 $DL_BASE/market/index.json"; exit 0; }
  sleep 5
done
die "https://$HOST/market/index.json isn't redirected yet"
