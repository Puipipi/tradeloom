"""Check the exact per-flavor runtime inputs used by Android's sourceSets.

Invoked before release builds by build-apk.sh. This checks file completeness and
manifest digests, not ELF semantics or the contents of the eventual APK.
"""

import argparse
import hashlib
import json
from pathlib import Path
import re
import sys


ROOT = Path(__file__).resolve().parent.parent
ABIS = {"arm64": "arm64-v8a", "x64": "x86_64"}
REQUIRED_JNI = ("libproot.so", "libproot-loader.so", "libtalloc.so", "libandroid-shmem.so")


def check_file(path, size, digest):
    if not path.is_file():
        raise ValueError(f"missing runtime file: {path}")
    if type(size) is not int or size <= 0:
        raise ValueError(f"invalid manifest byte count for {path}")
    if not isinstance(digest, str) or re.fullmatch(r"[0-9a-f]{64}", digest) is None:
        raise ValueError(f"invalid manifest sha256 for {path}")
    actual_size = path.stat().st_size
    if actual_size != size:
        raise ValueError(f"size mismatch: {path} (got {actual_size}, expected {size})")
    actual = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            actual.update(block)
    if actual.hexdigest() != digest:
        raise ValueError(f"sha256 mismatch: {path}")


def check_bundle(flavor, tradeloom_mesh=False):
    abi = ABIS[flavor]
    bundle = ROOT / "runtime" / ("out-tradeloom" if tradeloom_mesh else "out") / abi
    assets = bundle / "assets" / "runtime"
    manifest_path = assets / "manifest.json"
    if not manifest_path.is_file():
        raise ValueError(f"missing runtime manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if not isinstance(manifest, dict) or manifest.get("abi") != abi:
        raise ValueError(f"{manifest_path}: expected ABI {abi}")
    if tradeloom_mesh:
        lock_path = ROOT / "runtime/vendor/tradeloom-mesh/lock.json"
        expected_mesh = json.loads(lock_path.read_text(encoding="utf-8"))
        if manifest.get("tradeLoomMesh") != expected_mesh:
            raise ValueError(f"{manifest_path}: TradeLoom Mesh identity does not match the repository lock")
    schema = manifest.get("schema", 1)
    if type(schema) is not int or schema not in (1, 2):
        raise ValueError(f"{manifest_path}: unsupported runtime schema {schema!r}")
    if schema == 1:
        if "layers" in manifest:
            raise ValueError(f"{manifest_path}: schema 1 must not contain layers")
        archives = [("rootfs", {"asset": manifest["rootfs"],
                     "bytes": manifest["rootfsBytes"], "sha256": manifest["rootfsSha256"]})]
    else:
        if any(key in manifest for key in ("rootfs", "rootfsSha256", "rootfsFormat")):
            raise ValueError(f"{manifest_path}: schema 2 must not contain a single rootfs archive")
        layers = manifest["layers"]
        if not isinstance(layers, dict) or set(layers) != {"base", "engine"}:
            raise ValueError(f"{manifest_path}: schema 2 requires base and engine layers")
        archives = [(name, layers[name]) for name in ("base", "engine")]
    for kind, archive in archives:
        if not isinstance(archive, dict):
            raise ValueError(f"{manifest_path}: invalid {kind} archive record")
        name = archive["asset"]
        if name not in (f"{kind}-{abi}.tar.xz", f"{kind}-{abi}.tar.gz"):
            raise ValueError(f"{manifest_path}: invalid {kind} asset name for {abi}")
        check_file(assets / name, archive["bytes"], archive["sha256"])
    jni = manifest["jniLibs"]
    if not isinstance(jni, dict):
        raise ValueError(f"{manifest_path}: invalid jniLibs record")
    for name in REQUIRED_JNI:
        if name not in jni:
            raise ValueError(f"{manifest_path}: missing required jniLibs entry {name}")
    for name, record in jni.items():
        if Path(name).name != name or not name.startswith("lib") or not name.endswith(".so"):
            raise ValueError(f"{manifest_path}: invalid JNI filename {name!r}")
        if not isinstance(record, dict):
            raise ValueError(f"{manifest_path}: invalid JNI record for {name}")
        check_file(bundle / "jniLibs" / abi / name, record["bytes"], record["sha256"])
    print(f"runtime verified: {flavor} ({abi}), schema {schema}, {len(archives) + len(jni)} files")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("flavors", nargs="+", choices=ABIS)
    parser.add_argument("--tradeloom-mesh", action="store_true")
    args = parser.parse_args()
    failed = False
    for flavor in args.flavors:
        try:
            check_bundle(flavor, args.tradeloom_mesh)
        except (OSError, ValueError, KeyError, TypeError) as error:
            failed = True
            print(f"build-apk: {flavor}: {error}", file=sys.stderr)
            print(f"build-apk: rebuild runtime first: bash runtime/build-runtime.sh {ABIS[flavor]}", file=sys.stderr)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
