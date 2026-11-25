#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
SOURCE_ROOT="${TRADELOOM_SOURCE_ROOT:?Set TRADELOOM_SOURCE_ROOT to a Git checkout}"
SOURCE_COMMIT="${TRADELOOM_SOURCE_COMMIT:?Set TRADELOOM_SOURCE_COMMIT to a full 40-character commit SHA}"
OUTPUT_ROOT="${TRADELOOM_OUTPUT_ROOT:?Set TRADELOOM_OUTPUT_ROOT to a new writable output directory}"
: "${DSH_OHOS_NATIVE_LIBS:?Use your built Native libs directory; DSH Go signing materials are not reused}"
: "${DSH_NODE_HEADERS:?Set the pinned Node source headers directory}"
: "${DSH_OHOS_RUNTIME:?Set the composed runtime zip path}"
: "${DSH_OHOS_SIGN_KEYSTORE:?Set your own Harmony signing keystore}"
: "${DSH_OHOS_SIGN_CERTIFICATE:?Set your own Harmony signing certificate}"
: "${DSH_OHOS_SIGN_PROFILE:?Set your own Harmony signing profile for io.github.ccch1mneyyy.tradeloom}"
: "${DSH_OHOS_SIGN_KEY_ALIAS:?Set the alias in your Harmony signing keystore}"
: "${DSH_OHOS_SIGN_KEY_PASSWORD:?Set your Harmony signing key password}"
: "${DSH_OHOS_SIGN_STORE_PASSWORD:?Set your Harmony signing store password}"
: "${DSH_OHOS_SIGN_TOOL:?Set the Harmony signing tool path}"
[[ "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}$ ]] || { printf 'TRADELOOM_SOURCE_COMMIT must be a full commit SHA\n' >&2; exit 2; }
git -C "$SOURCE_ROOT" cat-file -e "$SOURCE_COMMIT^{commit}"
RESOLVED_COMMIT="$(git -C "$SOURCE_ROOT" rev-parse "$SOURCE_COMMIT^{commit}")"
SOURCE_COMMIT_LOWER="$(printf '%s' "$SOURCE_COMMIT" | tr 'A-F' 'a-f')"
RESOLVED_COMMIT_LOWER="$(printf '%s' "$RESOLVED_COMMIT" | tr 'A-F' 'a-f')"
[[ "$RESOLVED_COMMIT_LOWER" == "$SOURCE_COMMIT_LOWER" ]] || { printf 'Source commit did not resolve exactly\n' >&2; exit 2; }
mkdir -p "$OUTPUT_ROOT"
OUTPUT_ROOT="$(cd "$OUTPUT_ROOT" && pwd -P)"
RUN_DIR="$OUTPUT_ROOT/tradeloom-ohos-$(date -u +%Y%m%dT%H%M%SZ)"
[[ ! -e "$RUN_DIR" ]] || { printf 'Output already exists: %s\n' "$RUN_DIR" >&2; exit 2; }
mkdir "$RUN_DIR"
WORK_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tradeloom-ohos.XXXXXX")"
cleanup() {
  case "$WORK_ROOT" in
    "${TMPDIR:-/tmp}"/tradeloom-ohos.*) rm -rf -- "$WORK_ROOT" ;;
    *) printf 'Refusing unexpected temporary path cleanup: %s\n' "$WORK_ROOT" >&2; return 1 ;;
  esac
}
trap cleanup EXIT
STAGE="$WORK_ROOT/source"
mkdir "$STAGE"
git -C "$SOURCE_ROOT" archive --format=tar "$RESOLVED_COMMIT" | tar -xf - -C "$STAGE"
python3 "$SCRIPT_DIR/prepare_tradeloom_platform.py" --root "$STAGE" --platform ohos

cd "$STAGE"
bash tooling/ohos/build-hap.sh --release --distribution device
SIGNED="$STAGE/app/build/hap/dsh-go-device-signed.hap"
[[ -s "$SIGNED" ]] || { printf 'Expected signed HAP was not produced: %s\n' "$SIGNED" >&2; exit 1; }
DESTINATION="$RUN_DIR/TradeLoom-device-signed.hap"
cp "$SIGNED" "$DESTINATION"
printf 'Signed Harmony HAP: %s\n' "$DESTINATION"
