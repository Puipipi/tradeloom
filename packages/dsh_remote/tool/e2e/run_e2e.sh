#!/usr/bin/env bash
# End-to-end check of dsh_remote against the real upstream stack, fully
# isolated in a temp dir (own DSH_HOME, loopback only):
#
#   ds-harness-remote apps/server (self-hosted, password login, Relay only)
#     <- Host: `dsh web` + ds-harness-remote@$PLUGIN_VERSION plugin from npm
#     <- Client: test/live_remote_test.dart (this package), no model prompts
#
# Usage: tool/e2e/run_e2e.sh [--keep]
# Env:   UPSTREAM   ds-harness-remote checkout (default ../../.refs/ds-harness-remote-upstream)
#        DSH_BIN    dsh launcher for the Host (default: dsh on PATH)
#        PLUGIN_VERSION (default 0.5.23)
#        PLUGIN_SPEC  anything `dsh plugin add` accepts, e.g. a packed upstream
#                     tarball (default ds-harness-remote@$PLUGIN_VERSION)
#        RELAY_ATTACH=1  mount tool/e2e/relay-node.ts on the Server so it offers
#                     `transport.relay.attach` (the open-source Server has no
#                     Relay node); needs Host plugin >= 0.6.0, and the run fails
#                     unless both sides attached and frames crossed the node
#        RELAY_CLIENT_HOST=10.0.2.2  advertise an emulator-reachable Relay node to clients
#        WEBRTC=1     let the Server negotiate LAN / P2P / TURN and forward
#                     WebRTC signaling like the hosted one (tool/e2e/patch-webrtc.mjs;
#                     no STUN / TURN servers). The Dart test has no WebRTC stack
#                     and stays on the Relay; pair it with SERVE=1 for a client
#                     that has one (tool/e2e/p2p_emulator.sh)
#        SERVE=1      skip the Dart test: write SERVER_URL / ACCOUNT / PASSWORD to
#                     $WORK/serve.env and keep the stack up until $WORK/stop exists
#        PLUGIN_OPTIONAL=1  install the plugin's optional dependencies too
#                     (@roamhq/wrtc, the Host's native WebRTC; without it werift)
# Needs: node >= 22, npm, network access to the npm registry, dart.
set -euo pipefail

PKG="$(cd "$(dirname "$0")/../.." && pwd)"
UPSTREAM="${UPSTREAM:-$PKG/../../.refs/ds-harness-remote-upstream}"
DSH_BIN="${DSH_BIN:-dsh}"
PLUGIN_VERSION="${PLUGIN_VERSION:-0.5.23}"
PLUGIN_SPEC="${PLUGIN_SPEC:-ds-harness-remote@$PLUGIN_VERSION}"
RELAY_ATTACH="${RELAY_ATTACH:-0}"
WEBRTC="${WEBRTC:-0}"
SERVE="${SERVE:-0}"
OPTIONAL_FLAG="--no-optional"
[[ "${PLUGIN_OPTIONAL:-0}" == 1 ]] && OPTIONAL_FLAG=""
KEEP=0
[[ "${1:-}" == "--keep" ]] && KEEP=1

WORK="$(mktemp -d "${TMPDIR:-/tmp}/dsh-remote-e2e.XXXXXX")"
SERVER_PID=""
HOST_PID=""
cleanup() {
  [[ -n "$HOST_PID" ]] && kill "$HOST_PID" 2>/dev/null || true
  [[ -n "$SERVER_PID" ]] && kill "$SERVER_PID" 2>/dev/null || true
  wait 2>/dev/null || true
  if [[ "$KEEP" == 1 ]]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

log() { printf '[e2e] %s\n' "$*"; }
wait_for() { # file pattern seconds
  for _ in $(seq 1 $(( $3 * 4 ))); do grep -q "$2" "$1" 2>/dev/null && return 0; sleep 0.25; done
  echo "timed out waiting for '$2' in $1" >&2; tail -20 "$1" >&2; return 1
}

# 1. Self-hosted Server, bundled from the upstream sources.
log "building self-hosted Server from $UPSTREAM"
mkdir -p "$WORK/server/src/server" "$WORK/server/src/protocol" "$WORK/home" "$WORK/dsh-home" "$WORK/work"
cp "$UPSTREAM"/apps/server/src/*.ts "$WORK/server/src/server/"
cp "$UPSTREAM"/packages/protocol/src/*.ts "$WORK/server/src/protocol/"
PORT="$(node -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
if [[ "$RELAY_ATTACH" == 1 ]]; then
  log "mounting the E2E Relay node (transport.relay.attach)"
  node "$PKG/tool/e2e/patch-relay-attach.mjs" "$WORK/server/src/server" "ws://127.0.0.1:$PORT/ws/v1/relay"
fi
if [[ "$WEBRTC" == 1 ]]; then
  log "turning on WebRTC signaling (transport.lan/p2p/turn)"
  node "$PKG/tool/e2e/patch-webrtc.mjs" "$WORK/server/src/server"
fi
echo '{"name":"e2e-server","private":true,"type":"module"}' > "$WORK/server/package.json"
(cd "$WORK/server" && npm_config_cache="$WORK/npm-cache" npm install --silent --no-audit --no-fund \
  --registry=https://registry.npmjs.org/ ws@8.21.3 zod@4.6.7 esbuild@0.24.2 >/dev/null)
(cd "$WORK/server" && ./node_modules/.bin/esbuild src/server/main.ts --bundle --platform=node --format=esm \
  --target=node22 --alias:@dsh-remote/protocol=./src/protocol/index.ts --outfile=dist/main.js --log-level=warning \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);")

SERVER_URL="http://127.0.0.1:$PORT"
ACCOUNT="e2e-owner@example.test"
PASSWORD="e2e-$(node -e 'console.log(require("crypto").randomBytes(18).toString("base64url"))')"
(cd "$WORK/server" && DSH_SERVER_ACCOUNT="$ACCOUNT" DSH_SERVER_PASSWORD="$PASSWORD" DSH_SERVER_PUBLIC_URL="$SERVER_URL" \
  DSH_SERVER_PORT="$PORT" DSH_SERVER_HOST=127.0.0.1 DSH_SERVER_DATA_FILE="$WORK/server-data/state.json" \
  exec node dist/main.js >"$WORK/server.log" 2>&1) &
SERVER_PID=$!
wait_for "$WORK/server.log" "listening" 20
log "Server at $SERVER_URL"

# 2. Host: isolated DSH profile with the plugin pointed at the local Server.
export DSH_HOME="$WORK/dsh-home"
log "installing $PLUGIN_SPEC into an isolated profile"
(cd "$WORK" && "$DSH_BIN" plugin --profile web add -w $OPTIONAL_FLAG "$PLUGIN_SPEC" >"$WORK/plugin-install.log" 2>&1) \
  || { tail -30 "$WORK/plugin-install.log" >&2; exit 1; }
cat >"$DSH_HOME/profiles/web/cordis.patch.yml" <<EOF
- id: ds-harness-remote
  config:
    enabled: true
    role: host
    serverUrl: $SERVER_URL
    deviceName: E2E Host
    terminal: { enabled: false }
    codex: { enabled: false }
    cursor: { enabled: false }
    acp: { enabled: false }
EOF
node "$PKG/tool/e2e/provision-host.mjs" "$SERVER_URL" "$ACCOUNT" "$PASSWORD" "$DSH_HOME" "E2E Host" >"$WORK/host.json"
(cd "$WORK/work" && exec env -u DEEPSEEK_API_KEY "$DSH_BIN" web --host 127.0.0.1 --port 0 --no-open >"$WORK/host.log" 2>&1) &
HOST_PID=$!
wait_for "$WORK/host.log" "server control connection online" 90
log "Host online ($("$DSH_BIN" --version))"

if [[ "$SERVE" == 1 ]]; then
  printf 'SERVER_URL=%s\nACCOUNT=%s\nPASSWORD=%s\nWORK=%s\n' "$SERVER_URL" "$ACCOUNT" "$PASSWORD" "$WORK" >"$WORK/serve.env"
  log "serving; details in $WORK/serve.env, touch $WORK/stop to end"
  while [[ ! -f "$WORK/stop" ]]; do sleep 1; done
  grep -h 'transport selected\|authenticated peer channel ready\|webrtc' "$WORK/server.log" "$WORK/host.log" >&2 || true
  log "ok"
  exit 0
fi

# 3. Client: the live test through the Relay.
log "running test/live_remote_test.dart"
(cd "$PKG" && DSH_REMOTE_LIVE_SERVER="$SERVER_URL" DSH_REMOTE_LIVE_EMAIL="$ACCOUNT" DSH_REMOTE_PASSWORD="$PASSWORD" \
  DSH_REMOTE_LIVE_CWD="$WORK/work" dart test -t live test/live_remote_test.dart -r expanded)
if [[ "$RELAY_ATTACH" == 1 ]]; then
  wait_for "$WORK/server.log" "relay close" 10
  attaches="$(grep -c '^relay attach' "$WORK/server.log" || true)"
  pongs="$(grep -c '^relay pong' "$WORK/server.log" || true)"
  frames=0
  for n in $(grep -o 'frames=[0-9]*' "$WORK/server.log" | cut -d= -f2); do frames=$(( frames + n )); done
  if grep '^relay reject' "$WORK/server.log" >&2 || (( attaches < 2 || pongs < 2 || frames == 0 )); then
    echo "Relay node not used as expected: $attaches attaches, $pongs pongs, $frames frames" >&2
    exit 1
  fi
  log "Relay node: $attaches attaches, $pongs pongs, $frames frames forwarded by closed sides"
fi
log "ok"
