// Build an independent test prefix without re-resolving any 0.2.2-rc.1 runtime entry.
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
const { values } = parseArgs({ options: { out: { type: 'string' }, 'dsh-version': { type: 'string', default: '0.2.2-rc.1' } } });
const version = values['dsh-version'];
assert.ok(['0.2.1-rc.4', '0.2.2-rc.1'].includes(version), 'unsupported test DSH version');
assert.ok(isAbsolute(values.out ?? ''), '--out must be a new absolute directory');
const base = new URL('../../../../locks/dsh-' + version + '/', import.meta.url);
const original = await readFile(new URL('package-lock.json', base));
const manifest = JSON.parse(await readFile(new URL('package.json', base)));
const lock = JSON.parse(original);
assert.equal(manifest.dependencies['@deepseek-ai/dsh'], version);
const additions = [
  ['@deepseek-ai/dsh-llm-mock-server', version, 'https://registry.npmjs.org/@deepseek-ai/dsh-llm-mock-server/-/dsh-llm-mock-server-' + version + '.tgz', version === '0.2.1-rc.4'
    ? 'sha512-XgQQ1GaBBEhKYSv3+rwhJuuf0OuVvX/PBO9WloYsG70V93aSabVvZBR3r/Y5+D5G0KIYaehe6qSMAvPcPmE6Tw=='
    : 'sha512-hxBNmQEGeibDdmdEtWv3Pmm/11omcnvWbyh6RULkasUQoNVfgppJbrBtres2EaqUjaEULIRuMFhdLZcX13zMhQ=='],
  ['image-size', '2.0.2', 'https://registry.npmjs.org/image-size/-/image-size-2.0.2.tgz', 'sha512-IRqXKlaXwgSMAMtpNzZa1ZAe8m+Sa1770Dhk8VkSsP9LS+iHD62Zd8FQKs8fbPiagBE7BzoFX23cxFnwshpV6w=='],
];
for (const [name, version, resolved, integrity] of additions) {
  const key = 'node_modules/' + name;
  assert.equal(lock.packages[key], undefined, 'test addition must not replace a runtime lock entry');
  manifest.dependencies[name] = version;
  lock.packages[''].dependencies[name] = version;
  lock.packages[key] = { version, resolved, integrity, license: 'MIT' };
}
await mkdir(values.out, { mode: 0o700 });
for (const [file, value] of [['package.json', manifest], ['package-lock.json', lock], ['test-inputs.json', {
  dsh: version,
  runtimeLockSha256: createHash('sha256').update(original).digest('hex'),
  preservedRuntimeEntries: Object.keys(JSON.parse(original).packages).length - 1,
  additions: additions.map(([name, version]) => ({ name, version })),
}]]) await writeFile(join(values.out, file), JSON.stringify(value, null, 2) + '\n');
console.log(values.out);
