import hashlib
import json
import os
import pathlib
import stat
import subprocess
import sys
import zipfile

REPO = pathlib.Path(__file__).resolve().parents[3]
BASE_ZIP = pathlib.Path(r"D:\Codex-ICT-builds\ui18-final-20261105-01a16e3f\portable-release-r76\TradeLoom-r76.zip")
ENTRY_MANIFEST = pathlib.Path(r"D:\Codex-ICT-builds\ui18-final-20261105-01a16e3f\portable-release-r76\program-entry-manifest.json")
SOURCE_MANIFEST = REPO / "candidate-source-manifest-o08.json"
INSTALLED_BOOTSTRAP = pathlib.Path(__file__).resolve().parents[1] / "installed-bootstrap.mjs"
BASE_PIN = (797266789, "868815b145f5447c284bf75b6d48eaa483a832389795019bd1429de6df2bc341")
ENTRY_PIN = (8491236, "8b87366fdd62c178e3cdadb3fd23954ffaf2aa2736b73b61ac9f8c6ec438a12b")
SOURCE_PIN = (67608, "567d725766cb2d264b88edda25a2355f6a421ccb9f189349c0b2bb1c8890b0ee")
SDK = {"app/resources/app.asar": "e86597aa3fe799c7f69c8b80a2c4cd3a0b45dce1e76749322cd2024bbf2c0c8d", "app/resources/runtime/primary-runtime/dependencies/node/bin/node.exe": "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32"}

def digest(data): return hashlib.sha256(data).hexdigest()
def file_pin(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or path.is_symlink() or getattr(info, "st_file_attributes", 0) & 0x400: raise RuntimeError("not an ordinary pinned input: " + path.name)
    h = hashlib.sha256(); total = 0
    with path.open("rb") as stream:
        while True:
            chunk = stream.read(1024 * 1024)
            if not chunk: break
            h.update(chunk); total += len(chunk)
    return total, h.hexdigest()
def tree(rows):
    ordered = sorted(rows, key=lambda x: x["path"])
    script = f"import {{ digestInventory }} from {json.dumps(INSTALLED_BOOTSTRAP.as_uri())}; let s=''; for await (const c of process.stdin) s+=c; console.log(digestInventory(JSON.parse(s)))"
    run = subprocess.run(["node", "--input-type=module", "-e", script], input=json.dumps(ordered), text=True, capture_output=True)
    if run.returncode != 0: raise RuntimeError("installed-bootstrap digestInventory failed: " + run.stderr.strip())
    return {"files": len(rows), "bytes": sum(x["bytes"] for x in rows), "sha256": run.stdout.strip()}
def checked_source(relative):
    p = pathlib.PurePosixPath(relative)
    if not relative or p.is_absolute() or ".." in p.parts or "\\" in relative or "." in p.parts or ":" in relative or "\0" in relative: raise RuntimeError("unsafe source path: " + relative)
    source = REPO.joinpath(*p.parts)
    cursor = REPO
    for segment in p.parts:
        cursor = cursor / segment
        if cursor.is_symlink() or getattr(cursor.lstat(), "st_file_attributes", 0) & 0x400 or (hasattr(cursor, "is_junction") and cursor.is_junction()): raise RuntimeError("reparse source path: " + relative)
    if not source.resolve().is_relative_to(REPO.resolve()): raise RuntimeError("source escaped repository: " + relative)
    if not source.is_file(): raise RuntimeError("missing source file: " + relative)
    return source
def validate_manifest(manifest):
    if manifest.get("sourceRepository", {}).get("head") != "4999f9e8bb079c7b69fb21982b89234963f7aa8e" or manifest.get("sourceRepository", {}).get("tree") != "85803f3774a51a6096b06a1d8f2f304d4d0dc38e": raise RuntimeError("source manifest identity mismatch")
    package = json.loads(checked_source("packages/tradeloom-shell/package.json").read_text(encoding="utf-8"))
    expected_shell = {"packages/tradeloom-shell/package.json", *("packages/tradeloom-shell/" + item for item in package.get("files", []))}
    actual_shell = {row.get("source") for row in manifest.get("businessShell", {}).get("files", [])}
    if actual_shell != expected_shell or len(actual_shell) != manifest.get("businessShell", {}).get("fileCount"): raise RuntimeError("business-shell inventory does not match package.files")
    required = {"workbench/canvas_workflow_definition_api.py", "workbench/workflow_definition_validator.py", "workbench/workflow_definition_validator.mjs", "workbench/migrations/0015_canvas_workflow_definition.py", "packages/tradeloom-shell/workflow-schema.js", "packages/tradeloom-shell/workflow-definition.js", "packages/tradeloom-shell/roles.js"}
    backend = {row.get("source") for row in manifest.get("backend", {}).get("files", [])}
    if not required.issubset(backend): raise RuntimeError("backend inventory omitted required O08/canonical source")
    for key in ("backend", "businessShell"):
        rows = manifest.get(key, {}).get("files", [])
        if len(rows) != manifest[key].get("fileCount"): raise RuntimeError("source inventory count mismatch: " + key)
        root = "resources/tradeloom/backend/" if key == "backend" else "resources/tradeloom/business-shell/"
        folded = set(); tree_rows=[]
        for row in rows:
            source=row.get("source"); target=row.get("target")
            pure=pathlib.PurePosixPath(source or "")
            if not source or pure.is_absolute() or ".." in pure.parts or "\\" in source: raise RuntimeError("unsafe source manifest path")
            expected_target=root + (source.removeprefix("packages/tradeloom-shell/") if key == "businessShell" else source)
            if target != expected_target or target.casefold() in folded: raise RuntimeError("source target mismatch/collision")
            folded.add(target.casefold()); tree_rows.append({"path":target.removeprefix(root),"bytes":row.get("bytes"),"sha256":row.get("sha256")})
        actual_tree=tree(tree_rows)
        pin=manifest[key].get("tree")
        if not pin or pin != actual_tree: raise RuntimeError("source inventory tree pin mismatch: " + key)
    for row in manifest.get("sourceRepository", {}).get("selectedWorktreePins", []):
        source=checked_source(row.get("path"))
        if file_pin(source) != (row.get("bytes"), row.get("sha256")): raise RuntimeError("selected worktree pin mismatch: " + row["path"])
def main():
    if len(sys.argv) != 2: raise SystemExit("expected output directory only")
    requested = pathlib.Path(sys.argv[1]).absolute()
    for parent in (requested, *requested.parents):
        if parent.exists() and (parent.is_symlink() or (hasattr(parent, "is_junction") and parent.is_junction()) or getattr(parent.lstat(), "st_file_attributes", 0) & 0x400): raise RuntimeError("reparse output ancestor")
    out = requested.resolve()
    if out.exists(): raise RuntimeError("output must not exist")
    forbidden = [pathlib.Path(r"D:\Codex-ICT-builds\ui18-final-20261105-01a16e3f\p2"), pathlib.Path(r"D:\Codex-ICT-builds\ui18-final-20261105-01a16e3f\portable-release-r76"), pathlib.Path(r"C:\Users\23825\Desktop\ICT")]
    if any(str(out).casefold() == str(root.resolve()).casefold() or str(out).casefold().startswith(str(root.resolve()).casefold().rstrip("\\/") + os.sep.casefold()) for root in forbidden): raise RuntimeError("forbidden output root")
    if any(parent.is_symlink() for parent in [out, *out.parents]): raise RuntimeError("reparse output ancestor")
    if file_pin(BASE_ZIP) != BASE_PIN or file_pin(ENTRY_MANIFEST) != ENTRY_PIN: raise RuntimeError("frozen base pin mismatch")
    if file_pin(SOURCE_MANIFEST) != SOURCE_PIN: raise RuntimeError("fixed source manifest pin mismatch")
    manifest = json.loads(SOURCE_MANIFEST.read_text(encoding="utf-8"))
    validate_manifest(manifest)
    with zipfile.ZipFile(BASE_ZIP) as base:
        entry = json.loads(ENTRY_MANIFEST.read_text(encoding="utf-8"))
        expected = {x["path"]: x for x in entry["files"]}
        if len(expected) != 39739 or len(base.infolist()) != 39739: raise RuntimeError("base inventory count mismatch")
        if len(expected) != len(entry["files"]): raise RuntimeError("duplicate base manifest path")
        for name, row in expected.items():
            p = pathlib.PurePosixPath(name)
            if p.is_absolute() or ".." in p.parts or "\\" in name or ":" in name or not name or "\0" in name: raise RuntimeError("unsafe base manifest path")
        records = []
        replacement = {}
        deployment_name = "TradeLoom-r76/app/resources/tradeloom/deployment.json"
        deployment = json.loads(base.read(deployment_name))
        original_deployment = json.loads(json.dumps(deployment))
        for part, root in (("backend", "resources/tradeloom/backend"), ("businessShell", "resources/tradeloom/business-shell")):
            rows = manifest[part]["files"]
            if not rows: raise RuntimeError("empty source inventory: " + part)
            targets = set()
            for row in rows:
                source_name, target_name = row.get("source"), row.get("target")
                source = checked_source(source_name)
                data = source.read_bytes()
                if len(data) != row["bytes"] or digest(data) != row["sha256"]: raise RuntimeError("source pin mismatch: " + row["source"])
                target = root + "/" + row["source"].removeprefix("packages/tradeloom-shell/") if part == "businessShell" else root + "/" + row["source"]
                if target != target_name or target.casefold() in targets: raise RuntimeError("source target mismatch/collision: " + row["source"])
                targets.add(target.casefold())
                name = "TradeLoom-r76/app/" + target
                replacement[name] = data
                records.append({"path": target, "bytes": len(data), "sha256": digest(data)})
            inv = tree([{"path": x["path"].removeprefix(root + "/"), "bytes": x["bytes"], "sha256": x["sha256"]} for x in records if x["path"].startswith(root + "/")])
            key = "business" if part == "backend" else "businessShell"
            deployment["resources"][key].update({"root": root, "fileCount": inv["files"], "bytes": inv["bytes"], "sha256": inv["sha256"]})
            if key == "business": deployment["resources"][key]["files"] = [{"path": x["path"].removeprefix(root + "/"), "bytes": x["bytes"], "sha256": x["sha256"]} for x in sorted(records, key=lambda x:x["path"]) if x["path"].startswith(root + "/")]
        deployment_bytes = (json.dumps(deployment, indent=2, ensure_ascii=False) + "\n").encode()
        def leaves(value, prefix=""):
            if isinstance(value, dict):
                result={}
                for key,item in value.items(): result.update(leaves(item, prefix + "." + key if prefix else key))
                return result
            return {prefix:value}
        allowed_leaves={"resources.business.files","resources.business.fileCount","resources.business.bytes","resources.business.sha256","resources.businessShell.fileCount","resources.businessShell.bytes","resources.businessShell.sha256"}
        before_leaves, after_leaves = leaves(original_deployment), leaves(deployment)
        changed_leaves={key for key in before_leaves.keys() | after_leaves.keys() if before_leaves.get(key) != after_leaves.get(key)}
        if changed_leaves != allowed_leaves: raise RuntimeError("deployment changed unexpected leaves: " + str(sorted(changed_leaves)))
        replacement[deployment_name] = deployment_bytes
        out.mkdir(parents=True)
        zip_path = out / "TradeLoom-o08-candidate.zip"
        temp = out / "TradeLoom-o08-candidate.zip.part"
        with zipfile.ZipFile(temp, "w", allowZip64=True) as target:
            base_seen = set(); base_seen_folded = set()
            for info in base.infolist():
                relative = info.filename.removeprefix("TradeLoom-r76/")
                if not info.filename.startswith("TradeLoom-r76/") or info.is_dir() or relative.casefold() in base_seen_folded or relative not in expected: raise RuntimeError("unsafe/duplicate/unmanifested base ZIP entry")
                original = base.read(info.filename)
                base_row = expected[relative]
                if len(original) != base_row["bytes"] or digest(original) != base_row["sha256"]: raise RuntimeError("base ZIP entry mismatch: " + relative)
                base_seen.add(relative); base_seen_folded.add(relative.casefold())
                if info.filename.startswith("TradeLoom-r76/app/resources/tradeloom/backend/") or info.filename.startswith("TradeLoom-r76/app/resources/tradeloom/business-shell/"):
                    continue
                data = replacement.get(info.filename)
                if data is None:
                    data = original
                target.writestr(info, data)
            if base_seen != set(expected): raise RuntimeError("base inventory mismatch")
            for name, data in replacement.items():
                if name.startswith("TradeLoom-r76/app/resources/tradeloom/backend/") or name.startswith("TradeLoom-r76/app/resources/tradeloom/business-shell/"):
                    info = zipfile.ZipInfo(name, date_time=(2026, 11, 7, 0, 0, 0)); info.compress_type = zipfile.ZIP_DEFLATED
                    target.writestr(info, data)
        os.replace(temp, zip_path)
    with zipfile.ZipFile(zip_path) as outputzip:
        outrows=[]
        for info in outputzip.infolist():
            if info.is_dir(): continue
            b=outputzip.read(info.filename); rel=info.filename.removeprefix("TradeLoom-r76/")
            outrows.append({"path":rel,"bytes":len(b),"sha256":digest(b)})
        output_by={x["path"]:x for x in outrows}
        if len(output_by) != len(outrows): raise RuntimeError("duplicate output ZIP path")
        allowed_prefixes=("app/resources/tradeloom/backend/", "app/resources/tradeloom/business-shell/")
        allowed_exact={"app/resources/tradeloom/deployment.json"}
        removed=[]; added=set(output_by)-set(expected); changed=[]
        for name,row in expected.items():
            actual=output_by.get(name)
            if actual is None:
                if not name.startswith(allowed_prefixes): raise RuntimeError("unexpected removed entry: "+name)
                removed.append(name); continue
            if row["bytes"] != actual["bytes"] or row["sha256"] != actual["sha256"]:
                if not name.startswith(allowed_prefixes) and name not in allowed_exact: raise RuntimeError("unexpected changed base entry: "+name)
                changed.append(name)
        if any(not name.startswith(allowed_prefixes) for name in added): raise RuntimeError("unexpected added entry: "+str(sorted(added)[:3]))
        diff={"schemaVersion":1,"kind":"candidate-base-entry-diff","baseEntries":len(expected),"outputEntries":len(output_by),"added":sorted(added),"removed":sorted(removed),"changed":sorted(changed),"allowedRoots":[*allowed_prefixes,"app/resources/tradeloom/deployment.json"]}
        sdk_by={x["path"]:x["sha256"] for x in outrows}
        for path, expected_sha in SDK.items():
            if sdk_by.get(path) != expected_sha: raise RuntimeError("inherited SDK changed: " + path)
    rows_sorted=sorted(outrows,key=lambda x:x["path"])
    (out/"program-entry-manifest.json").write_text(json.dumps({"schemaVersion":1,"kind":"candidate-program-entry-manifest","zipRoot":"TradeLoom-r76/","files":rows_sorted,"tree":tree(rows_sorted)},indent=2)+"\n",encoding="utf-8")
    (out/"entry-diff.json").write_text(json.dumps(diff,indent=2)+"\n",encoding="utf-8")
    sidecar={"schemaVersion":1,"kind":"candidate-source-overlay","status":"candidate-artifact-assembled-not-official-source-build","sourceRepository":manifest["sourceRepository"],"inheritedArtifact":{"release":"R76 SDK/program baseline","zip":str(BASE_ZIP),"sdk":manifest["inheritedSdk"]},"programZip":{"file":zip_path.name,"bytes":zip_path.stat().st_size,"sha256":file_pin(zip_path)[1]},"entryCount":len(outrows),"changedEntryCount":len(changed),"changedEntriesSha256":digest(json.dumps(sorted(changed),separators=(",",":"),ensure_ascii=False).encode()),"officialBuildReceipt":False,"installed":False,"launched":False}
    (out/"candidate-overlay-receipt.json").write_text(json.dumps(sidecar,indent=2)+"\n",encoding="utf-8")
    print(json.dumps({"output":str(out),"entries":len(outrows),"zip":sidecar["programZip"],"changed":len(replacement)}))
if __name__ == "__main__": main()
