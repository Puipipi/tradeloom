"""Linux: full setup shell, entirely local command stand-ins; no SDK or network.

    python3 -m unittest discover -s tooling -p test_setup_toolchain.py -v
"""
from contextlib import contextmanager
from pathlib import Path
import hashlib
import json
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest

SCRIPT = Path(__file__).resolve().parent / "setup-toolchain.sh"
PAYLOAD = b"local toolchain fixture, not an archive\n"
CACHE_NAMES = {
    "flutter": "flutter_linux_3.47.7-stable.tar.xz",
    "cmdline": "commandlinetools-linux-13114758_latest.zip",
}
DISPATCH = r'''#!INTERPRETER
from pathlib import Path
import json, os, shutil, signal, sys
name, args = Path(sys.argv[0]).name, sys.argv[1:]
root = Path(os.environ['TOOLCHAIN_TEST_ROOT'])
dev, scenario = root / 'dev', os.environ['TOOLCHAIN_TEST_SCENARIO']
with (root / 'trace.jsonl').open('a') as out:
    out.write(json.dumps({'command': name, 'args': args}) + '\n')
def program(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(root / 'bin/dispatch', path)
    path.chmod(0o755)
if name == 'curl':
    url = args[-1]
    if '-o' not in args:
        if 'Adoptium/17/jdk/x64/linux/' not in url: raise SystemExit(97)
        print('OpenJDK17U-jdk_x64_linux_hotspot_17.0.99_9.tar.gz')
    else:
        if scenario == 'downstream-failure' and 'Adoptium' in url:
            print('fixture: JDK download failed (23)', file=sys.stderr)
            raise SystemExit(23)
        transfer = os.environ.get('TOOLCHAIN_TEST_TRANSFER')
        destination = Path(args[args.index('-o') + 1])
        if transfer in ('partial', 'hold', 'bad-digest'):
            destination.write_bytes(b'partial')
            if transfer == 'hold':
                (root / 'transfer-ready').write_text('1')
                while True: signal.pause()
            raise SystemExit(0 if transfer == 'bad-digest' else 18)
        Path(args[args.index('-o') + 1]).write_bytes(b'local toolchain fixture, not an archive\n')
elif name == 'tar':
    if '-xzf' in args:
        program(dev / 'jdk-17/bin/java')
        if scenario in ('jdk-failure', 'multiple-failures'):
            print('fixture: JDK extraction failed (23)', file=sys.stderr)
            raise SystemExit(23)
    elif '-xJf' in args:
        program(dev / 'flutter/bin/flutter')
        if scenario == 'flutter-failure':
            print('fixture: Flutter extraction failed (23)', file=sys.stderr)
            raise SystemExit(23)
        source = dev / 'flutter/packages/flutter_tools/gradle/src/main/FlutterExtension.kt'
        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text('val ndkVersion = "28.2.13676358"\nval compileSdkVersion = 36\n')
    else: raise SystemExit(97)
elif name == 'unzip':
    if Path(args[-1]).read_bytes() != b'local toolchain fixture, not an archive\n':
        print('fixture: cached archive is incomplete (9)', file=sys.stderr)
        raise SystemExit(9)
    program(dev / '.downloads/cmdline-tools/bin/sdkmanager')
    if scenario in ('cmdline-failure', 'multiple-failures'):
        code = 29 if scenario == 'multiple-failures' else 23
        print(f'fixture: command-line extraction failed ({code})', file=sys.stderr)
        raise SystemExit(code)
elif name == 'sdkmanager':
    if scenario == 'downstream-failure':
        print('fixture: downstream SDK command failed (42)', file=sys.stderr)
        raise SystemExit(42)
elif name not in ('java', 'flutter'):
    raise SystemExit(97)
'''.replace('INTERPRETER', sys.executable)


def program(path):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(DISPATCH)
    path.chmod(0o755)


def prepared_flutter(root):
    program(root / "dev/flutter/bin/flutter")
    source = root / "dev/flutter/packages/flutter_tools/gradle/src/main/FlutterExtension.kt"
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_text('val ndkVersion = "28.2.13676358"\nval compileSdkVersion = 36\n')


@unittest.skipUnless(sys.platform.startswith("linux"), "Linux shell toolchain test")
class SetupToolchainTest(unittest.TestCase):
    @contextmanager
    def fixture(self, scenario):
        with tempfile.TemporaryDirectory(prefix="toolchain-shell-test-") as tmp:
            root = Path(tmp)
            script = root / "repo/tooling/setup-toolchain.sh"
            script.parent.mkdir(parents=True)
            script.write_bytes(SCRIPT.read_bytes())
            program(root / "bin/dispatch")
            for name in ("curl", "tar", "unzip", "java", "flutter", "sdkmanager"):
                program(root / "bin" / name)
            if scenario in ("flutter-failure", "cmdline-failure", "cache-flutter", "cache-cmdline"):
                program(root / "dev/jdk-17/bin/java")
            if scenario not in ("flutter-failure", "cache-flutter"):
                prepared_flutter(root)
            if scenario not in ("cmdline-failure", "multiple-failures", "cache-cmdline"):
                program(root / "dev/android-sdk/cmdline-tools/latest/bin/sdkmanager")
            env = dict(os.environ, DEV_ROOT=str(root / "dev"),
                       FLUTTER_VERSION="3.47.7", CMDLINE_TOOLS_BUILD="13114758",
                       FLUTTER_SHA256=hashlib.sha256(PAYLOAD).hexdigest(),
                       PATH=str(root / "bin") + os.pathsep + os.environ.get("PATH", ""),
                       TOOLCHAIN_TEST_ROOT=str(root), TOOLCHAIN_TEST_SCENARIO=scenario)
            env.pop("BASH_ENV", None)
            env.pop("ENV", None)
            env.pop("TOOLCHAIN_TEST_TRANSFER", None)
            (root / "trace.jsonl").touch()
            yield root, script, env

    def invoke(self, root, script, env):
        trace = root / "trace.jsonl"
        start = len(trace.read_text().splitlines())
        result = subprocess.run(["bash", str(script)], cwd=root, env=env,
                                text=True, capture_output=True, timeout=10)
        calls = [json.loads(line) for line in trace.read_text().splitlines()[start:]]
        return {"exit": result.returncode, "stdout": result.stdout, "stderr": result.stderr,
                "env_written": (script.parent / "env.sh").exists(), "calls": calls}

    def run_script(self, scenario):
        with self.fixture(scenario) as (root, script, env):
            return self.invoke(root, script, env)

    def test_install_root_survives_working_directory_changes(self):
        for kind in ("relative", "absolute", "default"):
            with self.subTest(kind=kind), self.fixture("success") as (root, script, env):
                program(root / "dev/jdk-17/bin/java")
                dev = root / "dev"
                if kind == "default":
                    env.pop("DEV_ROOT")
                    env["HOME"] = str(root)
                else:
                    dev = root / "dev tools"
                    (root / "dev").rename(dev)
                    env["DEV_ROOT"] = dev.name if kind == "relative" else str(dev)
                result = self.invoke(root, script, env)
                self.assertEqual(result["exit"], 0, result["stderr"])
                app = root / "repo/app"
                app.mkdir()
                probe = subprocess.run(
                    ["bash", "-e", "-c", 'source "$1"; cd "$2"; command -v java; '
                     'command -v flutter; command -v sdkmanager; '
                     'printf "%s\\n" "$JAVA_HOME" "$ANDROID_HOME" "$ANDROID_SDK_ROOT"',
                     "probe", str(script.parent / "env.sh"), str(app)],
                    cwd=root, env=dict(env, PATH=os.defpath), text=True, capture_output=True, timeout=10)
                self.assertEqual(probe.returncode, 0, probe.stdout + probe.stderr)
                self.assertEqual(probe.stdout.splitlines(), [str(dev / suffix) for suffix in (
                    "jdk-17/bin/java", "flutter/bin/flutter", "android-sdk/cmdline-tools/latest/bin/sdkmanager",
                    "jdk-17", "android-sdk", "android-sdk")])

    def assert_download_retry(self, target):
        with self.fixture("cache-" + target) as (root, script, env):
            cache = root / "dev/.downloads" / CACHE_NAMES[target]
            env["TOOLCHAIN_TEST_TRANSFER"] = "partial"
            first = self.invoke(root, script, env)
            first_files = list(cache.parent.iterdir())
            env["TOOLCHAIN_TEST_TRANSFER"] = "complete"
            retry = self.invoke(root, script, env)
            self.assertEqual(first["exit"], 18, first["stderr"])
            self.assertFalse(first["env_written"])
            self.assertEqual(first_files, [], f"retry exit={retry['exit']}: {retry['stderr']}")
            self.assertEqual(retry["exit"], 0, retry["stderr"])
            self.assertTrue(retry["env_written"])
            self.assertEqual(cache.read_bytes(), PAYLOAD)
            self.assertEqual(list(cache.parent.iterdir()), [cache])
            for result in (first, retry):
                self.assertEqual(sum(c["command"] == "curl" for c in result["calls"]), 1)

    def test_flutter_partial_download_can_retry_without_manual_cache_removal(self):
        self.assert_download_retry("flutter")

    def test_cmdline_partial_download_can_retry_without_manual_cache_removal(self):
        self.assert_download_retry("cmdline")

    def test_failed_extraction_is_repeated_before_installation_can_be_reused(self):
        for target, directory, flag in (("jdk", "jdk-17", "-xzf"), ("flutter", "flutter", "-xJf")):
            with self.subTest(target=target), self.fixture(target + "-failure") as (root, script, env):
                marker = root / "dev" / directory / ".dsh-toolchain-incomplete"
                first = self.invoke(root, script, env)
                self.assertEqual(first["exit"], 23, first["stderr"])
                self.assertTrue(marker.is_file())
                if target == "flutter":
                    self.assertFalse((root / "dev/flutter/packages/flutter_tools/gradle/src/main/FlutterExtension.kt").exists())
                env["TOOLCHAIN_TEST_SCENARIO"] = "success"
                retry = self.invoke(root, script, env)
                self.assertEqual(retry["exit"], 0, retry["stderr"])
                self.assertEqual(sum(c["command"] == "tar" and flag in c["args"] for c in retry["calls"]), 1)
                self.assertFalse(marker.exists())
                repeated = self.invoke(root, script, env)
                self.assertEqual(repeated["exit"], 0, repeated["stderr"])
                self.assertFalse(any(c["command"] in ("curl", "tar") for c in repeated["calls"]))

    def test_existing_installations_without_markers_are_reused_without_download(self):
        with self.fixture("success") as (root, script, env):
            program(root / "dev/jdk-17/bin/java")
            result = self.invoke(root, script, env)
            self.assertEqual(result["exit"], 0, result["stderr"])
            self.assertFalse(any(c["command"] in ("curl", "tar") for c in result["calls"]))
            for directory in ("jdk-17", "flutter"):
                self.assertFalse((root / "dev" / directory / ".dsh-toolchain-incomplete").exists())

    def test_existing_complete_caches_are_reused_without_download(self):
        for target, name in CACHE_NAMES.items():
            with self.subTest(target=target), self.fixture("cache-" + target) as (root, script, env):
                cache = root / "dev/.downloads" / name
                cache.parent.mkdir(parents=True)
                cache.write_bytes(PAYLOAD)
                env["TOOLCHAIN_TEST_TRANSFER"] = "partial"
                result = self.invoke(root, script, env)
                self.assertEqual(result["exit"], 0, result["stderr"])
                self.assertEqual(cache.read_bytes(), PAYLOAD)
                self.assertFalse(any(c["command"] == "curl" for c in result["calls"]))
                self.assertEqual(list(cache.parent.iterdir()), [cache])

    def test_historical_bad_caches_are_preserved_and_still_rejected(self):
        for target, name in CACHE_NAMES.items():
            with self.subTest(target=target), self.fixture("cache-" + target) as (root, script, env):
                cache = root / "dev/.downloads" / name
                cache.parent.mkdir(parents=True)
                cache.write_bytes(b"partial")
                result = self.invoke(root, script, env)
                self.assertEqual(result["exit"], 1 if target == "flutter" else 9)
                self.assertEqual(cache.read_bytes(), b"partial")
                self.assertFalse(result["env_written"])
                self.assertFalse(any(c["command"] == "curl" for c in result["calls"]))
                self.assertEqual(list(cache.parent.iterdir()), [cache])

    def test_terminated_download_removes_only_its_temporary_file(self):
        for target, name in CACHE_NAMES.items():
            with self.subTest(target=target), self.fixture("cache-" + target) as (root, script, env):
                cache = root / "dev/.downloads" / name
                cache.parent.mkdir(parents=True)
                sentinel = cache.parent / "unrelated-cache"
                sentinel.write_bytes(b"keep")
                env["TOOLCHAIN_TEST_TRANSFER"] = "hold"
                process = subprocess.Popen(["bash", str(script)], cwd=root, env=env,
                                           text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                           start_new_session=True)
                try:
                    deadline = time.monotonic() + 5
                    while not (root / "transfer-ready").exists() and process.poll() is None:
                        if time.monotonic() >= deadline:
                            self.fail("local transfer stand-in did not reach its interruption gate")
                        time.sleep(.01)
                    self.assertTrue((root / "transfer-ready").exists())
                    os.killpg(process.pid, signal.SIGTERM)
                    stdout, stderr = process.communicate(timeout=10)
                    self.assertNotEqual(process.returncode, 0, stdout + stderr)
                finally:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.communicate(timeout=10)
                self.assertEqual(list(cache.parent.iterdir()), [sentinel])
                self.assertEqual(sentinel.read_bytes(), b"keep")
                self.assertFalse((script.parent / "env.sh").exists())

    def test_complete_transfer_with_bad_flutter_digest_remains_rejected(self):
        with self.fixture("cache-flutter") as (root, script, env):
            env["TOOLCHAIN_TEST_TRANSFER"] = "bad-digest"
            result = self.invoke(root, script, env)
            cache = root / "dev/.downloads" / CACHE_NAMES["flutter"]
            self.assertEqual(result["exit"], 1)
            self.assertEqual(cache.read_bytes(), b"partial")
            self.assertEqual(list(cache.parent.iterdir()), [cache])
            self.assertFalse(result["env_written"])

    def assert_stopped(self, scenario, code):
        result = self.run_script(scenario)
        self.assertEqual(result["exit"], code, result["stderr"])
        self.assertFalse(result["env_written"])
        self.assertNotIn("done; source tooling/env.sh", result["stdout"])
        self.assertFalse(any(c["command"] in ("sdkmanager", "flutter") for c in result["calls"]))
        return result

    def test_flutter_defaults_use_the_declaration_file_in_either_creation_order(self):
        sources = {
            "AgpCommonExtensionWrapper.kt": "    var ndkVersion: String\n",
            "FlutterExtension.kt": '    val compileSdkVersion: Int = 36\n    val ndkVersion: String = "28.2.13676358"\n',
        }
        for order in (tuple(sources), tuple(reversed(sources))):
            with self.subTest(order=order), self.fixture("success") as (root, script, env):
                main = root / "dev/flutter/packages/flutter_tools/gradle/src/main"
                (main / "FlutterExtension.kt").unlink()
                kotlin = main / "kotlin"
                kotlin.mkdir()
                for name in order:
                    (kotlin / name).write_text(sources[name])
                result = self.invoke(root, script, env)
                self.assertEqual(result["exit"], 0, result["stderr"])
                self.assertIn("Flutter defaults: compileSdk=36 ndk=28.2.13676358", result["stdout"])
                packages = next(c["args"] for c in result["calls"]
                                if c["command"] == "sdkmanager" and "--licenses" not in c["args"])
                self.assertIn("platforms;android-36", packages)
                self.assertIn("ndk;28.2.13676358", packages)

    def test_success_still_configures_and_writes_environment(self):
        result = self.run_script("success")
        self.assertEqual(result["exit"], 0, result["stderr"])
        self.assertTrue(result["env_written"])
        self.assertIn("done; source tooling/env.sh", result["stdout"])
        commands = {c["command"] for c in result["calls"]}
        self.assertTrue({"java", "sdkmanager", "flutter"}.issubset(commands))

    def test_first_installer_failure_stops_before_configuration(self):
        result = self.assert_stopped("jdk-failure", 23)
        # A conditional install_jdk invocation would disable its own errexit,
        # execute java -version after tar failed, and falsely turn it successful.
        self.assertFalse(any(c["command"] == "java" for c in result["calls"]))

    def test_second_installer_failure_stops_before_configuration(self):
        self.assert_stopped("flutter-failure", 23)

    def test_third_installer_failure_keeps_stopping(self):
        self.assert_stopped("cmdline-failure", 23)

    def test_installer_failure_is_not_replaced_by_downstream_error(self):
        self.assert_stopped("downstream-failure", 23)

    def test_multiple_failures_are_waited_and_return_last_failing_status(self):
        result = self.assert_stopped("multiple-failures", 29)
        self.assertIn("JDK extraction failed (23)", result["stderr"])
        self.assertIn("command-line extraction failed (29)", result["stderr"])


if __name__ == "__main__":
    unittest.main()
