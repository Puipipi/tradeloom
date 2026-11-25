#!/usr/bin/env python3
"""Engine changes must not replace the user Linux system or its package database."""
import importlib.util
import io
import json
from pathlib import Path
import re
import subprocess
import sys
import tarfile
import tempfile
import unittest

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('rtbuild', HERE / 'lib/rtbuild.py')
rtbuild = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rtbuild)


class RuntimeUpgradePackaging(unittest.TestCase):
    def test_system_identity_ignores_engine_versions_and_deb_order(self):
        original = rtbuild.upgrade_descriptor('arm64-v8a', '24.04.5', 'base', ['ca', 'tz'], 'python')
        reordered = rtbuild.upgrade_descriptor('arm64-v8a', '24.04.5', 'base', ['tz', 'ca'], 'python')
        self.assertEqual(original, reordered)
        for abi, base, debs, python in [
            ('x86_64', 'base', ['ca', 'tz'], 'python'),
            ('arm64-v8a', 'other-base', ['ca', 'tz'], 'python'),
            ('arm64-v8a', 'base', ['ca', 'other'], 'python'),
            ('arm64-v8a', 'base', ['ca', 'tz'], 'other-python'),
        ]:
            changed = rtbuild.upgrade_descriptor(abi, '24.04.5', base, debs, python)
            self.assertNotEqual(original['baseId'], changed['baseId'])

    def test_android_and_builder_share_the_exact_non_overlapping_owned_paths(self):
        source = HERE.parent / 'app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/EngineUpgrade.kt'
        declaration = source.read_text().split('internal val ENGINE_PATHS = listOf(', 1)[1].split('\n)', 1)[0]
        self.assertEqual(rtbuild.ENGINE_PATHS, re.findall(r'"([^"]+)"', declaration))
        for path in rtbuild.ENGINE_PATHS:
            self.assertNotIn(path, ('usr', 'usr/local', 'usr/local/bin', 'opt/python', 'var/lib/dpkg', 'root'))
            self.assertNotIn('..', path.split('/'))
            self.assertFalse(any(other.startswith(path + '/') for other in rtbuild.ENGINE_PATHS if other != path))

    def test_real_assembler_and_manifest_emit_the_same_upgrade_contract(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            def archive(name, files):
                target = root / name
                with tarfile.open(target, 'w:gz') as tar:
                    for path, content in files.items():
                        data = content.encode()
                        entry = tarfile.TarInfo(path)
                        entry.mode = 0o755
                        entry.size = len(data)
                        tar.addfile(entry, io.BytesIO(data))
                return target
            base = archive('base.tar.gz', {'etc/os-release': 'ID=ubuntu\nVERSION_ID="24.04"\n'})
            node = archive('node.tar.gz', {'node/bin/node': 'node fixture'})
            python = archive('python.tar.gz', {'python/bin/python3': 'python fixture'})
            dsh = root / 'dsh/node_modules/package'
            dsh.mkdir(parents=True)
            (dsh / 'index.js').write_text('engine fixture')
            pnpm = root / 'pnpm/node_modules/pnpm/bin'
            pnpm.mkdir(parents=True)
            (pnpm / 'pnpm.mjs').write_text('pnpm fixture')
            (pnpm / 'pnpx.mjs').write_text('pnpx fixture')
            versions = dict(runtimeVersion='test-engine', abi='arm64-v8a', ubuntuVersion='24.04.5',
                            nodeVersion='24', dshVersion='test', pnpmVersion='11', prootVersion='5',
                            tallocVersion='2', androidShmemVersion='0')
            out, report = root / 'rootfs.tar.gz', root / 'report.json'
            subprocess.run([sys.executable, '-I', str(HERE / 'lib/rtbuild.py'), 'assemble',
                            '--abi', 'arm64-v8a', '--base', str(base), '--node', str(node),
                            '--python', str(python), '--dsh-prefix', str(root / 'dsh'),
                            '--pnpm-prefix', str(root / 'pnpm'), '--runtime-info', json.dumps(versions),
                            '--out', str(out), '--report', str(report), '--compress', 'gz'], check=True,
                           capture_output=True, text=True)
            with tarfile.open(out, 'r:gz') as tar:
                archived = json.load(tar.extractfile('etc/dsh-app/runtime.json'))
                names = set(tar.getnames())
                self.assertTrue(set(rtbuild.ENGINE_PATHS) <= names)
            jni, manifest = root / 'jni.json', root / 'manifest.json'
            jni.write_text('{}')
            subprocess.run([sys.executable, '-I', str(HERE / 'lib/rtbuild.py'), 'manifest',
                            '--abi', 'arm64-v8a', '--report', str(report), '--jnilibs', str(jni),
                            '--versions', json.dumps(versions), '--out', str(manifest)], check=True,
                           capture_output=True, text=True)
            self.assertEqual(archived['upgrade'], json.loads(report.read_text())['upgrade'])
            self.assertEqual(archived['upgrade'], json.loads(manifest.read_text())['upgrade'])


if __name__ == '__main__':
    unittest.main(verbosity=2)
