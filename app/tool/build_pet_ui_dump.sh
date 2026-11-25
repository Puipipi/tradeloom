#!/usr/bin/env bash
set -euo pipefail
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:?Set ANDROID_HOME or ANDROID_SDK_ROOT}}
out=${1:?Usage: build_pet_ui_dump.sh OUTPUT_DIRECTORY}
src=$(cd "$(dirname "$0")" && pwd)/PetUiDump.java
mkdir -p "$out/classes"
android_jar=$(printf '%s\n' "$sdk"/platforms/android-*/android.jar | sort -V | tail -1)
d8=$(printf '%s\n' "$sdk"/build-tools/*/d8 | sort -V | tail -1)
"${JAVA_HOME:+$JAVA_HOME/bin/}javac" -source 8 -target 8 -cp "$android_jar" -d "$out/classes" "$src"
"$d8" --lib "$android_jar" --min-api 26 --output "$out" "$out/classes/PetUiDump.class"
printf '%s\n' "$out/classes.dex"
