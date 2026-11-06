#!/usr/bin/env python3
"""Package the fixed R74 ASAR, unpacked sidecar, and deployment input."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import subprocess
import zipfile

EXPECTED = {
    "resources/app.asar": (172819677, "1b1e56467e5fb682a7de176385b38e63937d32de5ed2d289bf29b4ab95d6da15"),
    "resources/tradeloom/deployment.json": (75753, "659de9699911bafeb6c52f71ff67f20eb6289beceba9e88d04727e603f6b61c7"),
}
SIDECAR = (1583, 255019766, "dff1b37d32b0e917f25c6b887552fd8fbbee61564dc6e17519ae171733ec34f0")
TOTAL = (1585, 427915196)
CHUNK = 1024 * 1024


def digest_file(path: Path):
    before = path.lstat()
    if not stat.S_ISREG(before.st_mode):
        raise RuntimeError(f"not an ordinary file: {path.name}")
    h = hashlib.sha256()
    size = 0
    with path.open("rb") as src:
        opened = os.fstat(src.fileno())
        if (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns) != (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns):
            raise RuntimeError(f"source changed before read: {path.name}")
        while True:
            block = src.read(CHUNK)
            if not block:
                break
            h.update(block)
            size += len(block)
        after_open = os.fstat(src.fileno())
    after = path.lstat()
    stamp = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if stamp(before) != stamp(after) or stamp(before) != stamp(after_open) or size != before.st_size:
        raise RuntimeError(f"source changed during read: {path.name}")
    return size, h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--resources-root", required=True)
    ap.add_argument("--output-zip", required=True)
    args = ap.parse_args()
    root = Path(args.resources_root).resolve(strict=True)
    if not root.is_dir() or root.is_symlink():
        raise RuntimeError("resources root must be an ordinary directory")
    output = Path(args.output_zip).resolve()
    if output.exists():
        raise RuntimeError("output ZIP already exists")
    output.parent.mkdir(parents=True, exist_ok=True)

    rows = []
    source_paths = {
        "resources/app.asar": root / "app.asar",
        "resources/tradeloom/deployment.json": root / "tradeloom/deployment.json",
    }
    for rel, (expected_size, expected_hash) in EXPECTED.items():
        p = source_paths[rel]
        size, sha = digest_file(p)
        if (size, sha) != (expected_size, expected_hash):
            raise RuntimeError(f"fixed input mismatch: {rel}")
        rows.append({"path": rel, "bytes": size, "sha256": sha})

    side_root = root / "app.asar.unpacked"
    side_rows = []
    for current, dirs, files in os.walk(side_root, topdown=True, followlinks=False):
        current_p = Path(current)
        kept = []
        for name in dirs:
            p = current_p / name
            if p.is_symlink() or not stat.S_ISDIR(p.lstat().st_mode):
                raise RuntimeError("reparse or non-directory in fixed sidecar")
            kept.append(name)
        dirs[:] = kept
        for name in files:
            p = current_p / name
            if p.is_symlink():
                raise RuntimeError("reparse in fixed sidecar")
            rel = p.relative_to(side_root).as_posix()
            size, sha = digest_file(p)
            side_rows.append({"path": rel, "bytes": size, "sha256": sha})
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js is required for the frozen canonical locale sort")
    canonical_js = "const fs=require('fs'),crypto=require('crypto');const rows=JSON.parse(fs.readFileSync(0,'utf8'));rows.sort((a,b)=>a.path.localeCompare(b.path,'en'));process.stdout.write(crypto.createHash('sha256').update(rows.map(r=>`${r.path}\\0${r.bytes}\\0${r.sha256.toLowerCase()}\\n`).join(''),'utf8').digest('hex'))"
    canonical = subprocess.run([node, "-e", canonical_js], input=json.dumps(side_rows), text=True, capture_output=True, check=True)
    side_tree = canonical.stdout.strip()
    side_rows.sort(key=lambda r: r["path"].casefold())
    side_bytes = sum(r["bytes"] for r in side_rows)
    if (len(side_rows), side_bytes, side_tree) != SIDECAR:
        raise RuntimeError(f"fixed unpacked sidecar mismatch: {len(side_rows)}/{side_bytes}/{side_tree}")
    rows.extend({"path": f"resources/app.asar.unpacked/{r['path']}", "bytes": r["bytes"], "sha256": r["sha256"]} for r in side_rows)
    if (len(rows), sum(r["bytes"] for r in rows)) != TOTAL:
        raise RuntimeError("fixed build-input totals mismatch")

    tmp = output.with_suffix(output.suffix + ".part")
    if tmp.exists():
        raise RuntimeError("temporary ZIP already exists")
    with zipfile.ZipFile(tmp, "x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zf:
        members = [("resources/app.asar", root / "app.asar"), ("resources/tradeloom/deployment.json", root / "tradeloom/deployment.json")]
        members.extend((f"resources/app.asar.unpacked/{r['path']}", side_root.joinpath(*PurePosixPath(r["path"]).parts)) for r in side_rows)
        for arcname, source in members:
            info = zipfile.ZipInfo(arcname, date_time=(2026, 11, 6, 0, 0, 0))
            info.compress_type = zipfile.ZIP_DEFLATED
            info.create_system = 0
            with source.open("rb") as src, zf.open(info, "w", force_zip64=True) as dst:
                while True:
                    chunk = src.read(CHUNK)
                    if not chunk:
                        break
                    dst.write(chunk)

    readback = []
    with zipfile.ZipFile(tmp, "r") as zf:
        if len(zf.infolist()) != len(rows) or len({i.filename for i in zf.infolist()}) != len(rows):
            raise RuntimeError("ZIP member count/uniqueness mismatch")
        expected_rows = {r["path"]: r for r in rows}
        for info in zf.infolist():
            rel = PurePosixPath(info.filename)
            if rel.is_absolute() or ".." in rel.parts or info.filename not in expected_rows:
                raise RuntimeError("unsafe or unexpected ZIP member")
            h = hashlib.sha256()
            size = 0
            with zf.open(info, "r") as src:
                while True:
                    chunk = src.read(CHUNK)
                    if not chunk:
                        break
                    h.update(chunk)
                    size += len(chunk)
            exp = expected_rows[info.filename]
            if (size, h.hexdigest()) != (exp["bytes"], exp["sha256"]):
                raise RuntimeError(f"ZIP readback mismatch: {info.filename}")
            readback.append(info.filename)
    tmp.replace(output)
    zip_size, zip_sha = digest_file(output)
    receipt = {
        "status": "fixed-r74-build-inputs-readback-verified-not-built",
        "files": len(rows), "bytes": sum(r["bytes"] for r in rows),
        "sidecar": {"files": len(side_rows), "bytes": side_bytes, "treeSha256": side_tree},
        "zip": {"bytes": zip_size, "sha256": zip_sha},
        "members": rows,
    }
    receipt_path = output.with_name(output.stem + ".receipt.json")
    with receipt_path.open("x", encoding="utf-8", newline="\n") as f:
        json.dump(receipt, f, ensure_ascii=False, indent=2)
        f.write("\n")
    print(json.dumps({"status": receipt["status"], "files": len(rows), "bytes": receipt["bytes"], "zipBytes": zip_size, "zipSha256": zip_sha, "receipt": receipt_path.name}, ensure_ascii=False))


if __name__ == "__main__":
    main()
