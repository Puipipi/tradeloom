#!/usr/bin/env python3
"""Host measurements with the production Kotlin plan and pinned rootfs.

The Linux proot executable/version is recorded separately from Android's
Termux libproot. No result here proves Android execution permission or latency.
"""
import argparse
import hashlib
import http.client
import json
import os
from pathlib import Path
import platform
import re
import select
import shutil
import signal
import subprocess
import time
import uuid


def nul_read(file):
    return [value for value in Path(file).read_text().split('\0') if value]


def nul_write(file, values):
    Path(file).write_text('\0'.join(values) + '\0')


def owned_fixture(file, content):
    """A reusable host runner must never replace a user's AGENTS/skill file."""
    file.parent.mkdir(parents=True, exist_ok=True)
    if file.is_symlink() or (file.exists() and file.read_text() != content):
        raise RuntimeError(f'refusing to overwrite a non-fixture file: {file}')
    file.write_text(content)


def request(port, path, cookie=None, payload=None):
    connection = http.client.HTTPConnection('127.0.0.1', port, timeout=30)
    headers = {'Cookie': cookie} if cookie else {}
    body = None
    if payload is not None:
        body = json.dumps(payload).encode()
        headers['Content-Type'] = 'application/json'
    start = time.monotonic_ns()
    connection.request('POST' if body else 'GET', path, body=body, headers=headers)
    response = connection.getresponse()
    data = response.read()
    result = {'status': response.status, 'headers': {key.lower(): value for key, value in response.getheaders()},
              'body': data, 'ms': (time.monotonic_ns() - start) / 1e6}
    connection.close()
    return result


def rpc(port, cookie, method, args):
    response = request(port, '/api/' + method, cookie, {
        'type': 'client-request', 'rpcId': str(uuid.uuid4()), 'method': method, 'payload': {'args': args}})
    assert response['status'] == 200, (method, response)
    data = json.loads(response['body'])
    assert data.get('result', {}).get('ok') is True, (method, data)
    return data['result']['value'], response['ms']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--rootfs', type=Path, required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--proot', type=Path, required=True)
    parser.add_argument('--proot-library-path', default='')
    parser.add_argument('--planner', type=Path, required=True)
    parser.add_argument('--ownership-helper', type=Path, help='Linux adapter for the production process ownership classifier')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--samples', type=int, default=3)
    parser.add_argument('--port', type=int, default=39120)
    parser.add_argument('--mode', choices=['both', 'direct', 'proot'], default='both')
    parser.add_argument('--chromium', type=Path, help='optional real browser PaintTiming; requires host playwright')
    parser.add_argument('--proot-source-sha256', help='source archive identity when upstream version output is generic')
    parser.add_argument('--disable-proot-seccomp', action='store_true', help='explicit diagnostic override; production default leaves seccomp enabled')
    parser.add_argument('--keep-profiles', action='store_true', help='retain this runner\'s temporary profile for an explicit rollback experiment')
    parser.add_argument('--resume-result', type=Path, help='reuse this harness\'s retained profile/session from a previous result.json; not a fresh-profile timing sample')
    parser.add_argument('--physical-session-cwd', action='store_true', help='create a physical-root cwd session for the explicit mode-switch experiment')
    args = parser.parse_args()
    previous = json.loads(args.resume_result.read_text()) if args.resume_result else None
    if previous:
        assert args.samples == 1 and args.mode != 'both' and args.keep_profiles, 'resume requires one retained, explicit-mode sample'
        assert previous['profileGuestPath'].startswith('/tmp/direct-profiles/')
        assert previous['probeFileGuestPath'].startswith('/root/workspace/direct-probe-')
    root = args.rootfs.resolve()
    out = args.output.resolve(); out.mkdir(parents=True, exist_ok=True)
    source = Path(__file__).resolve().parent
    manifest = json.loads(args.manifest.read_text())
    guest = manifest['launch']['argv']
    guest = guest[guest.index('/usr/bin/env'):]
    guest = [value for value in guest if value != '{GUEST_ENV}']
    root.joinpath('root/workspace').mkdir(parents=True, exist_ok=True)
    owned_fixture(root.joinpath('root/workspace/AGENTS.md'), '# Test workspace\n\ndirect-host-agent-instructions-sentinel\n')
    skill = root / 'root/workspace/.dsh/skills/direct-host-fixture'
    skill.mkdir(parents=True, exist_ok=True)
    owned_fixture(skill / 'SKILL.md', '---\nname: direct-host-fixture\ndescription: Local direct/proot path verification fixture.\n---\n\nKeep $DSH_HOME paths intact.\n')
    fixture = root / 'tmp/direct-tests'; fixture.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source / 'fixture.mjs', fixture / 'fixture.mjs')
    shutil.copy2(source / 'processes.test.mjs', fixture / 'processes.test.mjs')
    shutil.copy2(source / 'timing.mjs', fixture / 'timing.mjs')
    (fixture / 'probe.patch.yml').write_text('- insert:\n    - id: dsh-app-direct-host-probe\n      name: /tmp/direct-tests/fixture.mjs\n')
    # Linux proot intentionally uses only the supported common flags. The
    # production DirectLaunch still consumes the fully composed argv afterward.
    l2s = root / 'root/.l2s'; l2s.mkdir(exist_ok=True)
    host_env = {'PATH': '/usr/bin:/bin', 'HOME': str(out), 'PROOT_L2S_DIR': str(l2s)}
    if args.disable_proot_seccomp:
        host_env['PROOT_NO_SECCOMP'] = '1'
    if args.proot_library_path:
        host_env['LD_LIBRARY_PATH'] = str(Path(args.proot_library_path).resolve())
    proot = str(args.proot.resolve())
    help_text = subprocess.run([proot, '--help'], env=host_env, text=True, capture_output=True, check=True).stdout
    flags = [flag for flag in ['--kill-on-exit', '--link2symlink', '--sysvipc', '-L'] if flag in help_text]
    prefix = [proot, *flags, '-0', '--rootfs=' + str(root), '--cwd=/root', '-b', '/dev', '-b', '/proc']
    version = subprocess.run([proot, '--version'], env=host_env, text=True, capture_output=True)
    (out / 'inputs.json').write_text(json.dumps({
        'rootfs': str(root), 'manifest': str(args.manifest.resolve()),
        'nodeSha256': hashlib.sha256((root / 'opt/node/bin/node').read_bytes()).hexdigest(),
        'proot': proot, 'prootSha256': hashlib.sha256(Path(proot).read_bytes()).hexdigest(),
        'prootVersionOutput': version.stdout + version.stderr,
        'prootSourceSha256': args.proot_source_sha256, 'prootFlags': flags,
        'seccompDisabled': args.disable_proot_seccomp,
        'host': {'kernel': platform.release(), 'machine': platform.machine(), 'cpuCount': os.cpu_count()},
        'scope': 'Linux host: warm OS page cache; fresh per-run DSH profiles; optional browser PaintTiming is reported separately; not Android',
        'fileOperation': 'pre-observe regular fixture; timed write replacement + read; new-file L2S compatibility tested separately',
    }, ensure_ascii=False, indent=2) + '\n')
    records = []
    run_id = uuid.uuid4().hex[:12]
    modes = ['proot', 'direct'] if args.mode == 'both' else [args.mode]
    for sample in range(args.samples):
        # Alternate order so a fixed direct-second ordering does not masquerade
        # as a launch-method effect. Both share precisely this rootfs input.
        order = modes if sample % 2 == 0 else list(reversed(modes))
        for mode in order:
            plan = out / f'{sample}-{mode}'; plan.mkdir(exist_ok=True)
            tail = [value.replace('{PORT}', str(args.port)) for value in guest]
            command = tail[-1].replace('dsh-web.patch.yml', 'dsh-web.patch.yml --patch /tmp/direct-tests/probe.patch.yml')
            tail[-1] = command
            shell_at = tail.index('/bin/sh')
            home = previous['profileGuestPath'] if previous else f'/tmp/direct-profiles/{run_id}/{sample}-{mode}'
            probe_file = previous['probeFileGuestPath'] if previous else f'/root/workspace/direct-probe-{run_id}-{sample}-{mode}.txt'
            if not previous:
                with root.joinpath(probe_file.lstrip('/')).open('x') as fixture_file:
                    fixture_file.write('direct-host-existing-file-fixture\n')
            tail[shell_at:shell_at] = [f'DSH_HOME={home}', 'DSH_GO_RUNTIME_ROOT=' + str(root),
                'DSH_GO_HOST_PROBE_FILE=' + probe_file,
                'DEEPSEEK_API_KEY=sk-dsh-app-smoke-test-not-a-real-key']
            argv = prefix + tail
            environment = host_env.copy()
            cwd = str(root / 'root')
            nul_write(plan / 'input-argv.nul', argv)
            nul_write(plan / 'input-env.nul', [f'{key}={value}' for key, value in environment.items()])
            subprocess.run(['java', '-jar', str(args.planner.resolve()), str(root), 'x86_64',
                            str(plan / 'input-argv.nul'), str(plan / 'input-env.nul'), str(plan), '/bin/sh', mode], check=True)
            argv = nul_read(plan / 'argv.nul')
            environment = dict(value.split('=', 1) for value in nul_read(plan / 'env.nul'))
            cwd = (plan / 'cwd.txt').read_text()
            selection = json.loads((plan / 'selection.json').read_text())
            # Instrument the actual mode after the production planner decides.
            # A fresh default PRoot no longer exposes physical rootfs aliases.
            if selection['actual'] == 'direct':
                environment['NODE_OPTIONS'] = environment.get('NODE_OPTIONS', '') + f' --import={fixture}/timing.mjs'
            else:
                argv = [value + ' --import=/tmp/direct-tests/timing.mjs' if value.startswith('NODE_OPTIONS=') else value for value in argv]
            nul_write(plan / 'executed-argv.nul', argv)
            nul_write(plan / 'executed-env.nul', [f'{key}={value}' for key, value in environment.items()])
            log = []
            root.joinpath('tmp/dsh-web.pid').unlink(missing_ok=True)
            start_epoch_ms = time.time_ns() / 1e6
            start = time.monotonic_ns()
            process = subprocess.Popen(argv, env=environment, cwd=cwd, stdout=subprocess.PIPE,
                                       stderr=subprocess.STDOUT, start_new_session=True)
            record = {'mode': selection['actual'], 'requestedMode': mode, 'fallbackReason': selection['fallbackReason'],
                      'sample': sample, 'pid': process.pid, 'phases': {}, 'startupEvents': [], 'spawnEpochMs': start_epoch_ms,
                      'profileGuestPath': home, 'probeFileGuestPath': probe_file}
            if previous:
                record['resumedFrom'] = str(args.resume_result.resolve())
            try:
                token = None; pending = b''
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline and process.poll() is None:
                    readable, _, _ = select.select([process.stdout], [], [], .1)
                    if not readable:
                        continue
                    chunk = os.read(process.stdout.fileno(), 65536)
                    if not chunk:
                        break
                    pending += chunk
                    while b'\n' in pending:
                        raw, pending = pending.split(b'\n', 1)
                        line = raw.decode(errors='replace')
                        elapsed = (time.monotonic_ns() - start) / 1e6
                        log.append(f'{elapsed:.3f} ms {re.sub(r"token=[A-Za-z0-9._~%-]+", "token=<redacted>", line)}')
                        if line.startswith('[direct-host-timing] '):
                            record['startupEvents'].append(json.loads(line.removeprefix('[direct-host-timing] ')))
                        match = re.search(r'http://127\.0\.0\.1:[0-9]+/\?token=([A-Za-z0-9_-]+)', line)
                        if match:
                            token = match.group(1); record['phases']['tokenMs'] = elapsed
                    if token:
                        break
                assert token, 'engine did not publish a token; see log'
                events = record['startupEvents']
                listened = next((event for event in events if event['event'] == 'listen' and isinstance(event.get('address'), dict) and event['address'].get('port') == args.port), None)
                token_event = next((event for event in events if event['event'] == 'token'), None)
                if listened:
                    record['phases']['execChainMs'] = listened['timeOrigin'] - start_epoch_ms
                    record['phases']['nodeToListenMs'] = listened['atMs']
                    if token_event: record['phases']['listenToTokenMs'] = token_event['atMs'] - listened['atMs']
                exchange = request(args.port, '/?token=' + token)
                assert exchange['status'] == 303, exchange
                cookie = exchange['headers']['set-cookie'].split(';', 1)[0]
                record['phases']['authMs'] = exchange['ms']
                models, elapsed = rpc(args.port, cookie, 'session/modelCatalog', {})
                record['phases']['modelListMs'] = elapsed
                record['modelCatalog'] = models
                if previous:
                    created = {'sessionId': previous['sessionId']}
                else:
                    session_cwd = str(root / 'root/workspace') if args.physical_session_cwd else '/root/workspace'
                    created, elapsed = rpc(args.port, cookie, 'session/create', {'request': {'cwd': session_cwd}})
                    record['phases']['sessionCreateMs'] = elapsed
                record['sessionId'] = created['sessionId']
                if args.keep_profiles:
                    identity = request(args.port, '/direct-host-probe/identity?sessionId=' + created['sessionId'], cookie)
                    assert identity['status'] == 200, identity
                    record['identity'] = json.loads(identity['body'])
                    if previous:
                        assert record['identity']['sessionId'] == previous['sessionId']
                        assert record['identity']['headerCwd'] == previous['identity']['headerCwd']
                        record['phases']['sessionResumeMs'] = identity['ms']
                for operation in ['files', 'terminal', 'instructions']:
                    response = request(args.port, '/direct-host-probe/' + operation + '?sessionId=' + created['sessionId'], cookie)
                    assert response['status'] == 200, response
                    value = json.loads(response['body'])
                    record[operation] = value
                    record['phases'][operation + 'HttpMs'] = response['ms']
                    if operation == 'files':
                        assert not value['observed']['isError'], value
                        if previous:
                            assert previous['files']['expected'] in json.dumps(value['observed']), 'prior completed write did not survive mode switch'
                        assert not value['write']['isError'] and not value['read']['isError'], value
                        assert value['expected'] in json.dumps(value['read']), value
                        assert value['denied']['isError'] and value['denied']['error']['info']['code'] == 'FS_SANDBOX_DENIED', value
                    elif operation == 'terminal':
                        assert value['outcome']['exitCode'] == 0 and 'direct-pty-ok' in value['output'] and '42' in value['output'], value
                    else:
                        assert 'direct-host-agent-instructions-sentinel' in json.dumps(value), value
                references, elapsed = rpc(args.port, cookie, 'fileReferences/list', {'agentId': created['sessionId'], 'query': Path(record['files']['requested']).name})
                assert Path(record['files']['requested']).name in json.dumps(references), references
                record['references'] = references; record['phases']['referencesMs'] = elapsed
                skills, elapsed = rpc(args.port, cookie, 'skills/list', {'request': {'sessionId': created['sessionId']}})
                assert 'direct-host-fixture' in json.dumps(skills), skills
                record['skills'] = skills; record['phases']['skillsMs'] = elapsed
                stat, elapsed = rpc(args.port, cookie, 'workspaceFiles/stat', {
                    'workspaceFileScopeId': created['sessionId'], 'path': record['files']['requested']})
                record['fileStat'] = stat; record['phases']['fileStatMs'] = elapsed
                page = request(args.port, '/', cookie)
                assert page['status'] == 200 and b'<html' in page['body'], (page['status'], page['body'][:100])
                record['phases']['htmlResponseMs'] = page['ms']
                record['htmlBytes'] = len(page['body'])
                record['note'] = 'HTML response time is not a browser paint measurement.'
                if args.chromium:
                    browser = subprocess.run(['node', str(source / 'browser-paint.cjs')], input=json.dumps({
                        'baseUrl': f'http://127.0.0.1:{args.port}/', 'cookie': cookie,
                        'executablePath': str(args.chromium.resolve()), 'screenshot': str(plan / 'first-screen.png'),
                    }), text=True, capture_output=True, timeout=45)
                    (plan / 'browser.stderr.log').write_text(browser.stderr)
                    assert browser.returncode == 0, browser.stderr
                    record['browser'] = json.loads(browser.stdout)
            finally:
                pidfile = root / 'tmp/dsh-web.pid'
                known = {}
                if args.ownership_helper:
                    from ownership import snapshot, reap
                    record['processTreeBeforeStop'] = snapshot(root, args.ownership_helper)
                    known = {row['pid']: row['started'] for row in record['processTreeBeforeStop']}
                stop_start = time.monotonic_ns()
                if pidfile.exists():
                    try:
                        target = int(pidfile.read_text().strip())
                        if (Path('/proc') / str(target) / 'cmdline').exists():
                            os.kill(target, signal.SIGTERM)
                    except (ValueError, ProcessLookupError):
                        pass
                try:
                    process.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    record['forcedStop'] = True
                    os.killpg(process.pid, signal.SIGKILL); process.wait()
                record['stopMs'] = (time.monotonic_ns() - stop_start) / 1e6
                record['exitCode'] = process.returncode
                if args.ownership_helper:
                    reap_start = time.monotonic_ns()
                    record['orphanCleanup'] = reap(root, args.ownership_helper, known)
                    record['orphanCleanupMs'] = (time.monotonic_ns() - reap_start) / 1e6
                remaining = process.stdout.read().decode(errors='replace')
                if remaining: log.append(re.sub(r'token=[A-Za-z0-9._~%-]+', 'token=<redacted>', remaining))
                if not args.keep_profiles:
                    # PRoot owns its fake-link reference counts. Remove only the
                    # two uniquely named fixtures we created, through PRoot;
                    # never clear the global backing store or other profiles.
                    cleanup = subprocess.run(prefix + ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin',
                                             '/bin/rm', '-rf', '--', home, probe_file], env=host_env,
                                             text=True, capture_output=True, timeout=10)
                    record['fixtureCleanup'] = {'exitCode': cleanup.returncode, 'stderr': cleanup.stderr,
                        'pathsRemain': [path for path in [home, probe_file] if root.joinpath(path.lstrip('/')).exists()],
                        'backingCountAfter': sum(1 for _ in l2s.iterdir())}
                (plan / 'engine.log').write_text('\n'.join(log) + '\n')
                (plan / 'result.json').write_text(json.dumps(record, ensure_ascii=False, indent=2) + '\n')
                records.append(record)
                (out / 'results.json').write_text(json.dumps(records, ensure_ascii=False, indent=2) + '\n')
            print(json.dumps({'sample': sample, 'mode': record['mode'], 'requestedMode': mode, 'fallbackReason': record['fallbackReason'],
                              **record['phases'], 'stopMs': record['stopMs'], 'exitCode': record['exitCode']}), flush=True)


if __name__ == '__main__':
    main()
