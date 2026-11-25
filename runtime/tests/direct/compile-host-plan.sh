#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../.." && pwd)"
KOTLINC="${KOTLINC:-kotlinc}"
OUT="${1:?output jar path required}"
command -v "$KOTLINC" >/dev/null || { echo "KOTLINC must name a Kotlin compiler; direct host tests compile the real Android planner" >&2; exit 1; }
mkdir -p "$(dirname "$OUT")"
"$KOTLINC" "$REPO/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/DirectLaunch.kt" \
  "$HERE/HostPlan.kt" -include-runtime -d "$OUT"
"$KOTLINC" "$REPO/app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/RuntimeProcessOwnership.kt" \
  "$HERE/HostOwnership.kt" -include-runtime -d "${OUT%.jar}-ownership.jar"
