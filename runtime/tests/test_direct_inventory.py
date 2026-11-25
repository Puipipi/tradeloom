#!/usr/bin/env python3
"""Generated native module inventory is limited to the exact archived bytes."""
import hashlib
import importlib.util
from pathlib import Path
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('rtbuild', Path(__file__).resolve().parents[1] / 'lib/rtbuild.py')
rtbuild = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rtbuild)


class DirectInventory(unittest.TestCase):
    def test_only_regular_bundled_addons_grant_native_loading(self):
        entry = lambda kind='file': rtbuild.Entry(kind, 0o644, data=b'fixture bytes')
        values = {
            'opt/dsh/node_modules/pkg/native.node': entry(),
            'root/.dsh/profiles/user/node_modules/pkg/native.node': entry(),
            'opt/dsh/node_modules/pkg/native.so': entry(),
            'opt/dsh/node_modules/pkg/alias.node': entry('symlink'),
        }
        result = rtbuild.direct_native_inventory(values)
        self.assertEqual(result, {'schema': 1, 'files': {
            '/opt/dsh/node_modules/pkg/native.node': hashlib.sha256(b'fixture bytes').hexdigest(),
        }})

    def test_inventory_and_tar_use_the_same_snapshot_if_source_changes(self):
        with tempfile.TemporaryDirectory() as temporary:
            source = Path(temporary) / 'native.node'
            source.write_bytes(b'vetted fixture')
            entry = rtbuild.Entry('file', 0o644, path=str(source))
            result = rtbuild.direct_native_inventory({'opt/dsh/node_modules/pkg/native.node': entry})
            source.write_bytes(b'later source change')
            self.assertEqual(entry.read(), b'vetted fixture')
            self.assertEqual(next(iter(result['files'].values())), hashlib.sha256(entry.read()).hexdigest())


if __name__ == '__main__':
    unittest.main(verbosity=2)
