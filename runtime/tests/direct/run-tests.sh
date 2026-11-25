#!/usr/bin/env bash
# Source-only Linux gate. The supplied rootfs is a disposable test copy, not an
# installed user runtime. PRoot must come from the pinned production source.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${1:?disposable rootfs required}"
MANIFEST="${2:?manifest required}"
PROOT="${3:?Linux build of pinned PRoot required}"
OUT="${4:?evidence directory required}"
PORT="${5:-39120}"
mkdir -p "$OUT"
ROOT="$(CDPATH= cd "$ROOT" && pwd -P)"
OUT="$(CDPATH= cd "$OUT" && pwd -P)"
command -v java >/dev/null || { echo 'java required' >&2; exit 1; }
[[ -x "$PROOT" && -f "$ROOT/opt/dsh-go/direct/preload.mjs" ]] || { echo 'built direct rootfs and host PRoot required' >&2; exit 1; }

bash "$HERE/compile-host-plan.sh" "$OUT/host-plan.jar" > "$OUT/planner-compile.log" 2>&1
python3 "$HERE/startup-policy.py" --output "$OUT/startup-policy" > "$OUT/startup-policy.log" 2>&1
python3 -I "$HERE/../test_direct_inventory.py" > "$OUT/native-inventory.log" 2>&1
bash "$HERE/compile-cleanup-probe.sh" "$OUT/cleanup-probe.jar" > "$OUT/cleanup-compile.log" 2>&1
java -jar "$OUT/cleanup-probe.jar" "$OUT/cleanup-roots" > "$OUT/cleanup-observation.jsonl" 2> "$OUT/cleanup-observation.stderr.log"
UV_USE_IO_URING=0 "$ROOT/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" \
  --library-path "$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/lib/x86_64-linux-gnu:$ROOT/usr/lib:$ROOT/lib" \
  "$ROOT/opt/node/bin/node" --test --test-isolation=none "$HERE/dns.test.mjs" > "$OUT/dns.log" 2>&1
UV_USE_IO_URING=0 "$ROOT/usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2" \
  --library-path "$ROOT/usr/lib/x86_64-linux-gnu:$ROOT/lib/x86_64-linux-gnu:$ROOT/usr/lib:$ROOT/lib" \
  "$ROOT/opt/node/bin/node" --test --test-isolation=none "$HERE/modules.test.mjs" > "$OUT/modules.test.log" 2>&1

EXTRA=()
[[ -z "${DIRECT_CHROMIUM:-}" ]] || EXTRA+=(--chromium "$DIRECT_CHROMIUM")
[[ -z "${DIRECT_PROOT_SOURCE_SHA256:-}" ]] || EXTRA+=(--proot-source-sha256 "$DIRECT_PROOT_SOURCE_SHA256")
python3 "$HERE/run-host.py" --rootfs "$ROOT" --manifest "$MANIFEST" --proot "$PROOT" \
  --planner "$OUT/host-plan.jar" --ownership-helper "$OUT/host-plan-ownership.jar" \
  --output "$OUT/web" --samples "${DIRECT_SAMPLES:-1}" --port "$PORT" "${EXTRA[@]}"

# A fallback is a successful compatibility outcome, not a successful direct test.
python3 - "$OUT/web/results.json" <<'PY'
import json,sys
rows=json.load(open(sys.argv[1]))
assert any(row['mode']=='direct' for row in rows), 'no actual direct run; inspect fallbackReason and use a fresh disposable fixture'
assert all(row['fixtureCleanup']['exitCode']==0 for row in rows), 'temporary PRoot fixtures did not cleanly close'
assert all(not row['fixtureCleanup']['pathsRemain'] for row in rows), 'temporary test profile/file still exists after cleanup'
assert all(row['orphanCleanup']['complete'] for row in rows), 'runtime-owned processes remain'
PY
# Do not let the surrounding test account conceal a missed guest-path mkdir.
# Root drops to UID/GID65534 for this gate; other users keep their actual UID.
python3 "$HERE/nonroot-session.py" --rootfs "$ROOT" --manifest "$MANIFEST" --proot "$PROOT" \
  --planner "$OUT/host-plan.jar" --output "$OUT/nonroot-session" --disposable-rootfs \
  > "$OUT/nonroot-session.log" 2>&1
cp "$HERE/"*.mjs "$ROOT/tmp/direct-tests/"
NODE="$ROOT/opt/dsh-app/direct/bin/node"
TEST_PATH="$ROOT/opt/dsh-app/direct/bin:$ROOT/usr/local/sbin:$ROOT/usr/local/bin:$ROOT/usr/sbin:$ROOT/usr/bin:$ROOT/sbin:$ROOT/bin"
for test in paths.test processes.test pnpm-copy tls l2s-guard native-modules; do
  env -i PATH="$TEST_PATH" HOME="$ROOT/root" TMPDIR="$ROOT/tmp" \
    DSH_HOME="$ROOT/tmp/direct-unit-home" UV_USE_IO_URING=0 NODE_OPTIONS=--dns-result-order=ipv4first \
    "$NODE" "$ROOT/tmp/direct-tests/$test.mjs" > "$OUT/$test.log" 2>&1
done
python3 "$HERE/run-module-identity.py" --rootfs "$ROOT" --output "$OUT/module-identity" > "$OUT/module-identity.log" 2>&1
python3 "$HERE/execpath-probe.py" --rootfs "$ROOT" --output "$OUT/execpath"
python3 "$HERE/lifecycle.py" --rootfs "$ROOT" --helper "$OUT/host-plan-ownership.jar" --output "$OUT/lifecycle.json"
python3 "$HERE/rollback.py" --rootfs "$ROOT" --manifest "$MANIFEST" --proot "$PROOT" \
  --planner "$OUT/host-plan.jar" --ownership-helper "$OUT/host-plan-ownership.jar" --output "$OUT/rollback" --port "$PORT"
echo 'PASS direct host gate: non-root session creation/workspace tools, actual-mode startup policy, real web/RPC/PTY/AGENTS/skills, DNS, processes, pnpm copy, TLS, late L2S refusal and same-session rollback'
