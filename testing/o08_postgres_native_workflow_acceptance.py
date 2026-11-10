"""Run the real O08 SDK workflow once, then read its run after private PG/Django restart."""

from __future__ import annotations

import json
import hashlib
import os
from pathlib import Path
import re
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")


REPO = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = Path(os.environ.get("TEMP", tempfile.gettempdir())) / "tlr4p" / "targets" / "win-x64" / "unsigned-artifacts" / "win-unpacked" / "resources"
PYTHON = PACKAGE_ROOT / "runtime" / "primary-runtime" / "dependencies" / "python" / "python.exe"
PYTHON_PACKAGES = PACKAGE_ROOT / "tradeloom" / "python-packages"
PG_BIN = PACKAGE_ROOT / "tradeloom" / "postgresql" / "pgsql" / "bin"
PG_CTL = PG_BIN / "pg_ctl.exe"
INITDB = PG_BIN / "initdb.exe"
CREATEDB = PG_BIN / "createdb.exe"
DSH_RUNTIME = Path(os.environ.get("TEMP", tempfile.gettempdir())) / "tlr4p" / "targets" / "win-x64" / "dsh"
NODE_SCRIPT = REPO / "testing" / "o08_sdk_native_workflow_acceptance.mjs"
CANDIDATE_AFTER = REPO / "recovery-20261029" / "o08-artifact-service-identity-candidate-20261030" / "after" / "workflow-native-artifact-http.js"


class AcceptanceFailure(Exception):
    def __init__(self, phase: str, code: str):
        super().__init__(phase)
        self.phase = phase
        self.code = code


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def run_file_command(command: list[str], *, cwd: Path, env: dict[str, str], output: Path,
                     timeout: int, phase: str) -> int:
    try:
        with output.open("ab") as stream:
            result = subprocess.run(command, cwd=cwd, env=env, stdin=subprocess.DEVNULL,
                                    stdout=stream, stderr=subprocess.STDOUT, timeout=timeout,
                                    creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as error:
        raise AcceptanceFailure(phase, "timeout") from error
    if result.returncode:
        raise AcceptanceFailure(phase, f"exit-{result.returncode}")
    return result.returncode


def pg_status(data: Path, *, cwd: Path, env: dict[str, str], output: Path, phase: str) -> int:
    try:
        with output.open("ab") as stream:
            result = subprocess.run([str(PG_CTL), "status", "-D", str(data)], cwd=cwd, env=env,
                                    stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                    timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as error:
        raise AcceptanceFailure(phase, "timeout") from error
    if result.returncode not in (0, 3):
        raise AcceptanceFailure(phase, f"exit-{result.returncode}")
    return result.returncode


def wait_http(port: int, process: subprocess.Popen[bytes], phase: str) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise AcceptanceFailure(phase, f"django-exit-{process.returncode}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise AcceptanceFailure(phase, "listen-timeout")


def stop_owned_django(process: subprocess.Popen[bytes]) -> None:
    if process.poll() is None:
        process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def main() -> int:
    for path in (PYTHON, PYTHON_PACKAGES, PG_CTL, INITDB, CREATEDB, DSH_RUNTIME / "package.json", NODE_SCRIPT):
        if not path.exists():
            raise AcceptanceFailure("preflight", "required-runtime-file-missing")
    node = shutil.which("node")
    if not node:
        raise AcceptanceFailure("preflight", "node-not-found")
    try:
        node_path = Path(node).resolve(strict=True)
        if not node_path.is_file() or node_path.is_symlink():
            raise OSError("node-not-regular-file")
        with node_path.open("rb") as handle:
            node_sha256 = hashlib.file_digest(handle, "sha256").hexdigest()
    except OSError as error:
        raise AcceptanceFailure("preflight", f"node-file-{type(error).__name__}") from None
    node = str(node_path)

    root = Path(tempfile.mkdtemp(prefix="tl-o08-pg-", dir=tempfile.gettempdir())).resolve()
    if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith("tl-o08-pg-"):
        shutil.rmtree(root, ignore_errors=True)
        raise AcceptanceFailure("temp-root", "owned-root-validation-failed")
    data = root / "pgdata"
    data.mkdir()
    logs = root / "logs"
    logs.mkdir()
    pg_port = free_loopback_port()
    django_port = free_loopback_port()
    while django_port == pg_port:
        django_port = free_loopback_port()
    database = "tradeloom_o08_" + uuid.uuid4().hex[:12]
    bridge_key = secrets.token_hex(32)
    scenario = os.environ.get("TRADELOOM_O08_SCENARIO", "success")
    if scenario not in {"success", "cancel", "timeout", "llm-error", "deliverable", "native-artifact"}:
        raise AcceptanceFailure("preflight", "unsupported-scenario")
    if scenario == "native-artifact" and not CANDIDATE_AFTER.is_file():
        raise AcceptanceFailure("preflight", "artifact-candidate-after-missing")
    media_root = root / "media"
    artifact_root = root / "artifact-storage"
    media_root.mkdir()
    artifact_root.mkdir()

    inherited = ("SYSTEMROOT", "WINDIR", "TEMP", "TMP", "PATH", "PATHEXT", "COMSPEC")
    env = {name: os.environ[name] for name in inherited if name in os.environ}
    env["PATH"] = os.pathsep.join(str(item) for item in (PG_BIN, PYTHON.parent, env.get("PATH", "")) if item)
    env.update({
        "PYTHONPATH": os.pathsep.join((str(PYTHON_PACKAGES), str(REPO))),
        "PYTHONNOUSERSITE": "1",
        "DJANGO_SETTINGS_MODULE": "config.settings",
        "TRADELOOM_DB_HOST": "127.0.0.1",
        "TRADELOOM_DB_PORT": str(pg_port),
        "TRADELOOM_DB_NAME": database,
        "TRADELOOM_DB_USER": "tradeloom",
        "TRADELOOM_DB_PASSWORD": "",
        "TRADELOOM_NATIVE_BRIDGE_KEY": bridge_key,
        "TRADELOOM_O08_DJANGO_PORT": str(django_port),
        "TRADELOOM_DJANGO_PORT": str(django_port),
        "TRADELOOM_MEDIA_ROOT": str(media_root),
        "TRADELOOM_ARTIFACT_ROOT": str(artifact_root),
        "TRADELOOM_O08_SCENARIO": scenario,
        "TRADELOOM_O08_RUNSTORE": "postgres",
        "TRADELOOM_DSH_RUNTIME_ROOT": str(DSH_RUNTIME),
        "TRADELOOM_ARTIFACT_NODE": node,
        "TRADELOOM_ARTIFACT_NODE_SHA256": node_sha256,
    })
    if scenario == "native-artifact":
        env["TRADELOOM_O08_ARTIFACT_CANDIDATE_AFTER"] = str(CANDIDATE_AFTER)
    pg_log = logs / "postgres.log"
    control_log = logs / "postgres-control.log"
    django_log = logs / "django.log"
    node_output = logs / "node-output.log"
    node_error = logs / "node-error.log"
    django_process: subprocess.Popen[bytes] | None = None
    phase = "preflight"
    result: dict[str, object] = {"ok": False, "database": database, "pgPort": pg_port, "djangoPort": django_port}
    failure: AcceptanceFailure | None = None
    cleanup_error: str | None = None
    safe_to_remove_root = True

    def start_pg(label: str) -> None:
        run_file_command([str(PG_CTL), "-D", str(data), "-l", str(pg_log), "-o",
                          f"-h 127.0.0.1 -p {pg_port} -c listen_addresses=127.0.0.1",
                          "-w", "-t", "45", "start"], cwd=root, env=env,
                         output=control_log, timeout=60, phase=label)

    def start_django(label: str) -> subprocess.Popen[bytes]:
        try:
            with django_log.open("ab") as stream:
                process = subprocess.Popen([str(PYTHON), str(REPO / "manage.py"), "runserver", "--noreload",
                                            f"127.0.0.1:{django_port}"], cwd=REPO, env=env,
                                           stdin=subprocess.DEVNULL, stdout=stream, stderr=subprocess.STDOUT,
                                           creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), close_fds=True)
        except OSError as error:
            raise AcceptanceFailure(label, type(error).__name__) from error
        try:
            wait_http(django_port, process, label)
        except Exception:
            stop_owned_django(process)
            raise
        return process

    def run_node(label: str, args: list[str], extra_env: dict[str, str] | None = None) -> dict[str, object]:
        node_env = dict(env)
        node_env.update(extra_env or {})
        try:
            with node_output.open("ab") as stdout, node_error.open("ab") as stderr:
                completed = subprocess.run([node, str(NODE_SCRIPT), *args], cwd=REPO, env=node_env,
                                           stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr,
                                           timeout=150, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except subprocess.TimeoutExpired as error:
            raise AcceptanceFailure(label, "timeout") from error
        if completed.returncode:
            safe_node_error = "node-error"
            try:
                error_lines = node_error.read_text(encoding="utf-8").splitlines()
                error_pattern = r"(?:AssertionError|TypeError|RangeError|ReferenceError|AggregateError|SyntaxError|Error)(?: \[([A-Z0-9_]+)\])?"
                header = next((line for line in error_lines if re.search(error_pattern, line)), "")
                code_match = re.search(error_pattern, header)
                frame_match = next((re.search(r"o08_sdk_native_workflow_acceptance\.mjs:(\d+):(\d+)", line) for line in error_lines
                                    if "o08_sdk_native_workflow_acceptance.mjs:" in line), None)
                safe_node_error = f"node-{code_match.group(1) if code_match and code_match.group(1) else 'uncaught'}"
                if frame_match:
                    safe_node_error += f"-line-{frame_match.group(1)}"
                reason_match = next((re.search(r"handlerReason=([a-z_]+)", line) for line in error_lines
                                     if "handlerReason=" in line), None)
                if reason_match:
                    safe_node_error += f"-handler-{reason_match.group(1)}"
                authorization_match = next((re.search(r"authorized=(\d+)", line) for line in error_lines
                                            if "authorized=" in line), None)
                if authorization_match:
                    safe_node_error += f"-authorize-count-{authorization_match.group(1)}"
                for field in ("sessionQuerySame", "sessionQueryHasOriginal", "sessionQueryOriginalSame",
                              "filesystemSame", "filesystemHasOriginal", "filesystemOriginalSame",
                              "workspaceFilesSame", "workspaceFilesHasOriginal", "workspaceFilesOriginalSame",
                              "directoryPickerSame", "readEventSuccessful"):
                    match = next((re.search(rf"{field}=(true|false)", line) for line in error_lines
                                  if f"{field}=" in line), None)
                    if match:
                        safe_node_error += f"-{field}-{match.group(1)}"
            except OSError:
                pass
            raise AcceptanceFailure(label, f"exit-{completed.returncode}-{safe_node_error}")
        try:
            lines = [line for line in node_output.read_text(encoding="utf-8").splitlines() if line.strip()]
            receipt = json.loads(lines[-1])
        except (OSError, IndexError, json.JSONDecodeError) as error:
            raise AcceptanceFailure(label, "missing-json-receipt") from error
        expected_phase = "postgres-restart-readback" if args == ["readback"] else "complete"
        if receipt.get("ok") is not True or receipt.get("phase") != expected_phase:
            raise AcceptanceFailure(label, "receipt-not-passed")
        return receipt

    try:
        phase = "initdb"
        run_file_command([str(INITDB), "-D", str(data), "-U", "tradeloom", "-A", "trust",
                          "--encoding=UTF8", "--no-locale"], cwd=root, env=env,
                         output=control_log, timeout=120, phase=phase)
        phase = "postgres-start-first"
        start_pg(phase)
        first_status = pg_status(data, cwd=root, env=env, output=control_log, phase="pg-status-first")
        if first_status != 0:
            raise AcceptanceFailure("pg-status-first", "owned-cluster-not-running")
        result["pgStatusAfterFirstStart"] = first_status
        phase = "createdb"
        run_file_command([str(CREATEDB), "-h", "127.0.0.1", "-p", str(pg_port), "-U", "tradeloom", database],
                         cwd=root, env=env, output=control_log, timeout=60, phase=phase)
        phase = "django-migrate"
        run_file_command([str(PYTHON), str(REPO / "manage.py"), "migrate", "--noinput"], cwd=REPO, env=env,
                         output=django_log, timeout=240, phase=phase)
        phase = "django-start-first"
        django_process = start_django(phase)
        phase = "native-sdk-execution"
        executed = run_node(phase, [])
        run_id = str(executed.get("run", {}).get("runId", ""))
        execution_run = executed.get("run", {})
        if execution_run.get("status") != "done" or executed.get("sdk", {}).get("childStarts") != 1:
            raise AcceptanceFailure(phase, "sdk-terminal-receipt-invalid")
        if scenario == "native-artifact":
            sdk = executed.get("sdk", {})
            calls = sdk.get("toolCalls", [])
            receipt_checks = {
                "nodeDone": execution_run.get("nodeStatus") == "done",
                "sdkChildStartEnd": sdk.get("childStarts") == 1 and sdk.get("childEnds") == 1,
                "childCompleted": sdk.get("stopReason") == "completed",
                "childParentMatches": sdk.get("childParentMatches") is True,
                "realWriteReceipt": any(call.get("name") == "write" and call.get("isError") is False for call in calls),
                "realPresentReceipt": any(call.get("name") == "present" and call.get("isError") is False for call in calls),
            }
        else:
            receipt_checks = {
                "nodeDone": execution_run.get("nodeStatus") == "done",
                "workflowToolReceipt": executed.get("sdk", {}).get("workflowToolReceipt") is True,
                "subagentToolReceipt": executed.get("sdk", {}).get("subagentToolReceipt") is True,
                "terminalSource": execution_run.get("terminalSource") == "subagent/end",
                "parentMatches": execution_run.get("parentMatches") is True,
                "childLifecycleMatches": execution_run.get("childIdMatchesLifecycle") is True,
            }
        if not all(receipt_checks.values()):
            failed = ",".join(key for key, value in receipt_checks.items() if not value)
            raise AcceptanceFailure(phase, f"sdk-receipt-{failed}")
        if scenario == "native-artifact":
            artifact = executed.get("nativeArtifact")
            if (not isinstance(artifact, dict) or artifact.get("bytesMatch") is not True
                    or artifact.get("sourceSessionId") != execution_run.get("childId")
                    or artifact.get("sourceSeq") is None or artifact.get("fileIndex") != 0
                    or artifact.get("callId") is None or artifact.get("turn") != 1
                    or artifact.get("registerStatus") not in {200, 201} or artifact.get("listStatus") != 200
                    or artifact.get("downloadStatus") != 200 or artifact.get("previewStatus") != 200):
                failed = ",".join(key for key, condition in {
                    "bytesMatch": isinstance(artifact, dict) and artifact.get("bytesMatch") is True,
                    "sourceSession": isinstance(artifact, dict) and artifact.get("sourceSessionId") == execution_run.get("childId"),
                    "sourceSeq": isinstance(artifact, dict) and artifact.get("sourceSeq") is not None,
                    "fileIndex": isinstance(artifact, dict) and artifact.get("fileIndex") == 0,
                    "callId": isinstance(artifact, dict) and artifact.get("callId") is not None,
                    "turn": isinstance(artifact, dict) and artifact.get("turn") == 1,
                    "registerStatus": isinstance(artifact, dict) and artifact.get("registerStatus") in {200, 201},
                    "listStatus": isinstance(artifact, dict) and artifact.get("listStatus") == 200,
                    "downloadStatus": isinstance(artifact, dict) and artifact.get("downloadStatus") == 200,
                    "previewStatus": isinstance(artifact, dict) and artifact.get("previewStatus") == 200,
                }.items() if not condition)
                raise AcceptanceFailure(phase, f"native-artifact-{failed or 'invalid'}")
        if not re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", run_id):
            raise AcceptanceFailure(phase, "sdk-run-id-invalid")
        result["execution"] = executed
        result["artifactRoots"] = {
            "mediaRootScopedToTemp": media_root.resolve().is_relative_to(root.resolve()),
            "artifactRootScopedToTemp": artifact_root.resolve().is_relative_to(root.resolve()),
            "scenario": scenario,
        }

        phase = "django-stop-before-restart"
        stop_owned_django(django_process)
        django_process = None
        phase = "postgres-stop-before-restart"
        run_file_command([str(PG_CTL), "-D", str(data), "-m", "fast", "-w", "-t", "30", "stop"],
                         cwd=root, env=env, output=control_log, timeout=45, phase=phase)
        stopped_status = pg_status(data, cwd=root, env=env, output=control_log, phase="pg-status-stopped")
        if stopped_status != 3:
            raise AcceptanceFailure("pg-status-stopped", "owned-cluster-still-running")
        result["pgStatusAfterFirstStop"] = stopped_status

        phase = "postgres-restart"
        start_pg(phase)
        restarted_status = pg_status(data, cwd=root, env=env, output=control_log, phase="pg-status-restarted")
        if restarted_status != 0:
            raise AcceptanceFailure("pg-status-restarted", "owned-cluster-not-running")
        result["pgStatusAfterRestart"] = restarted_status
        phase = "django-restart"
        django_process = start_django(phase)
        phase = "adapter-readback-after-restart"
        readback = run_node(phase, ["readback"], {"TRADELOOM_O08_RUN_ID": run_id})
        if readback.get("runId") != run_id:
            raise AcceptanceFailure(phase, "run-id-changed-after-restart")
        if readback.get("phase") != "postgres-restart-readback" or readback.get("mode") != "readback-only":
            raise AcceptanceFailure(phase, "readback-mode-invalid")
        if readback.get("revision") != execution_run.get("revision"):
            raise AcceptanceFailure(phase, f"revision-changed-after-restart-{execution_run.get('revision')}-{readback.get('revision')}")
        if (readback.get("attempt") != 1 or readback.get("terminalCount") != 1
                or readback.get("childId") != execution_run.get("childId")
                or readback.get("nativeRunId") != execution_run.get("nativeRunId")
                or readback.get("requestId") != execution_run.get("requestId")
                or readback.get("output") != execution_run.get("output")):
            raise AcceptanceFailure(phase, "readback-shows-repeat-or-missing-terminal")
        result["readback"] = readback
        result["runId"] = run_id
        result["result"] = "passed"
    except AcceptanceFailure as error:
        failure = error
    except Exception as error:
        failure = AcceptanceFailure(phase, type(error).__name__)
    finally:
        if django_process is not None:
            try:
                stop_owned_django(django_process)
                if django_process.poll() is None:
                    raise RuntimeError("owned Django did not exit")
            except Exception as error:
                cleanup_error = cleanup_error or f"django-{type(error).__name__}"
                safe_to_remove_root = False
        try:
            status = pg_status(data, cwd=root, env=env, output=control_log, phase="pg-cleanup-status") if data.exists() else 3
            if status == 0:
                run_file_command([str(PG_CTL), "-D", str(data), "-m", "fast", "-w", "-t", "30", "stop"],
                                 cwd=root, env=env, output=control_log, timeout=45, phase="pg-cleanup-stop")
                status = pg_status(data, cwd=root, env=env, output=control_log, phase="pg-cleanup-status-after-stop")
            if status != 3:
                cleanup_error = cleanup_error or "owned-pg-still-running"
                safe_to_remove_root = False
            result["pgStatusFinal"] = status
        except Exception as error:
            cleanup_error = cleanup_error or f"pg-{type(error).__name__}"
            safe_to_remove_root = False
        if safe_to_remove_root and root.parent == Path(tempfile.gettempdir()).resolve() and root.name.startswith("tl-o08-pg-"):
            try:
                shutil.rmtree(root)
            except Exception as error:
                cleanup_error = cleanup_error or f"temp-cleanup-{type(error).__name__}"
        elif not safe_to_remove_root:
            cleanup_error = cleanup_error or "temp-root-preserved-because-owned-service-state-is-unknown"
        if root.exists():
            cleanup_error = cleanup_error or "temp-root-remains"

    if cleanup_error:
        failure = failure or AcceptanceFailure("cleanup", cleanup_error)
    if failure:
        print(json.dumps({"ok": False, "phase": failure.phase, "code": failure.code,
                          "cleanupCode": cleanup_error}, ensure_ascii=False), file=sys.stderr)
        return 1
    result["ok"] = True
    result["tempRootRemoved"] = not root.exists()
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
