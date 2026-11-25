// Real host recovery: shipped safe-mode constants/helper, public user terminal and file RPCs.
// DSH_PREFIX=<a prepared prefix> DSH_EVIDENCE_DIR=<new evidence dir> node runtime/tests/safe-home-recovery-live.mjs
// DSH_SAFE_MODE_SOURCE may select the unmodified Kotlin source for the same-test red control.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

assert(process.env.DSH_PREFIX, 'Set DSH_PREFIX to the prepared runtime.');
const prefix = resolve(process.env.DSH_PREFIX);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const kotlin = process.env.DSH_SAFE_MODE_SOURCE ?? join(repo, 'app/android/app/src/main/kotlin/io/github/ccch1mneyyy/dsh_app/runtime/SafeMode.kt');
const source = await fs.readFile(kotlin, 'utf8');
const constants = Object.fromEntries([...source.matchAll(/const val (\w+) = "([^"\n]*)"\s*$/gm)].map(m => [m[1], m[2]]));
function constant(name, seen = new Set()) {
  assert(!seen.has(name) && name in constants, `Unresolved source constant ${name}`);
  const next = new Set([...seen, name]);
  return constants[name].replace(/\$(\w+)/g, (_, key) => constant(key, next));
}
function raw(name) {
  const match = source.match(new RegExp(`const val ${name} = """([\\s\\S]*?)"""`));
  assert(match, `Missing real ${name}`);
  return match[1];
}
const envBlock = source.match(/val GUEST_ENV[^=]*=\s*linkedMapOf\(([\s\S]*?)\)/)?.[1];
assert(envBlock, 'Read the real declarative safe environment.');
const entries = [...envBlock.matchAll(/"([^"]+)"\s+to\s+("[^"]*"|\w+)/g)];
assert(entries.length > 0);
const runRoot = await fs.mkdtemp(join(tmpdir(), 'dsh-safe-home-live-'));
const userHome = join(runRoot, 'user');
const originalHome = join(userHome, '.dsh');
const safeDir = join(runRoot, 'safe-mode');
const workspace = join(runRoot, 'workspace');
const evidence = process.env.DSH_EVIDENCE_DIR ? resolve(process.env.DSH_EVIDENCE_DIR) : join(runRoot, 'evidence');
const mapGuest = value => value.replace(/^\/var\/lib\/dsh-app\/safe-mode(?=\/|$)/, safeDir)
  .replace(/^\/root\/\.dsh(?=\/|$)/, originalHome);
const safeEnv = Object.fromEntries(entries.map(m => [m[1], mapGuest(m[2].startsWith('"') ? JSON.parse(m[2]) : constant(m[2]))]));
const redact = text => text.replace(/token=[A-Za-z0-9._~%-]+/g, 'token=<redacted>');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const load = name => import(pathToFileURL(join(prefix, 'node_modules/@deepseek-ai', name, 'lib/index.js')));
const { default: WebSocket } = await import(pathToFileURL(join(prefix, 'node_modules/ws/wrapper.mjs')));
let child, closed, socket, hostLog = '', terminalOutput = '';
const facts = { source: kotlin, prefix, hostOnly: true, androidExecuted: false, scriptDoesNotSendModelInput: true };
async function tree(root) {
  const result = {};
  async function visit(dir) {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name), key = relative(root, path);
      if (entry.isDirectory()) { result[key + '/'] = null; await visit(path); }
      else result[key] = (await fs.readFile(path)).toString('base64');
    }
  }
  await visit(root); return result;
}
try {
  for (const dir of [originalHome, workspace, safeDir, evidence, join(safeDir, 'agents'), join(safeDir, 'bin')]) await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(join(safeDir, 'overlay.patch.yml'), raw('OVERLAY_YAML'));
  const helper = join(safeDir, 'bin/dsh-app-plugins');
  // User terminals scrub DSH_* variables. Map only the product's two fixed guest defaults,
  // so this host probe exercises that fallback without touching the host's /root or using chroot.
  const originalHelper = raw('PLUGINS_SCRIPT');
  let mappedHelper = originalHelper;
  const replacements = [["'/root/.dsh'", originalHome], ["'/var/lib/dsh-app/safe-mode'", safeDir]];
  for (const [literal, target] of replacements) {
    assert.equal(mappedHelper.split(literal).length - 1, 1, `Exactly one fixed default: ${literal}`);
    mappedHelper = mappedHelper.replace(literal, JSON.stringify(target));
  }
  facts.helperGuestDefaultMapping = { replacements: replacements.map(([literal, target]) => ({ literal, target, count: 1 })),
    originalSha256: createHash('sha256').update(originalHelper).digest('hex'), mappedSha256: createHash('sha256').update(mappedHelper).digest('hex') };
  await fs.writeFile(helper, mappedHelper, { mode: 0o700 });
  const [{ Context }, { Session }, jsonl, { createUserMessage }] = await Promise.all(['cordis', 'dsh-session', 'dsh-session-persistence-jsonl', 'dsh-llm'].map(load));
  const writer = new Context();
  await jsonl.apply(writer, { root: join(originalHome, 'sessions'), compression: 'zstd', listConcurrency: 2 });
  const session = Session.create('original-conversation', undefined, { ...Session.create('original-conversation').header, cwd: workspace });
  session.append('user/message', createUserMessage({ content: [{ type: 'text', text: 'Synthetic original conversation to preserve. 原始对话。' }], source: { kind: 'user' } }), { surfaceOp: 'append' });
  const handle = await writer.sessionPersistence.create(session.header);
  await handle.append(session.snapshotEvents()); await handle.flush(); await handle.close();
  const originalLog = (await writer.sessionPersistence.stat(session.id)).location.path;
  await writer.fiber.dispose();
  await fs.mkdir(join(originalHome, 'storages'), { recursive: true });
  await fs.writeFile(join(originalHome, 'storages/workspace.json'), '{broken workspace storage');
  await fs.mkdir(join(originalHome, 'attachments/v1'), { recursive: true });
  await fs.writeFile(join(originalHome, 'attachments/v1/synthetic.bin'), Buffer.alloc(2 * 1024 * 1024 + 113, 0x73));
  await fs.mkdir(join(originalHome, 'credentials'), { recursive: true });
  await fs.writeFile(join(originalHome, 'credentials/private-fixture'), 'SYNTHETIC_PRIVATE_EXCLUDED');
  const before = await tree(originalHome);

  // Generate the existing production overlay using its real generator, then map only its guest path.
  const py = "import importlib.util,sys\nspec=importlib.util.spec_from_file_location('recovery_rtbuild',sys.argv[1])\nm=importlib.util.module_from_spec(spec);sys.modules[spec.name]=m;spec.loader.exec_module(m)\nsys.stdout.buffer.write(m.overlay_entries({},with_pnpm=True,with_bridge=True)['etc/dsh-app/dsh-web.patch.yml'].data)\n";
  const generated = spawnSync(process.env.PYTHON ?? 'python3', ['-c', py, join(repo, 'runtime/lib/rtbuild.py')], { encoding: 'utf8' });
  assert.equal(generated.status, 0, generated.stderr);
  const appPatch = join(runRoot, 'app.patch.yml');
  await fs.writeFile(appPatch, generated.stdout.replaceAll('/opt/dsh-go/dsh-go-bridge', join(repo, 'runtime/bridge/dsh-go-bridge')));
  const env = { PATH: `${dirname(process.execPath)}:${join(prefix, 'node_modules/.bin')}:/usr/bin:/bin`, LANG: 'C.UTF-8', HOME: userHome,
    DSH_HOME: originalHome, DSH_TELEMETRY_DISABLED: '1', ...safeEnv, DSH_APP_SAFE_DIR: safeDir, DSH_APP_PATCH: appPatch };
  facts.guestEnvironmentKeys = Object.keys(safeEnv); facts.effectiveHome = env.DSH_HOME;
  facts.originalLog = relative(originalHome, originalLog);
  const profileArgs = constant('SAFE_PROFILE_ARGS').split(/\s+/).map(mapGuest);
  child = spawn(process.execPath, [join(prefix, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ...profileArgs,
    '--patch', appPatch, '--host', '127.0.0.1', '--port', '0', '--no-open'], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
  closed = once(child, 'close');
  const startup = new Promise((resolveReady, reject) => {
    const timeout = setTimeout(() => reject(Error('Real safe-mode host did not become ready within 25s')), 25000);
    const consume = bytes => {
      hostLog += bytes.toString();
      const match = hostLog.match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)\/\?token=([\w-]+)/);
      if (match) { clearTimeout(timeout); resolveReady({ origin: match[1], token: match[2] }); }
    };
    child.stdout.on('data', consume); child.stderr.on('data', consume);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    closed.then(exit => { clearTimeout(timeout); reject(Error(`Real safe-mode host exited before readiness: ${JSON.stringify(exit)}\n${redact(hostLog.slice(-5000))}`)); });
  });
  const { origin, token } = await startup;
  const login = await fetch(`${origin}/?token=${token}`, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  assert.equal(login.status, 303);
  const cookie = login.headers.getSetCookie().map(v => v.split(';')[0]).join('; '); assert(cookie);
  let seq = 0;
  async function rpc(method, args) {
    const response = await fetch(`${origin}/api/${method}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: `rescue-${++seq}`, method, payload: { args } }), signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 200, method);
    let envelope;
    if (response.headers.get('content-type')?.startsWith('multipart/form-data')) {
      const form = await response.formData(); const metadata = form.get('metadata');
      envelope = JSON.parse(typeof metadata === 'string' ? metadata : await metadata.text());
      for (const attachment of envelope.attachments) {
        assert.equal(attachment.codec, 'bytes');
        let parent = envelope.result; let key = 'value';
        for (const segment of attachment.path) { parent = parent[key]; key = segment; }
        parent[key] = Buffer.from(await form.get(attachment.part).arrayBuffer());
      }
    } else envelope = await response.json();
    assert.equal(envelope.result?.ok, true, `${method}: ${JSON.stringify(envelope)}`);
    return envelope.result.value;
  }
  const created = await rpc('session/create', { request: { sessionId: 'rescue-user-session', cwd: workspace } });
  assert.equal(created.sessionId, 'rescue-user-session');
  assert.equal(created.agentPreset, 'ptc');
  const minimal = await rpc('session/create', { request: { sessionId: 'rescue-minimal', cwd: workspace, agentPreset: 'minimal' } });
  assert.equal(minimal.agentPreset, 'minimal'); facts.createdPresets = [created.agentPreset, minimal.agentPreset];
  facts.sessionCreatedWithoutCredentials = true;
  const terminalId = 'rescue-terminal';
  const info = await rpc('terminal/create', { agentId: created.sessionId, request: { id: terminalId, cols: 120, rows: 32 } });
  assert.equal(info.id, terminalId); facts.terminalCreated = true;
  socket = new WebSocket(origin.replace('http:', 'ws:') + '/api/remote.mux', { headers: { cookie } });
  const messages = [], waiters = [];
  socket.on('message', bytes => {
    const message = JSON.parse(String(bytes)); messages.push(message);
    if (message.type === 'item' && message.streamId === 'terminal') {
      if (message.value.type === 'output') terminalOutput += message.value.data;
    }
    for (const w of [...waiters]) if (w.match(message)) { waiters.splice(waiters.indexOf(w), 1); clearTimeout(w.timer); w.resolve(message); }
  });
  const next = match => {
    const present = messages.find(match); if (present) return Promise.resolve(present);
    return new Promise((resolveNext, reject) => { const w = { match, resolve: resolveNext }; w.timer = setTimeout(() => {
      waiters.splice(waiters.indexOf(w), 1); reject(Error('Expected real terminal frame not received: ' + JSON.stringify(messages.slice(-4))));
    }, 15000); waiters.push(w); });
  };
  await once(socket, 'open');
  socket.send(JSON.stringify({ type: 'open', streamId: 'terminal', endpoint: 'terminal/attach', payload: { args: { agentId: created.sessionId, id: terminalId } } }));
  const snapshot = await next(m => m.type === 'item' && m.streamId === 'terminal' && m.value.type === 'snapshot');
  assert.equal(snapshot.value.writable, true);
  const archive = join(workspace, 'original-conversations.tar');
  const command = `printf 'DSH_RECOVERY_ENV:%s|%s\\n' "\${DSH_HOME-unset}" "\${DSH_APP_ORIGINAL_HOME-unset}"; ${quote(process.execPath)} ${quote(helper)} export ${quote(archive)}; printf '\\nDSH_RECOVERY_EXIT:%s\\n' "$?"\n`;
  socket.send(JSON.stringify({ type: 'item', streamId: 'terminal', value: { type: 'write', sequence: 1, data: command } }));
  await next(m => m.type === 'item' && m.streamId === 'terminal' && m.value.type === 'output' && /DSH_RECOVERY_EXIT:\d+(?:\r?\n|\u001b)/.test(terminalOutput));
  assert.match(terminalOutput, /DSH_RECOVERY_ENV:unset\|unset\r?\n/, 'Real user terminal strips DSH environment.');
  assert.equal(terminalOutput.match(/DSH_RECOVERY_EXIT:(\d+)(?:\r?\n|\u001b)/)[1], '0', terminalOutput);
  facts.terminalDshEnvironmentScrubbed = true; facts.exportThroughTerminal = true;
  const stat = await rpc('workspaceFiles/stat', { workspaceFileScopeId: created.sessionId, path: archive });
  const chunks = []; let offset = 0;
  while (true) {
    const window = await rpc('workspaceFiles/readBytes', { workspaceFileScopeId: created.sessionId, path: archive, options: { range: { offset, length: 1024 * 1024 } } });
    assert.equal(window.version, stat.version); assert(Buffer.isBuffer(window.data));
    chunks.push(window.data); offset += window.data.length;
    if (window.eof) break;
    assert(window.data.length > 0);
  }
  const downloaded = Buffer.concat(chunks); assert.equal(downloaded.length, stat.bytes);
  assert.deepEqual(downloaded, await fs.readFile(archive)); assert(chunks.length >= 3);
  const received = join(evidence, 'downloaded.tar'); await fs.writeFile(received, downloaded);
  for (const member of [facts.originalLog, 'attachments/v1/synthetic.bin', 'storages/workspace.json']) {
    const extraction = spawnSync('tar', ['-xOf', received, member], { maxBuffer: 16 * 1024 * 1024 }); assert.equal(extraction.status, 0, String(extraction.stderr));
    assert.deepEqual(extraction.stdout, await fs.readFile(join(originalHome, member)), member);
  }
  assert(!downloaded.includes(Buffer.from('SYNTHETIC_PRIVATE_EXCLUDED')));
  await rpc('terminal/close', { agentId: created.sessionId, id: terminalId });
  assert.deepEqual(await tree(originalHome), before, 'Rescue startup, public terminal and export preserve every original file.');
  facts.originalTreeUnchanged = true; facts.downloadWindows = chunks.length; facts.downloadedBytes = downloaded.length;
  facts.status = 'PASS'; console.log(JSON.stringify(facts));
} catch (error) {
  facts.status = 'FAIL'; facts.error = redact(String(error.stack)); console.error(facts.error); process.exitCode = 1;
} finally {
  socket?.terminate();
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill('SIGTERM'); const force = setTimeout(() => child.kill('SIGKILL'), 10000);
    await closed; clearTimeout(force);
  }
  await fs.mkdir(evidence, { recursive: true });
  await fs.writeFile(join(evidence, 'host.log'), redact(hostLog));
  await fs.writeFile(join(evidence, 'terminal.log'), redact(terminalOutput));
  await fs.writeFile(join(evidence, 'result.json'), JSON.stringify(facts, null, 2) + '\n');
  if (process.env.DSH_EVIDENCE_DIR) await fs.rm(runRoot, { recursive: true, force: true });
  else console.log('Evidence: ' + evidence);
}
