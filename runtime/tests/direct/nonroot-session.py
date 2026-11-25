#!/usr/bin/env python3
"""Real non-root direct session/create and registered workspace write/read gate.

Only supply a disposable test rootfs. A root parent changes ownership of this
copy to UID65534. Its ancestors must be traversable by that UID. Existing
workspace bytes are moved aside and restored; host /root is never modified.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import re
import select
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import uuid


def request(port, path, cookie=None, payload=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
    headers = {} if cookie is None else {'Cookie': cookie}
    body = None if payload is None else json.dumps(payload).encode()
    if body is not None:
        headers['Content-Type'] = 'application/json'
    connection.request('GET' if payload is None else 'POST', path, body, headers)
    response = connection.getresponse()
    result = {'status': response.status, 'headers': {k.lower(): v for k, v in response.getheaders()},
              'body': response.read().decode()}
    connection.close()
    return result


def rpc(port, cookie, method, args):
    result = request(port, '/api/' + method, cookie, {
        'type': 'client-request', 'rpcId': str(uuid.uuid4()), 'method': method, 'payload': {'args': args},
    })
    return {'status': result['status'], 'data': json.loads(result['body'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ['rootfs', 'manifest', 'proot', 'planner', 'output']:
        parser.add_argument('--' + name, required=True, type=Path)
    parser.add_argument('--disposable-rootfs', action='store_true', required=True)
    args = parser.parse_args()
    root = args.rootfs.resolve()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=False)
    assert root != Path('/') and (root / 'opt/dsh-go/direct/preload.mjs').is_file()
    assert not any((root / 'root/.l2s').iterdir()), 'use a disposable fixture without fake hard links'
    uid = 65534 if os.geteuid() == 0 else os.geteuid()
    gid = 65534 if os.geteuid() == 0 else os.getegid()
    assert uid != 0
    identity = {'user': uid, 'group': gid, 'extra_groups': []} if os.geteuid() == 0 else {}
    base = Path(tempfile.mkdtemp(prefix='dsh-direct-nonroot-'))
    base.chmod(0o755)
    plan = base / 'plan'
    plan.mkdir()
    suffix = uuid.uuid4().hex
    fixture_guest = '/tmp/direct-nonroot-' + suffix
    profile_guest = '/tmp/direct-nonroot-profile-' + suffix
    fixture = root / fixture_guest.lstrip('/')
    profile = root / profile_guest.lstrip('/')
    workspace = root / 'root/workspace'
    backup = None
    process = None
    pending = b''
    log = []
    result = {'uid': uid, 'gid': gid, 'passed': False,
              'scope': 'Linux real non-root engine, production planner/RPC/file tools; no Android claim'}

    def save(name, value):
        (out / name).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

    def nul(path):
        return [item for item in path.read_text().split('\0') if item]

    try:
        if workspace.exists():
            assert workspace.is_dir() and not workspace.is_symlink()
            backup = workspace.with_name('workspace-nonroot-backup-' + suffix)
            workspace.rename(backup)
        assert not workspace.exists(), 'the RPC must create the directory'
        with socket.socket() as listener:
            listener.bind(('127.0.0.1', 0))
            port = listener.getsockname()[1]
        manifest = json.loads(args.manifest.read_text())
        launch = manifest['launch']['argv']
        tail = [v.replace('{PORT}', str(port)) for v in launch[launch.index('/usr/bin/env'):] if v != '{GUEST_ENV}']
        fixture.mkdir()
        shutil.copyfile(Path(__file__).with_suffix('.mjs'), fixture / 'fixture.mjs')
        (fixture / 'probe.patch.yml').write_text('- insert:\n    - id: dsh-direct-nonroot-test\n      name: ' + fixture_guest + '/fixture.mjs\n')
        tail[-1] = tail[-1].replace('dsh-web.patch.yml', 'dsh-web.patch.yml --patch ' + fixture_guest + '/probe.patch.yml')
        shell_at = tail.index('/bin/sh')
        tail[shell_at:shell_at] = ['DSH_HOME=' + profile_guest, 'DSH_GO_RUNTIME_ROOT=' + str(root),
                                 'DEEPSEEK_API_KEY=sk-nonroot-fixture-not-a-real-key']
        argv = [str(args.proot.resolve()), '--kill-on-exit', '--link2symlink', '--sysvipc', '-L', '-0',
                '--rootfs=' + str(root), '--cwd=/root', '-b', '/dev', '-b', '/proc', *tail]
        environment = {'PATH': '/usr/bin:/bin', 'HOME': str(base), 'PROOT_L2S_DIR': str(root / 'root/.l2s')}
        (plan / 'input-argv.nul').write_text('\0'.join(argv) + '\0')
        (plan / 'input-env.nul').write_text('\0'.join(f'{k}={v}' for k, v in environment.items()) + '\0')
        command = ['java', '-jar', str(args.planner.resolve()), str(root), 'x86_64',
                   str(plan / 'input-argv.nul'), str(plan / 'input-env.nul'), str(plan), '/bin/sh']
        planned = subprocess.run(command, text=True, capture_output=True, timeout=30)
        save('planner-command.json', {'argv': command, 'exit': planned.returncode})
        (out / 'planner.log').write_text(planned.stdout + planned.stderr)
        assert planned.returncode == 0, planned.stderr
        selection = json.loads((plan / 'selection.json').read_text())
        assert selection['actual'] == 'direct' and selection['fallbackReason'] is None, selection
        assert (root / 'root/.dsh-go-direct-path-alias').read_text() == 'v1\n' + str(root) + '\n'
        result['physicalAliasPersistedWithHome'] = True
        argv = nul(plan / 'argv.nul')
        environment = dict(item.split('=', 1) for item in nul(plan / 'env.nul'))
        cwd = (plan / 'cwd.txt').read_text()
        if os.geteuid() == 0:
            for parent, directories, files in os.walk(root, followlinks=False):
                os.chown(parent, uid, gid, follow_symlinks=False)
                for name in directories + files:
                    os.chown(Path(parent) / name, uid, gid, follow_symlinks=False)
        preflight_code = """import json,os,pathlib,stat
assert os.geteuid()!=0
s=os.stat('/root')
print(json.dumps({'uid':os.getuid(),'euid':os.geteuid(),'gid':os.getgid(),'groups':os.getgroups(),
'rootUid':s.st_uid,'rootMode':stat.S_IMODE(s.st_mode),'rootWritable':os.access('/root',os.W_OK|os.X_OK),
'capEff':next(line.split(':')[1].strip() for line in pathlib.Path('/proc/self/status').read_text().splitlines() if line.startswith('CapEff:'))}))
"""
        preflight = subprocess.run([sys.executable, '-c', preflight_code], cwd=cwd, env={'PATH': '/usr/bin:/bin'},
                                   text=True, capture_output=True, timeout=10, **identity)
        save('launcher-preflight.json', {'exit': preflight.returncode, 'stdout': preflight.stdout, 'stderr': preflight.stderr})
        assert preflight.returncode == 0, preflight.stderr
        launcher = json.loads(preflight.stdout)
        assert launcher['euid'] == uid and launcher['rootUid'] == 0 and not launcher['rootWritable']
        assert int(launcher['capEff'], 16) == 0 and (not identity or launcher['groups'] == [])
        save('launch.json', {'argv': argv, 'environment': environment, 'cwd': cwd, 'selection': selection,
                            'uid': uid, 'gid': gid, 'identity': identity, 'port': port})
        process = subprocess.Popen(argv, env=environment, cwd=cwd, umask=0o077, stdout=subprocess.PIPE,
                                   stderr=subprocess.STDOUT, start_new_session=True, **identity)
        result['pid'] = process.pid
        token = None
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and process.poll() is None and token is None:
            readable, _, _ = select.select([process.stdout], [], [], 0.1)
            if not readable:
                continue
            chunk = os.read(process.stdout.fileno(), 65536)
            if not chunk:
                break
            pending += chunk
            while b'\n' in pending:
                raw, pending = pending.split(b'\n', 1)
                line = raw.decode(errors='replace')
                log.append(re.sub(r'token=[A-Za-z0-9._~%-]+', 'token=<redacted>', line))
                match = re.search(r'http://127\.0\.0\.1:[0-9]+/\?token=([A-Za-z0-9_-]+)', line)
                if match:
                    token = match.group(1)
        assert token, 'engine did not publish a local authentication token'
        exchange = request(port, '/?token=' + token)
        assert exchange['status'] == 303
        cookie = exchange['headers']['set-cookie'].split(';', 1)[0]
        preflight = request(port, '/direct-nonroot-test/preflight', cookie)
        save('node-preflight-response.json', preflight)
        assert preflight['status'] == 200, preflight
        node = json.loads(preflight['body'])
        assert node['euid'] == uid and node['uid'] == uid
        assert node['hostRoot']['uid'] == 0 and node['hostRoot']['writable'] is False
        assert any(line.startswith('CapEff:') and int(line.split(':', 1)[1].strip(), 16) == 0 for line in node['capabilities'])
        controller = root / 'opt/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/index.js'
        assert node['controllerSha256'] == hashlib.sha256(controller.read_bytes()).hexdigest()
        created = rpc(port, cookie, 'session/create', {'request': {'cwd': '/root/workspace'}})
        save('guest-cwd-create-response.json', created)
        assert created['status'] == 200 and created['data']['result']['ok'] is True, created
        assert workspace.is_dir() and workspace.stat().st_uid == uid
        session_id = created['data']['result']['value']['sessionId']
        response = request(port, '/direct-nonroot-test/files?sessionId=' + session_id, cookie)
        save('registered-tools-response.json', response)
        assert response['status'] == 200, response
        files = json.loads(response['body'])
        assert files['headerCwd'] == '/root/workspace', 'preserve caller metadata spelling'
        assert not files['write']['isError'] and not files['read']['isError'], files
        assert files['content'].strip() in json.dumps(files['read']), files
        physical_file = Path(files['physicalFilename'])
        assert physical_file.parent == workspace and not physical_file.is_symlink()
        assert physical_file.read_text() == files['content'] and physical_file.stat().st_uid == uid
        result.update(passed=True, sessionId=session_id, headerCwd=files['headerCwd'],
                      createdWorkspaceUid=workspace.stat().st_uid, writtenFileUid=physical_file.stat().st_uid,
                      guestCwdCreateSucceeded=True, registeredToolsRoundTripSucceeded=True)
    except BaseException as error:
        result['error'] = repr(error)
        raise
    finally:
        if process is not None:
            if process.poll() is None:
                process.send_signal(signal.SIGTERM)
            try:
                remaining, _ = process.communicate(timeout=8)
            except subprocess.TimeoutExpired:
                process.kill()
                remaining, _ = process.communicate(timeout=5)
                result['forcedStopRequired'] = True
            log.extend(re.sub(r'token=[A-Za-z0-9._~%-]+', 'token=<redacted>', line)
                       for line in (pending + remaining).decode(errors='replace').splitlines())
            result['engineExitCode'] = process.returncode
            result['ownedProcessStillPresent'] = Path(f'/proc/{process.pid}').exists()
        (out / 'engine.log').write_text('\n'.join(log) + '\n')
        clean = not any((root / 'root/.l2s').iterdir())
        result['cleanupAllowedWithoutFakeLinks'] = clean
        if clean:
            if workspace.exists():
                shutil.rmtree(workspace)
            if backup is not None:
                backup.rename(workspace)
            for path in [fixture, profile, base]:
                if path.exists():
                    shutil.rmtree(path)
        save('result.json', result)
    assert result['passed'] and result['engineExitCode'] == 0 and not result['ownedProcessStillPresent'], result
    assert result['cleanupAllowedWithoutFakeLinks'], result
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main()
