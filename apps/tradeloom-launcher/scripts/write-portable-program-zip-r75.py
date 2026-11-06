import hashlib
import json
import os
import stat
import sys
import zipfile

BASE_FILES = 39739
BASE_BYTES = 2218773644
BASE_TREE_SHA256 = "c7c5c0e3fdddce08e6cddbb251edc14088d67a92c740a40c3b13669c356651a8"
OVERLAYS = {
    "app/resources/app.asar": (172819677, "1b1e56467e5fb682a7de176385b38e63937d32de5ed2d289bf29b4ab95d6da15", 172823311, "e86597aa3fe799c7f69c8b80a2c4cd3a0b45dce1e76749322cd2024bbf2c0c8d"),
    "app/resources/tradeloom/deployment.json": (75753, "659de9699911bafeb6c52f71ff67f20eb6289beceba9e88d04727e603f6b61c7", 75753, "6847189104017cc29cf292361e70a2568db6a824b965562aa36a89a1c91586aa"),
}
ZIP_ROOT = "TradeLoom-r75/"
PART_NAME = "TradeLoom-r75.zip.part"
ROWS_NAME = "pack-rows.json"

def sha_file(path):
    digest = hashlib.sha256()
    total = 0
    before = checked_stat(path)
    before_stamp = stamp(before)
    with open(path, "rb", buffering=0) as stream:
        if stamp(os.fstat(stream.fileno())) != before_stamp:
            raise RuntimeError("SOURCE_CHANGED_BEFORE_HASH:" + os.path.basename(path))
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            total += len(chunk)
        if stamp(os.fstat(stream.fileno())) != before_stamp:
            raise RuntimeError("SOURCE_CHANGED_DURING_HASH:" + os.path.basename(path))
    if stamp(checked_stat(path)) != before_stamp or total != before.st_size:
        raise RuntimeError("SOURCE_CHANGED_AFTER_HASH:" + os.path.basename(path))
    return total, digest.hexdigest()

def stamp(info):
    # On Windows, lstat/fstat expose different ctime semantics for the same file.
    stable_ctime = None if os.name == "nt" else info.st_ctime_ns
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, stable_ctime,
            getattr(info, "st_file_attributes", 0))

def checked_stat(path):
    info = os.lstat(path)
    attrs = getattr(info, "st_file_attributes", 0)
    if stat.S_ISLNK(info.st_mode) or attrs & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
        raise RuntimeError("REPARSE_ENTRY:" + os.path.basename(path))
    return info

def inventory(root):
    rows = []
    stack = [(root, "")]
    while stack:
        directory, relative = stack.pop()
        with os.scandir(directory) as entries:
            children = sorted(entries, key=lambda entry: entry.name, reverse=True)
        for entry in children:
            rel = (relative + "/" if relative else "") + entry.name
            path = os.path.join(directory, entry.name)
            info = checked_stat(path)
            if stat.S_ISDIR(info.st_mode):
                stack.append((path, rel))
            elif stat.S_ISREG(info.st_mode):
                rows.append((rel.replace("\\", "/"), path, stamp(info)))
            else:
                raise RuntimeError("UNSUPPORTED_ENTRY:" + rel)
    return rows

def add_stream(zf, member, source, expected_stamp=None):
    before = checked_stat(source)
    before_stamp = stamp(before)
    if expected_stamp is not None and before_stamp != expected_stamp:
        raise RuntimeError("SOURCE_CHANGED_BEFORE_READ:" + member)
    digest = hashlib.sha256()
    count = 0
    info = zipfile.ZipInfo(member, date_time=(2026, 11, 6, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = (stat.S_IFREG | stat.S_IMODE(before.st_mode)) << 16
    info.create_system = 3
    with open(source, "rb", buffering=0) as source_stream:
        if stamp(os.fstat(source_stream.fileno())) != before_stamp:
            raise RuntimeError("SOURCE_CHANGED_BEFORE_OPEN:" + member)
        with zf.open(info, "w", force_zip64=True) as target_stream:
            while True:
                chunk = source_stream.read(1024 * 1024)
                if not chunk:
                    break
                digest.update(chunk)
                target_stream.write(chunk)
                count += len(chunk)
        if stamp(os.fstat(source_stream.fileno())) != before_stamp:
            raise RuntimeError("SOURCE_CHANGED_DURING_READ:" + member)
    if stamp(checked_stat(source)) != before_stamp or count != before.st_size:
        raise RuntimeError("SOURCE_CHANGED_AFTER_READ:" + member)
    return {"path": member[len(ZIP_ROOT):], "bytes": count, "sha256": digest.hexdigest()}

def verify_old_overlay(path, expected, expected_stamp):
    if stamp(checked_stat(path)) != expected_stamp:
        raise RuntimeError("R74_OVERLAY_CHANGED_AFTER_INVENTORY:" + os.path.basename(path))
    size, digest = sha_file(path)
    if size != expected[0] or digest != expected[1]:
        raise RuntimeError("R74_OVERLAY_PREIMAGE_MISMATCH:" + os.path.basename(path))
    if stamp(checked_stat(path)) != expected_stamp:
        raise RuntimeError("R74_OVERLAY_CHANGED_AFTER_HASH:" + os.path.basename(path))
    return {"path": next(k for k in OVERLAYS if k.endswith(os.path.basename(path))), "bytes": size, "sha256": digest}

def main():
    if len(sys.argv) != 5:
        raise RuntimeError("usage: write-portable-zip.py <p2-root> <r75-resources> <output-root> <zip-part>")
    p2_root, resources_root, output_root, part_path = map(os.path.abspath, sys.argv[1:])
    if os.path.lexists(part_path) or os.path.lexists(os.path.join(output_root, ROWS_NAME)):
        raise RuntimeError("OUTPUT_EVIDENCE_ALREADY_EXISTS")
    files = inventory(p2_root)
    if len(files) != BASE_FILES:
        raise RuntimeError("P2_FILE_COUNT_MISMATCH")
    rel_map = {row[0]: row for row in files}
    if len(rel_map) != BASE_FILES:
        raise RuntimeError("P2_DUPLICATE_RELATIVE_PATH")
    for rel, expected in OVERLAYS.items():
        if rel not in rel_map:
            raise RuntimeError("P2_OVERLAY_MISSING:" + rel)

    base_rows = []
    final_rows = []
    overlay_old_rows = {}
    overlay_sources = {}
    for rel, (before_bytes, before_sha, after_bytes, after_sha) in OVERLAYS.items():
        old_path = rel_map[rel][1]
        overlay_old_rows[rel] = verify_old_overlay(old_path, (before_bytes, before_sha), rel_map[rel][2])
        resource_relative = rel.removeprefix("app/resources/")
        new_path = os.path.join(resources_root, *resource_relative.split("/"))
        new_size, new_sha = sha_file(new_path)
        if new_size != after_bytes or new_sha != after_sha:
            raise RuntimeError("R75_OVERLAY_SOURCE_MISMATCH:" + rel)
        overlay_sources[rel] = (new_path, after_bytes, after_sha)

    print(json.dumps({"phase": "zip-write-start", "files": len(files)}, separators=(",", ":")), flush=True)
    seen_overlays = set()
    with zipfile.ZipFile(part_path, mode="x", compression=zipfile.ZIP_DEFLATED, compresslevel=6, allowZip64=True) as zf:
        for rel, source, expected_stamp in files:
            base_row = overlay_old_rows.get(rel)
            if base_row is None:
                base_row = add_stream(zf, ZIP_ROOT + rel, source, expected_stamp)
                final_row = base_row
            else:
                if rel in seen_overlays:
                    raise RuntimeError("DUPLICATE_OVERLAY_MEMBER:" + rel)
                seen_overlays.add(rel)
                final_row = None
            base_rows.append(base_row)
            if final_row is not None:
                final_rows.append(final_row)
        if seen_overlays != set(OVERLAYS):
            raise RuntimeError("OVERLAY_MEMBER_SET_MISMATCH")
        for rel, (source, size, digest) in overlay_sources.items():
            row = add_stream(zf, ZIP_ROOT + rel, source)
            if row["bytes"] != size or row["sha256"] != digest:
                raise RuntimeError("R75_OVERLAY_CHANGED_DURING_PACK:" + rel)
            final_rows.append(row)
        zf.comment = b"TradeLoom portable R75 program-only release"

    if len(base_rows) != BASE_FILES or sum(row["bytes"] for row in base_rows) != BASE_BYTES:
        raise RuntimeError("P2_BASE_SIZE_MISMATCH")
    if len(final_rows) != BASE_FILES or sum(row["bytes"] for row in final_rows) != BASE_BYTES + 3634:
        raise RuntimeError("FINAL_PROGRAM_SIZE_MISMATCH")

    expected_final = {row["path"]: row for row in final_rows}
    if len(expected_final) != BASE_FILES:
        raise RuntimeError("FINAL_MEMBER_DUPLICATE")
    print(json.dumps({"phase": "zip-readback-start", "files": len(expected_final)}, separators=(",", ":")), flush=True)
    with zipfile.ZipFile(part_path, mode="r") as zf:
        infos = zf.infolist()
        if len(infos) != BASE_FILES or len({info.filename for info in infos}) != BASE_FILES:
            raise RuntimeError("ZIP_MEMBER_COUNT_OR_DUPLICATE")
        seen = set()
        for info in infos:
            if info.is_dir() or not info.filename.startswith(ZIP_ROOT):
                raise RuntimeError("ZIP_MEMBER_ROOT_OR_DIRECTORY_INVALID")
            rel = info.filename[len(ZIP_ROOT):]
            if not rel or rel.startswith("/") or "\\" in rel or any(part in ("", ".", "..") for part in rel.split("/")):
                raise RuntimeError("ZIP_MEMBER_PATH_INVALID")
            expected = expected_final.get(rel)
            if expected is None:
                raise RuntimeError("UNEXPECTED_ZIP_MEMBER")
            digest = hashlib.sha256()
            count = 0
            with zf.open(info, "r") as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    count += len(chunk)
            if count != expected["bytes"] or digest.hexdigest() != expected["sha256"]:
                raise RuntimeError("ZIP_READBACK_HASH_MISMATCH:" + rel)
            seen.add(rel)
    if seen != set(expected_final):
        raise RuntimeError("ZIP_READBACK_SET_MISMATCH")

    rows_path = os.path.join(output_root, ROWS_NAME)
    with open(rows_path, "x", encoding="utf-8", newline="\n") as stream:
        json.dump({"baseRows": base_rows, "finalRows": final_rows}, stream, ensure_ascii=False, separators=(",", ":"))
        stream.write("\n")
    print(json.dumps({"phase": "zip-readback-complete", "files": len(seen), "bytes": sum(row["bytes"] for row in final_rows)}, separators=(",", ":")), flush=True)

if __name__ == "__main__":
    main()
