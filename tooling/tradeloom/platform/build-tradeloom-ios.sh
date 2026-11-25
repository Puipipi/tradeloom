#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="${TRADELOOM_SOURCE_ROOT:?Set TRADELOOM_SOURCE_ROOT to a Git checkout}"
SOURCE_COMMIT="${TRADELOOM_SOURCE_COMMIT:?Set TRADELOOM_SOURCE_COMMIT to a full 40-character commit SHA}"
OUTPUT_ROOT="${TRADELOOM_OUTPUT_ROOT:?Set TRADELOOM_OUTPUT_ROOT to a new writable output directory}"
TEAM_ID="${TRADELOOM_IOS_TEAM_ID:?Set TRADELOOM_IOS_TEAM_ID to your Apple Developer Team ID}"
EXPORT_OPTIONS="${TRADELOOM_IOS_EXPORT_OPTIONS_PLIST:?Set TRADELOOM_IOS_EXPORT_OPTIONS_PLIST to a local export options plist}"
[[ "$TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || { printf 'Invalid Apple Team ID format\n' >&2; exit 2; }
[[ "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || { printf 'TRADELOOM_SOURCE_COMMIT must be a full commit SHA\n' >&2; exit 2; }
[[ -f "$EXPORT_OPTIONS" && -r "$EXPORT_OPTIONS" ]] || { printf 'Export options plist is missing or unreadable\n' >&2; exit 2; }
git -C "$SOURCE_ROOT" cat-file -e "$SOURCE_COMMIT^{commit}"
RESOLVED_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse "$SOURCE_COMMIT^{commit}")"
SOURCE_COMMIT_LOWER="$(printf '%s' "$SOURCE_COMMIT" | tr 'A-F' 'a-f')"
RESOLVED_COMMIT_LOWER="$(printf '%s' "$RESOLVED_COMMIT" | tr 'A-F' 'a-f')"
[[ "$RESOLVED_COMMIT_LOWER" == "$SOURCE_COMMIT_LOWER" ]] || { printf 'Source commit did not resolve exactly\n' >&2; exit 2; }
SOURCE_ROOT="$(cd "$SOURCE_ROOT" && pwd -P)"
EXPORT_OPTIONS="$(cd "$(dirname "$EXPORT_OPTIONS")" && pwd -P)/$(basename "$EXPORT_OPTIONS")"
python3 "$SCRIPT_DIR/prepare_tradeloom_platform.py" --validate-ios-export-options "$EXPORT_OPTIONS" --team-id "$TEAM_ID" --source-root "$SOURCE_ROOT"
mkdir -p "$OUTPUT_ROOT"
OUTPUT_ROOT="$(cd "$OUTPUT_ROOT" && pwd -P)"
RUN_DIR="$OUTPUT_ROOT/tradeloom-ios-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$RUN_DIR" ]] || { printf 'Output already exists: %s\n' "$RUN_DIR" >&2; exit 2; }
mkdir "$RUN_DIR"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tradeloom-ios.XXXXXX")"
cleanup() {
  case "$WORK_ROOT" in
    "${TMPDIR:-/tmp}"/tradeloom-ios.*) rm -rf -- "$WORK_ROOT" ;;
    *) printf 'Refusing unexpected temporary path cleanup: %s\n' "$WORK_ROOT" >&2; return 1 ;;
  esac
}
trap cleanup EXIT
STAGE="$WORK_ROOT/source"
mkdir "$STAGE"
git -C "$SOURCE_ROOT" archive --format=tar "$RESOLVED_COMMIT" | tar -xf - -C "$STAGE"
python3 "$SCRIPT_DIR/prepare_tradeloom_platform.py" --root "$STAGE" --platform ios

cd "$STAGE/app"
[[ -d ios/Runner.xcworkspace && -s ios/Runner.xcworkspace/contents.xcworkspacedata ]] || { printf 'Runner.xcworkspace missing from source archive\n' >&2; exit 1; }
bash ../tooling/ios/build.sh --release --no-codesign --config-only --dart-define=TRADELOOM_BRAND=true
xcodebuild \
  -workspace ios/Runner.xcworkspace \
  -scheme Runner \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  -archivePath "$RUN_DIR/TradeLoom.xcarchive" \
  CODE_SIGN_STYLE=Automatic \
  DEVELOPMENT_TEAM="$TEAM_ID" \
  CODE_SIGNING_ALLOWED=YES \
  archive
ARCHIVE_APP="$RUN_DIR/TradeLoom.xcarchive/Products/Applications/Runner.app"
[[ -d "$ARCHIVE_APP" ]] || { printf 'Runner.app missing from archive\n' >&2; exit 1; }
APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$ARCHIVE_APP/Info.plist")"
[[ "$APP_ID" == 'io.github.ccch1mneyyy.tradeloom' ]] || { printf 'Unexpected archived app identifier: %s\n' "$APP_ID" >&2; exit 1; }
SHARE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$ARCHIVE_APP/PlugIns/ShareExtension.appex/Info.plist")"
WIDGET_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$ARCHIVE_APP/PlugIns/CompanionWidget.appex/Info.plist")"
[[ "$SHARE_ID" == "$APP_ID.ShareExtension" ]] || { printf 'Unexpected archived share extension identifier: %s\n' "$SHARE_ID" >&2; exit 1; }
[[ "$WIDGET_ID" == "$APP_ID.CompanionWidget" ]] || { printf 'Unexpected archived widget identifier: %s\n' "$WIDGET_ID" >&2; exit 1; }
/usr/bin/codesign --verify --deep --strict "$ARCHIVE_APP"
verify_component_team() {
  local component="$1" details
  details="$(/usr/bin/codesign -dv --verbose=4 "$component" 2>&1)" || {
    printf 'Unable to inspect code signature: %s\n' "$component" >&2
    return 1
  }
  grep -Fxq "TeamIdentifier=$TEAM_ID" <<< "$details" || {
    printf 'Unexpected signing team for: %s\n' "$component" >&2
    return 1
  }
}
verify_component_team "$ARCHIVE_APP"
verify_component_team "$ARCHIVE_APP/PlugIns/ShareExtension.appex"
verify_component_team "$ARCHIVE_APP/PlugIns/CompanionWidget.appex"
EXPORT_DIR="$RUN_DIR/export"
mkdir "$EXPORT_DIR"
xcodebuild -exportArchive \
  -archivePath "$RUN_DIR/TradeLoom.xcarchive" \
  -exportPath "$EXPORT_DIR" \
  -exportOptionsPlist "$EXPORT_OPTIONS"
IPA_COUNT=0
IPA_PATH=""
for candidate in "$EXPORT_DIR"/*.ipa; do
  [[ -f "$candidate" ]] || continue
  IPA_COUNT=$((IPA_COUNT + 1))
  IPA_PATH="$candidate"
done
[[ "$IPA_COUNT" -eq 1 ]] || { printf 'Expected exactly one exported IPA, found %s\n' "$IPA_COUNT" >&2; exit 1; }
IPA_CHECK="$WORK_ROOT/ipa-check"
mkdir "$IPA_CHECK"
unzip -q "$IPA_PATH" -d "$IPA_CHECK"
IPA_APP=""
for candidate in "$IPA_CHECK"/Payload/*.app; do
  [[ -d "$candidate" ]] || continue
  [[ -z "$IPA_APP" ]] || { printf 'IPA contains multiple top-level apps\n' >&2; exit 1; }
  IPA_APP="$candidate"
done
[[ -n "$IPA_APP" ]] || { printf 'IPA Payload app is missing\n' >&2; exit 1; }
IPA_APP_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$IPA_APP/Info.plist")"
IPA_SHARE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$IPA_APP/PlugIns/ShareExtension.appex/Info.plist")"
IPA_WIDGET_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$IPA_APP/PlugIns/CompanionWidget.appex/Info.plist")"
[[ "$IPA_APP_ID" == 'io.github.ccch1mneyyy.tradeloom' && "$IPA_SHARE_ID" == "$IPA_APP_ID.ShareExtension" && "$IPA_WIDGET_ID" == "$IPA_APP_ID.CompanionWidget" ]] || {
  printf 'Exported IPA contains unexpected bundle identifiers\n' >&2; exit 1;
}
/usr/bin/codesign --verify --deep --strict "$IPA_APP"
verify_component_team "$IPA_APP"
verify_component_team "$IPA_APP/PlugIns/ShareExtension.appex"
verify_component_team "$IPA_APP/PlugIns/CompanionWidget.appex"
printf 'Signed iOS archive: %s\nInstallable TradeLoom IPA: %s\n' "$RUN_DIR/TradeLoom.xcarchive" "$IPA_PATH"
