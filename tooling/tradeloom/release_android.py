#!/usr/bin/env python3
"""Build a signed, dual-ABI TradeLoom OTA bundle in a new local directory."""
import argparse
import ipaddress
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import unquote, urlsplit

from stamp_update_manifest import stamp

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tooling"))
from release_assets import MAX_VERSION_CODE, VERSION_RE, ReleaseError, find_aapt2, release_build

PACKAGE = "io.github.ccch1mneyyy.dsh_app.tradeloom"
FLAVORS = ("arm64", "x64")
UPSTREAM_REF = "refs/remotes/upstream/main"
SIGNER = re.compile(r"^Signer #\d+ certificate SHA-256 digest: ([0-9a-fA-F]{64})$", re.MULTILINE)


def run(*args):
    result = subprocess.run(args, cwd=ROOT, text=True, capture_output=True)
    if result.returncode:
        raise ValueError(f"{Path(args[0]).name} {args[1]} failed")
    return result.stdout.strip()


def validate_feed(value):
    uri = urlsplit(value)
    host = uri.hostname or ""
    _ = uri.port  # Also reject a malformed authority/port.
    if (
        uri.scheme != "https" or not host or host.rstrip(".").lower() == "localhost"
        or host.rstrip(".").lower().endswith(".localhost")
        or uri.username is not None or uri.password is not None
        or "?" in value or "#" in value or any(char.isspace() for char in value)
        or not uri.path.startswith("/") or not uri.path.endswith("/update.json")
        or any(unquote(part) in (".", "..") for part in uri.path.split("/"))
    ):
        raise ValueError("use the authorized HTTPS update.json URL without credentials, query or fragment")
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        if not all(re.fullmatch(r"[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?", part)
                   for part in host.rstrip(".").split(".")) or host.isdecimal():
            raise ValueError("invalid update feed host") from None
    else:
        effective_address = getattr(address, "ipv4_mapped", None) or address
        if effective_address.is_loopback or effective_address.is_unspecified:
            raise ValueError("the official feed cannot point at a local QA endpoint")
    return value


def version_parts(value):
    match = VERSION_RE.fullmatch(value)
    if not match or not match.group(2):
        raise ValueError("versions must include both versionName and Android versionCode (X.Y.Z+N)")
    name, code = match.group(1), int(match.group(2))
    if not 1 < code <= MAX_VERSION_CODE or str(code) != match.group(2):
        raise ValueError("Android versionCode is out of range")
    base, separator, prerelease = name.partition("-")
    tags = prerelease.split(".") if separator else []
    if any(not tag for tag in tags):
        raise ValueError("empty pre-release identifier")
    rank = (tuple(map(int, base.split("."))), not separator,
            tuple((0, int(tag)) if tag.isdecimal() else (1, tag) for tag in tags))
    return name, code, rank


def validate_versions(version, previous_version):
    name, code, rank = version_parts(version)
    _, previous_code, previous_rank = version_parts(previous_version)
    if code <= previous_code or rank < previous_rank:
        raise ValueError("release must advance Android versionCode without decreasing versionName")
    return name, code


def verify_apks(apks, aapt2, apksigner, expected_fingerprint, name, code):
    versions = {}
    for flavor in FLAVORS:
        path = str(apks[flavor])
        apk_info = run(aapt2, "dump", "badging", path)
        package = re.search(r"^package: name='([^']+)' versionCode='(\d+)' versionName='([^']+)'", apk_info, re.MULTILINE)
        if not package or package[1] != PACKAGE:
            raise ValueError(f"{flavor}: expected APK package {PACKAGE}")
        versions[flavor] = package[3], int(package[2])
        signers = SIGNER.findall(run(apksigner, "verify", "--print-certs", path))
        if [signer.lower() for signer in signers] != [expected_fingerprint]:
            raise ValueError(f"{flavor}: APK signature does not match the expected release certificate")
    release_build(name, code, versions)


def candidate_commits():
    if run("git", "status", "--porcelain", "--untracked-files=normal"):
        raise ValueError("start from a clean, locked candidate checkout")
    head = run("git", "rev-parse", "--verify", "HEAD^{commit}")
    upstream = run("git", "rev-parse", "--verify", UPSTREAM_REF + "^{commit}")
    run("git", "merge-base", "--is-ancestor", upstream, head)
    return head, upstream


def package_release(apks, out, *, version, previous_version, feed, fingerprint, head, upstream, aapt2, apksigner):
    name, code = validate_versions(version, previous_version)
    validate_feed(feed)
    if out.exists() or out.is_symlink():
        raise ValueError("choose a new release output directory")
    if set(apks) != set(FLAVORS):
        raise ValueError("both arm64 and x64 APKs are required")
    with tempfile.TemporaryDirectory(dir=out.parent, prefix=".tradeloom-release-") as scratch:
        inputs = {flavor: Path(scratch) / f"{flavor}.apk" for flavor in FLAVORS}
        for flavor, path in inputs.items():
            shutil.copyfile(apks[flavor], path)
        verify_apks(inputs, aapt2, apksigner, fingerprint, name, code)
        bundle = Path(scratch) / "bundle"
        version_dir = bundle / version
        subprocess.run([sys.executable, str(ROOT / "tooling/release_assets.py"), "--product", "tradeloom",
                        "--delta-from", "0", "--version", version, "--out", str(version_dir),
                        *(f"{flavor}={inputs[flavor]}" for flavor in FLAVORS)],
                       cwd=ROOT, check=True, stdout=subprocess.DEVNULL)
        manifest = version_dir / "update.json"
        stamp(manifest, upstream, version_directory=version)
        manifest.rename(bundle / "update.json")
        (bundle / "release-provenance.json").write_text(json.dumps({
            "candidateCommit": head, "sourceCommit": upstream, "feed": feed,
            "previousVersion": previous_version, "version": version, "signerSha256": fingerprint,
        }, indent=2) + "\n", encoding="utf-8")
        if out.exists() or out.is_symlink():
            raise ValueError("release output appeared during packaging")
        bundle.rename(out)


def preserve_previous_apks(apk_dir):
    previous = [
        apk_dir / f"{prefix}-{flavor}-release.apk"
        for prefix in ("app", "tradeloom-app") for flavor in FLAVORS
    ]
    previous = [path for path in previous if path.exists() or path.is_symlink()]
    if not previous:
        return
    retained = Path(tempfile.mkdtemp(dir=apk_dir, prefix="previous-official-apks-"))
    for path in previous:
        path.rename(retained / path.name)
    print(f"Previous APKs retained at {retained}", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--feed", required=True, help="authorized HTTPS update.json URL to embed in both APKs")
    parser.add_argument("--version", required=True, help="new versionName+versionCode")
    parser.add_argument("--previous-version", required=True, help="published versionName+versionCode used as the upgrade baseline")
    parser.add_argument("--signer-sha256", required=True, help="public certificate SHA-256 from the authorized installed release")
    parser.add_argument("--out", required=True, type=Path, help="new directory in which to stage the release, without publishing it")
    args = parser.parse_args()
    try:
        validate_feed(args.feed)
        name, code = validate_versions(args.version, args.previous_version)
        fingerprint = args.signer_sha256.lower()
        if not re.fullmatch(r"[0-9a-f]{64}", fingerprint):
            raise ValueError("expected a 64-digit SHA-256 certificate fingerprint")
        out = args.out.absolute()
        if out.exists() or out.is_symlink() or not out.parent.is_dir():
            raise ValueError("output must be a new directory within an existing parent")
        head, upstream = candidate_commits()
        aapt2 = find_aapt2()
        if not aapt2:
            raise ValueError("Android SDK aapt2 is required")
        apksigner = Path(aapt2).with_name("apksigner.bat" if os.name == "nt" else "apksigner")
        if not apksigner.is_file():
            raise ValueError("Android SDK apksigner is required")
        if not (ROOT / "app/android/key.properties").is_file():
            raise ValueError("official Android signing must already be configured")
        if b"\r\n" in (ROOT / "tooling/build-apk.sh").read_bytes():
            raise ValueError("build from a WSL/Linux checkout with LF shell scripts")
        apk_dir = ROOT / "app/build/app/outputs/flutter-apk"
        preserve_previous_apks(apk_dir)
        env = os.environ | {"TRADELOOM_UPDATE_FEED": args.feed, "TRADELOOM_OFFICIAL_RELEASE": "1"}
        subprocess.run(["bash", "tooling/build-apk.sh", "--tradeloom", "--no-companion", "--no-star",
                        "--release", "-f", "all", "--build-name", name, "--build-number", str(code),
                        "--keep-daemon"], env=env, cwd=ROOT, check=True)
        if candidate_commits() != (head, upstream):
            raise ValueError("candidate or upstream lock changed during the build")
        package_release({f: apk_dir / f"tradeloom-app-{f}-release.apk" for f in FLAVORS}, out,
                        version=args.version, previous_version=args.previous_version, feed=args.feed,
                        fingerprint=fingerprint, head=head, upstream=upstream, aapt2=aapt2, apksigner=str(apksigner))
        print(f"TradeLoom {args.version} staged at {out}")
    except (ValueError, OSError, ReleaseError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
