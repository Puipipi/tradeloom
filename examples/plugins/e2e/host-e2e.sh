#!/usr/bin/env bash
# End-to-end on a desktop host: installs the three example plugins into a throwaway DSH profile
# the way a person does (`dsh plugin --profile web add <path>`), boots `dsh web` with the dsh-go
# bridge loaded by path (as the app's on-device runtime does), and checks what the app would get
# from the bridge (host-e2e.mjs). Never touches ~/.dsh; nothing is published or committed.
#
#   examples/plugins/e2e/host-e2e.sh [--dsh-prefix DIR] [--pnpm BIN] [--port N] [--keep] [--capture FILE]
#
# --capture: route the checks through sdk/plugin-kit/scripts/wire-capture.mjs and record the traffic.
#
# Defaults: runtime/.work/x86_64/dsh-prefix (the runtime build's DSH, route guard applied) and
# runtime/.work/x86_64/pnpm-prefix (pnpm 11, as on the phone).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
PREFIX="$REPO/runtime/.work/x86_64/dsh-prefix"
PNPM="$REPO/runtime/.work/x86_64/pnpm-prefix/node_modules/.bin/pnpm"
PORT=38231
KEEP=0
CAPTURE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dsh-prefix) PREFIX="$(cd "$2" && pwd)"; shift 2 ;;
    --pnpm) PNPM="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --capture) CAPTURE="$2"; shift 2 ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
done
NODE="$(command -v node)"
DSH="$PREFIX/node_modules/@deepseek-ai/dsh/lib/bin.js"
[[ -f "$DSH" ]] || { echo "no DSH at $DSH" >&2; exit 2; }
[[ -x "$PNPM" ]] || { echo "no pnpm at $PNPM" >&2; exit 2; }
TMP="$(mktemp -d "${TMPDIR:-/tmp}/dsh-go-examples-e2e.XXXXXX")"
DSH_PID=""
cleanup() {
  if [[ -n "$DSH_PID" ]]; then kill -TERM "$DSH_PID" 2>/dev/null || true; wait "$DSH_PID" 2>/dev/null || true; fi
  if [[ $KEEP == 1 ]]; then echo "kept $TMP"; else rm -rf "$TMP"; fi
}
trap cleanup EXIT
trap 'exit 130' INT TERM

mkdir -p "$TMP/home/.dsh" "$TMP/bin" "$TMP/plugins" "$TMP/work"
ln -s "$PNPM" "$TMP/bin/pnpm"
# Copies, as a person would put them on the host (the repo checkout stays untouched).
for p in weather usage quick; do
  cp -r "$REPO/examples/plugins/dsh-go-example-$p" "$TMP/plugins/"
  rm -rf "$TMP/plugins/dsh-go-example-$p/test"
done
# A probe that runs one weather_forecast call through DSH's own tool registry (pre-policy, guards,
# output schema, presentationMeta snapshot) and returns the result, meta included.
mkdir -p "$TMP/probe"
cat > "$TMP/probe/index.js" <<'JS'
export const name = 'dsh-go-e2e-probe'
export const inject = ['tools', 'webServer']
export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-go-e2e-probe/weather',
    handler: async (req, res) => {
      const result = await ctx.tools.execute({ callId: 'e2e-weather-1', name: 'weather_forecast', arguments: { city: 'Hangzhou', days: 3, language: 'zh' }, signal: AbortSignal.timeout(40000) })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ registered: ctx.tools.get('weather_forecast') !== undefined, result }))
    },
  }), 'e2e probe route')
}
JS
cat > "$TMP/bridge.patch.yml" <<YML
- insert:
    - id: dsh-go-bridge
      name: $REPO/runtime/bridge/dsh-go-bridge/lib/index.js
    - id: dsh-go-e2e-probe
      name: $TMP/probe/index.js
YML

ENVV=(env -i PATH="$TMP/bin:$(dirname "$NODE"):/usr/bin:/bin" HOME="$TMP/home" DSH_HOME="$TMP/home/.dsh" LANG=C.UTF-8
  XDG_CACHE_HOME="$TMP/home/.cache" npm_config_cache="$TMP/home/.cache/npm"
  pnpm_config_store_dir="$TMP/home/.pnpm-store" UV_USE_IO_URING=0 NODE_OPTIONS=--dns-result-order=ipv4first)
run_env() { "${ENVV[@]}" "$@"; }

echo "== install (dsh plugin --profile web add <path>)"
for p in weather usage quick; do
  if run_env "$NODE" "$DSH" plugin --profile web add "$TMP/plugins/dsh-go-example-$p" > "$TMP/install-$p.log" 2>&1; then
    echo "  PASS installed dsh-go-example-$p"
  else
    echo "  FAIL install dsh-go-example-$p"; tail -30 "$TMP/install-$p.log"; exit 1
  fi
done
grep -o '"dsh-go-example-[a-z]*": "[^"]*"' "$TMP/home/.dsh/profiles/web/package.json" | sed 's/^/  profile dependency /'

echo "== boot dsh web"
cd "$TMP/work"
# env execs node: $! is the DSH process itself, so cleanup stops it.
"${ENVV[@]}" "$NODE" "$DSH" web --patch "$TMP/bridge.patch.yml" --host 127.0.0.1 --port "$PORT" --no-open > "$TMP/dsh-web.log" 2>&1 &
DSH_PID=$!
TOKEN=""
for _ in $(seq 1 240); do
  TOKEN="$(sed -n 's#^dsh web: http://127\.0\.0\.1:[0-9]*/?token=\([A-Za-z0-9_-]*\).*#\1#p' "$TMP/dsh-web.log" | head -1)"
  [[ -n "$TOKEN" ]] && break
  kill -0 "$DSH_PID" 2>/dev/null || break
  sleep 0.5
done
if [[ -z "$TOKEN" ]]; then echo "dsh web did not start:" >&2; tail -40 "$TMP/dsh-web.log" >&2; exit 1; fi
BASE_PORT="$PORT"
PROXY_PID=""
if [[ -n "$CAPTURE" ]]; then
  BASE_PORT=$((PORT + 1))
  "$NODE" "$REPO/sdk/plugin-kit/scripts/wire-capture.mjs" "$BASE_PORT" "$PORT" "$CAPTURE" > "$TMP/proxy.log" 2>&1 &
  PROXY_PID=$!
  sleep 0.5
fi
rc=0
"$NODE" "$HERE/host-e2e.mjs" "http://127.0.0.1:$BASE_PORT" "$TOKEN" "$REPO" || rc=$?
[[ -n "$PROXY_PID" ]] && kill "$PROXY_PID" 2>/dev/null
if grep -nE 'TypeError|ReferenceError|SyntaxError|unhandled|dsh-go-example' "$TMP/dsh-web.log" | grep -viE 'loaded|mounted' | head -20; then :; fi
exit $rc
