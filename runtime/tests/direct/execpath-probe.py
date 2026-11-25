#!/usr/bin/env python3
"""Record exact Node loader identity and the known isolated --test limitation."""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--rootfs', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.rootfs.resolve(); out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
node = root / 'opt/node/bin/node'
loader = root / 'usr/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2'
libraries = ':'.join(str(root / part) for part in ['usr/lib/x86_64-linux-gnu', 'lib/x86_64-linux-gnu', 'usr/lib', 'lib'])
wrapper = root / 'opt/dsh-app/direct/bin/node'
program = '''const cp=require('node:child_process');
const child=cp.spawnSync(process.execPath,['-p','6*7'],{encoding:'utf8'});
console.log(JSON.stringify({node:process.version,execPath:process.execPath,argv0:process.argv[0],
descriptor:Object.getOwnPropertyDescriptor(process,'execPath'),child:{status:child.status,stdout:child.stdout,stderr:child.stderr,error:child.error?.code}}));'''
rows = []
with tempfile.TemporaryDirectory(prefix='direct-execpath-', dir=root / 'tmp') as temporary:
    test = Path(temporary) / 'identity.test.mjs'
    test.write_text("import test from 'node:test'; import assert from 'node:assert/strict'; test('fixture',()=>assert.equal(6*7,42));\n")
    commands = {
        'native-host-interpreter': [str(node), '-e', program],
        'explicit-rootfs-loader': [str(loader), '--library-path', libraries, str(node), '-e', program],
        'production-node-wrapper': [str(wrapper), '-e', program],
        'isolated-test-known-limitation': [str(wrapper), '--test', str(test)],
        'in-process-test-control': [str(wrapper), '--test', '--test-isolation=none', str(test)],
    }
    for name, command in commands.items():
        result = subprocess.run(command, env={'PATH': '/usr/bin:/bin', 'HOME': str(root / 'root'), 'UV_USE_IO_URING': '0'},
                                capture_output=True, text=True, timeout=20)
        (out / (name + '.stdout.log')).write_text(result.stdout)
        (out / (name + '.stderr.log')).write_text(result.stderr)
        rows.append({'name': name, 'argv': command, 'exitCode': result.returncode})
    assert rows[2]['exitCode'] == 0
    assert json.loads((out / 'production-node-wrapper.stdout.log').read_text())['child']['stdout'] == '42\n'
    assert rows[3]['exitCode'] != 0, 'If this upstream limitation changed, review and update the documented boundary.'
    assert rows[4]['exitCode'] == 0
(out / 'inputs-and-results.json').write_text(json.dumps({
    'nodeSha256': hashlib.sha256(node.read_bytes()).hexdigest(),
    'loaderSha256': hashlib.sha256(loader.read_bytes()).hexdigest(),
    'results': rows,
    'scope': 'Host kernel interpreter is an identity control, not an Android claim. Normal spawn/fork work; default Node --test isolation remains unsupported.',
}, indent=2) + '\n')
print('PASS normal child execPath; recorded unsupported isolated Node --test and its in-process control')
