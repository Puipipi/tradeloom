# shellcheck shell=bash
# Our Cloudflare ids, for the scripts that use the account (sourced from the
# worker directory: provision.sh, beta-keys.sh, publish-release.sh, stats.sh).
# The public tree's wrangler.jsonc only has placeholders for them
# (tooling/oss-redact.txt in the private tree), so each comes from the
# environment, else from a file outside the tree, else from wrangler.jsonc:
#
#   ACCOUNT  CF_ACCOUNT_ID, else CF_ACCOUNT_ID_FILE (default ~/keys/dshgo-cloudflare-account-id)
#   KV_ID    the QUOTA namespace: CF_KV_QUOTA_ID, else CF_KV_QUOTA_ID_FILE
#            (default ~/keys/dshgo-cloudflare-kv-quota-id; provision.sh apply writes it)
#
# Neither is a secret, but neither goes into the tracked file: wrangler runs
# with a copy of the config that has them (wrangler_config, then wr).

ACCOUNT_FILE=${CF_ACCOUNT_ID_FILE:-$HOME/keys/dshgo-cloudflare-account-id}
KV_ID_FILE=${CF_KV_QUOTA_ID_FILE:-$HOME/keys/dshgo-cloudflare-kv-quota-id}

# wrangler.jsonc as JSON: comments and trailing commas dropped.
wrangler_json() {
  python3 - <<'PY'
import json, re, sys
text = open("wrangler.jsonc", encoding="utf-8").read()
text = re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?\*/', lambda m: m.group(0) if m.group(0).startswith('"') else "", text, flags=re.S)
json.dump(json.loads(re.sub(r",(\s*[}\]])", r"\1", text)), sys.stdout)
PY
}

cf_id() { # VALUE FILE JQ-PATH: VALUE, else FILE's content, else that value in wrangler.jsonc
  if [[ -n "$1" ]]; then printf '%s' "$1"
  elif [[ -r "$2" ]]; then tr -d '[:space:]' <"$2"
  else wrangler_json | jq -r "$3 // empty"
  fi
}
ACCOUNT=$(cf_id "${CF_ACCOUNT_ID:-}" "$ACCOUNT_FILE" .account_id)
KV_ID=$(cf_id "${CF_KV_QUOTA_ID:-}" "$KV_ID_FILE" '.kv_namespaces[] | select(.binding == "QUOTA") | .id')

# 32 hex digits, and not the placeholder.
real_id() { [[ "$1" =~ ^[0-9a-f]{32}$ && "$1" != 00000000000000000000000000000000 ]]; }

# The config wr runs wrangler with: wrangler.jsonc with our ids, HOST as its
# custom domain when given, and without the Analytics Engine datasets when
# ANALYTICS=0 (a deploy with them fails on an account that hasn't enabled
# Analytics Engine). It sits next to wrangler.jsonc (wrangler resolves main,
# assets and the build against the config's directory) and is removed on exit
# (this sets the EXIT trap).
wrangler_config() { # [HOST]
  WRANGLER_CONFIG=$(mktemp --tmpdir="$PWD" --suffix=.json .wrangler-XXXXXX)
  trap 'rm -f "$WRANGLER_CONFIG"' EXIT
  wrangler_json | jq --arg account "$ACCOUNT" --arg kv "$KV_ID" --arg host "${1:-}" --arg analytics "${ANALYTICS:-1}" '
    .account_id = $account
    | (.kv_namespaces[] | select(.binding == "QUOTA")).id = $kv
    | if $host == "" then . else .routes = [{pattern: $host, custom_domain: true}] end
    | if $analytics == "0" then del(.analytics_engine_datasets) else . end' >"$WRANGLER_CONFIG"
}

wr() { # wrangler, with the token from CF_TOKEN_FILE and that config
  CLOUDFLARE_API_TOKEN="$(cat "$CF_TOKEN_FILE")" CLOUDFLARE_ACCOUNT_ID="$ACCOUNT" WRANGLER_SEND_METRICS=false \
    npx wrangler "$@" --config "$WRANGLER_CONFIG"
}
