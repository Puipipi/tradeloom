"""Linux dev-run child ownership checks; no Flutter, SDK or device is executed.

The real shell entry owns local peers for adb, flutter and the waiting command.
Anonymous pipe gates establish phases; timeouts only bound failed handshakes/cleanup.
"""
import ctypes
import json
import os
from pathlib import Path
import re
import shutil
import signal
import select
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "dev-run.sh"
PEER = r'''#!INTERPRETER
import json, os, sys
from pathlib import Path
root = Path(os.environ['DEV_RUN_CLEANUP_ROOT'])
name = Path(sys.argv[0]).name
args = sys.argv[1:]
if name == 'adb':
    if args[2:4] == ['shell', 'dumpsys']:
        print('flags=[ DEBUGGABLE ]\n versionName=1.2.3\n versionCode=123')
        raise SystemExit(0)
    if args[2:5] == ['shell', 'am', 'force-stop']:
        name = 'stop'
    elif args[2:5] == ['shell', 'monkey', '-p']:
        name = 'launch'
    else:
        raise SystemExit(97)
row = {'name': name, 'pid': os.getpid(), 'args': args}
text = Path(f'/proc/{os.getpid()}/stat').read_text(encoding='utf-8')
fields = text[text.rindex(')') + 2:].split()
row.update(pgrp=int(fields[2]), starttime=fields[19])
fd = os.open(root / 'peers.jsonl', os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.write(fd, (json.dumps(row) + '\n').encode())
os.close(fd)
os.write(int(os.environ['DEV_RUN_EVENTS']), (json.dumps(row) + '\n').encode())
gate = json.loads(os.environ['DEV_RUN_GATES'])[name]
# The test owner bounds each phase and kills/reaps this recorded peer in cleanup.
command = os.read(gate, 1)
raise SystemExit(23 if command == b'F' else 0)
'''.replace('INTERPRETER', sys.executable)


def identity(pid):
    try:
        text = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8")
    except FileNotFoundError:
        return None
    fields = text[text.rindex(")") + 2:].split()
    return {"pid": pid, "pgrp": int(fields[2]), "starttime": fields[19]}


class Entry:
    def __init__(self, case):
        self.case = case
        self.temp = tempfile.TemporaryDirectory(prefix="dev-run-cleanup-")
        self.root = Path(self.temp.name)
        self.process = None
        self.gates = {}
        self.events_read = self.events_write = None
        self.event_buffer = b""
        self.rows = {}
        self.trace = None
        case.addCleanup(self.close)
        script = self.root / "repo/tooling/dev-run.sh"
        script.parent.mkdir(parents=True)
        script.write_bytes(SCRIPT.read_bytes())
        (self.root / "repo/app").mkdir()
        binary = self.root / "bin"
        binary.mkdir()
        for name in ("dirname", "tr", "grep", "sed", "head"):
            (binary / name).symlink_to(shutil.which(name))
        for name in ("adb", "flutter", "sleep"):
            path = binary / name
            path.write_text(PEER, encoding="utf-8")
            path.chmod(0o755)
        self.events_read, self.events_write = os.pipe()
        self.gates = {name: list(os.pipe()) for name in ("sleep", "flutter", "stop", "launch")}
        self.trace = (self.root / "trace.txt").open("w+", encoding="utf-8")
        environment = dict(os.environ, PATH=str(binary), DEV_RUN_CLEANUP_ROOT=str(self.root),
                           DSH_ANDROID_TOOLS=str(self.root / "no-sdk"),
                           DSH_FLUTTER=str(self.root / "no-flutter"),
                           BASH_XTRACEFD=str(self.trace.fileno()),
                           DEV_RUN_EVENTS=str(self.events_write),
                           DEV_RUN_GATES=json.dumps({name: pair[0] for name, pair in self.gates.items()}))
        for name in ("BASH_ENV", "ENV", "WINDIR", "DSH_ATTACH_WAIT"):
            environment.pop(name, None)
        self.process = subprocess.Popen(
            [shutil.which("bash"), "-x", str(script), "--attach", "-s", "fixture"],
            cwd=self.root, env=environment, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            pass_fds=(self.trace.fileno(), self.events_write, *(pair[0] for pair in self.gates.values())),
            start_new_session=True,
        )
        os.close(self.events_write)
        self.events_write = None
        for pair in self.gates.values():
            os.close(pair[0])
            pair[0] = None
        self.receive("sleep", "flutter")
        case.assertEqual(self.rows["sleep"]["args"], ["10"])

    def receive(self, *names):
        while not set(names).issubset(self.rows):
            while b"\n" not in self.event_buffer:
                self.case.assertTrue(select.select([self.events_read], [], [], 5)[0], "peer phase was not reached")
                chunk = os.read(self.events_read, 65536)
                self.case.assertTrue(chunk, "peer must identify itself before waiting")
                self.event_buffer += chunk
            line, _, self.event_buffer = self.event_buffer.partition(b"\n")
            row = json.loads(line)
            self.case.assertEqual(row["pgrp"], self.process.pid)
            self.case.assertNotIn(row["name"], self.rows)
            self.rows[row["name"]] = row

    def release(self, name, command=b"R"):
        os.write(self.gates[name][1], command)

    def done(self, status):
        self.case.assertEqual(self.process.wait(timeout=5), status)
        try:
            stdout, stderr = self.process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            self.case.fail("stdio remained open after attach exited; waiting peer was never released")
        self.case.assertEqual(stdout, b"")
        self.case.assertEqual(stderr, b"")

    def close(self):
        process = self.process
        owned = {}
        if process is not None:
            trace = self.root / "trace.txt"
            match = re.search(r'^\+ restart=(\d+)$', trace.read_text(encoding="utf-8"), re.M) if trace.exists() else None
            if match:
                child = identity(int(match[1]))
                if child and child["pgrp"] == process.pid:
                    owned[child["pid"]] = child["starttime"]
            records = self.root / "peers.jsonl"
            if records.exists():
                for line in records.read_text(encoding="utf-8").splitlines():
                    row = json.loads(line)
                    if row["pgrp"] == process.pid:
                        owned[row["pid"]] = row["starttime"]
            # Only this fixture's recorded PIDs, never a process-name search or waitpid(-1).
            if process.poll() is None:
                process.kill()
            process.wait(timeout=5)
            for pid, born in owned.items():
                child = identity(pid)
                if child and child["starttime"] == born:
                    try:
                        os.kill(pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            for pid in owned:
                try:
                    os.waitpid(pid, 0)
                except ChildProcessError:
                    pass
            process.communicate(timeout=5)
        for pair in self.gates.values():
            for descriptor in pair:
                if descriptor is not None:
                    os.close(descriptor)
        for descriptor in (self.events_read, self.events_write):
            if descriptor is not None:
                os.close(descriptor)
        if self.trace is not None:
            self.trace.close()
        self.temp.cleanup()
        if process is not None:
            for pid, born in owned.items():
                child = identity(pid)
                self.case.assertFalse(child and child["starttime"] == born, "recorded fixture child was not reaped")


@unittest.skipUnless(sys.platform.startswith("linux") and shutil.which("bash"), "Linux shell ownership check")
class DevRunCleanupTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if os.geteuid() == 0:
            raise unittest.SkipTest("run the isolated process checks as non-root")
        # Own any orphan from the negative control, and reap only recorded PIDs.
        cls.libc = ctypes.CDLL(None, use_errno=True)
        cls.previous_subreaper = ctypes.c_int()
        if cls.libc.prctl(37, ctypes.byref(cls.previous_subreaper), 0, 0, 0) != 0:
            raise unittest.SkipTest("requires Linux child-subreaper support")
        if cls.libc.prctl(36, 1, 0, 0, 0) != 0:
            raise unittest.SkipTest("requires Linux child-subreaper support")

    @classmethod
    def tearDownClass(cls):
        if cls.libc.prctl(36, cls.previous_subreaper.value, 0, 0, 0) != 0:
            raise OSError(ctypes.get_errno(), "could not restore child-subreaper state")

    def test_failed_attach_cancels_waiting_restart(self):
        entry = Entry(self)
        entry.release("flutter", b"F")
        self.assertEqual(entry.process.wait(timeout=5), 23)
        # The sleep peer has not received a release; only owner cancellation can close it.
        entry.done(23)
        self.assertNotIn("stop", entry.rows)
        self.assertNotIn("launch", entry.rows)

    def test_normal_restart_finishes_before_attach_returns(self):
        entry = Entry(self)
        entry.release("sleep")
        entry.receive("stop")
        entry.release("stop")
        entry.receive("launch")
        self.assertEqual(entry.rows["launch"]["args"][2:5], ["shell", "monkey", "-p"])
        entry.release("launch")
        entry.release("flutter")
        entry.done(0)

    def test_detach_after_stop_begins_still_completes_launch(self):
        entry = Entry(self)
        entry.release("sleep")
        entry.receive("stop")  # The shell has entered the existing TERM-ignored phase.
        entry.release("flutter")
        self.assertEqual(entry.process.wait(timeout=5), 0)
        entry.release("stop")
        entry.receive("launch")
        entry.release("launch")
        entry.done(0)


if __name__ == "__main__":
    unittest.main()
