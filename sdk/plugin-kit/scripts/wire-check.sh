#!/usr/bin/env bash
# Records real bridge traffic and validates it against schema/*.schema.json:
#   1. the protocol integration test (runtime/tests/native-bridge.mjs) against `dsh web` with the
#      runtime/tests/fixtures plugins, then its --empty run without them;
#   2. the example plugins' end-to-end (examples/plugins/e2e/host-e2e.sh --capture).
# Every request and frame passes through scripts/wire-capture.mjs. Never touches ~/.dsh.
#
#   sdk/plugin-kit/scripts/wire-check.sh [--dsh-prefix DIR] [--keep]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(dirname "$HERE")"
REPO="$(cd "$KIT/../.." && pwd)"
PREFIX="$REPO/runtime/.work/x86_64/dsh-prefix"
KEEP=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-prefix) PREFIX="$(cd "$2" && pwd)"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
NODE="$(command -v node)"
TESTS="$REPO/runtime/tests"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-go-wire.XXXXXX")"
PORT=38261; PROXY=38262
PIDS=()
cleanup() {
  for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done
  PIDS=()
  if [[ $KEEP == 1 ]]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

cat > "$TMP/bridge.patch.yml" <<YML
- insert:
    - id: dsh-go-bridge
      name: $REPO/runtime/bridge/dsh-go-bridge/lib/index.js
      config:
        native:
          heartbeatSeconds: 1
          idleTimeoutSeconds: 4
          feedLingerMs: 1500
YML
cat > "$TMP/fixtures.patch.yml" <<YML
- insert:
    - id: fx-usage
      name: $TESTS/fixtures/native-usage/index.js
    - id: fx-quick
      name: $TESTS/fixtures/native-quick/index.js
    - id: fx-static
      name: $TESTS/fixtures/native-static/index.js
YML

boot() {  # boot <label> <patch files…>: dsh web on $PORT + recording proxy on $PROXY; sets TOKEN
  local label="$1"; shift
  local -a patches=()
  for p in "$@"; do patches+=(--patch "$p"); done
  rm -rf "$TMP/home"; mkdir -p "$TMP/home/.dsh" "$TMP/work"
  (cd "$TMP/work" && exec env -i PATH="$(dirname "$NODE"):/usr/bin:/bin" HOME="$TMP/home" DSH_HOME="$TMP/home/.dsh" LANG=C.UTF-8 \
    DEEPSEEK_API_KEY=sk-dsh-app-native-test-not-a-real-key UV_USE_IO_URING=0 \
    "$NODE" "$PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js" web "${patches[@]}" --host 127.0.0.1 --port "$PORT" --no-open) > "$TMP/dsh-web-$label.log" 2>&1 &
  PIDS+=($!)
  TOKEN=""
  for _ in $(seq 1 240); do
    TOKEN="$(sed -n 's#^dsh web: http://127\.0\.0\.1:[0-9]*/?token=\([A-Za-z0-9_-]*\).*#\1#p' "$TMP/dsh-web-$label.log" | head -1)"
    [[ -n "$TOKEN" ]] && break
    sleep 0.5
  done
  [[ -n "$TOKEN" ]] || { echo "dsh web ($label) did not start" >&2; tail -30 "$TMP/dsh-web-$label.log" >&2; exit 1; }
  "$NODE" "$HERE/wire-capture.mjs" "$PROXY" "$PORT" "$TMP/wire-$label.jsonl" > "$TMP/proxy-$label.log" 2>&1 &
  PIDS+=($!)
  sleep 0.5
}
stop_all() { for p in "${PIDS[@]}"; do kill -TERM "$p" 2>/dev/null || true; wait "$p" 2>/dev/null || true; done; PIDS=(); }

echo "== native bridge test through the recording proxy (fixtures)"
boot fixtures "$TMP/bridge.patch.yml" "$TMP/fixtures.patch.yml"
na_rc=0
"$NODE" "$TESTS/native-bridge.mjs" "http://127.0.0.1:$PROXY" "$TOKEN" > "$TMP/na-fixtures.out" 2>&1 || na_rc=$?
grep -cE '^\s*.*PASS' "$TMP/na-fixtures.out" | sed 's/^/  bridge PASS lines: /'
grep -E 'FAIL' "$TMP/na-fixtures.out" | head -10 || true
stop_all

echo "== native bridge test --empty"
boot empty "$TMP/bridge.patch.yml"
"$NODE" "$TESTS/native-bridge.mjs" "http://127.0.0.1:$PROXY" "$TOKEN" --empty > "$TMP/na-empty.out" 2>&1 || na_rc=$?
grep -E 'FAIL' "$TMP/na-empty.out" | head -10 || true
stop_all

echo "== example plugins end-to-end through the recording proxy"
ex_rc=0
"$REPO/examples/plugins/e2e/host-e2e.sh" --capture "$TMP/wire-examples.jsonl" > "$TMP/examples.out" 2>&1 || ex_rc=$?
tail -1 "$TMP/examples.out"

echo "== schema validation"
wc -l "$TMP"/wire-*.jsonl | sed 's/^/  /'
"$NODE" "$HERE/validate-wire.mjs" "$TMP"/wire-*.jsonl || exit 1
echo "bridge test exit $na_rc, examples exit $ex_rc"
