import argparse
import copy
import hashlib
import json
import os
import re
import stat
import struct
import sys
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

BASE_ZIP_BYTES = 797266789
BASE_ZIP_SHA256 = "868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341"
BASE_ASAR_BYTES = 172823311
BASE_ASAR_SHA256 = "e86597aa3fe799c7f69c8b80a2c4cd3a0b45dce1e76749322cd2024bbf2c0c8d"
BASE_ASAR_ENTRY = "TradeLoom-r76/app/resources/app.asar"
DEPLOYMENT_ENTRY = "TradeLoom-r76/app/resources/tradeloom/deployment.json"
BUSINESS_PREFIX = "app/resources/tradeloom/business-shell/"
SDK_BASES = {
    "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js": (21078, "8341045a11cabac8b653f5b8f92f59ab596510079fecd2352a39ba03a1b00ac7"),
    "dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js": (44434, "0ebcca7583e082716f79b0b55bc1749d48269cc8db2989b043b321b57abd3684"),
    "dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js": (28257, "7b59cf82c2784c25bdce4e3e24e5e5303b02b9f1003efacf50255492d17baf8b"),
    "dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js": (74599, "cf57e3ecd487ac5c2553455aaa5cef2c6fb41e6bd61be5aa455675d1d7193033"),
    "dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js": (162201, "1e53932e7c4213ea24a7d87f06960b7a7702cb21f8a5741c97242b4a470a442a"),
    "dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-D4iGkJJO.js": (1742658, "5768cc3f3f26c795a73efb6fe68195feb1928a63e25266f52c6ebacd40fa5e5b"),
}
SDK_POSTS = {
    "dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js": (22911, "e65f27015abbfbb0f01c9252bb0a8f259082e94d9d7442f2a7c8e908cfac8cc9"),
    "dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js": (48241, "f04acccc1608e1395be044b8fc00a256735eabae8d33af9fb3c4214b6da46a85"),
    "dsh/node_modules/@deepseek-ai/dsh-agent/lib/index.js": (28880, "19a3992a1c26045af0e02147dd2683d7be81e46ef1aebd1e2693a0cd374bd99e"),
    "dsh/node_modules/@deepseek-ai/dsh-agent-loop/lib/index.js": (84141, "7718bc220318c307ffd84fa3762ad03e6b730cde0c4b8242b9fac001c596a64f"),
    "dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js": (163035, "6acd8bba3f69b434c5a13f80ac06d076b3c1911b77efe958d507d463ce2c51cc"),
    "dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/index-D4iGkJJO.js": (1742862, "a57a794762829c4a34a038d0252efd31e6f5898fd449af34f691ff18b22aa49b"),
}
NEW_SDK_ENTRY = "dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/native-operation-origin-adapter.mjs"
MAX_HEADER = 32 * 1024 * 1024


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def safe_relative(value):
    path = PurePosixPath(value)
    if not value or path.is_absolute() or "\\" in value or any(part in ("", ".", "..") for part in path.parts):
        raise ValueError("unsafe archive path: " + str(value))
    return path.as_posix()


def validate_source_manifest(doc, repo_root, patch_path):
    if doc.get("schema") != "n01-origin-source-manifest-v1":
        raise ValueError("source manifest schema mismatch")
    source_repo = doc.get("sourceRepository", {})
    if (source_repo.get("head") != "f0033ee9a377ef8e7b279d351a1353d39fc9ec2c"
            or source_repo.get("tree") != "da9cc243ff43726876d67dc30aee26274a37c051"
            or source_repo.get("remote") != "https://github.com/Puipipi/tradeloom.git"
            or source_repo.get("private") is not True
            or source_repo.get("branch") != "integration/n01-production-origin-on-f0033-20261108"):
        raise ValueError("source repository identity is not the authorized N01 base")
    rows = doc.get("sourceFiles")
    if not isinstance(rows, list) or not rows:
        raise ValueError("source mapping is empty")
    counts = {kind: sum(1 for row in rows if row.get("archiveKind") == kind) for kind in ("backend", "asar", "businessShell", "programResource", "sourceOnly")}
    if counts != {"backend": 162, "asar": 99, "businessShell": 65, "programResource": 3, "sourceOnly": 2} or len(rows) != 331:
        raise ValueError("complete N01 application source mapping membership mismatch")
    seen_source, seen_target = set(), set()
    for row in rows:
        source = safe_relative(row.get("sourcePath", ""))
        target = safe_relative(row.get("archivePath", ""))
        kind = row.get("archiveKind")
        if source in seen_source or (kind, target) in seen_target or kind not in ("asar", "businessShell", "backend", "programResource", "sourceOnly"):
            raise ValueError("duplicate source or invalid archive mapping")
        seen_source.add(source)
        seen_target.add((kind, target))
        raw = (repo_root / Path(*PurePosixPath(source).parts)).read_bytes()
        if len(raw) != row.get("bytes") or sha256(raw) != row.get("sha256"):
            raise ValueError("source drift: " + source)
    delta = doc.get("sdkDelta")
    if not isinstance(delta, list) or len(delta) != 7:
        raise ValueError("SDK delta must contain exactly six pinned edits and one approved addition")
    seen_sdk = set()
    for row in delta:
        path = safe_relative(row.get("path", ""))
        if path in seen_sdk:
            raise ValueError("duplicate SDK path")
        seen_sdk.add(path)
        if path == NEW_SDK_ENTRY:
            if row.get("baseAbsent") is not True:
                raise ValueError("new adapter preimage must be absent")
            if tuple(row.get("post", ())) != tuple(doc.get("sdkPatch", {}).get("postPins", {}).get(path, ())):
                raise ValueError("new adapter post pin mismatch")
        else:
            if path not in SDK_BASES or tuple(row.get("base", ())) != SDK_BASES[path] or tuple(row.get("post", ())) != SDK_POSTS[path]:
                raise ValueError("SDK pre/post pin mismatch: " + path)
    if seen_sdk != set(SDK_BASES) | {NEW_SDK_ENTRY}:
        raise ValueError("SDK delta contains missing or unlisted paths")
    patch_raw = Path(patch_path).read_bytes()
    if sha256(patch_raw) != doc.get("sdkPatch", {}).get("sha256") or len(patch_raw) != doc.get("sdkPatch", {}).get("bytes"):
        raise ValueError("SDK patch file identity mismatch")
    expected_post_pins = {path: list(SDK_POSTS[path]) for path in SDK_POSTS}
    new_post = doc.get("sdkPatch", {}).get("postPins", {}).get(NEW_SDK_ENTRY)
    if not isinstance(new_post, list) or len(new_post) != 2 or not isinstance(new_post[0], int) or not re.fullmatch(r"[0-9a-f]{64}", str(new_post[1])):
        raise ValueError("new adapter postimage pin is malformed")
    expected_post_pins[NEW_SDK_ENTRY] = new_post
    if doc.get("sdkPatch", {}).get("postPins") != expected_post_pins:
        raise ValueError("SDK postimage pin map mismatch")
    adapter = doc.get("sdkPatch", {}).get("adapterSource", {})
    if adapter.get("archivePath") != NEW_SDK_ENTRY:
        raise ValueError("new adapter source mapping path mismatch")
    adapter_raw = (repo_root / Path(*PurePosixPath(safe_relative(adapter.get("sourcePath", ""))).parts)).read_bytes()
    if len(adapter_raw) != adapter.get("bytes") or sha256(adapter_raw) != adapter.get("sha256") or [len(adapter_raw), sha256(adapter_raw)] != new_post:
        raise ValueError("new adapter source or postimage drift")
    return {"sourceFiles": len(rows), "sdkEntries": len(seen_sdk), "patchSha256": sha256(patch_raw)}


def parse_patch(patch_bytes):
    text = patch_bytes.decode("utf-8")
    sections = []
    current = None
    for line in text.splitlines(keepends=True):
        if line.startswith("diff --git a/"):
            if current is not None:
                sections.append(current)
            match = re.match(r"diff --git a/(.+) b/(.+)\n?$", line.rstrip("\n"))
            if not match or match.group(1) != match.group(2):
                raise ValueError("invalid patch path header")
            current = {"path": match.group(1), "lines": []}
        elif current is not None:
            current["lines"].append(line)
    if current is not None:
        sections.append(current)
    if not sections:
        raise ValueError("SDK patch is empty")
    return sections


def apply_section(original, section):
    lines = original.decode("utf-8").splitlines(keepends=True)
    hunk_re = re.compile(r"@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
    out, cursor = [], 0
    new_file = any(line.startswith("new file mode ") for line in section["lines"])
    for line in section["lines"]:
        if not line.startswith("@@ "):
            continue
        match = hunk_re.match(line)
        if not match:
            raise ValueError("malformed unified diff hunk")
        old_start = int(match.group(1))
        index = max(0, old_start - 1)
        out.extend(lines[cursor:index])
        cursor = index
        pos = section["lines"].index(line) + 1
        # Find this hunk's line span in the original section.
        hunk_lines = []
        for candidate in section["lines"][pos:]:
            if candidate.startswith("@@ ") or candidate.startswith("diff --git "):
                break
            if candidate.startswith("--- ") or candidate.startswith("+++ "):
                continue
            if candidate.startswith("\\ No newline at end of file"):
                continue
            hunk_lines.append(candidate)
        for candidate in hunk_lines:
            marker, value = candidate[:1], candidate[1:]
            if marker in (" ", "-"):
                if cursor >= len(lines) or lines[cursor] != value:
                    raise ValueError("patch context mismatch: " + section["path"])
                if marker == " ":
                    out.append(value)
                cursor += 1
            elif marker == "+":
                out.append(value)
            else:
                raise ValueError("unsupported unified patch line")
    out.extend(lines[cursor:])
    return "".join(out).encode("utf-8")


def parse_asar(asar):
    if len(asar) < 16 or struct.unpack_from("<I", asar, 0)[0] != 4:
        raise ValueError("invalid ASAR header prefix")
    json_size = struct.unpack_from("<I", asar, 12)[0]
    padding = (-json_size) % 4
    pickle_size = struct.unpack_from("<I", asar, 4)[0]
    pickle_payload_size = struct.unpack_from("<I", asar, 8)[0]
    if (pickle_size != json_size + 8 + padding or pickle_payload_size != json_size + 4 + padding):
        raise ValueError("ASAR pickle header alignment mismatch")
    if json_size > MAX_HEADER or 16 + json_size + padding > len(asar):
        raise ValueError("ASAR header size outside bound")
    data_offset = 8 + pickle_size
    if data_offset != 16 + json_size + padding or asar[16 + json_size:data_offset] != b"\0" * padding:
        raise ValueError("ASAR data offset mismatch")
    header = json.loads(asar[16:16 + json_size].decode("utf-8"))
    return header, data_offset


def encode_asar(header, payload):
    header_json = json.dumps(header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    padding = (-len(header_json)) % 4
    prefix = struct.pack("<IIII", 4, len(header_json) + 8 + padding, len(header_json) + 4 + padding, len(header_json))
    return prefix + header_json + b"\0" * padding + payload


def walk_asar_files(header):
    rows = []
    def walk(node, prefix=""):
        for name, child in node.get("files", {}).items():
            path = f"{prefix}/{name}" if prefix else name
            if "files" in child:
                walk(child, path)
            elif "link" not in child:
                rows.append((path, child))
    walk(header)
    return rows


def set_asar_file(header, path, data, offset=None):
    parts = safe_relative(path).split("/")
    node = header
    for part in parts[:-1]:
        node = node.setdefault("files", {}).setdefault(part, {"files": {}})
        if "files" not in node or "link" in node:
            raise ValueError("ASAR path collides with a file or link: " + path)
    files = node.setdefault("files", {})
    entry = files.setdefault(parts[-1], {})
    entry.pop("unpacked", None)
    entry["size"] = len(data)
    if offset is not None:
        entry["offset"] = str(offset)
    entry["integrity"] = integrity_record(data)


def integrity_record(data):
    block_size = 4 * 1024 * 1024
    blocks = [sha256(data[index:index + block_size]) for index in range(0, len(data), block_size)]
    return {"algorithm": "SHA256", "hash": sha256(data), "blockSize": block_size, "blocks": blocks}


def rebuild_asar(asar, replacement_data, delta):
    header, data_offset = parse_asar(asar)
    files = walk_asar_files(header)
    by_path = {path: entry for path, entry in files}
    if len(by_path) != len(files):
        raise ValueError("ASAR contains duplicate file paths")
    originals = {}
    for path, entry in files:
        if entry.get("unpacked") is True:
            continue
        try:
            offset, size = int(entry["offset"]), int(entry["size"])
        except (KeyError, TypeError, ValueError):
            raise ValueError("invalid ASAR file extent: " + path)
        start, end = data_offset + offset, data_offset + offset + size
        if offset < 0 or size < 0 or end > len(asar):
            raise ValueError("ASAR file extent outside data: " + path)
        originals[path] = asar[start:end]
    for path, content in replacement_data.items():
        if path not in by_path:
            raise ValueError("source map targets absent ASAR entry: " + path)
        originals[path] = content
    patch_sections = parse_patch(delta["patchBytes"])
    if {item["path"] for item in patch_sections} != set(SDK_BASES) | {NEW_SDK_ENTRY}:
        raise ValueError("patch contains a seventh edit or omits a pinned SDK entry")
    for section in patch_sections:
        path = section["path"]
        if path == NEW_SDK_ENTRY:
            if path in by_path:
                raise ValueError("approved new SDK adapter already exists")
            post = apply_section(b"", section)
            expected_size, expected_sha = delta["postPins"][path]
            if len(post) != expected_size or sha256(post) != expected_sha:
                raise ValueError("new SDK adapter postimage mismatch")
            originals[path] = post
            continue
        old = originals.get(path)
        expected_size, expected_sha = SDK_BASES[path]
        if old is None or len(old) != expected_size or sha256(old) != expected_sha:
            raise ValueError("ASAR SDK preimage mismatch: " + path)
        post = apply_section(old, section)
        post_size, post_sha = SDK_POSTS[path]
        if len(post) != post_size or sha256(post) != post_sha:
            raise ValueError("ASAR SDK postimage mismatch: " + path)
        originals[path] = post

    old_positions = {path: int(entry.get("offset", 0)) for path, entry in files if path in originals and not entry.get("unpacked")}
    ordered = sorted(originals, key=lambda path: (0, old_positions[path], path) if path in old_positions else (1, 0, path))
    data_parts = []
    offset = 0
    for path in ordered:
        content = originals[path]
        set_asar_file(header, path, content, offset)
        data_parts.append(content)
        offset += len(content)
    # Unpacked files remain in the header and sidecar unchanged.
    return encode_asar(header, b"".join(data_parts)), originals


def stream_hash(file_path):
    digest, count = hashlib.sha256(), 0
    with open(file_path, "rb", buffering=0) as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk:
                break
            count += len(chunk)
            digest.update(chunk)
    return count, digest.hexdigest()


def canonical_tree(rows):
    ordered = sorted(rows, key=lambda row: row["path"].lower())
    raw = "".join(f"{row['path']}\0{row['bytes']}\0{row['sha256'].lower()}\n" for row in ordered).encode("utf-8")
    return sha256(raw)


def final_inventory_rows(base_rows, replacements, prefix):
    base_by_path = {safe_relative(row["path"][len(prefix):]): row for row in base_rows if row["path"].startswith(prefix)}
    if len(base_by_path) != sum(1 for row in base_rows if row["path"].startswith(prefix)):
        raise ValueError("duplicate base entries in deployment inventory: " + prefix)
    result = {}
    for rel, row in base_by_path.items():
        member = prefix + rel
        raw = replacements.get(member)
        result[rel] = {"path": rel, "bytes": len(raw) if raw is not None else row["bytes"],
                       "sha256": sha256(raw) if raw is not None else row["sha256"]}
    for member, raw in replacements.items():
        if member.startswith(prefix):
            rel = safe_relative(member[len(prefix):])
            result[rel] = {"path": rel, "bytes": len(raw), "sha256": sha256(raw)}
    return list(result.values())


def update_deployment_inventories(deployment, shell_rows, backend_rows):
    shell_info = deployment["resources"]["businessShell"]
    shell_info.update({"fileCount": len(shell_rows), "bytes": sum(row["bytes"] for row in shell_rows), "sha256": canonical_tree(shell_rows)})
    backend_info = deployment["resources"]["business"]
    backend_info.update({"fileCount": len(backend_rows), "bytes": sum(row["bytes"] for row in backend_rows), "sha256": canonical_tree(backend_rows)})


def write_zip_members(base_zip, output_zip, expected_by_path, replacements, additions):
    if Path(output_zip).exists():
        raise ValueError("candidate ZIP part already exists")
    final_rows = []
    with zipfile.ZipFile(base_zip, "r") as base, zipfile.ZipFile(output_zip, "x", allowZip64=True) as target:
        infos = base.infolist()
        if len(infos) != len(expected_by_path) or len({info.filename for info in infos}) != len(infos):
            raise ValueError("candidate base ZIP inventory count or uniqueness mismatch")
        for info in infos:
            if info.is_dir() or not info.filename.startswith("TradeLoom-r76/"):
                raise ValueError("candidate base ZIP member root or directory mismatch")
            rel = safe_relative(info.filename[len("TradeLoom-r76/"):])
            expected = expected_by_path.get(rel)
            if expected is None:
                raise ValueError("candidate base ZIP member absent from inventory: " + rel)
            new_info = copy.copy(info)
            replacement = replacements.get(rel)
            if replacement is not None:
                new_info.file_size = len(replacement)
            digest, count = hashlib.sha256(), 0
            with target.open(new_info, "w", force_zip64=True) as dest:
                if replacement is not None:
                    chunks = (memoryview(replacement)[start:start + 1024 * 1024] for start in range(0, len(replacement), 1024 * 1024))
                    for chunk in chunks:
                        dest.write(chunk)
                        digest.update(chunk)
                        count += len(chunk)
                else:
                    with base.open(info, "r") as source:
                        while True:
                            chunk = source.read(1024 * 1024)
                            if not chunk:
                                break
                            dest.write(chunk)
                            digest.update(chunk)
                            count += len(chunk)
            final_rows.append({"path": rel, "bytes": count, "sha256": digest.hexdigest()})
        if {row["path"] for row in final_rows} != set(expected_by_path):
            raise ValueError("candidate base ZIP entry set differs from inventory")
        for rel in sorted(additions):
            if rel in expected_by_path or rel not in replacements:
                raise ValueError("candidate addition is not a new declared replacement: " + rel)
            raw = replacements[rel]
            new_info = zipfile.ZipInfo("TradeLoom-r76/" + rel, date_time=(2026, 11, 8, 0, 0, 0))
            new_info.compress_type = zipfile.ZIP_DEFLATED
            new_info.create_system = 3
            new_info.external_attr = (stat.S_IFREG | 0o644) << 16
            with target.open(new_info, "w", force_zip64=True) as stream:
                stream.write(raw)
            final_rows.append({"path": rel, "bytes": len(raw), "sha256": sha256(raw)})
    with zipfile.ZipFile(output_zip, "r") as result:
        infos = result.infolist()
        if len(infos) != len(expected_by_path) + len(additions) or len({info.filename for info in infos}) != len(infos):
            raise ValueError("candidate ZIP readback entry count mismatch")
        for row in final_rows:
            with result.open("TradeLoom-r76/" + row["path"], "r") as stream:
                digest, count = hashlib.sha256(), 0
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    count += len(chunk)
            if count != row["bytes"] or digest.hexdigest() != row["sha256"]:
                raise ValueError("candidate ZIP readback mismatch: " + row["path"])
    base_by_path = {row["path"]: row for row in expected_by_path.values()}
    for row in final_rows:
        if row["path"] not in replacements and row != base_by_path[row["path"]]:
            raise ValueError("unlisted R76 ZIP entry changed: " + row["path"])
    return final_rows


def fixture_archive_contract(output_dir):
    output = Path(output_dir).resolve()
    if output.exists() or output.is_symlink():
        raise ValueError("fixture output already exists")
    output.mkdir(parents=True, exist_ok=False)
    base_zip = output / "fixture-base.zip"
    base_members = {
        "app/resources/tradeloom/business-shell/kept.js": b"old",
        "app/resources/tradeloom/backend/kept.py": b"base",
        "app/resources/untouched.bin": b"leave-this-base-member",
        "app/resources/app.asar": b"fixture-base-asar",
    }
    base_rows = [{"path": path, "bytes": len(raw), "sha256": sha256(raw)} for path, raw in base_members.items()]
    expected_by_path = {row["path"]: row for row in base_rows}
    shell_rows = final_inventory_rows(base_rows, {"app/resources/tradeloom/business-shell/added.mjs": b"new-shell"}, BUSINESS_PREFIX)
    backend_prefix = "app/resources/tradeloom/backend/"
    backend_replacements = {backend_prefix + "added.py": b"new-backend"}
    backend_rows = final_inventory_rows(base_rows, backend_replacements, backend_prefix)
    deployment = {"resources": {"businessShell": {}, "business": {}}}
    update_deployment_inventories(deployment, shell_rows, backend_rows)
    replacements = {
        "app/resources/tradeloom/business-shell/added.mjs": b"new-shell",
        **backend_replacements,
        "app/resources/tradeloom/deployment.json": (json.dumps(deployment, separators=(",", ":")) + "\n").encode("utf-8"),
        "app/resources/app.asar": b"fixture-post-asar",
    }
    additions = set(replacements) - set(expected_by_path)
    with zipfile.ZipFile(base_zip, "x", allowZip64=True) as base:
        for path, raw in base_members.items():
            base.writestr("TradeLoom-r76/" + path, raw)
    result_zip = output / "fixture-candidate.zip"
    final_rows = write_zip_members(base_zip, result_zip, expected_by_path, replacements, additions)
    with zipfile.ZipFile(result_zip, "r") as built:
        readback_deployment = json.loads(built.read("TradeLoom-r76/app/resources/tradeloom/deployment.json").decode("utf-8"))
        if built.read("TradeLoom-r76/app/resources/untouched.bin") != base_members["app/resources/untouched.bin"]:
            raise ValueError("fixture unlisted member did not remain byte-identical")
    update_deployment_inventories_check = {
        "businessShell": {"fileCount": len(shell_rows), "bytes": sum(row["bytes"] for row in shell_rows), "sha256": canonical_tree(shell_rows)},
        "business": {"fileCount": len(backend_rows), "bytes": sum(row["bytes"] for row in backend_rows), "sha256": canonical_tree(backend_rows)},
    }
    for name, expected in update_deployment_inventories_check.items():
        if readback_deployment["resources"][name] != expected:
            raise ValueError("fixture deployment output readback mismatch: " + name)
    return {"status": "fixture-archive-readback-valid", "entryCount": len(final_rows), "changedEntries": sorted(replacements),
            "zipBytes": result_zip.stat().st_size, "zipSha256": stream_hash(result_zip)[1],
            "shell": readback_deployment["resources"]["businessShell"], "backend": readback_deployment["resources"]["business"]}


def fixture_asar_contract(output_dir, source_root, patch_path):
    output = Path(output_dir).resolve()
    if output.exists() or output.is_symlink():
        raise ValueError("fixture output already exists")
    output.mkdir(parents=True, exist_ok=False)
    source_root_value = str(Path(source_root).resolve())
    if os.name == "nt" and not source_root_value.startswith("\\\\?\\"):
        source_root_value = "\\\\?\\" + source_root_value
    source_root = Path(source_root_value)
    patch_raw = Path(patch_path).read_bytes()
    adapter_post = (6153, "38c7d2f9f37621b8e9896db697d444e0113d827d159b2c7b01eaca7fc7ebdc7d")
    post_pins = {path: list(pin) for path, pin in SDK_POSTS.items()}
    post_pins[NEW_SDK_ENTRY] = list(adapter_post)
    delta = {"patchBytes": patch_raw, "postPins": post_pins}
    entries = {}
    for path, (expected_bytes, expected_hash) in SDK_BASES.items():
        relative = path.removeprefix("dsh/node_modules/@deepseek-ai/")
        raw = (source_root / Path(*PurePosixPath(relative).parts)).read_bytes()
        if len(raw) != expected_bytes or sha256(raw) != expected_hash:
            raise ValueError("fixture SDK base source pin mismatch: " + path)
        entries[path] = raw
    entries["fixture/unlisted.js"] = b"preserve-base-entry"

    def pack_asar(payload_entries):
        header = {"files": {}}
        payload = []
        offset = 0
        for path, raw in payload_entries.items():
            set_asar_file(header, path, raw, offset)
            payload.append(raw)
            offset += len(raw)
        return encode_asar(header, b"".join(payload))

    base_asar = pack_asar(entries)
    built_asar, built_entries = rebuild_asar(base_asar, {}, delta)
    target = output / "fixture-candidate.asar"
    target.write_bytes(built_asar)
    readback = target.read_bytes()
    header, data_offset = parse_asar(readback)
    readback_rows = walk_asar_files(header)
    readback_by_path = {path: entry for path, entry in readback_rows}
    expected_paths = set(SDK_POSTS) | {NEW_SDK_ENTRY, "fixture/unlisted.js"}
    if set(readback_by_path) != expected_paths:
        raise ValueError("fixture ASAR readback entry set mismatch")
    for path in expected_paths:
        entry = readback_by_path[path]
        raw = readback[data_offset + int(entry["offset"]):data_offset + int(entry["offset"]) + int(entry["size"])]
        if path in SDK_POSTS:
            expected = SDK_POSTS[path]
        elif path == NEW_SDK_ENTRY:
            expected = adapter_post
        else:
            expected = (len(entries[path]), sha256(entries[path]))
        if (len(raw), sha256(raw)) != expected:
            raise ValueError("fixture ASAR readback bytes/hash mismatch: " + path)
    if built_entries["fixture/unlisted.js"] != entries["fixture/unlisted.js"]:
        raise ValueError("fixture ASAR changed an unlisted entry")
    negative_results = {}
    wrong_path = next(iter(SDK_BASES))
    for label in ("missing", "wrongPrefix", "wrongPreimage", "newEntryAlreadyExists"):
        bad_entries = dict(entries)
        if label == "missing":
            bad_entries.pop(wrong_path)
        elif label == "wrongPrefix":
            bad_entries["wrong/" + wrong_path] = bad_entries.pop(wrong_path)
        elif label == "wrongPreimage":
            bad_entries[wrong_path] = bad_entries[wrong_path] + b"x"
        else:
            bad_entries[NEW_SDK_ENTRY] = b"unexpected existing adapter"
        try:
            rebuild_asar(pack_asar(bad_entries), {}, delta)
        except ValueError as error:
            expected_error = "approved new SDK adapter already exists" if label == "newEntryAlreadyExists" else "ASAR SDK preimage mismatch"
            if expected_error not in str(error):
                raise
            negative_results[label] = str(error)
        else:
            raise ValueError("fixture ASAR accepted a missing or wrong-prefix SDK entry: " + label)
    alignment_residues = []
    fixed_three_padding_rejected = 0
    r76_json_bytes = 4771689
    r76_padding = (-r76_json_bytes) % 4
    r76_prefix = [4, r76_json_bytes + 8 + r76_padding, r76_json_bytes + 4 + r76_padding, r76_json_bytes]
    if r76_prefix != [4, 4771700, 4771696, 4771689]:
        raise ValueError("fixed R76 ASAR header tuple no longer matches aligned pickle rule")
    for residue in range(4):
        aligned_header = {"files": {}}
        chosen = None
        for length in range(1, 30):
            aligned_header = {"files": {}}
            set_asar_file(aligned_header, "fixture/" + ("x" * length), b"", 0)
            encoded_header = json.dumps(aligned_header, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
            if len(encoded_header) % 4 == residue:
                chosen = encoded_header
                break
        if chosen is None:
            raise ValueError("cannot construct ASAR header alignment fixture")
        encoded = encode_asar(aligned_header, b"")
        parsed, offset = parse_asar(encoded)
        pad = (-len(chosen)) % 4
        if offset != 16 + len(chosen) + pad or struct.unpack_from("<I", encoded, 4)[0] != len(chosen) + 8 + pad:
            raise ValueError("ASAR fixture pickle alignment did not match independent integer rule")
        alignment_residues.append(residue)
        if residue != 1:
            malformed = struct.pack("<IIII", 4, len(chosen) + 11, len(chosen) + 7, len(chosen)) + chosen + b"\0\0\0"
            try:
                parse_asar(malformed)
            except ValueError as error:
                if "alignment mismatch" not in str(error):
                    raise
                fixed_three_padding_rejected += 1
            else:
                raise ValueError("ASAR parser accepted fixed-three padding for an incompatible JSON remainder")
    return {"status": "fixture-asar-patch-readback-valid", "entryCount": len(readback_rows), "bytes": len(readback),
            "sha256": sha256(readback), "sdkPostPins": len(SDK_POSTS), "newAdapterPin": list(adapter_post),
            "negativeResults": negative_results, "alignmentResidues": alignment_residues,
            "fixedThreePaddingRejected": fixed_three_padding_rejected, "r76HeaderPrefix": r76_prefix}


def fixture_inventory_contract():
    base_rows = [
        {"path": "app/resources/tradeloom/business-shell/kept.js", "bytes": 3, "sha256": sha256(b"old")},
        {"path": "app/resources/tradeloom/backend/kept.py", "bytes": 4, "sha256": sha256(b"base")},
    ]
    replacements = {
        "app/resources/tradeloom/business-shell/added.mjs": b"new-shell",
        "app/resources/tradeloom/backend/added.py": b"new-backend",
    }
    shell_rows = final_inventory_rows(base_rows, replacements, BUSINESS_PREFIX)
    backend_rows = final_inventory_rows(base_rows, replacements, "app/resources/tradeloom/backend/")
    deployment = {"resources": {"businessShell": {}, "business": {}}}
    update_deployment_inventories(deployment, shell_rows, backend_rows)
    readback = json.loads(json.dumps(deployment))
    for name, rows in (("businessShell", shell_rows), ("business", backend_rows)):
        info = readback["resources"][name]
        if info["fileCount"] != len(rows) or info["bytes"] != sum(row["bytes"] for row in rows) or info["sha256"] != canonical_tree(rows):
            raise ValueError("fixture deployment inventory readback mismatch: " + name)
    if {row["path"] for row in shell_rows} != {"kept.js", "added.mjs"} or {row["path"] for row in backend_rows} != {"kept.py", "added.py"}:
        raise ValueError("fixture final inventory omitted preserved or added entries")
    return {"shell": readback["resources"]["businessShell"], "backend": readback["resources"]["business"]}


def write_candidate(doc, repo_root, patch_path, base_zip, entry_manifest, output_dir):
    output = Path(output_dir).resolve()
    if output.exists() or output.is_symlink():
        raise ValueError("candidate output already exists")
    output.mkdir(parents=True, exist_ok=False)
    base_bytes, base_sha = stream_hash(base_zip)
    if base_bytes != BASE_ZIP_BYTES or base_sha != BASE_ZIP_SHA256:
        raise ValueError("fixed R76 ZIP identity mismatch")
    expected = json.loads(Path(entry_manifest).read_text(encoding="utf-8"))
    expected_rows = expected.get("files")
    if not isinstance(expected_rows, list) or len(expected_rows) != 39739:
        raise ValueError("fixed R76 ZIP inventory manifest invalid")
    expected_by_path = {safe_relative(row["path"]): row for row in expected_rows}
    if len(expected_by_path) != len(expected_rows):
        raise ValueError("fixed R76 ZIP inventory has duplicate paths")

    source_rows = doc["sourceFiles"]
    asar_sources, business_sources, source_additions = {}, {}, set()
    source_file_records = []
    for row in source_rows:
        source_path = safe_relative(row["sourcePath"])
        raw = (repo_root / Path(*PurePosixPath(source_path).parts)).read_bytes()
        record = {"path": source_path, "bytes": len(raw), "sha256": sha256(raw)}
        source_file_records.append(record)
        if row["archiveKind"] == "asar":
            asar_sources[safe_relative(row["archivePath"])] = raw
        elif row["archiveKind"] == "businessShell":
            member = BUSINESS_PREFIX + safe_relative(row["archivePath"])
            business_sources[member] = raw
            if row.get("baseAbsent") is True:
                source_additions.add(member)
        elif row["archiveKind"] in ("backend", "programResource"):
            prefix = "app/resources/tradeloom/backend/" if row["archiveKind"] == "backend" else "app/resources/tradeloom/plugin-seed/"
            member = prefix + safe_relative(row["archivePath"])
            business_sources[member] = raw
            if row["archiveKind"] == "backend" and row.get("baseAbsent") is True:
                source_additions.add(member)
    patch_raw = Path(patch_path).read_bytes()
    delta = {"patchBytes": patch_raw, "postPins": doc["sdkPatch"]["postPins"]}

    base_rows = []
    special_content = {}
    with zipfile.ZipFile(base_zip, "r") as base:
        infos = base.infolist()
        names = [info.filename for info in infos]
        if len(infos) != 39739 or len(set(names)) != len(infos):
            raise ValueError("fixed R76 ZIP member count or duplicate mismatch")
        for info in infos:
            if info.is_dir() or not info.filename.startswith("TradeLoom-r76/"):
                raise ValueError("fixed R76 ZIP contains an unexpected member root or directory")
            rel = safe_relative(info.filename[len("TradeLoom-r76/"):])
            expected_row = expected_by_path.get(rel)
            if expected_row is None:
                raise ValueError("R76 entry is absent from fixed inventory: " + rel)
            digest, count = hashlib.sha256(), 0
            chunks = [] if rel in ("app/resources/app.asar", "app/resources/tradeloom/deployment.json") else None
            with base.open(info, "r") as stream:
                while True:
                    chunk = stream.read(1024 * 1024)
                    if not chunk:
                        break
                    digest.update(chunk)
                    count += len(chunk)
                    if chunks is not None:
                        chunks.append(chunk)
            item_hash = digest.hexdigest()
            if count != expected_row["bytes"] or item_hash != expected_row["sha256"]:
                raise ValueError("R76 entry inventory mismatch: " + rel)
            base_rows.append({"path": rel, "bytes": count, "sha256": item_hash})
            if chunks is not None:
                special_content[rel] = b"".join(chunks)
    if set(expected_by_path) != {row["path"] for row in base_rows}:
        raise ValueError("R76 ZIP entry set differs from fixed inventory")
    for row in source_rows:
        kind = row["archiveKind"]
        if kind == "sourceOnly":
            continue
        archive_path = safe_relative(row["archivePath"])
        if kind == "asar":
            continue
        prefix = "app/resources/tradeloom/backend/" if kind == "backend" else "app/resources/tradeloom/business-shell/" if kind == "businessShell" else "app/resources/tradeloom/plugin-seed/"
        exists = prefix + archive_path in expected_by_path
        if (row.get("baseAbsent") is True) == exists:
            raise ValueError("source-map base-presence claim mismatches R76 inventory: " + archive_path)
    if canonical_tree(base_rows) != "c7c5c0e3fdddce08e6cddbb251edc14088d67a92c740a40c3b13669c356651a8":
        raise ValueError("R76 ZIP canonical inventory tree mismatch")
    original_asar = special_content.get("app/resources/app.asar")
    if original_asar is None or len(original_asar) != BASE_ASAR_BYTES or sha256(original_asar) != BASE_ASAR_SHA256:
        raise ValueError("R76 app.asar identity mismatch")
    built_asar, asar_entries = rebuild_asar(original_asar, asar_sources, delta)
    deployment = json.loads(special_content["app/resources/tradeloom/deployment.json"].decode("utf-8"))
    shell_rows = final_inventory_rows(base_rows, business_sources, BUSINESS_PREFIX)
    deployment["sourceBuild"]["appMainSha256"] = next(row["sha256"] for row in source_file_records if row["path"] == "apps/tradeloom-launcher/accepted-runtime/lib/main.js")
    replacements = dict(business_sources)
    replacements["app/resources/app.asar"] = built_asar
    backend_prefix = "app/resources/tradeloom/backend/"
    backend_rows = final_inventory_rows(base_rows, replacements, backend_prefix)
    if not backend_rows:
        raise ValueError("fixed R76 backend resource inventory is missing")
    update_deployment_inventories(deployment, shell_rows, backend_rows)
    built_deployment = (json.dumps(deployment, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")

    replacements["app/resources/tradeloom/deployment.json"] = built_deployment
    allowed = set(replacements)
    additions = allowed - set(expected_by_path)
    declared_additions = {
        (BUSINESS_PREFIX if row.get("archiveKind") == "businessShell" else "app/resources/tradeloom/backend/") + row["archivePath"]
        for row in source_rows if row.get("archiveKind") in ("backend", "businessShell") and row.get("baseAbsent") is True
    }
    if additions != source_additions or not additions.issubset(declared_additions):
        raise ValueError("application additions must be explicitly declared in the source map")
    zip_part = output / "TradeLoom-r76.zip.part"
    final_rows = write_zip_members(base_zip, zip_part, expected_by_path, replacements, additions)
    final_zip = output / "TradeLoom-r76.zip"
    os.replace(zip_part, final_zip)
    (output / "source-manifest.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "entry-manifest.json").write_text(json.dumps({"base": base_rows, "final": final_rows}, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")
    receipt = {
        "kind": "n01-origin-isolated-candidate-receipt",
        "sourceRepository": doc["sourceRepository"],
        "sourceFiles": source_file_records,
        "sdkPatch": doc["sdkPatch"],
        "baseZip": {"bytes": base_bytes, "sha256": base_sha},
        "baseAsar": {"bytes": len(original_asar), "sha256": sha256(original_asar)},
        "postAsar": {"bytes": len(built_asar), "sha256": sha256(built_asar)},
        "outputZip": {"bytes": final_zip.stat().st_size, "sha256": stream_hash(final_zip)[1]},
        "zipEntries": len(final_rows),
        "changedEntries": sorted(allowed),
        "unlistedEntriesPreserved": True,
        "installedOrStarted": False,
    }
    (output / "receipt.json").write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"status": "candidate-built-isolated", "entries": len(final_rows), "changedEntries": len(allowed), "zip": str(final_zip)}


def build(args):
    manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8"))
    repo_root = Path(args.repo_root).resolve()
    summary = validate_source_manifest(manifest, repo_root, args.patch)
    if args.validate_only:
        print(json.dumps({"status": "source-and-patch-contract-valid", **summary}, separators=(",", ":")))
        return
    if not args.base_zip or not args.entry_manifest or not args.output_dir:
        raise ValueError("candidate build requires --base-zip, --entry-manifest, and --output-dir")
    result = write_candidate(manifest, repo_root, args.patch, args.base_zip, args.entry_manifest, args.output_dir)
    print(json.dumps(result, separators=(",", ":")))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fixture-inventory-test", action="store_true")
    parser.add_argument("--fixture-archive-test", action="store_true")
    parser.add_argument("--fixture-output")
    parser.add_argument("--fixture-asar-test", action="store_true")
    parser.add_argument("--fixture-source-root")
    parser.add_argument("--manifest")
    parser.add_argument("--repo-root")
    parser.add_argument("--patch")
    parser.add_argument("--base-zip")
    parser.add_argument("--entry-manifest")
    parser.add_argument("--output-dir")
    parser.add_argument("--validate-only", action="store_true")
    args = parser.parse_args()
    if args.fixture_inventory_test:
        print(json.dumps({"status": "fixture-inventory-contract-valid", **fixture_inventory_contract()}, separators=(",", ":")))
        return
    if args.fixture_archive_test:
        if not args.fixture_output:
            parser.error("--fixture-output is required for fixture archive mode")
        print(json.dumps(fixture_archive_contract(args.fixture_output), separators=(",", ":")))
        return
    if args.fixture_asar_test:
        if not args.fixture_output or not args.fixture_source_root or not args.patch:
            parser.error("--fixture-output, --fixture-source-root, and --patch are required for fixture ASAR mode")
        print(json.dumps(fixture_asar_contract(args.fixture_output, args.fixture_source_root, args.patch), separators=(",", ":")))
        return
    if not args.manifest or not args.repo_root or not args.patch:
        parser.error("--manifest, --repo-root, and --patch are required outside fixture mode")
    build(args)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"status": "failed", "error": type(error).__name__, "message": str(error)}, separators=(",", ":")), file=sys.stderr)
        raise SystemExit(1)
