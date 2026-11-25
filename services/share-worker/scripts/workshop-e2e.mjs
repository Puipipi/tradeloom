#!/usr/bin/env node
// One local-only rehearsal. Run from services/share-worker:
//   node scripts/workshop-e2e.mjs
// --skip-dart deliberately yields PARTIAL (exit 2), never the full PASS.
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { Agent, createServer, request as httpsRequest } from 'node:https';
import { createServer as createPortReservation } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { ACCOUNT_ORIGIN, check, COMPANION_ID, dartResultObserver, diagnosticLines, KEEP_ID, localConfig,
  localEnvironment, loopbackOrigin, parseJsonc, PET_ID, previewDescriptor, previewResponse, REHEARSAL_CLIENT_ID, REHEARSAL_PREVIEW,
  rehearsalFixtures, removeTemporaryStorage, sha256 } from './workshop-e2e-support.mjs';
import { localTlsCredentials } from './workshop-e2e-tls.mjs';

const here = dirname(fileURLToPath(import.meta.url)), worker = resolve(here, '..'), repo = resolve(worker, '../..');
const API = '/api/workshop/v1', ADMIN = API + '/admin', CATALOG = '/market/workshop.json';

function flutterCommand(env) {
  const name = process.platform === 'win32' ? 'flutter.bat' : 'flutter';
  const executable = (env.PATH ?? env.Path ?? '').split(delimiter).map(path => join(path, name)).find(existsSync);
  check(executable, 'flutter_missing_use_skip_dart_only_for_partial');
  const args = ['--no-version-check', '--suppress-analytics', 'test', '--no-pub', '--reporter', 'json', 'test/workshop/workshop_local_e2e_test.dart'];
  if (process.platform !== 'win32') return { executable, args };
  // Only this fixed command/arguments enter cmd.exe; secrets use the child
  // environment, never its command line. Reject cmd metacharacters in PATH.
  check(!/["%\r\n&|<>^]/.test(executable), 'unsupported_flutter_command_path');
  return { executable: join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe'),
    args: ['/d', '/s', '/c', `""${executable}" ${args.join(' ')}"`], verbatim: true };
}

function launch(executable, args, { cwd, env, secrets, onLine = () => {}, verbatim = false, service = false }) {
  const child = spawn(executable, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true, windowsVerbatimArguments: verbatim });
  const logs = [diagnosticLines(secrets, onLine), diagnosticLines(secrets)];
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', text => logs[0].write(text)); child.stderr.on('data', text => logs[1].write(text));
  let closed = false, spawnCode;
  child.on('error', error => { spawnCode = error.code ?? 'spawn_failed'; });
  const completion = new Promise(resolveDone => child.once('close', (code, signal) => {
    closed = true; logs.forEach(log => log.end()); resolveDone({ code, signal, spawnCode });
  }));
  return { child, completion, service, closed: () => closed, diagnostics: () => logs.map(log => log.summary()).filter(Boolean).join('\n') };
}

function stop(processHandle) {
  // A stopped PID/group must not be visited again after it could be reused.
  return processHandle.stopping ??= stopOnce(processHandle);
}

async function stopOnce(processHandle) {
  const pid = processHandle.child.pid;
  if (processHandle.closed()) {
    // An unexpected Wrangler-wrapper exit does not establish that workerd
    // exited. Do not signal an already-released PID or claim cleanup success.
    check(!processHandle.service || !pid, 'service_tree_cleanup_unconfirmed');
    return;
  }
  if (!pid) { await processHandle.completion; return; }
  if (process.platform === 'win32') {
    // Terminate only the tree rooted at the live child spawned by this run.
    const killer = spawn('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
    const killed = await new Promise(resolveDone => {
      killer.once('error', () => resolveDone(false));
      killer.once('close', code => resolveDone(code === 0));
    });
    await Promise.race([processHandle.completion, delay(5000)]);
    check(killed && processHandle.closed(), 'spawned_process_tree_did_not_close');
    return;
  }
  let groupGone = false;
  const signal = value => {
    try { process.kill(-pid, value); }
    catch (error) { if (error.code === 'ESRCH') groupGone = true; else throw error; }
  };
  const waitGroup = async () => {
    const end = performance.now() + 5000;
    for (;;) {
      if (!groupGone) signal(0);
      if (groupGone && processHandle.closed()) return true;
      if (performance.now() >= end) return false;
      await delay(50);
    }
  };
  signal('SIGINT');
  if (await waitGroup()) return;
  if (!groupGone) signal('SIGKILL');
  check(await waitGroup(), 'spawned_process_tree_did_not_close');
}

async function reservedPort() {
  const server = createPortReservation();
  await new Promise((ready, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', ready); });
  const port = server.address().port;
  await new Promise((closed, reject) => server.close(error => error ? reject(error) : closed()));
  return port;
}

function readHttp(origin, path, { agent, signal, method = 'GET', headers = {}, body, timeout = 15000 }) {
  const url = new URL(path, origin);
  check(path.startsWith('/') && !path.startsWith('//') && url.origin === loopbackOrigin(origin), 'request_left_local_origin');
  const content = body == null ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  return new Promise((resolveResponse, reject) => {
    const req = httpsRequest(url, { agent, method, signal,
      headers: { ...headers, ...(content ? { 'Content-Length': String(content.length) } : {}) } }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 1024 * 1024) req.destroy(Object.assign(new Error('rehearsal_response_too_large'), { rehearsalCode: 'rehearsal_response_too_large' }));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolveResponse({ status: response.statusCode, headers: response.headers, bytes: Buffer.concat(chunks) }));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('rehearsal_http_timeout'), { rehearsalCode: 'rehearsal_http_timeout' })), timeout);
    req.once('error', reject); req.once('close', () => clearTimeout(timer)); req.end(content);
  });
}

export async function run({ skipDart = false, log = console.log } = {}) {
  let temp, github, running, agent, origin, githubApi, lastRequest;
  let step = 'setup', failure, tempRemovalAttempts;
  const children = [], completed = [], cleanupErrors = [], abort = new AbortController();
  const interrupted = () => abort.abort();
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  // GitHub tokens are [A-Za-z0-9_]; hex keeps the synthetic one inside the Worker's shape check.
  const adminKey = randomBytes(32).toString('base64url'), githubToken = 'gho_' + randomBytes(32).toString('hex');
  const secrets = [adminKey, githubToken];
  const env = localEnvironment(process.env);
  const execute = async (executable, args, cwd, extra = {}, observe, verbatim = false) => {
    check(!abort.signal.aborted, 'interrupted');
    const handle = launch(executable, args, { cwd, env: { ...env, ...extra }, secrets, onLine: observe, verbatim }); children.push(handle);
    let timer, listener;
    try {
      const result = await Promise.race([handle.completion, new Promise(resolveTimeout => {
        timer = setTimeout(() => resolveTimeout({ timedOut: true }), 300000);
        listener = () => resolveTimeout({ interrupted: true }); abort.signal.addEventListener('abort', listener, { once: true });
      })]);
      if (result.code !== 0 || result.timedOut || result.interrupted) {
        await stop(handle);
        throw Object.assign(new Error('subprocess_failed'), { rehearsalCode: 'subprocess_failed',
          summary: { exit: result.code ?? null, signal: result.signal ?? null, spawnCode: result.spawnCode ?? null,
            timedOut: result.timedOut === true, interrupted: result.interrupted === true, diagnostics: handle.diagnostics() } });
      }
    } finally { clearTimeout(timer); abort.signal.removeEventListener('abort', listener); }
  };
  const phase = async (name, action) => {
    step = name; lastRequest = undefined; check(!abort.signal.aborted, 'interrupted');
    await action(); completed.push(name); log(`ok - ${name}`);
  };
  const call = async (path, { method = 'GET', body, author = false, admin = false, headers = {}, status = 200, json = true } = {}) => {
    lastRequest = { method, path };
    const response = await readHttp(origin, path, { method, body, agent, signal: abort.signal,
      headers: { ...(body ? { 'Content-Type': Buffer.isBuffer(body) ? 'application/zip' : 'application/json' } : {}),
        ...(author ? { Authorization: `Bearer ${githubToken}`, 'X-Workshop-Account-Origin': ACCOUNT_ORIGIN } : {}),
        ...(admin ? { 'X-Admin-Key': adminKey } : {}), ...headers } });
    lastRequest = { method, path, status: response.status, responseBytes: response.bytes.length,
      contentType: response.headers['content-type'] ?? null };
    let value;
    if (json || response.status !== status) {
      try { value = JSON.parse(response.bytes); } catch { /* Summary never contains arbitrary response text. */ }
      if (typeof value?.error === 'string' && /^workshop_[a-z_0-9]{1,80}$/.test(value.error)) lastRequest.error = value.error;
    }
    check(response.status === status, 'unexpected_http_status');
    if (json) check(value && typeof value === 'object', 'expected_json_response');
    return { value, ...response };
  };
  const expectError = async (path, status, error, options = {}) => {
    const response = await call(path, { ...options, status }); check(response.value.error === error, 'unexpected_stable_error');
  };
  const capabilities = async (uploads, companion) => {
    const { value } = await call(API + '/capabilities');
    check(value.schema === 1 && value.features?.uploads === uploads && value.features?.companion === companion &&
      value.account?.origin === ACCOUNT_ORIGIN && value.account?.clientId === REHEARSAL_CLIENT_ID,
      'capabilities_do_not_match_local_configuration');
    check(value.preview && Object.entries(REHEARSAL_PREVIEW).filter(([key]) => key !== 'sources').every(([key, expected]) => value.preview[key] === expected) &&
      Array.isArray(value.preview.sources) && value.preview.sources.length === 2 && REHEARSAL_PREVIEW.sources.every(source => value.preview.sources.includes(source)),
    'public_preview_capabilities_missing_or_changed');
  };
  const catalog = async (options = {}) => {
    const response = await call(CATALOG, options); check(response.value.schema === 1 && Array.isArray(response.value.entries) && Array.isArray(response.value.withdrawn), 'bad_catalog'); return response;
  };
  const matches = (entry, item) => entry && entry.kind === item.meta.kind && entry.id === item.meta.id && entry.version === item.meta.version &&
    entry.sha256 === item.meta.sha256 && entry.size === item.bytes.length;
  const download = async (entry, item) => {
    check(matches(entry, item) && typeof entry.url === 'string' && entry.url.startsWith('/market/workshop/'), 'public_entry_identity_mismatch');
    const response = await call(entry.url, { json: false });
    check(response.headers['content-type'] === 'application/zip' && response.bytes.equals(item.bytes), 'public_archive_bytes_mismatch');
  };
  const pendingPreviews = new Map();
  const previewUnavailable = async path => {
    await expectError(path, 404, 'workshop_not_found');
    const response = await call(path, { method: 'HEAD', status: 404, json: false });
    check(response.bytes.length === 0, 'missing_preview_head_has_body');
  };
  const publicPreview = async (entry, item, sid) => {
    const shown = pendingPreviews.get(sid), preview = previewDescriptor(entry.preview, item.meta);
    check(shown && JSON.stringify(preview) === JSON.stringify(shown.preview), 'published_preview_changed_after_review');
    const response = await call(preview.path, { json: false }); previewResponse(response, preview);
    check(response.bytes.equals(shown.bytes), 'public_preview_differs_from_admin_image');
    previewResponse(await call(preview.path, { method: 'HEAD', json: false }), preview, { head: true });
  };
  const legacyEntry = (entry, item) => {
    check(matches(entry, item) && !Object.hasOwn(entry, 'preview') && !Object.hasOwn(entry, 'previewSource'), 'legacy_publication_gained_preview');
  };
  let requestNumber = 0, githubCalls = 0;
  const submit = async item => {
    const creation = await call(API + '/submissions', { method: 'POST', body: { ...item.meta, requestId: `local_rehearsal_request_${++requestNumber}` }, author: true, status: 201 });
    const made = creation.value.submission;
    check(made?.status === 'draft' && /^[a-f0-9]{32}$/.test(made.submissionId) && matches(made.metadata, item), 'new_submission_is_not_expected_draft');
    check(made.metadata.previewSource === item.meta.previewSource && !Object.hasOwn(made, 'preview'), 'draft_preview_choice_mismatch');
    check(made.owner?.accountOrigin === ACCOUNT_ORIGIN && made.owner?.accountId === 7601 && made.owner?.username === 'local-rehearsal-user', 'unexpected_synthetic_owner');
    const uploaded = await call(`${API}/submissions/${made.submissionId}/archive`, { method: 'PUT', body: item.bytes, author: true });
    check(uploaded.value.submission?.status === 'pending' && uploaded.value.submission?.submissionId === made.submissionId && matches(uploaded.value.submission.metadata, item), 'upload_did_not_reach_pending');
    const submitted = uploaded.value.submission;
    check(submitted.metadata.previewSource === item.meta.previewSource, 'uploaded_preview_choice_mismatch');
    if (item.meta.previewSource === 'pet-idle') {
      const preview = previewDescriptor(submitted.preview, item.meta);
      await previewUnavailable(preview.path);
      const endpoint = `${ADMIN}/submissions/${made.submissionId}/public-preview`;
      await expectError(endpoint, 401, 'workshop_admin_auth_required');
      const response = await call(endpoint, { admin: true, json: false }); previewResponse(response, preview);
      pendingPreviews.set(made.submissionId, { preview, bytes: response.bytes });
    } else {
      check(!Object.hasOwn(submitted, 'preview') && !Object.hasOwn(submitted.metadata, 'previewSource'), 'legacy_submission_gained_preview');
    }
    return made.submissionId;
  };
  const approve = async sid => {
    const response = await call(`${ADMIN}/submissions/${sid}/review`, { method: 'POST', admin: true, body: { decision: 'approve', reason: '本地合成材料审核通过' } });
    check(response.value.submission?.submissionId === sid && response.value.submission?.status === 'approved', 'approval_not_recorded');
    const shown = pendingPreviews.get(sid);
    if (shown) check(JSON.stringify(previewDescriptor(response.value.submission.preview, response.value.submission.metadata)) === JSON.stringify(shown.preview), 'approval_changed_registered_preview');
    else check(!Object.hasOwn(response.value.submission, 'preview'), 'legacy_approval_gained_preview');
  };
  try {
    const wrangler = resolve(worker, 'node_modules/wrangler/bin/wrangler.js');
    check(existsSync(wrangler), 'installed_locked_wrangler_required_no_auto_install');
    const flutter = skipDart ? undefined : flutterCommand(env);
    temp = await mkdtemp(join(tmpdir(), 'dsh-workshop-e2e-'));
    const tls = localTlsCredentials(), caFile = join(temp, 'localhost-cert.pem'), keyFile = join(temp, 'localhost-key.pem');
    await writeFile(caFile, tls.cert, { mode: 0o600, flag: 'wx' });
    await writeFile(keyFile, tls.key, { mode: 0o600, flag: 'wx' });
    env.NODE_EXTRA_CA_CERTS = caFile;
    env.WRANGLER_LOG_PATH = join(temp, 'wrangler.log');
    await execute(process.execPath, [join(here, 'build-site.mjs')], worker);
    const fixtures = await rehearsalFixtures(worker);
    check(!fixtures.v1.bytes.equals(fixtures.v2.bytes), 'version_fixtures_must_differ');
    agent = new Agent({ ca: tls.cert, keepAlive: false });
    github = createServer(tls, (request, response) => {
      response.setHeader('Content-Type', 'application/json'); response.setHeader('Cache-Control', 'no-store');
      if (request.method !== 'GET' || request.url !== '/user') { response.writeHead(404); response.end('{"message":"Not Found"}'); return; }
      if (request.headers.authorization !== `Bearer ${githubToken}`) { response.writeHead(401); response.end('{"message":"Bad credentials"}'); return; }
      githubCalls++; response.end(JSON.stringify({ id: 7601, login: 'local-rehearsal-user' }));
    });
    await new Promise((ready, reject) => { github.once('error', reject); github.listen(0, '127.0.0.1', ready); });
    githubApi = `https://127.0.0.1:${github.address().port}`;
    const port = await reservedPort(); origin = loopbackOrigin(`https://127.0.0.1:${port}`);
    const original = parseJsonc(readFileSync(resolve(worker, 'wrangler.jsonc'), 'utf8'));
    const configFile = join(temp, 'wrangler.json'), persist = join(temp, 'state');
    await writeFile(join(temp, '.dev.vars'), `ADMIN_KEY=${adminKey}\n`, { mode: 0o600 });
    const start = async (uploads, companion) => {
      if (running) await stop(running);
      await writeFile(configFile, JSON.stringify(localConfig(worker, original, githubApi, { uploads, companion, port })));
      running = launch(process.execPath, [wrangler, 'dev', '--config', configFile, '--local', '--persist-to', persist,
        '--ip', '127.0.0.1', '--port', String(port), '--inspector-ip', '127.0.0.1', '--inspector-port', '0',
        '--local-protocol', 'https', '--https-cert-path', caFile, '--https-key-path', keyFile,
        '--show-interactive-dev-session=false', '--log-level', 'error'], { cwd: worker, env, secrets, service: true });
      children.push(running);
      const end = Date.now() + 60000;
      for (;;) {
        if (running.closed()) throw Object.assign(new Error('worker_exited_before_ready'), { rehearsalCode: 'worker_exited_before_ready', summary: { diagnostics: running.diagnostics() } });
        check(Date.now() < end, 'worker_readiness_timeout');
        try { await capabilities(uploads, companion); break; }
        catch (error) {
          if (!['ECONNREFUSED', 'ECONNRESET'].includes(error.code)) throw error;
          await delay(200, undefined, { signal: abort.signal });
        }
      }
    };
    await phase('01 capabilities and configured HTTPS GitHub stand-in', () => start(true, true));
    let sid1, sid2, public1, public2, kept, companionEntry;
    await phase('02 GitHub identity and pet upload reaches pending', async () => {
      sid1 = await submit(fixtures.v1); check(githubCalls >= 2, 'worker_did_not_contact_local_github');
    });
    await phase('03 approval publishes byte-identical archive', async () => {
      await approve(sid1);
      const { value } = await catalog(); public1 = value.entries.find(entry => entry.kind === 'pet' && entry.id === PET_ID);
      check(public1, 'first_version_missing_from_catalog'); await download(public1, fixtures.v1);
      await publicPreview(public1, fixtures.v1, sid1);
    });
    await phase('04 next version replaces the current pointer', async () => {
      sid2 = await submit(fixtures.v2); await approve(sid2);
      const { value } = await catalog(), rows = value.entries.filter(entry => entry.kind === 'pet' && entry.id === PET_ID);
      check(rows.length === 1, 'catalog_has_wrong_identity_count'); public2 = rows[0]; await download(public2, fixtures.v2);
      await publicPreview(public2, fixtures.v2, sid2);
      check(public2.preview.sha256 === public1.preview.sha256 && public2.preview.path !== public1.preview.path, 'shared_preview_lost_version_binding');
      await expectError(public1.url, 404, 'workshop_not_found');
      await previewUnavailable(public1.preview.path);
      // Independent, unwithdrawn controls distinguish a pause from withdrawal.
      await approve(await submit(fixtures.keep)); await approve(await submit(fixtures.companion));
      const after = (await catalog()).value;
      kept = after.entries.find(entry => entry.kind === 'pet' && entry.id === KEEP_ID);
      companionEntry = after.entries.find(entry => entry.kind === 'companion' && entry.id === COMPANION_ID);
      check(kept && companionEntry, 'unwithdrawn_controls_missing');
      legacyEntry(kept, fixtures.keep); legacyEntry(companionEntry, fixtures.companion);
      await download(kept, fixtures.keep); await download(companionEntry, fixtures.companion);
    });
    if (!skipDart) await phase('Dart real client / repository install and uninstall', async () => {
      const observed = dartResultObserver();
      await execute(flutter.executable, flutter.args, join(repo, 'app'), {
        DSH_WORKSHOP_E2E_ORIGIN: origin, DSH_WORKSHOP_E2E_CA_FILE: caFile,
        DSH_WORKSHOP_E2E_ITEM_ID: PET_ID, DSH_WORKSHOP_E2E_ITEM_VERSION: '2.0.0',
      }, line => observed.line(line), flutter.verbatim);
      check(observed.passed(), 'dart_target_did_not_run_and_pass');
      log(JSON.stringify({ dartTest: observed.evidence() }));
    });
    else log('PARTIAL - Dart stage explicitly skipped; full rehearsal cannot PASS');
    await phase('05 report handling does not withdraw its target', async () => {
      const target = { kind: 'pet', id: PET_ID, version: '2.0.0' };
      const reported = await call(API + '/reports', { method: 'POST', author: true, body: { ...target, reason: '本地演练：请核对作品来源' }, status: 201 });
      const rid = reported.value.reportId; check(/^[a-f0-9]{32}$/.test(rid), 'missing_report_id');
      const listed = await call(ADMIN + '/reports?status=open&kind=pet', { admin: true });
      check(listed.value.reports.some(report => report.reportId === rid && report.kind === target.kind && report.id === target.id && report.version === target.version), 'report_not_listed');
      const handled = await call(`${ADMIN}/reports/${rid}/resolve`, { method: 'POST', admin: true,
        body: { decision: 'handled', reason: '本地演练：已核对，保留发布' } });
      check(handled.value.report?.status === 'resolved' && handled.value.report?.resolution?.decision === 'handled' &&
        handled.value.report?.resolution?.actor === 'admin' && handled.value.report?.resolution?.reason === '本地演练：已核对，保留发布' &&
        handled.value.target?.current === true && handled.value.target?.withdrawal === null && matches(handled.value.target.release, fixtures.v2), 'report_resolution_changed_target');
      const current = (await catalog()).value.entries.find(entry => entry.kind === 'pet' && entry.id === PET_ID);
      check(current, 'report_handling_unpublished_target'); await download(current, fixtures.v2);
      await publicPreview(current, fixtures.v2, sid2);
    });
    let previousTag, history;
    await phase('06 withdrawal removes current release without reviving v1', async () => {
      const response = await call(`${API}/submissions/${sid2}/withdraw`, { method: 'POST', author: true, body: { reason: '本地演练结束，撤回本版本' } });
      check(response.value.submission?.status === 'withdrawn', 'withdrawal_not_recorded');
      const current = await catalog();
      check(!current.value.entries.some(entry => entry.kind === 'pet' && entry.id === PET_ID) &&
        current.value.withdrawn.some(entry => entry.kind === 'pet' && entry.id === PET_ID && entry.version === '2.0.0'), 'withdrawal_catalog_mismatch');
      previousTag = current.headers.etag; history = JSON.stringify(current.value.withdrawn); check(previousTag, 'catalog_missing_etag');
      await expectError(public2.url, 404, 'workshop_not_found'); await expectError(public1.url, 404, 'workshop_not_found');
      await previewUnavailable(public2.preview.path); await previewUnavailable(public1.preview.path);
    });
    await phase('07a upload pause retains browsing and downloads in the same storage', async () => {
      await start(false, true);
      const current = await catalog({ headers: { 'If-None-Match': previousTag } });
      check(current.value.features.uploads === false && current.value.features.companion === true && current.headers.etag !== previousTag, 'upload_switch_etag_or_features_stale');
      check(JSON.stringify(current.value.withdrawn) === history, 'upload_switch_lost_withdrawal_history'); previousTag = current.headers.etag;
      await expectError(API + '/submissions', 503, 'workshop_upload_disabled', { method: 'POST', author: true,
        body: { ...fixtures.keepNext.meta, requestId: 'local_rehearsal_paused_upload' } });
      await download(current.value.entries.find(entry => entry.id === KEEP_ID), fixtures.keep);
      await download(current.value.entries.find(entry => entry.id === COMPANION_ID), fixtures.companion);
      legacyEntry(current.value.entries.find(entry => entry.id === KEEP_ID), fixtures.keep);
      legacyEntry(current.value.entries.find(entry => entry.id === COMPANION_ID), fixtures.companion);
      await previewUnavailable(public2.preview.path);
    });
    await phase('07b companion pause hides only companion delivery', async () => {
      await start(true, false);
      const current = await catalog({ headers: { 'If-None-Match': previousTag } });
      check(current.value.features.uploads === true && current.value.features.companion === false && current.headers.etag !== previousTag &&
        !current.value.entries.some(entry => entry.kind === 'companion'), 'companion_switch_catalog_mismatch');
      check(JSON.stringify(current.value.withdrawn) === history, 'companion_switch_lost_withdrawal_history'); previousTag = current.headers.etag;
      await expectError('/market/companions.json', 503, 'workshop_companion_disabled');
      await expectError(companionEntry.url, 503, 'workshop_companion_disabled');
      await expectError(API + '/submissions', 503, 'workshop_companion_disabled', { method: 'POST', author: true,
        body: { ...fixtures.companion.meta, version: '2.0.0', requestId: 'local_rehearsal_paused_companion' } });
      await download(current.value.entries.find(entry => entry.id === KEEP_ID), fixtures.keep);
      legacyEntry(current.value.entries.find(entry => entry.id === KEEP_ID), fixtures.keep);
      await submit(fixtures.keepNext);
    });
    await phase('07c reopening restores the unwithdrawn companion only', async () => {
      await start(true, true);
      const current = await catalog({ headers: { 'If-None-Match': previousTag } });
      check(current.value.features.uploads === true && current.value.features.companion === true && current.headers.etag !== previousTag &&
        JSON.stringify(current.value.withdrawn) === history && !current.value.entries.some(entry => entry.id === PET_ID), 'reopening_changed_withdrawn_history');
      await download(current.value.entries.find(entry => entry.id === KEEP_ID), fixtures.keep);
      await download(current.value.entries.find(entry => entry.id === COMPANION_ID), fixtures.companion);
      await expectError(public2.url, 404, 'workshop_not_found');
      await previewUnavailable(public2.preview.path); await previewUnavailable(public1.preview.path);
      legacyEntry(current.value.entries.find(entry => entry.id === KEEP_ID), fixtures.keep);
      legacyEntry(current.value.entries.find(entry => entry.id === COMPANION_ID), fixtures.companion);
      const unchanged = await call(CATALOG, { headers: { 'If-None-Match': current.headers.etag }, status: 304, json: false });
      check(unchanged.bytes.length === 0, 'conditional_catalog_has_body');
    });
    await phase('08 public admin page CSP and missing-key 401', async () => {
      const page = await call('/workshop/admin', { json: false }), html = page.bytes.toString('utf8');
      const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)], csp = page.headers['content-security-policy'] ?? '';
      check(scripts.length === 1, 'admin_page_inline_script_count');
      const expected = Buffer.from(sha256(scripts[0][1]), 'hex').toString('base64');
      const expectedCsp = `default-src 'none'; script-src 'sha256-${expected}'; style-src 'unsafe-inline'; img-src blob: 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; object-src 'none'`;
      check(csp === expectedCsp && /^text\/html(?:;|$)/.test(page.headers['content-type'] ?? '') &&
        !html.includes(adminKey) && !html.includes(githubToken), 'admin_page_csp_or_secret_mismatch');
      await expectError(ADMIN + '/submissions?status=pending', 401, 'workshop_admin_auth_required');
    });
  } catch (error) {
    failure = { stage: step, code: error.rehearsalCode ?? error.code ?? error.name ?? 'unknown_failure',
      ...(error.summary ? { process: error.summary } : {}), ...(lastRequest ? { request: lastRequest } : {}) };
  } finally {
    agent?.destroy();
    for (const child of children.toReversed()) {
      try { await stop(child); } catch { cleanupErrors.push('spawned_process_cleanup_failed'); }
    }
    if (github?.listening) {
      github.closeAllConnections();
      try { await new Promise((closed, reject) => github.close(error => error ? reject(error) : closed())); }
      catch { cleanupErrors.push('local_github_cleanup_failed'); }
    }
    if (temp) {
      try { tempRemovalAttempts = await removeTemporaryStorage(temp); } catch { cleanupErrors.push('temporary_storage_cleanup_failed'); }
    }
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
  if (failure || cleanupErrors.length) {
    log(JSON.stringify({ result: 'FAIL', failure, cleanupErrors, completed, tempRemovalAttempts })); return 1;
  }
  log(JSON.stringify({ result: skipDart ? 'PARTIAL' : 'PASS', completed, githubRequests: githubCalls,
    dart: skipDart ? 'explicitly_skipped' : 'real_http_passed', cleanup: 'local_services_stopped_and_temp_removed', tempRemovalAttempts }));
  return skipDart ? 2 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = process.argv.slice(2);
  if (options.length === 1 && options[0] === '--help') {
    console.log('node scripts/workshop-e2e.mjs [--skip-dart]\nFull run requires the locked local Worker dependencies, generated site inputs, and Flutter already installed. No dependency installation or remote target is performed. --skip-dart returns PARTIAL / exit 2.');
  } else if (options.some(option => option !== '--skip-dart') || options.length > 1) {
    console.error('Unsupported option. Use --help; remote targets and credentials are not accepted.'); process.exitCode = 1;
  } else process.exitCode = await run({ skipDart: options.includes('--skip-dart') });
}
