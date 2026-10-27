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
REFERENCE = Path(r"C:\Users\23825\Desktop\ICT\workspace\research\references\deepseek-harness-v0.2.1-rc.3-readonly")
EVIDENCE = Path(r"C:\Users\23825\Desktop\ICT\workspace\testing\dsh-slot-patches")
TEMP_ROOT = EVIDENCE / "temp-runtimes"
POWERSHELL = shutil.which("pwsh")
PREPARE = REPO / "scripts" / "dsh" / "prepare-runtime.ps1"
CHECK = REPO / "scripts" / "dsh" / "check-upstream.ps1"
EXPECTED_HEAD = "1f81c047fc48fa190a683e469daa699857e9afe8"
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
        sidebar_contract = (runtime / "packages/client/ui-sidebar/src/client/contract/slots.ts").read_text(encoding="utf-8")
        self.assertIn("'sidebar.panellist.actions'", sidebar_contract)
        self.assertNotIn("sidebar.agents", sidebar_contract)
        desktop_manifest = json.loads((runtime / "apps/desktop/package.json").read_text(encoding="utf-8"))
        self.assertEqual(desktop_manifest.get("dshDesktopAppId"), "cn.tradeloom.workbench")
        reasoning_policy = (runtime / "packages/client/ui-chat/src/client/presentation-policy.ts").read_text(encoding="utf-8")
        reasoning_row = (runtime / "packages/client/ui-chat/src/client/chat/ReasoningRow.tsx").read_text(encoding="utf-8")
        reasoning_test = (runtime / "packages/client/ui-chat/tests/reasoning-row.client.spec.tsx").read_text(encoding="utf-8")
        self.assertIn("reasoningVisibility: 'hidden'", reasoning_policy)
        self.assertIn("if (hidden) return null", reasoning_row)
        self.assertIn("final answer visible", reasoning_test)
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
        lock = json.loads((REPO / "integrations" / "dsh" / "patches" / "patches.lock.json").read_text(encoding="utf-8"))
        generated_patch_files = {
            "apps/desktop/src/websocket-authority.ts",
            "apps/desktop/tests/websocket-authority.spec.ts",
            "apps/desktop/tests/desktop-installer-include.spec.ts",
            "packages/client/ui-conversation/tests/secondary-window-owner-document.client.spec.tsx",
            "packages/client/ui-primitives/src/owner-document.ts",
            "packages/client/ui-primitives/tests/secondary-window.client.spec.tsx",
        }
        self.assertEqual(set(changed), {".tradeloom-runtime-owned", *lock["targetFiles"], *generated_patch_files})
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
            candidate_file = fixture / "packages/client/ui-layout/src/client/AppFrame.tsx"
            original = candidate_file.read_text(encoding="utf-8")
            old = "return <div className={css.centerCol}>{props.children}</div>"
            self.assertEqual(original.count(old), 1)
            changed = original.replace(old, "return <div className={css.centerCol} data-candidate-conflict>{props.children}</div>")
            candidate_file.write_text(changed, encoding="utf-8")
            subprocess.run(["git", "-C", str(fixture), "add", "packages/client/ui-layout/src/client/AppFrame.tsx"], check=True)
            subprocess.run(["git", "-C", str(fixture), "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "conflict fixture"], check=True, capture_output=True)
            subprocess.run(["git", "-C", str(runtime), "fetch", str(fixture), "refs/heads/dsh-conflict-fixture:refs/heads/dsh-conflict-fixture"], check=True, capture_output=True)
            before = subprocess.run(["git", "-C", str(runtime), "status", "--porcelain"], text=True, capture_output=True, check=True).stdout
            proc = invoke(CHECK, "-RuntimePath", str(runtime), "-CandidateRef", "refs/heads/dsh-conflict-fixture")
            self.assertEqual(proc.returncode, 31, proc.stdout + proc.stderr)
            self.assertEqual(result_json(proc)["status"], "candidate_conflict")
            after = subprocess.run(["git", "-C", str(runtime), "status", "--porcelain"], text=True, capture_output=True, check=True).stdout
            self.assertEqual(after, before)




class MenuProspectivePatchTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.workspace = REPO.parent
        cls.root = cls.workspace / 'workspace/testing/frontend-visual-fixes-20261025/batch46-menu-runtime-source/patch-set-27'
        cls.lock = cls.root / 'patches.prospective.lock.json'
        cls.order = cls.root / 'order.prospective.json'
        cls.patch_root = REPO / 'integrations/dsh/patches'
        TEMP_ROOT.mkdir(parents=True, exist_ok=True)

    def args(self, lock=None, order=None, patch_root=None):
        return ['-ProspectiveLockPath', str(lock or self.lock), '-PatchRoot', str(patch_root or self.patch_root), '-PatchOrder', str(order or self.order)]

    def test_menu27_retains_all26_inputs_and_exact_source_contract(self):
        old_root = self.root.parents[1] / 'batch16-native-preflight/v4-26'
        old = json.loads((old_root / 'patches.prospective.lock.json').read_text())
        new = json.loads(self.lock.read_text())
        old_order = json.loads((old_root / 'order.prospective.json').read_text())
        order = json.loads(self.order.read_text())
        self.assertEqual(digest(self.lock).lower(), '0376bad0288ff90a944fd94b90596328a73cfe449ccc2faf1fe2682b50c51c2f')
        self.assertEqual(digest(self.order).lower(), 'e20f845702006c17bf2bce647a62567230f418b3fd0ab1e51e8b5ca678a5384b')
        self.assertEqual(new['upstream'], old['upstream'])
        self.assertEqual(len(new['patches']), 27)
        self.assertEqual(len(new['targetFiles']), 91)
        self.assertEqual(order['order'][:-1], old_order['order'])
        self.assertEqual(order['order'][-1], 'document-preview-zoom-menu-opaque.patch')
        for key, value in old['patches'].items(): self.assertEqual(new['patches'][key], value)
        for key, value in old['targetFiles'].items(): self.assertEqual(new['targetFiles'][key], value)
        self.assertEqual(new['targetFiles']['packages/client/ui-sidebar-documentpreview/src/client/zoom/ZoomControls.module.css'], {
            'baseSha256': 'b73e0fd34444dd0b4ff17e3d5ca595971f2c1c99180538e35a85dd8a33ce2acd',
            'newSha256': 'b0f9c0df4982ee5a39442569f5dc77e00ab899cdd535611c9ba9e9bb6b35f91f'})

    def test_menu27_correct_selector_reaches_existing_target_and_receipt_refusal(self):
        runtime = self.workspace / 'workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-16'
        receipt = runtime / '.tradeloom-desktop-build-receipt.json'
        before = receipt.read_bytes()
        result = invoke(PREPARE, '-ReferencePath', str(REFERENCE), '-RuntimePath', str(runtime), *self.args())
        self.assertEqual(result.returncode, 20, result.stdout + result.stderr)
        self.assertEqual(result_json(result)['status'], 'target_exists')
        built = subprocess.run(['node', str(REPO/'scripts/dsh/build-candidate.mjs'), '--runtime', str(runtime),
            '--prospective-lock-path', str(self.lock), '--patch-root', str(self.patch_root), '--patch-order', str(self.order)],
            cwd=REPO, capture_output=True, text=True)
        self.assertEqual(built.returncode, 1)
        self.assertIn('candidate runtime 已有构建 receipt', built.stderr)
        self.assertEqual(receipt.read_bytes(), before)
        code = "import {usesInstalledPnpm} from './scripts/dsh/build-candidate.mjs';console.log(JSON.stringify([undefined,'v2-24','v3-25','v4-26','patch-set-27','foreign'].map(usesInstalledPnpm)))"
        selected = subprocess.run(['node','--input-type=module','-e',code],cwd=REPO,capture_output=True,text=True,check=True)
        self.assertEqual(json.loads(selected.stdout), [False,False,True,True,True,False])

    def test_menu27_rejects_partial_or_foreign_exact_paths(self):
        with tempfile.TemporaryDirectory(prefix='menu27-path-', dir=TEMP_ROOT) as raw:
            target = Path(raw)/'never-created'
            partial = invoke(PREPARE, '-ReferencePath', str(REFERENCE), '-RuntimePath', str(target), '-ProspectiveLockPath', str(self.lock))
            self.assertEqual(result_json(partial)['status'], 'parameter_set_rejected')
            self.assertEqual(partial.returncode, 21)
            copied = Path(raw)/'copied.lock.json'
            copied.write_bytes(self.lock.read_bytes())
            foreign = invoke(PREPARE, '-ReferencePath', str(REFERENCE), '-RuntimePath', str(target), *self.args(lock=copied))
            self.assertEqual(foreign.returncode, 21)
            self.assertEqual(result_json(foreign)['status'], 'prospective_path_rejected')
            self.assertFalse(target.exists())

    def test_menu27_digest_patch_and_pin_rejections_use_only_isolated_input_copies(self):
        # Exact script bytes in a private sibling layout exercise digest gates
        # without ever mutating the approved frozen inputs or formal patches.
        with tempfile.TemporaryDirectory(prefix='menu27-tamper-', dir=TEMP_ROOT) as raw:
            ws = Path(raw)
            repo = ws/'tradeloom'
            script = repo/'scripts/dsh/prepare-runtime.ps1'
            script.parent.mkdir(parents=True)
            script.write_bytes(PREPARE.read_bytes())
            lock_root = ws/'workspace/testing/frontend-visual-fixes-20261025/batch46-menu-runtime-source/patch-set-27'
            lock_root.mkdir(parents=True)
            lock = lock_root/self.lock.name
            order = lock_root/self.order.name
            patches = repo/'integrations/dsh/patches'
            patches.mkdir(parents=True)
            names = json.loads(self.lock.read_text())['patches']
            for name in names: (patches/name).write_bytes((self.patch_root/name).read_bytes())
            reference = ws/'workspace/research/references/deepseek-harness-v0.2.1-rc.3-readonly'
            reference.mkdir(parents=True)
            target = ws/'workspace/runtime/tradeloom-harness/releases/menu27-never-created'
            for variant in ['lock', 'order', 'pin', 'patch']:
                with self.subTest(variant=variant):
                    lock.write_bytes(self.lock.read_bytes())
                    order.write_bytes(self.order.read_bytes())
                    patch = patches/'document-preview-zoom-menu-opaque.patch'
                    patch.write_bytes((self.patch_root/patch.name).read_bytes())
                    if variant == 'lock': lock.write_bytes(lock.read_bytes()+b' ')
                    if variant == 'order': order.write_bytes(order.read_bytes()+b' ')
                    if variant == 'pin':
                        value=json.loads(lock.read_text());value['upstream']['commit']='0'*40;lock.write_text(json.dumps(value))
                    if variant == 'patch': patch.write_bytes(patch.read_bytes()+b'\n')
                    result=invoke(script,'-ReferencePath',str(reference),'-RuntimePath',str(target),*self.args(lock,order,patches))
                    self.assertEqual(result.returncode,24,result.stdout+result.stderr)
                    self.assertEqual(result_json(result)['status'], 'patch_hash_mismatch' if variant=='patch' else 'prospective_digest_rejected')
                    self.assertFalse(target.exists())


    def test_menu27_generated_count_is_exactly_ten_without_relaxing_extra_or_missing(self):
        with tempfile.TemporaryDirectory(prefix='menu27-generated-', dir=TEMP_ROOT) as raw:
            ws=Path(raw);repo=ws/'tradeloom';script=repo/'scripts/dsh/check-upstream.ps1'
            script.parent.mkdir(parents=True);script.write_bytes(CHECK.read_bytes())
            lock_root=ws/'workspace/testing/frontend-visual-fixes-20261025/batch46-menu-runtime-source/patch-set-27'
            lock_root.mkdir(parents=True);lock=lock_root/self.lock.name;order=lock_root/self.order.name
            lock.write_bytes(self.lock.read_bytes());order.write_bytes(self.order.read_bytes())
            patches=repo/'integrations/dsh/patches';patches.mkdir(parents=True)
            for name in json.loads(self.lock.read_text())['patches']:
                (patches/name).write_bytes((self.patch_root/name).read_bytes())
            target=ws/'workspace/runtime/tradeloom-harness/releases/not-created'
            def check():
                return invoke(script,'-RuntimePath',str(target),*self.args(lock,order,patches))
            valid=check()
            self.assertEqual(valid.returncode,20,valid.stdout+valid.stderr)
            self.assertEqual(result_json(valid)['status'],'runtime_missing', 'correct 10 passed the early exact generated-set gate')
            missing=patches/'native-startup-observation.patch';before=missing.read_bytes()
            self.assertIn(b'new file mode ',before)
            missing.write_bytes(before.replace(b'new file mode ',b'old file mode ',1))
            rejected=check()
            self.assertEqual(rejected.returncode,24)
            self.assertEqual(result_json(rejected)['status'],'generated_target_set_rejected')
            missing.write_bytes(before)
            extra=patches/'document-preview-zoom-menu-opaque.patch'
            extra.write_bytes(extra.read_bytes()+(chr(10)+'diff --git a/apps/desktop/src/menu-test-extra.ts b/apps/desktop/src/menu-test-extra.ts'+chr(10)+'new file mode 100644'+chr(10)).encode())
            rejected=check()
            self.assertEqual(rejected.returncode,24)
            self.assertEqual(result_json(rejected)['status'],'generated_target_set_rejected')
            self.assertFalse(target.exists())


if __name__ == "__main__":
    unittest.main()
