#!/usr/bin/env python3
"""Actual orphan/direct/proot process cleanup; Android /proc access is a device gate."""
import argparse
import json
import os
from pathlib import Path
import signal
import select
import subprocess
import tempfile
import time
from ownership import snapshot, reap, signal_if_same

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--rootfs', type=Path, required=True)
parser.add_argument('--helper', type=Path, required=True)
parser.add_argument('--output', type=Path, required=True)
args = parser.parse_args()
root = args.rootfs.resolve()
outsider = subprocess.Popen(['/bin/sleep', '60'], cwd='/tmp', env={'PATH': '/usr/bin:/bin'}, start_new_session=True)
owned = None; rows = []; report = {}
try:
    with tempfile.TemporaryDirectory(prefix='direct-lifecycle-', dir=root / 'tmp') as directory:
        program = Path(directory) / 'children.mjs'
        program.write_text("""import cp from 'node:child_process';
const child = cp.spawn(process.execPath, ['-e','setInterval(()=>{},1000)'], {env:{PATH:'/usr/bin:/bin'},stdio:'ignore',detached:true});
const guest = cp.spawn('/bin/bash', ['-c','sleep 60'], {env:{PATH:'/usr/bin:/bin'},cwd:'/tmp',stdio:'ignore',detached:true});
child.unref(); guest.unref();
console.log(JSON.stringify({child:child.pid,guest:guest.pid}));
setInterval(()=>{},1000);
""")
        owned = subprocess.Popen([str(root / 'opt/dsh-app/direct/bin/node'), str(program)],
                                 cwd=directory, env={'PATH': '/usr/bin:/bin'}, stdout=subprocess.PIPE,
                                 stderr=subprocess.PIPE, text=True, start_new_session=True)
        assert select.select([owned.stdout], [], [], 5)[0], 'child fixture did not become ready'
        line = owned.stdout.readline()
        assert line, owned.stderr.read()
        children = json.loads(line)
        # Readiness polls, rather than assuming the two wrappers already exec'd.
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            rows = snapshot(root, args.helper)
            if all(pid in {row['pid'] for row in rows} for pid in [owned.pid, *children.values()]):
                break
        assert outsider.pid not in {row['pid'] for row in rows}, 'unrelated same-uid process must survive'
        assert all(pid in {row['pid'] for row in rows} for pid in [owned.pid, *children.values()]), (rows, children)
        known = {row['pid']: row['started'] for row in rows}
        owned.kill(); owned.wait(timeout=5)
        orphans = snapshot(root, args.helper, known)
        assert children['child'] in {row['pid'] for row in orphans}
        cleanup = reap(root, args.helper, known)
        assert cleanup['complete'], cleanup
        assert outsider.poll() is None, 'unrelated same-uid process was killed'
        assert not snapshot(root, args.helper, known)
        report = {'parent': owned.pid, 'children': children, 'before': rows, 'afterParentDeath': orphans,
                  'cleanup': cleanup, 'unrelatedProcessSurvived': True,
                  'scope': 'Linux signals + production ownership classifier; Android visibility/Os.kill still requires a device'}
finally:
    if owned is not None and owned.poll() is None:
        owned.kill(); owned.wait()
    for row in rows:
        signal_if_same(row, signal.SIGKILL)
    outsider.terminate(); outsider.wait(timeout=5)
args.output.write_text(json.dumps(report, indent=2) + '\n')
print('PASS direct parent, orphan child node, PRoot tool tree and unrelated-process exclusion')
