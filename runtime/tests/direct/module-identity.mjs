// Independent review probe. Run only through the unchanged production wrapper.
import fs from 'node:fs';
import cp from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Context } from '/opt/dsh/node_modules/@deepseek-ai/cordis/lib/index.js';
import { LocalFileSystem } from '/opt/dsh/node_modules/@deepseek-ai/dsh-fs-local/lib/index.js';

const root = process.env.DSH_GO_DIRECT_ROOTFS;
if (!root) throw new Error('Production direct wrapper is required');
const base = fs.mkdtempSync(`${root}/tmp/review-module-identity-`);
const outside = fs.mkdtempSync('/tmp/dsh-review-outside-module-');
const require = createRequire(import.meta.url);
const provider = new LocalFileSystem(new Context(), { cwd: base, diffBasisMaxBytes: 1024 * 1024 });
const report = { node: process.version, execArgv: process.execArgv, root, base, outside, observations: [] };
const backing = `${root}/root/.l2s`;

function guest(file, args) {
  const result = cp.spawnSync(file, args, { encoding: 'utf8', timeout: 10_000 });
  if (result.error || result.status !== 0) throw new Error(JSON.stringify({ file, args, status: result.status, error: String(result.error ?? ''), stderr: result.stderr }));
  return result.stdout;
}

async function observe(label, alias, type, marker) {
  delete globalThis[marker];
  const observation = { label, alias, realpath: fs.realpathSync(alias), type };
  try { await provider.resolve(alias); observation.typedFs = 'accepted'; }
  catch (error) { observation.typedFs = error.code; }
  try {
    const value = type === 'esm' ? (await import(pathToFileURL(alias).href)).default : require(alias);
    observation.module = 'evaluated';
    observation.value = value;
  } catch (error) {
    observation.module = 'rejected';
    observation.error = String(error);
  }
  observation.executed = globalThis[marker] === true;
  observation.pass = observation.typedFs === 'FS_IO_ERROR' && observation.module === 'rejected' && !observation.executed;
  report.observations.push(observation);
}

try {
  report.backingCountBefore = fs.existsSync(backing) ? fs.readdirSync(backing).length : 0;
  if (report.backingCountBefore !== 0) throw new Error('A fresh empty backing store is required');
  fs.symlinkSync(outside, `${base}/external`);
  for (const type of ['esm', 'cjs']) {
    const extension = type === 'esm' ? 'mjs' : 'cjs';
    const marker = `__review_external_${type}`;
    fs.writeFileSync(`${outside}/module.${extension}`, `globalThis.${marker}=true; ${type === 'esm' ? 'export default 42;' : 'module.exports=42;'}\n`);
    await observe(`external-${type}`, `${base}/external/module.${extension}`, type, marker);
  }
  for (const type of ['esm', 'cjs']) {
    const extension = type === 'esm' ? 'mjs' : 'cjs';
    const marker = `__review_late_l2s_${type}`;
    const source = `${base}/source.${extension}`;
    const alias = `${base}/alias.${extension}`;
    const content = `globalThis.${marker}=true; ${type === 'esm' ? 'export default 42;' : 'module.exports=42;'}\n`;
    fs.writeFileSync(source, content);
    guest('/bin/ln', [source, alias]);
    if (!fs.lstatSync(alias).isSymbolicLink() || !fs.realpathSync(alias).startsWith(`${backing}/`)) throw new Error('Pinned PRoot did not produce its real L2S representation');
    await observe(`late-l2s-${type}`, alias, type, marker);
    report.observations.at(-1).guestDataPreserved = guest('/bin/cat', [alias]) === content;
  }
  // Resolve without evaluation, then let a real PRoot operation replace the
  // ordinary source by its fake-link representation. Node's own resolution
  // caches must not turn a previously safe spelling into permanent authority.
  for (const type of ['esm', 'cjs']) {
    const extension = type === 'esm' ? 'mjs' : 'cjs';
    const marker = `__review_warm_l2s_${type}`;
    const source = `${base}/warm-source.${extension}`;
    const alias = `${base}/warm-alias.${extension}`;
    const content = `globalThis.${marker}=true; ${type === 'esm' ? 'export default 42;' : 'module.exports=42;'}\n`;
    fs.writeFileSync(source, content);
    const resolvedBefore = type === 'esm' ? import.meta.resolve(pathToFileURL(source).href) : require.resolve(source);
    if (globalThis[marker] !== undefined) throw new Error('The cache priming must not evaluate the module');
    guest('/bin/ln', [source, alias]);
    if (!fs.realpathSync(source).startsWith(`${backing}/`)) throw new Error('Expected the original source to become a real L2S link');
    await observe(`resolved-before-l2s-${type}`, source, type, marker);
    report.observations.at(-1).resolvedBefore = resolvedBefore;
    report.observations.at(-1).guestDataPreserved = guest('/bin/cat', [alias]) === content;
  }
  const child = cp.spawnSync(process.execPath, ['-e', 'console.log("must not execute")'], { encoding: 'utf8', timeout: 10_000 });
  report.childStartControl = { status: child.status, stdout: child.stdout, stderr: child.stderr, pass: child.status === 1 && child.stdout === '' && /compatible launch/u.test(child.stderr) };
} finally {
  guest('/bin/rm', ['-rf', '--', base]);
  fs.rmSync(outside, { recursive: true, force: true });
  report.backingCountAfter = fs.readdirSync(backing).length;
  report.pass = report.observations.length === 6 && report.observations.every((row) => row.pass) && report.childStartControl?.pass === true && report.backingCountAfter === 0;
  console.log(JSON.stringify(report, null, 2));
  if (!report.pass) process.exitCode = 1;
}
