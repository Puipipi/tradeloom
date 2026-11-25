#!/usr/bin/env python3
"""Boot a disposable x64 runtime and check only the branded Mesh route."""

import argparse
import hashlib
import http.cookiejar
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import socket
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request

RT = Path(__file__).resolve().parents[1]


def source_module():
    spec = importlib.util.spec_from_file_location("rtbuild", RT / "lib/rtbuild.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def digest(path):
    with path.open("rb") as file:
        return hashlib.file_digest(file, "sha256").hexdigest()


def read_assets(manifest):
    return list(manifest["layers"].values()) if manifest.get("schema", 1) == 2 else [
        {"asset": manifest["rootfs"], "sha256": manifest["rootfsSha256"]},
    ]


def launch_arguments(manifest, port):
    argv = manifest["launch"]["argv"]
    return [value.replace("{PORT}", str(port)) for value in argv[argv.index("/usr/bin/env"):]
            if value != "{GUEST_ENV}"]


def open_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--scratch", type=Path, required=True)
    parser.add_argument("--proot", type=Path)
    parser.add_argument("--prepared-root", type=Path)
    args = parser.parse_args()

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    if manifest["abi"] != "x86_64":
        raise SystemExit("the Mesh smoke test requires an x86_64 runtime manifest")

    args.scratch.mkdir(parents=True, exist_ok=True)
    if args.prepared_root:
        root = args.prepared_root.resolve()
        if (root.parent != args.scratch.resolve() or not root.name.startswith("mesh-root-")
                or not (root / "tradeloom-mesh-guest.log").is_file()):
            raise SystemExit("prepared root must be a previous Mesh guest under this scratch directory")
    else:
        root = Path(tempfile.mkdtemp(prefix="mesh-root-", dir=args.scratch))
        for record in read_assets(manifest):
            asset = record["asset"]
            if Path(asset).name != asset:
                raise SystemExit("runtime asset must be relative to its manifest")
            archive = args.manifest.parent / asset
            if digest(archive) != record["sha256"]:
                raise SystemExit("runtime archive hash mismatch")
            subprocess.run(["tar", "-xf", str(archive), "-C", str(root)], check=True)

    rtbuild = source_module()
    info = json.loads((root / "etc/dsh-app/runtime.json").read_text(encoding="utf-8"))
    info.pop("tradeLoomMesh", None)
    lock, files = rtbuild.tradeloom_mesh_package(info["dshVersion"])
    plain = rtbuild.overlay_entries(info, with_python=True, with_pnpm=True, with_bridge=True)
    branded = rtbuild.overlay_entries(
        {**info, "tradeLoomMesh": lock}, with_python=True, with_pnpm=True, with_bridge=True, mesh_files=files,
    )
    changed = {
        name for name, entry in branded.items()
        if name not in plain or entry.data != plain[name].data
    }
    expected = {rtbuild.DSH_WEB_PATCH.lstrip("/"), "etc/dsh-app/runtime.json"}
    expected.update(rtbuild.TRADELOOM_MESH_DIR + "/" + name for name in files)
    if changed != expected:
        raise SystemExit("unexpected changes between standard and TradeLoom overlay")
    for name in changed:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(branded[name].data)

    port = open_port()
    if args.proot:
        isolated = [str(args.proot.resolve()), "-r", str(root), "-w", "/root", "-b", "/dev", "-b", "/proc"]
        host = "PRoot Linux x86_64"
    else:
        bwrap = shutil.which("bwrap")
        if bwrap is None:
            raise SystemExit("bwrap or the --proot test executable is required")
        isolated = [bwrap, "--bind", str(root), "/", "--dev", "/dev", "--proc", "/proc",
                    "--unshare-user", "--uid", "0", "--gid", "0", "--die-with-parent", "--chdir", "/root", "--"]
        host = "bubblewrap Linux x86_64"

    process = subprocess.Popen(isolated + launch_arguments(manifest, port), text=True, bufsize=1,
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    token = []
    logs = []
    ready = threading.Event()

    def read_log():
        for line in process.stdout:
            match = re.search(r"dsh web: http://[^\s]+[?&]token=([A-Za-z0-9_-]+)", line)
            if match:
                token.append(match.group(1))
                ready.set()
            logs.append(re.sub(r"([?&](?:token|code)=)[A-Za-z0-9_-]+", r"\1<redacted>", line))

        ready.set()

    reader = threading.Thread(target=read_log, daemon=True)
    reader.start()
    try:
        if not ready.wait(45) or not token:
            raise SystemExit("guest did not report authenticated startup")
        origin = f"http://127.0.0.1:{port}"
        route = origin + "/.dsh-mesh/v1/status"
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
        try:
            with opener.open(route, timeout=5):
                raise SystemExit("guest accepted the status request without authentication")
        except urllib.error.HTTPError as error:
            if error.code not in (401, 403):
                raise
            anonymous = error.code
        with opener.open(origin + "/?token=" + token[0], timeout=10):
            pass
        deadline = time.monotonic() + 10
        while True:
            try:
                with opener.open(route, timeout=5) as response:
                    status = json.load(response)
                break
            except urllib.error.HTTPError as error:
                if error.code != 404 or time.monotonic() >= deadline:
                    raise
                time.sleep(0.25)
        if status.get("tradeLoomReadOnly") != 1 or status.get("paired") is not False:
            raise SystemExit("guest did not expose the expected unpaired TradeLoom read-only contract")
        print(json.dumps({
            "guest": host,
            "tradeLoomReadOnly": 1,
            "paired": False,
            "anonymousStatus": anonymous,
            "authenticatedStatus": 200,
            "entrySha256": lock["entrySha256"],
            "overlayChangedFiles": sorted(changed),
        }, indent=2))
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait()
        reader.join(timeout=2)
        (root / "tradeloom-mesh-guest.log").write_text("".join(logs), encoding="utf-8")


if __name__ == "__main__":
    main()
