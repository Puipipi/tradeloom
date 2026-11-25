"""Exercise the real dev-run entry with local adb output; no device or Flutter.

    python3 -m unittest discover -s tooling -p test_dev_run_devices.py -v
"""
from pathlib import Path
import json
import os
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent / "dev-run.sh"
ADB = r'''#!INTERPRETER
from pathlib import Path
import json, os, sys
root = Path(os.environ['DEV_RUN_TEST_ROOT'])
args = sys.argv[1:]
with (root / 'calls.jsonl').open('a') as out:
    out.write(json.dumps(args) + '\n')
if args == ['devices']:
    sys.stdout.buffer.write((root / 'devices.txt').read_bytes())
    raise SystemExit(int(os.environ['DEV_RUN_TEST_ADB_STATUS']))
if len(args) == 6 and args[0] == '-s' and args[2:] == [
    'shell', 'dumpsys', 'package', 'io.github.ccch1mneyyy.dsh_app'
]:
    # Stop at the existing debug-build gate, before restart or Flutter attach.
    print('flags=[]')
else:
    raise SystemExit(97)
'''.replace('INTERPRETER', sys.executable)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux shell entry test")
class DevRunDevicesTest(unittest.TestCase):
    def run_entry(self, rows, newline=b"\n", *, serial=None, adb_status=0):
        with tempfile.TemporaryDirectory(prefix="dev-run-devices-test-") as tmp:
            root = Path(tmp)
            script = root / "repo/tooling/dev-run.sh"
            script.parent.mkdir(parents=True)
            script.write_bytes(SCRIPT.read_bytes())
            binary = root / "bin/adb"
            binary.parent.mkdir()
            binary.write_text(ADB)
            binary.chmod(0o755)
            lines = [b"List of devices attached"] + [row.encode() for row in rows] + [b"", b""]
            (root / "devices.txt").write_bytes(newline.join(lines))
            env = dict(os.environ, PATH=str(binary.parent) + os.pathsep + os.environ.get("PATH", ""),
                       DSH_ANDROID_TOOLS=str(root / "no-sdk"), DSH_FLUTTER=str(root / "no-flutter"),
                       DEV_RUN_TEST_ROOT=str(root), DEV_RUN_TEST_ADB_STATUS=str(adb_status))
            for key in ("WINDIR", "BASH_ENV", "ENV"):
                env.pop(key, None)
            args = ["bash", str(script), "--attach"]
            if serial is not None:
                args += ["-s", serial]
            result = subprocess.run(args, env=env, cwd=root, capture_output=True, text=True, timeout=5)
            calls = [json.loads(line) for line in (root / "calls.jsonl").read_text().splitlines()]
            return result, calls

    def assert_selected(self, rows, newline, expected):
        result, calls = self.run_entry(rows, newline)
        self.assertEqual(result.returncode, 1)
        self.assertIn("isn't a debug build", result.stderr)
        self.assertEqual(calls, [["devices"], ["-s", expected, "shell", "dumpsys", "package",
                                              "io.github.ccch1mneyyy.dsh_app"]])

    def test_lf_device_reaches_existing_debug_gate(self):
        self.assert_selected(["fixture-1\tdevice"], b"\n", "fixture-1")

    def test_crlf_device_reaches_existing_debug_gate(self):
        self.assert_selected(["fixture-1\tdevice"], b"\r\n", "fixture-1")

    def test_only_authorized_device_is_selected(self):
        for newline in (b"\n", b"\r\n"):
            with self.subTest(newline=newline):
                self.assert_selected(["fixture-off\toffline", "fixture-no\tunauthorized",
                                      "192.0.2.10:5555\tdevice"], newline, "192.0.2.10:5555")

    def test_multiple_devices_still_require_explicit_serial(self):
        for newline in (b"\n", b"\r\n"):
            with self.subTest(newline=newline):
                result, calls = self.run_entry(["fixture-1\tdevice", "fixture-2\tdevice"], newline)
                self.assertEqual(result.returncode, 1)
                self.assertIn("more than one device, pick with -s", result.stderr)
                self.assertIn("fixture-1 fixture-2", result.stderr)
                self.assertEqual(calls, [["devices"]])

    def test_unavailable_devices_still_stop(self):
        for newline in (b"\n", b"\r\n"):
            with self.subTest(newline=newline):
                result, calls = self.run_entry(["fixture-off\toffline", "fixture-no\tunauthorized"], newline)
                self.assertEqual(result.returncode, 1)
                self.assertIn("no device:", result.stderr)
                self.assertEqual(calls, [["devices"]])

    def test_device_command_failure_still_propagates(self):
        result, calls = self.run_entry(["fixture-1\tdevice"], b"\r\n", adb_status=17)
        self.assertEqual(result.returncode, 17)
        self.assertEqual(calls, [["devices"]])

    def test_explicit_serial_still_bypasses_enumeration(self):
        result, calls = self.run_entry([], serial="fixture-explicit")
        self.assertEqual(result.returncode, 1)
        self.assertIn("isn't a debug build", result.stderr)
        self.assertEqual(calls, [["-s", "fixture-explicit", "shell", "dumpsys", "package",
                                 "io.github.ccch1mneyyy.dsh_app"]])


if __name__ == "__main__":
    unittest.main()
