"""Linux process signals using the production Kotlin ownership classification."""
import json
import os
from pathlib import Path
import signal
import subprocess
import time


def snapshot(root, helper, known=None):
    state = ','.join(f'{pid}:{started}' for pid, started in (known or {}).items())
    result = subprocess.run(['java', '-jar', str(helper), str(root), state], capture_output=True, text=True, check=True)
    return json.loads(result.stdout)


def signal_if_same(row, sig):
    try:
        process = Path('/proc') / str(row['pid'])
        tail = (process / 'stat').read_text().rsplit(') ', 1)[1].split()
        if process.stat().st_uid == os.getuid() and tail[19] == row['started']:
            os.kill(row['pid'], sig)
    except (FileNotFoundError, ProcessLookupError):
        pass


def reap(root, helper, known=None):
    known = dict(known or {})
    attempts = []; deadline = time.monotonic() + 2; first = True
    while True:
        rows = snapshot(root, helper, known)
        if not rows:
            return {'complete': True, 'attempts': attempts}
        attempts.append(rows)
        known.update({row['pid']: row['started'] for row in rows})
        for row in rows:
            signal_if_same(row, signal.SIGQUIT if first and row['proot'] else signal.SIGKILL)
        first = False
        if time.monotonic() >= deadline:
            return {'complete': False, 'attempts': attempts}
        time.sleep(.025)
