#!/usr/bin/env python3
"""Stamp a generated TradeLoom update.json with its upstream source commit.

The APK list, version, sizes and SHA-256 values must already come from
tooling/release_assets.py. Asset URLs are rewritten to relative versioned paths
so the app's build-pinned HTTPS origin remains authoritative.
"""
import argparse
import json
import pathlib
import re
import tempfile


SHA = re.compile(r"^[0-9a-f]{40}$")
VERSION = re.compile(r"^(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+(\d+))?$")


def stamp(path: pathlib.Path, source_commit: str, *, version_directory: str | None = None) -> dict:
    if not SHA.fullmatch(source_commit):
        raise ValueError("--source-commit must be a 40-character lowercase Git SHA")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, dict) or data.get("schema") != 1:
        raise ValueError("manifest must use schema 1")
    version = data.get("version")
    match = VERSION.fullmatch(version) if isinstance(version, str) else None
    if not match:
        raise ValueError("manifest version must be X.Y.Z[-pre][+build]")
    version_name = match.group(1)
    if version_directory is not None and version_directory != version:
        raise ValueError("explicit asset directory must equal the full manifest version")
    assets = data.get("assets")
    if not isinstance(assets, dict) or not assets:
        raise ValueError("manifest must contain at least one APK asset")
    if "patches" in data:
        raise ValueError("TradeLoom manifests do not carry DSH Go delta patches")
    for flavor, asset in assets.items():
        if flavor not in ("arm64", "x64") or not isinstance(asset, dict):
            raise ValueError(f"unsupported APK flavor: {flavor}")
        name = f"tradeloom-app-{version_name}-{flavor}.apk"
        if asset.get("name") != name:
            raise ValueError(f"{flavor} asset name must be {name}")
        digest = asset.get("sha256")
        if not isinstance(digest, str) or not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError(f"{flavor} APK needs a lowercase SHA-256 from release_assets.py")
        if not isinstance(asset.get("size"), int) or asset["size"] <= 0:
            raise ValueError(f"{flavor} APK needs a positive byte size")
        asset["url"] = f"{version_directory or version_name}/{name}"
    data["sourceCommit"] = source_commit
    data["title"] = f"TradeLoom {version_name}"
    data.pop("page", None)
    encoded = json.dumps(data, ensure_ascii=False, indent=2) + "\n"
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", newline="\n", dir=path.parent, delete=False) as handle:
        handle.write(encoded)
        temp = pathlib.Path(handle.name)
    temp.replace(path)
    return data


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=pathlib.Path, help="update.json emitted by release_assets.py")
    parser.add_argument("--source-commit", required=True, help="40-character dsh-Go upstream SHA included in this candidate")
    args = parser.parse_args()
    try:
        result = stamp(args.manifest, args.source_commit)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        parser.error(str(error))
    print(f"TradeLoom {result['version']} manifest stamped with source commit {result['sourceCommit']}")


if __name__ == "__main__":
    main()
