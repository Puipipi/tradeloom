#!/usr/bin/env python3
"""Real rc4 runCli + public RPC; controlled PM, exact owned Linux processes only."""
import argparse, concurrent.futures, ctypes, hashlib, http.cookiejar, json, os, pathlib, re, shutil, signal, subprocess, tempfile, threading, time, traceback, urllib.request, uuid

p = argparse.ArgumentParser()
p.add_argument('--prefix', required=True, type=pathlib.Path)
p.add_argument('--out', required=True, type=pathlib.Path)
p.add_argument('--port', type=int, default=39311)
CASES = ['cooperative', 'term-resistant', 'stop-unconfirmed', 'nonzero', 'success-remove', 'outer-not-bundle', 'success-background', 'late-cancel', 'stop-unconfirmed-emit', 'compat-primary-unconfirmed', 'compat-repair-success', 'compat-repair-cancel', 'compat-repair-unconfirmed', 'compat-repair-timeout', 'registry-retry']
p.add_argument('--cases', nargs='+', choices=CASES, default=CASES)
a = p.parse_args()
prefix = a.prefix.resolve()
here = pathlib.Path(__file__).resolve().parent
a.out.mkdir(parents=True, exist_ok=True)
run = pathlib.Path(tempfile.mkdtemp(prefix='run-', dir=a.out.resolve()))
evidence = run / 'evidence'
evidence.mkdir()
assert ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0) == 0, 'Own orphan reaping requires Linux subreaper'
sha = lambda data: hashlib.sha256(data).hexdigest()
manager = prefix / 'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js'
manager_hash = sha(manager.read_bytes())
mutex = threading.RLock()

def save(path, value):
    with mutex:
        path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def identity(pid):
    try:
        text = pathlib.Path('/proc/' + str(pid) + '/stat').read_text()
        fields = text[text.rindex(')') + 2:].split()
        return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]), 'pgrp': int(fields[2]), 'startTicks': int(fields[19])}
    except FileNotFoundError:
        return None

def same(prior):
    if prior is None:
        return None
    after = identity(prior['pid'])
    return after if after and after['startTicks'] == prior['startTicks'] else None

def group_alive(pgrp):
    try:
        os.killpg(pgrp, 0)
        return True
    except ProcessLookupError:
        return False

def wait_for(fn, label, timeout=20):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        value = fn()
        if value:
            return value
        time.sleep(.02)
    raise TimeoutError(label)

def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError:
        return None

def snap(profile):
    result = {}
    for name in ['package.json', 'pnpm-lock.yaml', 'package.json.lock', '.plugin-manager/run.json']:
        file = profile / name
        data = file.read_bytes() if file.exists() else None
        result[name] = {'exists': data is not None, 'bytes': len(data) if data is not None else 0, 'sha256': sha(data) if data is not None else None, 'text': data.decode() if data is not None else None}
    return result

def rpc_value(data):
    assert data['result']['ok'], data
    return data['result']['value']

def one(mode):
    case = run / mode
    private = case / 'private'
    private.mkdir(parents=True)
    control = private / 'control'
    control.mkdir()
    home = private / 'home'
    profile = home / 'profiles/web'
    profile.mkdir(parents=True)
    workspace = private / 'workspace'
    workspace.mkdir()
    dest = evidence / mode
    dest.mkdir()
    bundle = private / 'bundle'
    bundle.mkdir()
    bundle_name = 'wave10-own-confirmation-bundle'
    manifest = {'name': bundle_name, 'version': '1.0.0', 'private': True}
    if mode != 'outer-not-bundle':
        manifest['dsh'] = {'bundle': {'patch': 'cordis.patch.yml'}}
    (bundle / 'package.json').write_text(json.dumps(manifest))
    (bundle / 'cordis.patch.yml').write_text('[]\n')
    (case / 'node_modules').symlink_to(prefix / 'node_modules', target_is_directory=True)
    shutil.copyfile(here / 'observer.mjs', case / 'observer.mjs')
    patches = [{'id': name, 'disabled': True} for name in ['session-title-llm', 'llm-pi-ai', 'llm-deepseek-account', 'session-telemetry-otel', 'web-search-deepseek', 'web-deepseek-api', 'web-fetch-http', 'tool-web']]
    patches += [{'id': 'plugin-manager', 'config': {'idleTimeoutMs': 1000 if mode == 'compat-repair-timeout' else 60000, 'inspectTimeoutMs': 20000, 'registry': 'https://registry.fixture.invalid/', 'fallbackRegistries': ['https://fallback.fixture.invalid/'] if mode == 'registry-retry' else []}}, {'insert': [{'id': 'cancel-tree-confirmation-observer', 'name': str(case / 'observer.mjs')}]}]
    (profile / 'cordis.patch.yml').write_text(json.dumps(patches))
    (profile / 'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n# own baseline\n")
    env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'TMPDIR'] if key in os.environ}
    env.update({'TZ': 'Asia/Shanghai', 'DSH_HOME': str(home), 'DSH_TELEMETRY_DISABLED': '1', 'TREE_FIXTURE_PREFIX': str(prefix), 'TREE_FIXTURE_PORT': str(a.port), 'TREE_FIXTURE_PM': str(here / 'package-manager.mjs'), 'TREE_FIXTURE_CONTROL': str(control), 'TREE_FIXTURE_CASE': mode, 'TREE_FIXTURE_MANAGER_SHA': manager_hash})
    host = None
    handle = None
    child = None
    parent = None
    known = {}
    reaped = []
    cleanup_signals = []
    stop_reaper = threading.Event()
    pool = concurrent.futures.ThreadPoolExecutor(max_workers=2)
    audit = []
    steps = []
    base = 'http://127.0.0.1:' + str(a.port)
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))

    def register(prior):
        if prior:
            with mutex:
                known[prior['pid']] = prior

    def reap_known():
        # Never waitpid(-1): the Host's own Popen exit status belongs to Popen.wait.
        while not stop_reaper.wait(.005):
            with mutex:
                targets = list(known.values())
            for prior in targets:
                current = same(prior)
                if not current or current['ppid'] != os.getpid() or current['state'] != 'Z':
                    continue
                try:
                    pid, status = os.waitpid(prior['pid'], os.WNOHANG)
                    if pid:
                        with mutex:
                            reaped.append({'before': current, 'waitStatus': status, 'atNs': time.monotonic_ns()})
                except ChildProcessError:
                    pass

    reaper = threading.Thread(target=reap_known, daemon=True)
    reaper.start()

    def rpc(method, args):
        body = {'type': 'client-request', 'rpcId': 'wire-' + str(uuid.uuid4()), 'method': method, 'payload': {'args': args}}
        request = urllib.request.Request(base + '/api/' + method, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json', 'Origin': base})
        started = time.monotonic_ns()
        try:
            with opener.open(request, timeout=40) as response:
                status = response.status
                data = json.load(response)
            with mutex:
                audit.append({'method': method, 'request': args, 'status': status, 'response': data, 'startedNs': started, 'returnedNs': time.monotonic_ns()})
                save(dest / 'http-audit.json', audit)
            assert status == 200, data
            return data
        except BaseException as error:
            with mutex:
                audit.append({'method': method, 'request': args, 'transportError': type(error).__name__, 'startedNs': started, 'returnedNs': time.monotonic_ns()})
                save(dest / 'http-audit.json', audit)
            raise

    def snapshot(label):
        value = snap(profile)
        steps.append({'label': label, 'monotonicNs': time.monotonic_ns(), 'profile': value})
        save(dest / 'steps.json', steps)
        return value

    try:
        log = private / 'host.raw.log'
        log.touch(mode=0o600)
        handle = log.open('w')
        host = subprocess.Popen(['node', str(here / 'launcher.mjs')], cwd=workspace, env=env, stdout=handle, stderr=subprocess.STDOUT)

        def token():
            match = re.search(r'token=([\w-]+)', log.read_text())
            assert host.poll() is None, 'Host exited; private own log retained'
            return match[1] if match else None

        auth = wait_for(token, 'Host startup', 30)
        opener.open(base + '/?token=' + auth, timeout=10).read()
        proof = wait_for(lambda: read_json(control / 'loaded-service.json'), 'actual service identity')
        save(dest / 'loaded-service.json', proof)
        baseline = snapshot('before-install')
        save(dest / 'initial-local-manifest.json', json.loads((bundle / 'package.json').read_text()))
        request_id = 'own-tree-' + str(uuid.uuid4())
        pending = pool.submit(rpc, 'pluginManager/installBundle', {'spec': str(bundle), 'options': {'requestId': request_id, 'enabled': False}})
        ready = wait_for(lambda: read_json(control / 'parent-ready.json'), 'owned PM ready')
        parent = identity(ready['pid'])
        assert parent and parent['startTicks'] == ready['startTicks'] and parent['pgrp'] == parent['pid'], ready
        register(parent)
        child = read_json(control / 'descendant-ready.json')
        if child:
            assert same(child) and child['ppid'] == parent['pid'] and child['pgrp'] == parent['pgrp'], child
            register(child)
        marker = wait_for(lambda: read_json(profile / '.plugin-manager/run.json'), 'real run record')
        assert marker == {'pid': parent['pid'], 'grouped': True}, marker
        ready_files = snapshot('own-run-before-proceed-or-cancel')
        assert all(baseline[name] != ready_files[name] for name in ['package.json', 'pnpm-lock.yaml'])
        result = {'case': mode, 'parentBefore': parent, 'descendantBefore': child, 'runRecordBefore': marker}
        if mode in ['cooperative', 'term-resistant', 'stop-unconfirmed', 'stop-unconfirmed-emit', 'late-cancel']:
            if mode == 'late-cancel':
                (control / 'proceed').touch()
                held = wait_for(lambda: read_json(control / 'run-result-held.json'), 'actual runPnpm result held before outer continuation')
                assert held['exitCode'] == 0 and same(parent) is None and same(child), held
                result['heldResult'] = held
            start_ns = time.monotonic_ns()
            if mode == 'late-cancel':
                cancel_pending = pool.submit(rpc, 'pluginManager/cancelInstall', {'requestId': request_id})
                wait_for(lambda: not group_alive(parent['pgrp']), 'late cancellation stopped still owned group', 15)
                (control / 'release-run-result').touch()
                cancellation = cancel_pending.result(timeout=10)
            else:
                cancellation = rpc('pluginManager/cancelInstall', {'requestId': request_id})
            result['cancelRoundTripNs'] = time.monotonic_ns() - start_ns
            installation = pending.result(timeout=5)
            returned = snapshot('after-install-and-cancel-return')
            result.update({'cancelWire': cancellation, 'installationWire': installation, 'parentAtReturn': same(parent), 'descendantAtReturn': same(child), 'groupPresentAtReturn': group_alive(parent['pgrp'])})
            if mode in ['stop-unconfirmed', 'stop-unconfirmed-emit']:
                assert cancellation['result']['ok'] is False, result
                assert cancellation['result']['error']['code'] == 'gateway/internal', result
                assert rpc_value(installation)['application'] == 'failed', result
                assert same(parent) and same(parent)['state'] not in ['Z', 'X'], result
                assert same(child) and same(child)['state'] not in ['Z', 'X'], result
                assert result['groupPresentAtReturn'], result
                assert all(ready_files[name] == returned[name] for name in ['package.json', 'pnpm-lock.yaml']), result
                assert read_json(profile / '.plugin-manager/run.json') == marker, result
                assert not returned['package.json.lock']['exists'], result
                signals = [json.loads(line) for line in (control / 'signals.jsonl').read_text().splitlines()]
                assert any(item['suppressed'] for item in signals), signals
                result.update({'filesNotRestored': True, 'ownRunRecordRetained': True, 'injectedKillSuppression': signals})
                if mode == 'stop-unconfirmed-emit':
                    assert read_json(control / 'emit-failure-injected.json'), result
                    result['unrelatedEmitErrorDidNotMaskStopFailure'] = True
            else:
                assert rpc_value(cancellation)['status'] == 'cancelled', result
                assert rpc_value(installation)['application'] == 'cancelled', result
                assert not result['groupPresentAtReturn'] and same(parent) is None and same(child) is None, result
                assert all(baseline[name] == returned[name] for name in ['package.json', 'pnpm-lock.yaml']), result
                assert not returned['package.json.lock']['exists'] and not returned['.plugin-manager/run.json']['exists'], result
                (control / 'write-after-cancel').touch()
                # Observational grace, not a product latency/SLA assertion.
                time.sleep(.15)
                assert not (control / 'late-write-complete.json').exists()
                assert snap(profile) == returned
                result.update({'profileRestored': True, 'runRecordRemoved': True, 'gatedLateWriteAbsent': True})
        elif mode.startswith('compat-'):
            (control / 'proceed').touch()
            assert 'engines' not in json.loads((dest / 'initial-local-manifest.json').read_text())
            if mode == 'compat-primary-unconfirmed':
                installation = rpc_value(pending.result(timeout=25))
                returned = snapshot('compat-primary-stop-failed-before-internal-restore')
                assert installation['application'] == 'failed', installation
                assert same(parent) is None and same(child) and same(child)['state'] not in ['Z', 'X']
                assert group_alive(parent['pgrp'])
                assert all(ready_files[name] == returned[name] for name in ['package.json', 'pnpm-lock.yaml'])
                assert read_json(profile / '.plugin-manager/run.json') == marker
                assert not (control / 'repair-parent-ready.json').exists()
                assert not returned['package.json.lock']['exists']
                result.update({'installation': installation, 'internalRestoreNotEntered': True, 'repairNotStarted': True, 'ownRunRecordRetained': True, 'parentAtReturn': same(parent), 'descendantAtReturn': same(child)})
            else:
                repair = wait_for(lambda: read_json(control / 'repair-parent-ready.json'), 'actual compatibility repair launched')
                register(repair)
                repair_child = read_json(control / 'repair-descendant-ready.json')
                register(repair_child)
                assert same(repair) and repair['pgrp'] == repair['pid'] and repair['pid'] != parent['pid'], repair
                if repair_child:
                    assert same(repair_child) and repair_child['ppid'] == repair['pid'] and repair_child['pgrp'] == repair['pgrp']
                assert not group_alive(parent['pgrp']), parent
                repair_start = read_json(control / 'repair-start-files.json')
                assert repair_start == {'package': baseline['package.json']['text'], 'lock': baseline['pnpm-lock.yaml']['text']}, repair_start
                def new_record():
                    row = read_json(profile / '.plugin-manager/run.json')
                    return row if row and row.get('pid') == repair['pid'] else None
                repair_marker = wait_for(new_record, 'run record transferred to actual repair group')
                assert repair_marker == {'pid': repair['pid'], 'grouped': True}, repair_marker
                repair_files = snapshot('repair-own-run-before-cancel-or-result')
                result.update({'repairParentBefore': repair, 'repairDescendantBefore': repair_child, 'repairRecordBefore': repair_marker, 'internalRestoreBeforeRepair': True})
                if mode in ['compat-repair-cancel', 'compat-repair-unconfirmed']:
                    cancellation = rpc('pluginManager/cancelInstall', {'requestId': request_id})
                    installation = rpc_value(pending.result(timeout=5))
                    result['cancelWire'] = cancellation
                else:
                    if mode == 'compat-repair-success':
                        (control / 'repair-proceed').touch()
                    installation = rpc_value(pending.result(timeout=25))
                returned = snapshot('after-compat-repair-return')
                result.update({'installation': installation, 'repairParentAtReturn': same(repair), 'repairDescendantAtReturn': same(repair_child), 'repairGroupAtReturn': group_alive(repair['pgrp'])})
                assert not returned['package.json.lock']['exists']
                if mode == 'compat-repair-unconfirmed':
                    assert cancellation['result']['ok'] is False and cancellation['result']['error']['code'] == 'gateway/internal', result
                    assert installation['application'] == 'failed', result
                    assert same(repair) and same(repair)['state'] not in ['Z', 'X'] and same(repair_child) and same(repair_child)['state'] not in ['Z', 'X'], result
                    assert all(repair_files[name] == returned[name] for name in ['package.json', 'pnpm-lock.yaml']), result
                    assert read_json(profile / '.plugin-manager/run.json') == repair_marker, result
                    result.update({'failedRepairNotRestored': True, 'successorRecordRetained': True})
                else:
                    assert installation['application'] == ('cancelled' if mode == 'compat-repair-cancel' else 'failed'), result
                    if mode == 'compat-repair-cancel':
                        assert rpc_value(cancellation)['status'] == 'cancelled', result
                    assert same(repair) is None and same(repair_child) is None and not result['repairGroupAtReturn'], result
                    assert all(baseline[name] == returned[name] for name in ['package.json', 'pnpm-lock.yaml']), result
                    assert not returned['.plugin-manager/run.json']['exists'], result
                    result.update({'profileRestored': True, 'runRecordRemoved': True})
                    if mode == 'compat-repair-timeout':
                        beats = read_json(control / 'repair-heartbeat.json')
                        assert beats and beats['count'] >= 3, beats
                        assert read_json(control / 'repair-parent-sigterm.json'), result
                        result['repairHeartbeatBeforeTermination'] = beats
        else:
            (control / 'proceed').touch()
            installation = rpc_value(pending.result(timeout=25))
            returned = snapshot('after-install-return')
            result.update({'installation': installation, 'parentAtReturn': same(parent), 'descendantAtReturn': same(child), 'groupPresentAtReturn': group_alive(parent['pgrp'])})
            assert not returned['package.json.lock']['exists'] and not returned['.plugin-manager/run.json']['exists'], result
            if mode in ['nonzero', 'outer-not-bundle']:
                assert installation['application'] == 'failed', result
                assert all(baseline[name] == returned[name] for name in ['package.json', 'pnpm-lock.yaml']), result
                assert not result['groupPresentAtReturn'] and same(parent) is None and same(child) is None, result
                result['profileRestored'] = True
            else:
                assert installation['application'] == 'applied', result
                if mode == 'success-background':
                    assert same(parent) is None and same(child) and same(child)['state'] not in ['Z', 'X'] and result['groupPresentAtReturn'], result
                    result['normalBackgroundPreserved'] = True
                elif mode == 'success-remove':
                    removal = rpc_value(rpc('pluginManager/removeBundle', {'name': bundle_name}))
                    remove_info = read_json(control / 'remove-ready.json')
                    register(remove_info)
                    after_remove = snapshot('after-normal-remove')
                    assert removal['application'] == 'applied', removal
                    assert bundle_name not in json.loads(after_remove['package.json']['text']).get('dependencies', {}), after_remove
                    assert not after_remove['package.json.lock']['exists'] and not after_remove['.plugin-manager/run.json']['exists'], after_remove
                    assert remove_info and not group_alive(remove_info['pgrp']), remove_info
                    result['removal'] = removal
                elif mode == 'registry-retry':
                    retry = read_json(control / 'retry-start-files.json')
                    assert retry == {'package': baseline['package.json']['text'], 'lock': baseline['pnpm-lock.yaml']['text'], 'previousGroupPresent': False}, retry
                    commands = [json.loads(line) for line in (control / 'commands.jsonl').read_text().splitlines()]
                    additions = [row for row in commands if row['args'][0] == 'add']
                    assert len(additions) == 2, additions
                    second = read_json(control / 'parent-2-ready.json')
                    register(second)
                    assert second and not group_alive(second['pgrp']), second
                    assert installation['registries'] == ['https://registry.fixture.invalid/', 'https://fallback.fixture.invalid/'], installation
                    result.update({'secondAttemptSawRestoredFilesAndGoneFirstGroup': True, 'registryAttempts': additions})
        save(dest / 'RESULT.json', result)
        return result
    finally:
        # The only possible signals below name identities captured in this fixture.
        child = child or read_json(control / 'descendant-ready.json')
        parent = parent or read_json(control / 'parent-ready.json')
        register(parent)
        register(child)
        register(read_json(control / 'remove-ready.json'))
        register(read_json(control / 'repair-parent-ready.json'))
        register(read_json(control / 'repair-descendant-ready.json'))
        register(read_json(control / 'parent-2-ready.json'))
        (control / 'release-run-result').touch()
        (control / 'release-descendant').touch()
        with mutex:
            targets = list(known.values())
        for prior in targets:
            current = same(prior)
            if current and current['state'] not in ['Z', 'X']:
                try:
                    os.kill(prior['pid'], signal.SIGKILL)
                    cleanup_signals.append({'identity': current, 'signal': 'SIGKILL'})
                except ProcessLookupError:
                    pass
        if host and host.poll() is None:
            host.terminate()
            try:
                host.wait(timeout=10)
            except subprocess.TimeoutExpired:
                host.kill()
                host.wait(timeout=5)
        pool.shutdown(wait=True)
        wait_for(lambda: all(same(prior) is None for prior in targets), 'all exact owned processes gone', 10)
        stop_reaper.set()
        reaper.join(timeout=2)
        if handle:
            handle.close()
        for file in control.glob('*.json'):
            shutil.copyfile(file, dest / file.name)
        for file in control.glob('*.jsonl'):
            shutil.copyfile(file, dest / file.name)
        save(dest / 'http-audit.json', audit)
        save(dest / 'steps.json', steps)
        save(dest / 'CLEANUP.json', {'hostPid': host.pid if host else None, 'hostReturnCode': host.returncode if host else None, 'hostIdentity': identity(host.pid) if host else None, 'ownedIdentitiesAfter': [same(prior) for prior in targets], 'ownReaped': reaped, 'cleanupSignals': cleanup_signals, 'waitpidPolicy': 'recorded own PID only; Host Popen status not reaped by helper'})

results = []
save(evidence / 'INPUTS.json', {'managerSHA256': manager_hash, 'prefix': str(prefix), 'sourceSHA256': {file.name: sha(file.read_bytes()) for file in sorted(here.iterdir()) if file.is_file()}, 'cases': a.cases, 'port': a.port, 'beganUTC': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
try:
    for case in a.cases:
        results.append(one(case))
        print(json.dumps({'case': case, 'normativeAssertions': 'passed'}), flush=True)
    assert sha(manager.read_bytes()) == manager_hash
    save(evidence / 'SUMMARY.json', {'status': 'PASS_OWN_HOST_FIXTURES', 'managerSHA256': manager_hash, 'cases': results, 'noProductFilesModified': True, 'actualPnpmRegistryAndroidPRoot': 'UNRUN', 'faultInjection': 'named unconfirmed cases suppress only own recorded group KILL; late-cancel holds actual runPnpm result; emit case throws only on stop-failure log', 'finishedUTC': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
    print(json.dumps({'run': str(run), 'cases': len(results), 'managerSHA256': manager_hash}), flush=True)
except BaseException as error:
    save(evidence / 'FAILURE.json', {'type': type(error).__name__, 'message': str(error), 'completedCases': len(results), 'traceback': traceback.format_exc()})
    raise
finally:
    (a.out / 'latest-run.txt').write_text(str(run) + '\n')
