#!/usr/bin/env python3
"""Network opt-in CLI gate: actual DSH profile plugin add/remove with locked pnpm."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile

parser = argparse.ArgumentParser()
parser.add_argument('--prefix', required=True, type=Path)
parser.add_argument('--pnpm-prefix', required=True, type=Path)
parser.add_argument('--out', required=True, type=Path)
args = parser.parse_args()
args.out.mkdir(parents=True, exist_ok=True)
prefix = args.prefix.resolve()
pnpm = args.pnpm_prefix.resolve()
assert json.loads((prefix / 'node_modules/@deepseek-ai/dsh/package.json').read_text())['version'] == '0.2.2-rc.1'
assert json.loads((pnpm / 'node_modules/pnpm/package.json').read_text())['version'] == '11.28.5'
node = shutil.which('node')
assert node
with tempfile.TemporaryDirectory(prefix='plugin-cli-', dir=args.out.resolve()) as temporary:
    home = Path(temporary)
    env = dict(os.environ, HOME=str(home), DSH_HOME=str(home / 'dsh'),
               PATH=str(pnpm / 'node_modules/.bin') + os.pathsep + os.environ['PATH'])
    profile = home / 'dsh/profiles/web'
    observations = []
    def run(label, *command):
        with (args.out / (label + '.log')).open('w') as output:
            subprocess.run([node, str(prefix / 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
                            'plugin', '--profile', 'web', *command], env=env,
                           stdout=output, stderr=subprocess.STDOUT, check=True, timeout=180)
    def check(label, installed, patch):
        package = json.loads((profile / 'package.json').read_text())
        assert ('dsh-git-badge' in package.get('dependencies', {})) == installed
        assert ('dsh-git-badge' in package['dsh']['profile']['bundles']) == installed
        assert (profile / 'node_modules/dsh-git-badge').exists() == installed
        assert package['description'] == 'W17 unrelated manifest field'
        assert (profile / 'cordis.patch.yml').read_bytes() == patch
        observations.append(dict(stage=label, installed=installed, unrelatedManifestPreserved=True,
                                 userPatchSha256=hashlib.sha256(patch).hexdigest()))
    run('add', 'add', 'dsh-git-badge@0.20.1')
    package = json.loads((profile / 'package.json').read_text())
    assert package['dependencies']['dsh-git-badge'] == '0.20.1'
    package['description'] = 'W17 unrelated manifest field'
    (profile / 'package.json').write_text(json.dumps(package, indent=2) + '\n')
    patch = b'# W17 user patch sentinel\n- id: session-title-llm\n  disabled: true\n'
    (profile / 'cordis.patch.yml').write_bytes(patch)
    check('added', True, patch)
    run('remove', 'remove', 'dsh-git-badge')
    check('removed', False, patch)
    run('readd', 'add', 'dsh-git-badge@0.20.1')
    check('readded', True, patch)
    run('final-remove', 'remove', 'dsh-git-badge')
    check('finally-removed', False, patch)
    evidence = dict(result='PASS', dsh='0.2.2-rc.1', pnpm='11.28.5',
                    plugin='dsh-git-badge@0.20.1', observations=observations,
                    scope='actual host CLI; not Android, direct rootfs, or UI cancellation')
    (args.out / 'result.json').write_text(json.dumps(evidence, indent=2) + '\n')
    print(json.dumps(evidence))
