// Controlled package-manager seam: no pnpm, registry, external package or network access.
import {spawn} from 'node:child_process';
import {readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, symlinkSync, renameSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
const root = process.env.TREE_FIXTURE_CONTROL;
const mode = process.env.TREE_FIXTURE_CASE;
const args = process.argv.slice(2);
const ownIdentity = () => {
  const text = readFileSync('/proc/self/stat', 'utf8');
  const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
  return {pid: process.pid, ppid: process.ppid, state: fields[0], pgrp: Number(fields[2]), startTicks: Number(fields[19])};
};
const atomic = (path, bytes) => { const tmp = path + '.own-' + process.pid; writeFileSync(tmp, bytes, {mode: 0o600}); renameSync(tmp, path); };
const record = (name, value) => atomic(join(root, name), JSON.stringify(value) + '\n');
const waitFor = async name => { while (!existsSync(join(root, name))) await new Promise(resolve => setTimeout(resolve, 20)); };
if (args[0] === '--descendant') {
  const role = args[1] === 'repair' ? 'repair-' : '';
  if (mode !== 'cooperative') process.on('SIGTERM', () => record(role + 'descendant-sigterm.json', ownIdentity()));
  record(role + 'descendant-ready.json', ownIdentity());
  await waitFor('write-after-cancel');
  const profile = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  profile.wave10LateDescendantWrite = 'after-response';
  atomic(join(process.cwd(), 'package.json'), JSON.stringify(profile, null, 2) + '\n');
  appendFileSync(join(process.cwd(), 'pnpm-lock.yaml'), '# own descendant wrote after response\n');
  record('late-write-complete.json', ownIdentity());
  await waitFor('release-descendant');
  process.exit(0);
}
appendFileSync(join(root, 'commands.jsonl'), JSON.stringify({...ownIdentity(), args}) + '\n');
if (args[0] === 'config' && args[1] === 'get' && args[2] === 'registry') {
  console.log(mode === 'registry-retry' ? 'https://separate-config.fixture.invalid/' : 'https://registry.fixture.invalid/'); process.exit(0);
}
if (args[0] === 'install' && mode.startsWith('compat-')) {
  record('repair-start-files.json', {package: readFileSync(join(process.cwd(), 'package.json'), 'utf8'), lock: readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8')});
  if (['compat-repair-unconfirmed', 'compat-repair-timeout'].includes(mode)) process.on('SIGTERM', () => record('repair-parent-sigterm.json', ownIdentity()));
  let child;
  if (mode !== 'compat-repair-success') {
    const profile = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
    profile.wave10RepairPending = true;
    atomic(join(process.cwd(), 'package.json'), JSON.stringify(profile, null, 2) + '\n');
    atomic(join(process.cwd(), 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# own repair pending\n");
    child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--descendant', 'repair'], {cwd: process.cwd(), env: process.env, detached: false, stdio: 'ignore'});
    child.unref();
    await waitFor('repair-descendant-ready.json');
  }
  record('repair-parent-ready.json', {...ownIdentity(), ...(child ? {childPid: child.pid, childStdio: 'ignore', childDetached: false} : {})});
  console.log('Owned repair is ready');
  if (mode === 'compat-repair-timeout') {
    let count = 0;
    setInterval(() => { console.log('Owned repair heartbeat'); record('repair-heartbeat.json', {count: ++count, pid: process.pid}); }, 100);
  }
  await waitFor('repair-proceed');
  rmSync(join(process.cwd(), 'node_modules/wave10-own-confirmation-bundle'), {force: true});
  process.exit(0);
}
if (args[0] === 'remove') {
  const profile = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
  delete profile.dependencies[args[1]];
  atomic(join(process.cwd(), 'package.json'), JSON.stringify(profile, null, 2) + '\n');
  atomic(join(process.cwd(), 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# own removal\n");
  rmSync(join(process.cwd(), 'node_modules', args[1]), {force: true});
  record('remove-ready.json', ownIdentity());
  console.log('Owned fixture removal complete'); process.exit(0);
}
if (args[0] !== 'add') throw Error('Only controlled config get/add/remove fixture commands are permitted');
const spec = args[1].replace(/^(file|link):/, '');
const manifest = JSON.parse(readFileSync(join(spec, 'package.json'), 'utf8'));
const attempt = readFileSync(join(root, 'commands.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => row.args[0] === 'add').length;
if (mode === 'registry-retry' && attempt > 1) {
  const previous = JSON.parse(readFileSync(join(root, 'parent-1-ready.json'), 'utf8'));
  let previousGroupPresent = true;
  try { process.kill(-previous.pid, 0); } catch (error) { if (error.code === 'ESRCH') previousGroupPresent = false; else throw error; }
  record('retry-start-files.json', {package: readFileSync(join(process.cwd(), 'package.json'), 'utf8'), lock: readFileSync(join(process.cwd(), 'pnpm-lock.yaml'), 'utf8'), previousGroupPresent});
}
mkdirSync(join(process.cwd(), 'node_modules'), {recursive: true});
const target = join(process.cwd(), 'node_modules', manifest.name);
if (!existsSync(target)) symlinkSync(spec, target, 'dir');
const profile = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
profile.dependencies = {...profile.dependencies, [manifest.name]: 'file:' + spec};
profile.wave10PendingOwnInstall = true;
atomic(join(process.cwd(), 'package.json'), JSON.stringify(profile, null, 2) + '\n');
atomic(join(process.cwd(), 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n# own installation before result\n");
if (mode.startsWith('compat-')) {
  // The initial local source passed preflight; only the PM then produces this incompatible manifest.
  manifest.engines = {dsh: '>=999.0.0'};
  atomic(join(target, 'package.json'), JSON.stringify(manifest) + '\n');
  record('installed-compatibility.json', {phase: 'after-primary-spawn', engines: manifest.engines});
}
if (['stop-unconfirmed', 'stop-unconfirmed-emit'].includes(mode)) process.on('SIGTERM', () => record('parent-sigterm.json', ownIdentity()));
let child;
if (['cooperative', 'term-resistant', 'stop-unconfirmed', 'stop-unconfirmed-emit', 'outer-not-bundle', 'success-background', 'late-cancel', 'compat-primary-unconfirmed'].includes(mode) || mode === 'registry-retry' && attempt === 1) {
  child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--descendant'],
    {cwd: process.cwd(), env: process.env, detached: false, stdio: 'ignore'});
  child.unref();
  await waitFor('descendant-ready.json');
}
record('parent-ready.json', {...ownIdentity(), ...(child ? {childPid: child.pid, childStdio: 'ignore', childDetached: false} : {})});
record('parent-' + attempt + '-ready.json', {...ownIdentity(), ...(child ? {childPid: child.pid, childStdio: 'ignore', childDetached: false} : {})});
console.log('Owned package operation is ready');
await waitFor('proceed');
if (mode === 'nonzero') process.exit(17);
if (mode === 'registry-retry') {
  if (attempt === 1) { console.error('ERR_PNPM_META_FETCH_FAIL ECONNREFUSED https://registry.fixture.invalid/'); process.exit(17); }
  process.exit(0);
}
if (['success-remove', 'outer-not-bundle', 'success-background', 'late-cancel'].includes(mode) || mode.startsWith('compat-')) process.exit(0);
setInterval(() => {}, 1000);
