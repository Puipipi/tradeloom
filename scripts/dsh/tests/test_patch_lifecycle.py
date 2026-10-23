import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
REFERENCE = Path(r"C:\Users\23825\Desktop\ICT\workspace\research\references\deepseek-harness")
EVIDENCE = Path(r"C:\Users\23825\Desktop\ICT\workspace\testing\dsh-slot-patches")
TEMP_ROOT = EVIDENCE / "temp-runtimes"
POWERSHELL = shutil.which("pwsh")
PREPARE = REPO / "scripts" / "dsh" / "prepare-runtime.ps1"
CHECK = REPO / "scripts" / "dsh" / "check-upstream.ps1"
EXPECTED_HEAD = "687f282e8625c6b8d11ff58211a90524be2e4317"
EXPECTED_LICENSE = "EBB4F09972AEE8608BE255DEBAF78451A68E95C290F55C240DEC2ECFA16EA6BE"


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def invoke(script: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [POWERSHELL, "-NoProfile", "-File", str(script), *args],
        cwd=REPO,
        text=True,
        capture_output=True,
        check=False,
    )


def result_json(proc: subprocess.CompletedProcess[str]) -> dict:
    for line in reversed((proc.stdout + "\n" + proc.stderr).splitlines()):
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict) and "status" in parsed:
            return parsed
    raise AssertionError(f"No structured result in output:\n{proc.stdout}\n{proc.stderr}")


class PatchLifecycleTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if POWERSHELL is None:
            raise RuntimeError("PowerShell 7 (pwsh) is required for these script contract tests")
        if not REFERENCE.is_dir() or not (REFERENCE / ".git").exists():
            raise RuntimeError(f"Read-only upstream reference not found: {REFERENCE}")
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)
        cls._suite_directory = tempfile.TemporaryDirectory(prefix="suite-", dir=TEMP_ROOT)
        cls.runtime = Path(cls._suite_directory.name) / "runtime"
        cls.prepared_result = invoke(PREPARE, "-ReferencePath", str(REFERENCE), "-RuntimePath", str(cls.runtime))

    def temp_dir(self):
        return tempfile.TemporaryDirectory(prefix="case-", dir=TEMP_ROOT)

    @classmethod
    def tearDownClass(cls):
        cls._suite_directory.cleanup()

    def clone_reference(self, target: Path):
        proc = subprocess.run(
            ["git", "clone", "--shared", "--no-checkout", str(REFERENCE), str(target)],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        subprocess.run(["git", "-C", str(target), "config", "core.longpaths", "true"], check=True)
        proc = subprocess.run(
            ["git", "-C", str(target), "checkout", "--detach", EXPECTED_HEAD],
            text=True,
            capture_output=True,
            check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)

    def test_prepare_copies_pinned_source_and_applies_all_real_patches(self):
        runtime = self.runtime
        proc = self.prepared_result
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        outcome = result_json(proc)
        self.assertEqual(outcome["status"], "prepared")
        self.assertEqual(outcome["sourceCommit"], EXPECTED_HEAD)
        self.assertEqual(outcome["licenseSha256"], EXPECTED_LICENSE)
        self.assertIn("shell.top", (runtime / "packages/client/ui-layout/src/client/index.ts").read_text(encoding="utf-8"))
        self.assertIn("shell.top", (runtime / "packages/client/ui-layout/src/client/AppFrame.tsx").read_text(encoding="utf-8"))
        self.assertIn("sidebar.agents", (runtime / "packages/client/ui-sidebar/src/client/index.ts").read_text(encoding="utf-8"))
        self.assertIn("sidebar.agents", (runtime / "packages/client/ui-sidebar/src/client/SidebarRoot.tsx").read_text(encoding="utf-8"))
        desktop_manifest = json.loads((runtime / "apps/desktop/package.json").read_text(encoding="utf-8"))
        self.assertEqual(desktop_manifest.get("dshDesktopAppId"), "cn.tradeloom.workbench")
        reasoning_policy = (runtime / "packages/client/ui-chat/src/client/presentation-policy.ts").read_text(encoding="utf-8")
        reasoning_row = (runtime / "packages/client/ui-chat/src/client/chat/ReasoningRow.tsx").read_text(encoding="utf-8")
        reasoning_test = (runtime / "packages/client/ui-chat/tests/reasoning-row.client.spec.tsx").read_text(encoding="utf-8")
        self.assertIn("reasoningVisibility: 'hidden'", reasoning_policy)
        self.assertIn("if (hidden) return null", reasoning_row)
        self.assertIn("final answer visible", reasoning_test)
        contract = (runtime / "packages/client/ui-sidebar/src/client/contract/slots.ts").read_text(encoding="utf-8")
        self.assertIn("'sidebar.agents': { kind: 'single'; scope: 'root'; owner: SidebarSectionOwnerProps }", contract)
        self.assertIn("| 'sidebar.agents'", contract)
        changed = subprocess.run(
            ["git", "-C", str(runtime), "diff", "--name-only"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.splitlines()
        changed.extend(subprocess.run(
            ["git", "-C", str(runtime), "ls-files", "--others", "--exclude-standard"],
            text=True,
            capture_output=True,
            check=True,
        ).stdout.splitlines())
        self.assertEqual(set(changed), {
            ".tradeloom-runtime-owned",
            "packages/client/ui-layout/src/client/index.ts",
            "packages/client/ui-layout/src/client/AppFrame.tsx",
            "packages/client/ui-sidebar/src/client/contract/slots.ts",
            "packages/client/ui-sidebar/src/client/index.ts",
            "packages/client/ui-sidebar/src/client/SidebarRoot.tsx",
            "packages/client/ui-sidebar/tests/__snapshots__/sidebar-snapshot.client.spec.tsx.snap",
            "packages/client/ui-sidebar/tests/sidebar-root.client.spec.tsx",
            "packages/client/ui-chat/src/client/chat/ReasoningRow.tsx",
            "packages/client/ui-chat/src/client/presentation-policy.ts",
            "packages/client/ui-chat/tests/presentation-policy.client.spec.tsx",
            "packages/client/ui-chat/tests/reasoning-row.client.spec.tsx",
            "apps/desktop/scripts/electron-builder-config.mjs",
            "apps/desktop/scripts/desktop-package-environment.mjs",
            "apps/desktop/scripts/desktop-package-environment.d.mts",
            "scripts/client-build-environment.ts",
            "scripts/client-build-environment.client.spec.ts",
            "apps/desktop/scripts/package-target.ts",
            "apps/desktop/scripts/desktop-build-paths.mjs",
            "apps/desktop/scripts/desktop-build-paths.d.mts",
            "apps/desktop/scripts/smoke-packaged-runtime.ts",
            "apps/desktop/package.json",
            "apps/desktop/src/main.ts",
            "apps/desktop/src/fatal-recovery.ts",
            "apps/desktop/src/locale.ts",
            "apps/desktop/renderer/assets/welcome-brand.svg",
            "apps/desktop/resources/icon-windows.png",
            "apps/desktop/resources/icon-windows.svg",
            "apps/desktop/resources/tray-windows.ico",
            "apps/desktop/installer/assets/brand.png",
            "apps/desktop/installer/assets/brand-2x.png",
            "apps/desktop/installer/assets/brand-dark.png",
            "apps/desktop/installer/assets/brand-dark-2x.png",
            "apps/desktop/installer/assets/uninstaller-sidebar.png",
            "apps/desktop-host/src/index.ts",
            "apps/desktop/src/web-document.ts",
            "apps/desktop/tests/web-document.spec.ts",
            "apps/desktop/tests/desktop-package-environment.spec.ts",
            "apps/desktop/tests/desktop-build-paths.spec.ts",
            "apps/desktop/tests/main-startup.spec.ts",
            "apps/desktop/tests/fatal-recovery.spec.ts",
            "apps/desktop/tests/expected/about-panel.json",
            "apps/desktop/tests/expected/application-menu-en-US.json",
            "apps/desktop/tests/expected/application-menu-zh-CN.json",
            "apps/desktop/tests/expected/fatal-address-in-use-en.txt",
            "apps/desktop/tests/expected/fatal-address-in-use-zh-CN.txt",
            "apps/desktop/tests/expected/fatal-dialog-en.txt",
            "apps/desktop/tests/expected/fatal-dialog-zh-CN.txt",
            "apps/desktop/tests/expected/fatal-dialog-with-report-en.txt",
            "apps/desktop/tests/expected/fatal-dialog-with-report-zh-CN.txt",
            "apps/web/index.html",
            "apps/web/public/manifest.webmanifest",
            "apps/web/public/favicon.svg",
            "apps/web/public/favicon-dark.svg",
            "packages/client/ui-conversation/src/client/locales.ts",
            "apps/desktop/tests/desktop-installer-include.spec.ts",
            "apps/desktop/src/update-coordinator.ts",
            "apps/desktop/src/websocket-authority.ts",
            "apps/desktop/tests/websocket-authority.spec.ts",
            "packages/client/ui-settings-models/src/client/CustomProviderCard.tsx",
            "packages/client/ui-settings-models/src/client/ProviderEditor.tsx",
            "packages/client/ui-settings-models/src/client/locales.ts",
            "packages/client/ui-settings-models/tests/provider-form.client.spec.tsx",
            "packages/client/ui-workspace/src/client/stores.ts",
            "packages/client/ui-workspace/tests/tree.client.spec.ts",
            "packages/client/ui-workspace/tests/workspace-browser.client.spec.tsx",
        })
        lock = json.loads((REPO / "integrations" / "dsh" / "patches" / "patches.lock.json").read_text(encoding="utf-8"))
        for relative_path, hashes in lock["targetFiles"].items():
            self.assertEqual(digest(runtime / relative_path).lower(), hashes["newSha256"], relative_path)
        checked = invoke(CHECK, "-RuntimePath", str(runtime))
        self.assertEqual(checked.returncode, 0, checked.stdout + checked.stderr)
        self.assertEqual(result_json(checked)["status"], "compatible")
        self.assertFalse(proc.stderr.strip())

    def test_existing_runtime_refuses_without_changing_any_bytes(self):
        with self.temp_dir() as raw:
            runtime = Path(raw) / "existing"
            runtime.mkdir()
            sentinel = runtime / "sentinel.txt"
            sentinel.write_text("operator data\n")
            before = digest(sentinel)
            proc = invoke(PREPARE, "-ReferencePath", str(REFERENCE), "-RuntimePath", str(runtime))
            self.assertEqual(proc.returncode, 20, proc.stdout + proc.stderr)
            self.assertEqual(result_json(proc)["status"], "target_exists")
            self.assertEqual(digest(sentinel), before)
            self.assertEqual(list(runtime.iterdir()), [sentinel])

    def test_non_owned_target_is_rejected_without_creation(self):
        with self.temp_dir() as raw:
            fixture = Path(raw) / "source"
            self.clone_reference(fixture)
            (fixture / "README.md").write_text((fixture / "README.md").read_text(encoding="utf-8") + "\nfixture drift\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(fixture), "add", "README.md"], check=True)
            subprocess.run(["git", "-C", str(fixture), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture drift"], check=True, capture_output=True)
            outside = REPO / "outside-runtime-target-test"
            self.assertFalse(outside.exists(), f"Refusing to use occupied path: {outside}")
            proc = invoke(PREPARE, "-ReferencePath", str(fixture), "-RuntimePath", str(outside))
            self.assertEqual(proc.returncode, 21, proc.stdout + proc.stderr)
            self.assertEqual(result_json(proc)["status"], "path_rejected")
            self.assertFalse(outside.exists())

    def test_runtime_root_uses_external_workspace_and_rejects_repo_local_copy(self):
        with self.temp_dir() as raw:
            fixture = Path(raw) / "source"
            self.clone_reference(fixture)
            (fixture / "README.md").write_text((fixture / "README.md").read_text(encoding="utf-8") + "\nfixture drift\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(fixture), "add", "README.md"], check=True)
            subprocess.run(["git", "-C", str(fixture), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture drift"], check=True, capture_output=True)

            external_release = REPO.parent / "workspace" / "runtime" / "tradeloom-harness" / "releases" / "path-guard-only"
            self.assertFalse(external_release.exists(), f"Refusing to use occupied path: {external_release}")
            external = invoke(PREPARE, "-ReferencePath", str(fixture), "-RuntimePath", str(external_release))
            self.assertEqual(external.returncode, 22, external.stdout + external.stderr)
            self.assertEqual(result_json(external)["status"], "source_head_mismatch")
            self.assertFalse(external_release.exists())

            internal = REPO / "workspace" / "runtime" / "tradeloom-harness" / "releases" / "path-guard-only"
            rejected = invoke(PREPARE, "-ReferencePath", str(fixture), "-RuntimePath", str(internal))
            self.assertEqual(rejected.returncode, 21, rejected.stdout + rejected.stderr)
            self.assertEqual(result_json(rejected)["status"], "path_rejected")
            self.assertFalse(internal.exists())

    def test_junction_into_foreign_temp_directory_is_rejected_without_touching_sentinel(self):
        with self.temp_dir() as raw:
            foreign = Path(raw) / "foreign"
            foreign.mkdir()
            sentinel = foreign / "sentinel.txt"
            sentinel.write_text("untouched\n", encoding="utf-8")
            junction = TEMP_ROOT / ("junction-" + uuid.uuid4().hex)
            command = f"New-Item -ItemType Junction -Path '{junction}' -Target '{foreign}' | Out-Null"
            created = subprocess.run([POWERSHELL, "-NoProfile", "-Command", command], text=True, capture_output=True, check=False)
            self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
            try:
                target = junction / "redirected-runtime"
                proc = invoke(PREPARE, "-ReferencePath", str(REFERENCE), "-RuntimePath", str(target))
                self.assertEqual(proc.returncode, 21, proc.stdout + proc.stderr)
                self.assertEqual(result_json(proc)["status"], "path_rejected")
                check = invoke(CHECK, "-RuntimePath", str(target))
                self.assertEqual(check.returncode, 21, check.stdout + check.stderr)
                self.assertEqual(result_json(check)["status"], "path_rejected")
                self.assertEqual(sentinel.read_text(encoding="utf-8"), "untouched\n")
                self.assertFalse((foreign / "redirected-runtime").exists())
            finally:
                subprocess.run([POWERSHELL, "-NoProfile", "-Command", f"Remove-Item -LiteralPath '{junction}' -Force"], check=False, capture_output=True)

    def test_wrong_source_head_is_machine_rejected(self):
        with self.temp_dir() as raw:
            fixture = Path(raw) / "source"
            self.clone_reference(fixture)
            (fixture / "README.md").write_text((fixture / "README.md").read_text(encoding="utf-8") + "\nfixture drift\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(fixture), "add", "README.md"], check=True)
            subprocess.run(["git", "-C", str(fixture), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "fixture drift"], check=True, capture_output=True)
            runtime = Path(raw) / "runtime"
            proc = invoke(PREPARE, "-ReferencePath", str(fixture), "-RuntimePath", str(runtime))
            self.assertEqual(proc.returncode, 22, proc.stdout + proc.stderr)
            self.assertEqual(result_json(proc)["status"], "source_head_mismatch")
            self.assertFalse(runtime.exists())

    def test_wrong_license_is_machine_rejected_without_target_creation(self):
        with self.temp_dir() as raw:
            fixture = Path(raw) / "source"
            self.clone_reference(fixture)
            (fixture / "LICENSE").write_text("not the pinned license\n")
            runtime = Path(raw) / "runtime"
            proc = invoke(PREPARE, "-ReferencePath", str(fixture), "-RuntimePath", str(runtime))
            self.assertEqual(proc.returncode, 23, proc.stdout + proc.stderr)
            self.assertEqual(result_json(proc)["status"], "license_mismatch")
            self.assertFalse(runtime.exists())

    def test_patch_context_drift_is_reported_and_candidate_check_is_read_only(self):
        runtime = self.runtime
        target = runtime / "packages/client/ui-layout/src/client/index.ts"
        original = target.read_bytes()
        try:
            changed = target.read_text(encoding="utf-8").replace("'shell.bottom': { kind: 'single', scope: 'root' },", "'shell.bottom': { kind: 'list', scope: 'root' },")
            target.write_text(changed, encoding="utf-8")
            before = digest(target)
            proc = invoke(CHECK, "-RuntimePath", str(runtime))
            self.assertEqual(proc.returncode, 30, proc.stdout + proc.stderr)
            outcome = result_json(proc)
            self.assertEqual(outcome["status"], "patch_conflict")
            self.assertTrue(outcome["conflicts"])
            self.assertEqual(digest(target), before)
        finally:
            target.write_bytes(original)

    def test_candidate_conflict_reports_without_mutating_current_runtime(self):
        with self.temp_dir() as raw:
            runtime = self.runtime
            before = subprocess.run(["git", "-C", str(runtime), "status", "--porcelain"], text=True, capture_output=True, check=True).stdout
            compatible = invoke(CHECK, "-RuntimePath", str(runtime), "-CandidateRef", "HEAD")
            self.assertEqual(compatible.returncode, 0, compatible.stdout + compatible.stderr)
            self.assertEqual(result_json(compatible)["status"], "compatible")
            self.assertEqual(subprocess.run(["git", "-C", str(runtime), "status", "--porcelain"], text=True, capture_output=True, check=True).stdout, before)
            compatible_fixture = Path(raw) / "compatible-source"
            self.clone_reference(compatible_fixture)
            subprocess.run(["git", "-C", str(compatible_fixture), "switch", "-c", "dsh-compatible-fixture"], check=True, capture_output=True)
            compatible_file = compatible_fixture / "packages/client/ui-settings-models/src/client/CustomProviderCard.tsx"
            compatible_file.write_text(compatible_file.read_text(encoding="utf-8") + "\n// Unrelated candidate note outside patch hunks.\n", encoding="utf-8")
            subprocess.run(["git", "-C", str(compatible_fixture), "add", "packages/client/ui-settings-models/src/client/CustomProviderCard.tsx"], check=True)
            subprocess.run(["git", "-C", str(compatible_fixture), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "compatible fixture"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(runtime), "fetch", str(compatible_fixture), "refs/heads/dsh-compatible-fixture:refs/heads/dsh-compatible-fixture"], check=True, capture_output=True)
            compatible_change = invoke(CHECK, "-RuntimePath", str(runtime), "-CandidateRef", "refs/heads/dsh-compatible-fixture")
            self.assertEqual(compatible_change.returncode, 0, compatible_change.stdout + compatible_change.stderr)
            self.assertEqual(result_json(compatible_change)["status"], "compatible")
            fixture = Path(raw) / "candidate-source"
            self.clone_reference(fixture)
            subprocess.run(["git", "-C", str(fixture), "switch", "-c", "dsh-conflict-fixture"], check=True, capture_output=True)
            candidate_file = fixture / "packages/client/ui-sidebar/src/client/contract/slots.ts"
            original = candidate_file.read_text(encoding="utf-8")
            old = "'sidebar.panellist': { kind: 'list'; scope: 'root'; owner: SidebarPanelIconOwnerProps }"
            old_comment = "* the sidebar owns the button and resolves its label from list metadata."
            self.assertEqual(original.count(old), 1)
            self.assertEqual(original.count(old_comment), 1)
            changed = original.replace(old, "'sidebar.panellist': { kind: 'single'; scope: 'root'; owner: SidebarPanelIconOwnerProps }")
            changed = changed.replace(old_comment, "* a candidate slot contract has changed its owner surface.")
            candidate_file.write_text(changed, encoding="utf-8")
            subprocess.run(["git", "-C", str(fixture), "add", "packages/client/ui-sidebar/src/client/contract/slots.ts"], check=True)
            subprocess.run(["git", "-C", str(fixture), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "conflict fixture"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(runtime), "fetch", str(fixture), "refs/heads/dsh-conflict-fixture:refs/heads/dsh-conflict-fixture"], check=True, capture_output=True)
            before = subprocess.run(["git", "-C", str(runtime), "status", "--porcelain"], text=True, capture_output=True, check=True).stdout
            proc = invoke(CHECK, "-RuntimePath", str(runtime), "-CandidateRef", "refs/heads/dsh-conflict-fixture")
            self.assertEqual(proc.returncode, 31, proc.stdout + proc.stderr)
            self.assertEqual(result_json(proc)["status"], "candidate_conflict")
            after = subprocess.run(["git", "-C", str(runtime), "status", "--porcelain"], text=True, capture_output=True, check=True).stdout
            self.assertEqual(after, before)


if __name__ == "__main__":
    unittest.main()
