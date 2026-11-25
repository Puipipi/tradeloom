#!/usr/bin/env python3
"""Exercise runtime recipe outputs with real env/sh; no Android substitute."""
import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('rtbuild', Path(__file__).resolve().parents[1] / 'lib/rtbuild.py')
rtbuild = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rtbuild)
DEFAULT = '/usr/local/share:/usr/share:/system'
PRINT_ENV = 'printf "%s" "${XDG_DATA_DIRS-unset}"'


class FontEnvironment(unittest.TestCase):
    def launch_value(self, extra=()):
        argv = rtbuild.launch_template()['argv']
        begin = argv.index('/usr/bin/env')
        end = argv.index('{GUEST_ENV}')
        return subprocess.check_output(argv[begin:end] + list(extra) + ['/bin/sh', '-c', PRINT_ENV], text=True)

    def profile_value(self, extra=()):
        profile = rtbuild.overlay_entries({})['etc/profile.d/dsh-app.sh'].read()
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'profile.sh'
            path.write_bytes(profile)
            return subprocess.check_output(['/usr/bin/env', '-i', *extra, '/bin/sh', '-c', '. "$1"; ' + PRINT_ENV, 'sh', str(path)], text=True)

    def test_launcher_discovers_android_fonts_after_existing_system_roots(self):
        self.assertEqual(self.launch_value(), DEFAULT)

    def test_later_guest_override_remains_authoritative(self):
        for value in ('/private/fonts-root:/custom/data', ''):
            with self.subTest(value=value):
                self.assertEqual(self.launch_value(['XDG_DATA_DIRS=' + value]), value)

    def test_login_shell_has_same_default(self):
        self.assertEqual(self.profile_value(), DEFAULT)

    def test_login_shell_preserves_custom_and_explicit_empty(self):
        for value in ('/private/fonts-root:/custom/data', ''):
            with self.subTest(value=value):
                self.assertEqual(self.profile_value(['XDG_DATA_DIRS=' + value]), value)


if __name__ == '__main__':
    unittest.main(verbosity=2)
