#!/usr/bin/env bash
# Hot reload on a real phone, over the release build already on it, data kept.
#
#   tooling/dev-run.sh                build debug, install, launch, attach
#   tooling/dev-run.sh --attach       restart the debug build already installed, attach
#   tooling/dev-run.sh --no-build     install the last debug APK, then attach
#   tooling/dev-run.sh --wifi         move adb to Wi-Fi first (the cable may go after)
#   tooling/dev-run.sh -s SERIAL      which device, when more than one is connected
#
# Then, in this terminal: r hot reload, R hot restart, d detach (the app keeps running),
# q quit (the app stops).
# Code changed before attaching isn't what r looks at, it starts from what is on disk at
# attach: press R once for that. r takes care of everything changed after.
#
# Going back to a release build takes a new one: a debug build has a newer build number
# than the last release, and Android refuses a lower one.
#
# It installs with `adb install -r` and attaches, instead of `flutter run`, because a
# failed `flutter run` install uninstalls the app and tries again, and that would take
# the phone's keys and chats with it. Here a failed install stops without uninstalling;
# if adb loses the result, the phone may already have updated.
# That takes the same signing key (app/android/key.properties) and a versionCode that
# isn't lower: both are how build-apk.sh builds.
#
# Debug builds run on the JIT and animate worse than a release build, so use this for
# layout, sizes and colours. Judge smoothness on a release build (tooling/build-apk.sh).
#
# Windows: the Android toolchain lives in
# DSH_ANDROID_TOOLS (default D:/Tools/android), Flutter in DSH_FLUTTER (default
# D:/Tools/flutter-3.47.7/flutter), Python in DSH_PYTHON. Elsewhere, what's on PATH.
set -euo pipefail

ROOT=$(CDPATH= cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
APP="$ROOT/app"
PKG=io.github.ccch1mneyyy.dsh_app
APK="$APP/build/app/outputs/flutter-apk/app-arm64-debug.apk"

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
die() { echo "dev-run: $*" >&2; exit 1; }

serial='' build=1 install=1 wifi=0
while (($#)); do
  case "$1" in
    -s) serial=${2:?-s needs a serial}; shift 2 ;;
    --attach) build=0 install=0; shift ;;
    --no-build) build=0; shift ;;
    --wifi) wifi=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

# --- the toolchain (a Windows machine has none of it on PATH)
tools=${DSH_ANDROID_TOOLS:-/d/Tools/android}
flutter_home=${DSH_FLUTTER:-/d/Tools/flutter-3.47.7/flutter}
to_native() { if command -v cygpath >/dev/null; then cygpath -w "$1"; else echo "$1"; fi; }
if [[ -d $tools/sdk ]]; then
  JAVA_HOME=$(to_native "$tools/jdk-17")
  ANDROID_HOME=$(to_native "$tools/sdk")
  GRADLE_USER_HOME=$(to_native "$tools/gradle-home")
  export JAVA_HOME ANDROID_HOME GRADLE_USER_HOME ANDROID_SDK_ROOT=$ANDROID_HOME
  PATH="$tools/jdk-17/bin:$tools/sdk/platform-tools:$PATH"
fi
[[ -d $flutter_home/bin ]] && PATH="$flutter_home/bin:$PATH"
export PATH
# Git Bash would find flutter's sh script, and the Store's stub for python3.
if [[ -n ${WINDIR:-} ]]; then
  flutter() { flutter.bat "$@"; }
  export -f flutter
  py=${DSH_PYTHON:-$HOME/.workbuddy/binaries/python/envs/default/Scripts/python.exe}
  if [[ -x $py ]]; then
    export DSH_DEV_PY=$py
    python3() { "$DSH_DEV_PY" "$@"; }
    export -f python3
  fi
fi
command -v adb >/dev/null || die "adb not found"

# --- the device
devices() { adb devices | tr -d '\r' | awk 'NR > 1 && $2 == "device" { print $1 }'; }
if [[ -z $serial ]]; then
  found=$(devices)
  [[ -n $found ]] || die "no device: connect the phone, or pair it with adb pair"
  (($(wc -l <<<"$found") == 1)) || die "more than one device, pick with -s: $(tr '\n' ' ' <<<"$found")"
  serial=$found
fi

if ((wifi)); then
  ip=$(adb -s "$serial" shell ip route | awk '/ src / { for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' | head -n 1 | tr -d '\r')
  [[ -n $ip ]] || die "the phone has no IP address: is Wi-Fi on?"
  adb -s "$serial" tcpip 5555 >/dev/null
  sleep 2
  adb connect "$ip:5555"
  serial="$ip:5555"
  # adb connect succeeds on an unauthorized phone too, and it can take a moment to settle.
  for _ in 1 2 3 4 5; do
    grep -qxF "$serial" <<<"$(devices)" && break
    sleep 1
  done
  grep -qxF "$serial" <<<"$(devices)" ||
    die "cannot reach $serial over Wi-Fi: check the network and the phone's authorization prompt"
  echo "dev-run: on Wi-Fi as $serial; the cable can go"
fi
phone() { adb -s "$serial" "$@"; }

installed_since() {
  phone shell dumpsys package "$PKG" | sed -n 's/^ *firstInstallTime=//p' | head -n 1 | tr -d '\r'
}

# --- build and install
if ((build)); then
  "$ROOT/tooling/build-apk.sh" --debug -f arm64 --keep-daemon
fi
if ((install)); then
  [[ -f $APK ]] || die "no debug APK at $APK: run without --no-build"
  before=$(installed_since)
  if ! phone install -r "$APK"; then
    die "install did not report success; the phone may already have updated. Reconnect and check the installed build before retrying. Is it signed with the phone's key (app/android/key.properties)? Never uninstall to get past this: the app's data goes with it."
  fi
  after=$(installed_since)
  [[ -z $before || $before == "$after" ]] || die "first install time moved ($before -> $after): the app was reinstalled"
fi
# Only a debug build has anything to attach to, and restarting another one would be for nothing.
package=$(phone shell dumpsys package "$PKG" | tr -d '\r')
grep -Eq 'flags=\[.*DEBUGGABLE' <<<"$package" ||
  die "the build on the phone isn't a debug build: run without --attach"

# Attach finds the app by the address it logs when it starts, and only hears that once it
# is listening: the app restarts a moment after attach is up, not before.
(
  # Cancel and reap the waiting child before leaving this phase.
  trap 'kill $(jobs -pr) 2>/dev/null || true; wait; exit 0' TERM
  sleep "${DSH_ATTACH_WAIT:-10}" &
  wait "$!"
  # Too late to call off: a stop with no launch after it would leave the app closed.
  trap '' TERM
  phone shell am force-stop "$PKG"
  phone shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
) &
restart=$!
# An attach that gave up during the wait leaves the app alone.
trap 'kill "$restart" 2>/dev/null || true' EXIT

# --- reload
cd "$APP"
name=$(sed -n 's/^ *versionName=\([^[:space:]]*\).*/\1/p' <<<"$package" | head -n 1)
code=$(sed -n 's/^ *versionCode=\([0-9]*\).*/\1/p' <<<"$package" | head -n 1)
# The same define the APK was built with, or a reload would change what it reads.
exec_flutter=(flutter attach -d "$serial" --app-id "$PKG" "--dart-define=DSH_APP_VERSION=$name+$code")
"${exec_flutter[@]}"
