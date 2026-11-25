#!/usr/bin/env bash
# Native plugin protocol integration test against a real DSH (docs/design/native-plugins-protocol.md):
# boots `dsh web` from <dsh-prefix> with a throwaway HOME/DSH_HOME, runtime/bridge/dsh-go-bridge and
# the test plugins in runtime/tests/fixtures (loaded by path), runs runtime/tests/native-bridge.mjs;
# boots with the v1.2 fixture (fixtures/native-voice) for runtime/tests/native-capabilities-live.mjs;
# then boots again without the fixtures and checks that nothing changes when no plugin declares
# dshGo. Never touches ~/.dsh.
#
#   runtime/tests/run-native-tests.sh <dsh-prefix> [--port N]
#
# <dsh-prefix> is an `npm --prefix` tree such as runtime/.work/x86_64/dsh-prefix.
set -euo pipefail
HERE="$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME="$(dirname "$HERE")"
PREFIX="$(CDPATH= cd "${1:?usage: run-native-tests.sh <dsh-prefix> [--port N]}" && pwd)"; shift
PORT=38191
while [[ $# -gt 0 ]]; do
  case "$1" in
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
NODE="$RUNTIME/.cache/host-node/node-v24.22.1-linux-x64/bin/node"
[[ -x "$NODE" ]] || NODE="$(command -v node)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-native-test.XXXXXX")"
DSH_PID=""
stop_dsh() {
  if [[ -n "$DSH_PID" ]]; then kill -TERM "$DSH_PID" 2>/dev/null || true; wait "$DSH_PID" 2>/dev/null || true; DSH_PID=""; fi
}
cleanup() { stop_dsh; rm -rf "$TMP"; }
trap cleanup EXIT

# The bridge with shortened timers (heartbeat 1 s, idle 4 s, feed linger 1.5 s); protocol limits unchanged.
cat > "$TMP/bridge.patch.yml" <<YML
- insert:
    - id: dsh-go-bridge
      name: $RUNTIME/bridge/dsh-go-bridge/lib/index.js
      config:
        native:
          heartbeatSeconds: 1
          idleTimeoutSeconds: 4
          feedLingerMs: 1500
YML
cat > "$TMP/fixtures.patch.yml" <<YML
- insert:
    - id: fx-usage
      name: $HERE/fixtures/native-usage/index.js
    - id: fx-quick
      name: $HERE/fixtures/native-quick/index.js
    - id: fx-static
      name: $HERE/fixtures/native-static/index.js
YML
cat > "$TMP/voice.patch.yml" <<YML
- insert:
    - id: fx-voice
      name: $HERE/fixtures/native-voice/index.js
YML

boot() {  # boot <label> <patch files...>; sets TOKEN
  local label="$1"; shift
  local -a patches=()
  for p in "$@"; do patches+=(--patch "$p"); done
  rm -rf "$TMP/home"; mkdir -p "$TMP/home/.dsh"
  LOG="$TMP/dsh-web-$label.log"
  : > "$LOG"  # exists before the first poll; the background redirect may not have created it yet
  env -i PATH="$(dirname "$NODE"):/usr/bin:/bin" HOME="$TMP/home" DSH_HOME="$TMP/home/.dsh" LANG=C.UTF-8 \
    DEEPSEEK_API_KEY=sk-dsh-app-native-test-not-a-real-key UV_USE_IO_URING=0 \
    "$NODE" "$PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js" web "${patches[@]}" \
    --host 127.0.0.1 --port "$PORT" --no-open > "$LOG" 2>&1 &
  DSH_PID=$!
  TOKEN=""
  for _ in $(seq 1 240); do
    TOKEN="$(sed -n 's#^dsh web: http://127\.0\.0\.1:[0-9]*/?token=\([A-Za-z0-9_-]*\).*#\1#p' "$LOG" | head -1)"
    [[ -n "$TOKEN" ]] && break
    kill -0 "$DSH_PID" 2>/dev/null || break
    sleep 0.5
  done
  if [[ -z "$TOKEN" ]]; then echo "dsh web ($label) did not start:" >&2; tail -40 "$LOG" >&2; exit 1; fi
}

rc=0
boot fixtures "$TMP/bridge.patch.yml" "$TMP/fixtures.patch.yml"
"$NODE" "$HERE/native-bridge.mjs" "http://127.0.0.1:$PORT" "$TOKEN" || rc=$?
if grep -qE 'TypeError|ReferenceError|SyntaxError|unhandled' "$LOG"; then
  echo "unexpected errors in dsh web log:" >&2; grep -nE 'TypeError|ReferenceError|SyntaxError|unhandled' "$LOG" | head -20 >&2; rc=1
fi
cp "$LOG" "${NATIVE_TEST_LOG:-/dev/null}" 2>/dev/null || true
stop_dsh

boot voice "$TMP/bridge.patch.yml" "$TMP/voice.patch.yml"
"$NODE" "$HERE/native-capabilities-live.mjs" "http://127.0.0.1:$PORT" "$TOKEN" || rc=$?
if grep -qE 'TypeError|ReferenceError|SyntaxError|unhandled' "$LOG"; then
  echo "unexpected errors in dsh web log (voice):" >&2; grep -nE 'TypeError|ReferenceError|SyntaxError|unhandled' "$LOG" | head -20 >&2; rc=1
fi
stop_dsh

boot empty "$TMP/bridge.patch.yml"
"$NODE" "$HERE/native-bridge.mjs" "http://127.0.0.1:$PORT" "$TOKEN" --empty || rc=$?
stop_dsh
exit $rc
