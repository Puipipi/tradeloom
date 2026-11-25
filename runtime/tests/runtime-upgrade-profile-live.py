"""Real rc4 -> rc1 -> rc4 CLI/profile test; synthetic data, no model requests.

python3 runtime/tests/runtime-upgrade-profile-live.py --old-prefix <rc4> \
  --prefix <rc1> --output <evidence-directory> [--port 38972]
"""
import argparse
import http.cookiejar
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import urllib.error
import urllib.request


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--old-prefix', required=True, type=Path)
    parser.add_argument('--prefix', required=True, type=Path)
    parser.add_argument('--output', required=True, type=Path)
    parser.add_argument('--port', default=38972, type=int)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    old, new = args.old_prefix.resolve(), args.prefix.resolve()
    for prefix, version in [(old, '0.2.1-rc.4'), (new, '0.2.2-rc.1')]:
        assert json.loads((prefix / 'node_modules/@deepseek-ai/dsh/package.json').read_text())['version'] == version
    fixture = Path(__file__).parent / 'fixtures/profile-upgrade'
    results = {}
    with tempfile.TemporaryDirectory(prefix='dsh-profile-upgrade-') as temporary:
        root = Path(temporary)
        home = root / 'home'
        profile = home / 'profiles/web'
        profile.mkdir(parents=True)
        project = root / 'project'
        project.mkdir()
        plugin, observer = root / 'plugin.mjs', root / 'observer.mjs'
        shutil.copyfile(fixture / 'observer.mjs', observer)
        patch_path = profile / 'cordis.patch.yml'
        patch_path.write_text(json.dumps([{'insert': [
            {'id': 'profile-upgrade-fixture', 'name': plugin.as_uri()},
            {'id': 'profile-upgrade-observer', 'name': observer.as_uri()},
        ]}]))

        def run(prefix, stage, action):
            plugin.write_text((fixture / 'plugin.mjs').read_text().replace('__PREFIX__', str(prefix)))
            raw = root / (stage + '.raw.log')
            with raw.open('w') as stream:
                child = subprocess.Popen(['node', str(prefix / 'node_modules/@deepseek-ai/dsh/lib/bin.js'),
                                          'web', '--host', '127.0.0.1', '--port', str(args.port), '--no-open'],
                                         stdout=stream, stderr=subprocess.STDOUT, cwd=project,
                                         env={**os.environ, 'DSH_HOME': str(home),
                                              'DEEPSEEK_API_KEY': 'sk-profile-upgrade-not-a-real-key'})
                try:
                    for _ in range(300):
                        match = re.search(r'token=([A-Za-z0-9_-]+)', raw.read_text())
                        if match:
                            break
                        if child.poll() is not None:
                            raise RuntimeError(stage + ': Host exited before readiness; see redacted log')
                        time.sleep(0.1)
                    else:
                        raise TimeoutError(stage + ': Host did not become ready')
                    base = 'http://127.0.0.1:' + str(args.port)
                    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
                    opener.open(base + '/?token=' + match[1], timeout=10).read()

                    def request(path, data=None):
                        req = urllib.request.Request(base + path,
                            data=None if data is None else json.dumps(data).encode(),
                            headers={'Content-Type': 'application/json'})
                        try:
                            with opener.open(req, timeout=15) as response:
                                return json.load(response)
                        except urllib.error.HTTPError as error:
                            raise AssertionError((stage, error.code, error.read().decode())) from error

                    results[stage] = action(request)
                finally:
                    child.terminate()
                    try:
                        child.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        child.kill()
                        child.wait(timeout=10)
                    stream.flush()
                    text = re.sub(r'token=[A-Za-z0-9_-]+', 'token=<redacted>', raw.read_text())
                    (args.output / (stage + '.log')).write_text(text)

        def seed(request):
            response = request('/api/session/create', {'type': 'client-request', 'rpcId': 'upgrade-seed',
                'method': 'session/create', 'payload': {'args': {'request': {'cwd': str(project)}}}})
            assert response['result']['ok'], response
            session_id = response['result']['value']['sessionId']
            snapshot = request('/profile-upgrade-observer', {
                'operation': 'seed', 'project': str(project), 'sessionId': session_id})
            assert snapshot['credentialPreserved'] and snapshot['record']['payload']['count'] == 7
            assert snapshot['plugin'] == {'ordinary': 'persisted-by-rc4', 'live': 'old-live-value'}
            workspace = next(row for row in snapshot['workspaces'] if row['path'] == str(project))
            assert session_id in workspace['sessionIds']
            return snapshot

        run(old, 'old-created', seed)
        workspace_files = list(home.rglob('workspace.json'))
        credentials_files = list(home.rglob('.credentials.yaml'))
        assert len(workspace_files) == len(credentials_files) == 1, (workspace_files, credentials_files)
        preserved = {path: path.read_bytes() for path in [patch_path, workspace_files[0], credentials_files[0]]}
        workspace_id = next(row['id'] for row in results['old-created']['workspaces'] if row['path'] == str(project))

        def upgrade(request):
            opened = request('/profile-upgrade-observer')
            assert opened == results['old-created'], (opened, results['old-created'])
            assert all(path.read_bytes() == before for path, before in preserved.items()), 'read-only opening rewrote profile data'
            results['new-read-only'] = opened
            continued = request('/profile-upgrade-observer', {'operation': 'continue', 'workspaceId': workspace_id})
            assert continued['credentialPreserved'] and continued['continuedCredential']
            assert continued['record']['payload'] == {'count': 8, 'enabled': True}
            assert continued['plugin'] == {'ordinary': 'continued-by-rc1', 'live': 'new-live-value'}
            assert next(row for row in continued['workspaces'] if row['id'] == workspace_id)['title'] == '新版继续使用'
            return continued

        run(new, 'new-continued', upgrade)

        def rollback(request):
            opened = request('/profile-upgrade-observer')
            assert opened == results['new-continued'], (opened, results['new-continued'])
            return opened

        run(old, 'old-reopened', rollback)
        results['scope'] = 'Actual CLI, cookies, credentials, workspace.json, session membership and ConfigEditor writes; no model request or schedule migration in this case.'
        (args.output / 'summary.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(json.dumps({'result': 'PASS', 'phases': ['old-created', 'new-read-only', 'new-continued', 'old-reopened'],
                          'scope': results['scope']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
