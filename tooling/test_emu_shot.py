"""Real emu.sh entry with a local adb peer; no SDK, emulator or device."""
from pathlib import Path
import os
import subprocess
import sys
import tempfile
import unittest


SCRIPT = Path(__file__).resolve().parent / "emu.sh"
PAYLOAD = b"\x89PNG\r\n\x1a\nlocal screencap fixture bytes\n"
ADB = r'''#!INTERPRETER
from pathlib import Path
import os, sys
assert sys.argv[1:] == ['exec-out', 'screencap', '-p'], sys.argv
data = Path(os.environ['EMU_SHOT_PAYLOAD']).read_bytes()
mode = os.environ['EMU_SHOT_MODE']
if mode == 'partial':
    sys.stdout.buffer.write(data[:12])
elif mode == 'complete':
    sys.stdout.buffer.write(data)
if mode != 'complete':
    print('fixture: selected device disconnected', file=sys.stderr)
    raise SystemExit(1)
'''.replace('INTERPRETER', sys.executable)


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux shell entry test")
class EmuShotTest(unittest.TestCase):
    def test_failed_capture_preserves_previous_shot_and_retry_replaces_it(self):
        for mode in ("offline", "partial"):
            with self.subTest(mode=mode), tempfile.TemporaryDirectory(prefix="emu-shot-") as tmp:
                root = Path(tmp)
                tooling = root / "tooling"
                tooling.mkdir()
                script = tooling / "emu.sh"
                script.write_bytes(SCRIPT.read_bytes())
                # The generated env.sh only exports toolchain locations and PATH.
                (tooling / "env.sh").write_text(":\n")
                binary = root / "bin"
                binary.mkdir()
                adb = binary / "adb"
                adb.write_text(ADB)
                adb.chmod(0o755)
                payload = root / "capture.bin"
                payload.write_bytes(PAYLOAD)
                shots = tooling / "shots"
                shots.mkdir()
                saved = shots / "before.png"
                old = b"previous saved screenshot bytes\n"
                saved.write_bytes(old)
                env = dict(os.environ, PATH=str(binary) + os.pathsep + os.environ.get("PATH", ""),
                           EMU_SHOT_PAYLOAD=str(payload), ANDROID_SERIAL="fixture-selected")
                for key in ("BASH_ENV", "ENV"):
                    env.pop(key, None)
                command = ["bash", str(script), "shot", "before"]
                failed = subprocess.run(command, env=dict(env, EMU_SHOT_MODE=mode), cwd=root,
                                        capture_output=True, timeout=5)
                self.assertEqual(failed.returncode, 1, failed.stderr)
                self.assertEqual(failed.stdout, b"")
                self.assertEqual(saved.read_bytes(), old)
                self.assertEqual(list(shots.iterdir()), [saved])
                retry = subprocess.run(command, env=dict(env, EMU_SHOT_MODE="complete"), cwd=root,
                                       capture_output=True, timeout=5)
                self.assertEqual(retry.returncode, 0, retry.stderr)
                self.assertEqual(retry.stdout.decode().strip(), str(saved))
                self.assertEqual(saved.read_bytes(), PAYLOAD)
                self.assertEqual(list(shots.iterdir()), [saved])


if __name__ == "__main__":
    unittest.main()
