#!/usr/bin/env bash
# The direct path on a real WebRTC stack: the app's flutter_webrtc on an
# Android emulator against the Host on this machine. Start the stack first:
#
#   WEBRTC=1 SERVE=1 PLUGIN_SPEC=<0.6.0 tarball> tool/e2e/run_e2e.sh
#   tooling/build-apk.sh --debug -f x64 -t lib/dev/remote_p2p_probe_main.dart
#   tool/e2e/p2p_emulator.sh <WORK>/serve.env app/build/app/outputs/flutter-apk/app-x64-debug.apk
#
# It installs the probe build, hands it the Server (10.0.2.2 is the build
# machine's loopback) and waits for its verdict in logcat. Passes only when the
# tunnel took a direct path and the Host bound its Noise channel to WebRTC.
# PROBE_EXPECT_TRANSPORT=relay verifies fallback with automatic direct still enabled.
# Env: ANDROID_SERIAL (default emulator-5554), PROBE_DIRECT=0 to force the Relay.
set -euo pipefail
export ANDROID_SERIAL="${ANDROID_SERIAL:-emulator-5554}"
ENV_FILE=$1
APK=$2
# shellcheck disable=SC1090
source "$ENV_FILE"
APP=io.github.ccch1mneyyy.dsh_app
log() { printf '[p2p] %s\n' "$*"; }

adb install -r "$APK" >/dev/null
server="${SERVER_URL/127.0.0.1/10.0.2.2}"
direct=$([[ "${PROBE_DIRECT:-1}" == 0 ]] && echo false || echo true)
printf '{"server":"%s","email":"%s","password":"%s","direct":%s}' "$server" "$ACCOUNT" "$PASSWORD" "$direct" |
  adb shell "run-as $APP sh -c 'mkdir -p files && cat > files/remote_p2p_probe.json'"
adb shell am force-stop "$APP"
adb logcat -c
adb shell am start -n "$APP/.MainActivity" >/dev/null
log "probe started against $server"
for _ in $(seq 1 120); do
  adb logcat -d -s flutter | grep -q '\[p2p-probe\] \(ok\|FAILED\)' && break
  sleep 1
done
adb logcat -d -s flutter | grep '\[p2p-probe\]' | sed 's/^.*\[p2p-probe\]/[p2p-probe]/'
adb shell am force-stop "$APP"
verdict=$(adb logcat -d -s flutter | grep -o '\[p2p-probe\] ok transport=[a-z0-9]*' || true)
[[ -n "$verdict" ]] || { echo "probe failed or timed out" >&2; exit 1; }
hostlog="$WORK/host.log"
grep 'authenticated peer channel ready' "$hostlog" | tail -1 >&2 || true
if [[ -n "${PROBE_EXPECT_TRANSPORT:-}" ]]; then
  [[ "$verdict" == *"transport=$PROBE_EXPECT_TRANSPORT" ]] ||
    { echo "expected $PROBE_EXPECT_TRANSPORT, got: $verdict" >&2; exit 1; }
elif [[ "$direct" == true ]]; then
  [[ "$verdict" == *transport=lan || "$verdict" == *transport=p2p || "$verdict" == *transport=turn ]] ||
    { echo "expected a direct path, got: $verdict" >&2; exit 1; }
  grep 'authenticated peer channel ready' "$hostlog" | tail -1 | grep -q "LAN\|P2P\|TURN" ||
    { echo "the Host did not bind the channel to WebRTC" >&2; exit 1; }
else
  [[ "$verdict" == *transport=relay ]] ||
    { echo "expected the Relay with direct disabled, got: $verdict" >&2; exit 1; }
fi
log "$verdict"
