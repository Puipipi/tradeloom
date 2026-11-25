#!/usr/bin/env python3
"""One persisted session: direct -> proot -> requested direct/actual fallback.

No model request, profile migration, or broad backing-store cleanup. The
runner's own fixtures are removed through PRoot to retain its link counts.
"""
import argparse
import hashlib
import json
from pathlib import Path
import subprocess
import sys


def nul(file):
    return [value for value in file.read_text().split('\0') if value]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['rootfs', 'manifest', 'proot', 'planner', 'ownership-helper', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--port', type=int, default=39134)
    args = parser.parse_args()
    root = args.rootfs.resolve()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    assert not any((root / 'root/.l2s').iterdir()), 'start with an empty disposable fixture backing store'
    runner = Path(__file__).with_name('run-host.py')
    common = [sys.executable, str(runner), '--rootfs', str(root), '--manifest', str(args.manifest.resolve()),
        '--proot', str(args.proot.resolve()), '--planner', str(args.planner.resolve()),
        '--ownership-helper', str(args.ownership_helper.resolve()), '--samples', '1', '--keep-profiles', '--port', str(args.port)]
    rows = []; commands = []; prefix = None; host_env = None

    def stage(name, mode, previous=None):
        destination = out / name
        command = common + ['--mode', mode, '--output', str(destination)]
        if previous is None:
            command += ['--physical-session-cwd']
        else:
            command += ['--resume-result', str(previous)]
        commands.append(command)
        result = subprocess.run(command, text=True, capture_output=True, timeout=180)
        (out / (name + '.log')).write_text(result.stdout + result.stderr)
        (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')
        assert result.returncode == 0, name + ': ' + result.stderr
        row = json.loads((destination / 'results.json').read_text())[0]
        assert row['orphanCleanup']['complete'], row['orphanCleanup']
        rows.append(row)
        return destination / ('0-' + mode) / 'result.json'

    try:
        first = stage('1-direct', 'direct')
        assert rows[-1]['mode'] == 'direct'
        assert rows[-1]['identity']['headerCwd'] == str(root / 'root/workspace')
        plan = first.parent
        argv = nul(plan / 'input-argv.nul'); prefix = argv[:argv.index('/usr/bin/env')]
        host_env = dict(value.split('=', 1) for value in nul(plan / 'input-env.nul'))
        second = stage('2-compatible', 'proot', first)
        assert rows[-1]['mode'] == 'proot'

        # New fake links can arise after the initial launch. Preserve the
        # completed operation and demonstrate the next launch's actual mode.
        home = rows[-1]['profileGuestPath']
        source = home + '/rollback-source.txt'; alias = home + '/rollback-alias.txt'
        content = b'completed PRoot operation survives the next direct preference\n'
        root.joinpath(source.lstrip('/')).write_bytes(content)
        command = prefix + ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/bin/ln', source, alias]
        commands.append(command)
        linked = subprocess.run(command, env=host_env, text=True, capture_output=True, timeout=15)
        assert linked.returncode == 0, linked.stderr
        assert root.joinpath(alias.lstrip('/')).is_symlink(), 'production link2symlink was not active'
        assert any((root / 'root/.l2s').iterdir())
        stage('3-preference-falls-back', 'direct', second)
        assert rows[-1]['requestedMode'] == 'direct' and rows[-1]['mode'] == 'proot'
        assert rows[-1]['fallbackReason'] == 'incompatibleFiles'
        read = subprocess.run(prefix + ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/bin/cat', alias],
            env=host_env, capture_output=True, timeout=15)
        assert read.returncode == 0 and read.stdout == content
        report = {'scope': 'Linux exact-source PRoot; same real persisted session and profile; no Android claim',
            'requested': [row['requestedMode'] for row in rows], 'actual': [row['mode'] for row in rows],
            'sessionIds': [row['sessionId'] for row in rows],
            'headerCwd': [row['identity']['headerCwd'] for row in rows],
            'effectiveCwd': [row['identity']['effectiveCwd'] for row in rows],
            'previousWritesReadBeforeReplacement': True, 'lateGuestWritePreserved': True,
            'lateWriteSha256': hashlib.sha256(content).hexdigest()}
        assert len(set(report['sessionIds'])) == 1 and len(set(report['headerCwd'])) == 1
        (out / 'result.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps(report, indent=2))
    finally:
        if prefix is not None and rows:
            owned = [rows[0]['profileGuestPath'], rows[0]['probeFileGuestPath']]
            cleanup = subprocess.run(prefix + ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', '/bin/rm', '-rf', '--', *owned],
                env=host_env, text=True, capture_output=True, timeout=15)
            result = {'exitCode': cleanup.returncode, 'stderr': cleanup.stderr,
                'pathsRemain': [path for path in owned if root.joinpath(path.lstrip('/')).exists()],
                'backingCountAfter': sum(1 for _ in (root / 'root/.l2s').iterdir())}
            (out / 'cleanup.json').write_text(json.dumps(result, indent=2) + '\n')
            assert cleanup.returncode == 0 and not result['pathsRemain'] and result['backingCountAfter'] == 0, result
        (out / 'commands.json').write_text(json.dumps(commands, indent=2) + '\n')


if __name__ == '__main__':
    main()
