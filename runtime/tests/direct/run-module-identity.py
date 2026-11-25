#!/usr/bin/env python3
"""Independent module-boundary probes through an unchanged production wrapper."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rootfs', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    args = parser.parse_args()
    root = args.rootfs.resolve()
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    wrapper = root / 'opt/dsh-app/direct/bin/node'
    source = Path(__file__).with_name('module-identity.mjs')
    environment = {
        'PATH': '/usr/bin:/bin', 'HOME': str(root / 'root'),
        'TMPDIR': str(root / 'tmp'), 'UV_USE_IO_URING': '0',
        'NODE_OPTIONS': '--dns-result-order=ipv4first',
    }
    rows = []
    with tempfile.TemporaryDirectory(prefix='review-module-launch-', dir=root / 'tmp') as temporary:
        directory = Path(temporary)
        probe = directory / source.name
        shutil.copyfile(source, probe)
        for label, options in [('default', []), ('preserve-symlinks', ['--preserve-symlinks'])]:
            command = [str(wrapper), *options, str(probe)]
            result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=30)
            (output / (label + '.stdout.json')).write_text(result.stdout)
            (output / (label + '.stderr.log')).write_text(result.stderr)
            parsed = json.loads(result.stdout)
            rows.append({'label': label, 'argv': command, 'environment': environment,
                         'exitCode': result.returncode, 'pass': parsed['pass']})
        # Host TMPDIR can itself be below the disposable root. The negative
        # fixture must be physically outside the permitted execution world.
        with tempfile.TemporaryDirectory(prefix='dsh-review-outside-main-', dir='/tmp') as outside:
            assert not Path(outside).resolve().is_relative_to(root)
            for extension in ['mjs', 'cjs']:
                target = Path(outside) / ('entry.' + extension)
                target.write_text('console.log(JSON.stringify({outsideMainEvaluated:true,node:process.version}));\n')
                alias = directory / ('entry.' + extension)
                alias.symlink_to(target)
                for label, options in [('default-main', []), ('preserve-main', ['--preserve-symlinks-main'])]:
                    name = label + '-' + extension
                    command = [str(wrapper), *options, str(alias)]
                    result = subprocess.run(command, env=environment, capture_output=True, text=True, timeout=10)
                    (output / (name + '.stdout.log')).write_text(result.stdout)
                    (output / (name + '.stderr.log')).write_text(result.stderr)
                    evaluated = 'outsideMainEvaluated' in result.stdout
                    passed = result.returncode != 0 and not evaluated and ('compatible launch' in result.stderr or 'ERR_MODULE_NOT_FOUND' in result.stderr)
                    rows.append({'label': name, 'argv': command, 'environment': environment,
                                 'alias': str(alias), 'realpath': str(target), 'exitCode': result.returncode,
                                 'outsideEvaluated': evaluated, 'pass': passed})
    report = {
        'rootfs': str(root), 'wrapperSha256': hashlib.sha256(wrapper.read_bytes()).hexdigest(),
        'preloadSha256': hashlib.sha256((root / 'opt/dsh-go/direct/preload.mjs').read_bytes()).hexdigest(),
        'probeSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
        'rows': rows,
        'scope': 'Real pinned Node 24.22.1, production generated wrapper/preload, own benign temporary modules; no Android claim.',
    }
    (output / 'results.json').write_text(json.dumps(report, indent=2) + '\n')
    print(json.dumps(rows, indent=2))
    raise SystemExit(0 if all(row['pass'] for row in rows) else 1)


if __name__ == '__main__':
    main()
