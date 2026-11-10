"""Repeatable O09 acceptance using a private temporary PostgreSQL cluster.

Exercises the real Django persistence endpoint, PostgreSQL model, JavaScript
adapter, and journal recovery. It does not run a Host, SDK child, model, or GUI.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import secrets
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import uuid


REPO = Path(__file__).resolve().parents[1]
PACKAGE_ROOT = Path(os.environ.get("TEMP", tempfile.gettempdir())) / "tlr4p" / "targets" / "win-x64" / "unsigned-artifacts" / "win-unpacked" / "resources"
PYTHON = PACKAGE_ROOT / "runtime" / "primary-runtime" / "dependencies" / "python" / "python.exe"
PYTHON_PACKAGES = PACKAGE_ROOT / "tradeloom" / "python-packages"
PG_BIN = PACKAGE_ROOT / "tradeloom" / "postgresql" / "pgsql" / "bin"
PG_CTL = PG_BIN / "pg_ctl.exe"
INITDB = PG_BIN / "initdb.exe"
CREATEDB = PG_BIN / "createdb.exe"


NODE_DRIVER = r"""
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.env.TRADELOOM_REPO_ROOT
const port = Number(process.env.TRADELOOM_O09_DJANGO_PORT)
const host = '127.0.0.1'
const origin = 'http://' + host + ':' + port
const key = process.env.TRADELOOM_NATIVE_BRIDGE_KEY
const { createPostgresWorkflowRunStore } = await import(pathToFileURL(path.join(root, 'packages/tradeloom-shell/workflow-postgres.js')))
const { createWorkflowRunJournal } = await import(pathToFileURL(path.join(root, 'packages/tradeloom-shell/workflow-run-journal.js')))
const store = createPostgresWorkflowRunStore({
  webServer: { protocol: 'http:', host, port, getOrigin: () => origin },
  pairedHost: { host, port }, port, nativeBridgeKey: key,
})
const journal = createWorkflowRunJournal({ store })
if (process.argv[1] === 'create') {
  const document = {
    version: 1, id: 'o09_restart_acceptance',
    title: 'O09 temporary PostgreSQL restart acceptance',
    source: 'manual', confirmed: true,
    nodes: [
      { id: 'done_node', kind: 'agent', agent: 'product', title: 'Completed node', instruction: 'Synthetic terminal receipt' },
      { id: 'active_node', kind: 'agent', agent: 'product', title: 'Acknowledged active node', instruction: 'Synthetic acknowledged child' },
      { id: 'unknown_node', kind: 'agent', agent: 'product', title: 'Unknown node', instruction: 'Synthetic unknown attempt' },
    ],
    edges: [],
  }
  const handle = await journal.create({
    workflowId: document.id, document, requestId: 'o09-request',
    parentAgentId: 'o09-parent-agent', sessionId: 'o09-parent-session',
    bindingRevision: '1',
  })
  const initial = handle.getSnapshot()
  const input = (nodeId, requestId) => ({
    nodeId, attempt: 1, requestId,
    bindingRevision: initial.bindingRevision,
    definitionRevision: initial.definitionRevision,
  })
  await handle.executeAttempt(input('done_node', 'o09-done-request'), async context => {
    await context.recordChildAck({ toolCallId: 'o09-done-call', childId: 'o09-done-child', nativeRunId: 'o09-done-native-run' })
    return {
      status: 'completed', terminalSource: 'subagent/end',
      workflowRunId: context.workflowRunId, nodeId: context.nodeId, attempt: context.attempt,
      requestId: context.requestId, bindingRevision: context.bindingRevision,
      definitionRevision: context.definitionRevision, parentAgentId: context.parentAgentId,
      sessionId: context.sessionId, toolCallId: 'o09-done-call',
      childId: 'o09-done-child', nativeRunId: 'o09-done-native-run', output: 'completed',
    }
  })
  const active = handle.executeAttempt(input('active_node', 'o09-active-request'), async context => {
    await context.recordChildAck({ toolCallId: 'o09-active-call', childId: 'o09-active-child', nativeRunId: 'o09-active-native-run' })
    return new Promise(() => {})
  })
  void active
  try {
    await handle.executeAttempt(input('unknown_node', 'o09-unknown-request'), async context => {
      await context.recordChildAck({ toolCallId: 'o09-unknown-call', childId: 'o09-unknown-child', nativeRunId: 'o09-unknown-native-run' })
      throw Object.assign(new Error('synthetic lost observation'), { code: 'O09_SYNTHETIC_UNKNOWN' })
    })
    assert.fail('unknown attempt should be recorded as unknown')
  } catch (error) {
    assert.equal(error.code, 'O09_SYNTHETIC_UNKNOWN')
  }
  const before = await store.get(initial.id)
  assert.equal(before.nodes.done_node.status, 'done')
  assert.equal(before.nodes.active_node.status, 'running')
  assert.equal(before.nodes.active_node.attemptState, 'acknowledged')
  assert.equal(before.nodes.unknown_node.status, 'unknown')
  assert.deepEqual((await store.list({ activeOnly: true })).map(row => row.id), [initial.id])
  process.stdout.write(JSON.stringify({ runId: initial.id }) + '\n')
} else if (process.argv[1] === 'recover') {
  const runId = process.env.TRADELOOM_O09_RUN_ID
  const result = await journal.recoverInterruptedRuns()
  assert.equal(result.recovered.length, 1)
  assert.equal(result.recovered[0].id, runId)
  const snapshot = await store.get(runId)
  assert.equal(snapshot.status, 'interrupted')
  assert.equal(snapshot.nodes.done_node.status, 'done')
  assert.equal(snapshot.nodes.active_node.status, 'interrupted')
  assert.equal(snapshot.nodes.active_node.attemptState, 'interrupted')
  assert.equal(snapshot.nodes.active_node.childId, 'o09-active-child')
  assert.equal(snapshot.nodes.unknown_node.status, 'unknown')
  assert.equal(snapshot.nodes.unknown_node.attemptState, 'unknown')
  const reopened = await journal.open(runId)
  const resume = await reopened.inspectResume()
  assert.equal(resume.eligible, false)
  assert.deepEqual(resume.completedNodeIds, ['done_node'])
  assert.deepEqual(resume.eligibleNodeIds, [])
  assert.deepEqual(new Set(resume.blocked.map(item => item.nodeId)), new Set(['active_node', 'unknown_node']))
  process.stdout.write(JSON.stringify({
    runId, status: snapshot.status, doneNode: snapshot.nodes.done_node.status,
    activeNode: snapshot.nodes.active_node.status, unknownNode: snapshot.nodes.unknown_node.status,
    resumeEligible: resume.eligible, completedNodeIds: resume.completedNodeIds,
    blockedNodeIds: resume.blocked.map(item => item.nodeId),
  }) + '\n')
} else {
  throw new Error('expected create or recover phase')
}
"""


def checked(command: list[str], *, cwd: Path, env: dict[str, str], timeout: int = 120) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout,
                            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    if result.returncode:
        raise RuntimeError(f"command failed with exit {result.returncode}: {command[0]}\n{result.stdout[-4000:]}\n{result.stderr[-4000:]}")
    return result


def free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def wait_http(port: int, process: subprocess.Popen[bytes], log_path: Path) -> None:
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"Django exited ({process.returncode}); see {log_path}")
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.5):
                return
        except OSError:
            time.sleep(0.2)
    raise RuntimeError(f"Django did not listen on owned loopback port; see {log_path}")


def main() -> int:
    for path in (PYTHON, PYTHON_PACKAGES, PG_CTL, INITDB, CREATEDB):
        if not path.exists():
            raise RuntimeError(f"required packaged runtime file is missing: {path}")
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js was not found on PATH")

    root = Path(tempfile.mkdtemp(prefix="tl-o09-pg-"))
    data = root / "pgdata"
    data.mkdir()
    logs = root / "logs"
    logs.mkdir()
    pg_port = free_loopback_port()
    django_port = free_loopback_port()
    while django_port == pg_port:
        django_port = free_loopback_port()
    database = "tradeloom_o09_" + uuid.uuid4().hex[:12]
    key = secrets.token_hex(32)

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
        "TRADELOOM_NATIVE_BRIDGE_KEY": key,
        "TRADELOOM_O09_DJANGO_PORT": str(django_port),
        "TRADELOOM_REPO_ROOT": str(REPO),
    })
    pg_log = logs / "postgres.log"
    django_log = logs / "django.log"
    django_process: subprocess.Popen[bytes] | None = None
    evidence: dict[str, object] = {
        "result": "running", "workspace": str(root), "database": database,
        "postgresPort": pg_port, "djangoPort": django_port,
        "pgCtl": str(PG_CTL), "python": str(PYTHON),
    }

    def start_pg() -> None:
        control_log = logs / "postgres-control.log"
        with control_log.open("ab") as output:
            result = subprocess.run(
                [str(PG_CTL), "-D", str(data), "-l", str(pg_log), "-o",
                 f"-h 127.0.0.1 -p {pg_port} -c listen_addresses=127.0.0.1",
                 "-w", "-t", "45", "start"],
                cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT,
                timeout=60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        if result.returncode:
            raise RuntimeError(f"pg_ctl start failed ({result.returncode}); see {control_log}")

    def start_django() -> subprocess.Popen[bytes]:
        handle = django_log.open("ab")
        try:
            process = subprocess.Popen(
                [str(PYTHON), str(REPO / "manage.py"), "runserver", "--noreload", f"127.0.0.1:{django_port}"],
                cwd=REPO, env=env, stdout=handle, stderr=subprocess.STDOUT,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), close_fds=True)
        finally:
            handle.close()
        try:
            wait_http(django_port, process, django_log)
        except Exception:
            process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)
            raise
        return process

    try:
        checked([str(INITDB), "-D", str(data), "-U", "tradeloom", "-A", "trust", "--encoding=UTF8", "--no-locale"],
                cwd=root, env=env, timeout=120)
        start_pg()
        checked([str(CREATEDB), "-h", "127.0.0.1", "-p", str(pg_port), "-U", "tradeloom", database],
                cwd=root, env=env, timeout=60)
        checked([str(PYTHON), str(REPO / "manage.py"), "migrate", "--noinput"], cwd=REPO, env=env, timeout=240)
        django_process = start_django()

        def run_node(phase: str, extra: dict[str, str] | None = None) -> dict[str, object]:
            node_env = dict(env)
            node_env.update(extra or {})
            result = checked([node, "--input-type=module", "-e", NODE_DRIVER, phase],
                             cwd=REPO, env=node_env, timeout=60)
            return json.loads(result.stdout.strip().splitlines()[-1])

        created = run_node("create")
        evidence["create"] = created
        run_id = str(created["runId"])
        django_process.terminate()
        django_process.wait(timeout=15)
        django_process = None
        checked([str(PG_CTL), "-D", str(data), "-m", "fast", "-w", "-t", "30", "stop"],
                cwd=root, env=env, timeout=45)
        start_pg()
        django_process = start_django()
        recovered = run_node("recover", {"TRADELOOM_O09_RUN_ID": run_id})
        evidence["recovery"] = recovered
    finally:
        if django_process is not None:
            django_process.terminate()
            try:
                django_process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                django_process.kill()
                django_process.wait(timeout=10)
        if data.exists():
            control_log = logs / "postgres-control.log"
            with control_log.open("ab") as output:
                status = subprocess.run([str(PG_CTL), "status", "-D", str(data)],
                                        cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT,
                                        timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                if status.returncode == 0:
                    stopped = subprocess.run([str(PG_CTL), "-D", str(data), "-m", "fast", "-w", "-t", "30", "stop"],
                                             cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT,
                                             timeout=45, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
                    if stopped.returncode:
                        raise RuntimeError(f"owned PostgreSQL cleanup failed ({stopped.returncode}); see {control_log}")
    evidence["result"] = "passed"
    (root / "evidence.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(evidence, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(f"O09 PostgreSQL acceptance failed: {type(error).__name__}: {error}", file=sys.stderr)
        raise SystemExit(1)
