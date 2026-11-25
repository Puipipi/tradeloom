import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parseMarketIndex } from '@deepseek-ai/dsh-plugin-market-index';
import {
  inspect,
  scan,
  osiLicense,
  validateEntry,
  verifyIntegrity,
  unpack,
  MAX_BYTES,
  INDEX_URL,
} from '../scripts/core.mjs';
import { build } from '../scripts/build.mjs';
import { newer } from '../scripts/watch.mjs';
const policy = { officialPackages: [], blockedVersions: {} };
const entry = (name, version) => ({
  name,
  version,
  title: { en: 'Search', zh: '搜索' },
  summary: { en: 'Search the web' },
  category: 'tools',
  screenshots: [],
});
const fixture = async (id) => ({
  data: JSON.parse(await readFile(new URL(`fixtures/${id}.json`, import.meta.url))),
  bytes: await readFile(new URL(`fixtures/${id}.tgz`, import.meta.url)),
});
for (const id of ['liustack-modsearch', 'liustack-modlens'])
  test(`real npm tarball: ${id} verifies provenance and scans offline`, async () => {
    const { data, bytes } = await fixture(id),
      name = data.packument.name,
      version = Object.keys(data.packument.versions)[0];
    assert(verifyIntegrity(bytes, data.integrity));
    const report = await inspect(entry(name, version), {
      packument: data.packument,
      tarball: bytes,
      advisories: data.advisories,
      fetcher: () => {
        throw Error('unexpected network');
      },
    });
    assert.equal(report.status, 'passed', JSON.stringify(report));
    assert(report.risk.flags.includes('network'));
    assert(report.risk.flags.includes('not-adapted'));
    const out = build([{ entry: entry(name, version), report }], policy);
    assert.equal(parseMarketIndex(out.index, INDEX_URL).plugins.length, 1);
    assert.equal(out.index.plugins[0].versions.length, 1);
    assert.equal(out.sidecar.plugins[name].integrity, data.integrity);
    assert.equal(out.sidecar.plugins[name].tier, 'community');
  });
test('deny missing versions, oversized package, integrity mismatch, high advisory and unavailable advisory', async () => {
  const { data, bytes } = await fixture('liustack-modsearch'),
    name = data.packument.name,
    version = Object.keys(data.packument.versions)[0],
    e = entry(name, version);
  const opts = { packument: data.packument, tarball: bytes, advisories: data.advisories };
  assert((await inspect({ ...e, version: '0.0.0' }, opts)).denials.includes('version-not-found'));
  const large = structuredClone(data.packument);
  large.versions[version].dist.unpackedSize = MAX_BYTES + 1;
  assert((await inspect(e, { ...opts, packument: large })).denials.includes('package-too-large'));
  assert((await inspect(e, { ...opts, tarball: Buffer.from('tampered') })).denials.includes('integrity-mismatch'));
  assert(
    (
      await inspect(e, { ...opts, advisories: { [name]: [{ severity: 'high', vulnerable_versions: '*' }] } })
    ).denials.includes('high-advisory'),
  );
  assert.equal(
    (await inspect(e, { ...opts, advisories: { [name]: [{ severity: 'critical', vulnerable_versions: '<1.0.0' }] } }))
      .status,
    'passed',
  );
  assert((await inspect(e, { ...opts, advisories: null })).denials.includes('advisory-unavailable'));
  assert.equal(
    (await inspect(e, { ...opts, advisories: undefined, fetcher: async () => new Response('', { status: 503 }) }))
      .status,
    'denied',
  );
});
test('schema rejects spoofed tiers, ranges, urls and unknown fields', () => {
  const e = entry('test-plugin', '1.2.3');
  assert.deepEqual(validateEntry(e), []);
  for (const bad of [
    { tier: 'official' },
    { version: '^1.2.3' },
    { screenshots: ['http://x'] },
    { homepage: 'https://user:password@example.com' },
    { title: { zh: '缺英文' } },
    { risk: { level: 'low' } },
    { name: '../oops' },
  ])
    assert(validateEntry({ ...e, ...bad }).length);
});
test('SPDX OSI expression evaluation does not accept proprietary or missing licensing', () => {
  for (const good of ['MIT', 'Apache-2.0', 'MIT OR LicenseRef-Proprietary', 'MIT AND Apache-2.0'])
    assert(osiLicense(good), good);
  for (const bad of [undefined, 'UNLICENSED', 'CC-BY-NC-4.0', 'MIT AND LicenseRef-Proprietary', 'garbage'])
    assert(!osiLicense(bad), String(bad));
});
test('risk findings are warnings with actual filenames; max severity wins', () => {
  const files = new Map([
    [
      'lib/index.js',
      Buffer.from(
        "import {exec} from 'node:child_process'; fetch('https://example.com'); fs.writeFile('/tmp/file', data)",
      ),
    ],
    ['build/binding.node', Buffer.from('binary')],
    ['binding.gyp', Buffer.from('{}')],
    ['bundle.min.js', Buffer.from('const a=1;'.repeat(12000))],
  ]);
  const out = scan(files, { scripts: { postinstall: 'node setup.js' } });
  assert.equal(out.risk.level, 'high');
  assert.deepEqual(out.risk.flags, [
    'install-scripts',
    'native-code',
    'shell',
    'network',
    'filesystem',
    'obfuscated',
    'not-adapted',
  ]);
  assert.deepEqual(out.evidence.filesystem, ['lib/index.js']);
});
test('native adaptation uses existing v1 schema and actual implementation; bare declarations are not adapted', () => {
  const files = new Map([['src/tool.js', Buffer.from("const meta={'dsh-go/media':value}; // dsh-settings")]]);
  assert.equal(scan(files, {}).dshGo.adapted, false);
  assert.equal(scan(new Map(), { dshGo: { v: 1, contributes: {} } }).dshGo.adapted, false);
  assert.equal(scan(files, { dshGo: { v: 99, contributes: {} } }).dshGo.adapted, false);
  assert.equal(scan(new Map(), { dshGo: { v: 1, contributes: { invented: [{ id: 'fake' }] } } }).dshGo.adapted, false);
  assert.equal(
    scan(files, {
      dshGo: {
        v: 1,
        contributes: {
          'composer.actions': [{ id: 'same', label: 'A' }],
          'message.actions': [{ id: 'same', label: 'B' }],
        },
      },
    }).dshGo.adapted,
    false,
  );
  const out = scan(files, { dshGo: { v: 1, minApp: '1.0.3', contributes: {} } });
  assert(out.dshGo.adapted);
  assert.equal(out.dshGo.minApp, '1.0.3');
  assert.deepEqual(out.dshGo.features, ['media', 'settings-page']);
});
test('build requires passed matching audit, maintained official list and blocked versions', async () => {
  const { data, bytes } = await fixture('liustack-modsearch'),
    name = data.packument.name,
    version = Object.keys(data.packument.versions)[0],
    e = entry(name, version);
  const report = await inspect(e, { packument: data.packument, tarball: bytes, advisories: data.advisories });
  const rows = [{ entry: e, report }];
  assert.equal(build(rows, { ...policy, officialPackages: [name] }).sidecar.plugins[name].tier, 'official');
  assert.throws(() => build(rows, { ...policy, blockedVersions: { [name]: [version] } }), /blocked-version/);
  assert.throws(() => build([{ entry: { ...e, version: '99.0.0' }, report }], policy), /unapproved/);
  assert.throws(() => build([{ entry: e, report: { ...report, status: 'denied' } }], policy), /unapproved/);
  assert.throws(() => build([...rows, ...rows], policy), /duplicate-package/);
});
test('watch pins only newer valid latest versions', () => {
  const e = entry('example', '1.2.3');
  assert.equal(newer(e, { 'dist-tags': { latest: '1.3.0' } }).version, '1.3.0');
  for (const v of ['1.2.2', '1.2.3', '^2.0.0', undefined]) assert.equal(newer(e, { 'dist-tags': { latest: v } }), null);
});
test('tar reader rejects invalid gzip', async () => {
  await assert.rejects(unpack(Buffer.from('not a tar archive')));
});

// Deliberately modified archives supplement the unchanged real npm fixtures.
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { create as tarCreate } from 'tar';
async function modifiedArchive(mutate, options = {}) {
  const { data } = await fixture('liustack-modsearch');
  const name = data.packument.name,
    version = Object.keys(data.packument.versions)[0];
  const directory = await mkdtemp(join(tmpdir(), 'dsh-market-test-'));
  try {
    await mkdir(join(directory, 'package'));
    const pkg = structuredClone(data.packument.versions[version]);
    await mutate(pkg, directory);
    await writeFile(join(directory, 'package/package.json'), JSON.stringify(pkg));
    await writeFile(join(directory, 'package/cordis.patch.yml'), '[]');
    const chunks = [];
    for await (const b of tarCreate({ cwd: directory, gzip: true, ...options }, options.files ?? ['package']))
      chunks.push(b);
    const tarball = Buffer.concat(chunks),
      packument = structuredClone(data.packument);
    packument.versions[version].dist.integrity = 'sha512-' + createHash('sha512').update(tarball).digest('base64');
    return { entry: entry(name, version), options: { packument, tarball, advisories: data.advisories } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
test('actual package manifest controls licensing and bundle identity; install scripts only warn', async () => {
  for (const [change, reason] of [
    [
      (p) => {
        delete p.license;
      },
      'license-not-osi',
    ],
    [
      (p) => {
        p.license = 'UNLICENSED';
      },
      'license-not-osi',
    ],
    [
      (p) => {
        p.name = 'wrong-name';
      },
      'manifest-identity-mismatch',
    ],
    [
      (p) => {
        delete p.dsh;
      },
      'not-dsh-bundle',
    ],
  ]) {
    const f = await modifiedArchive(change);
    assert((await inspect(f.entry, f.options)).denials.includes(reason), reason);
  }
  const f = await modifiedArchive((p) => {
    p.scripts = { postinstall: 'echo risk' };
  });
  const report = await inspect(f.entry, f.options);
  assert.equal(report.status, 'passed');
  assert.equal(report.risk.level, 'high');
  assert(report.warnings.includes('install-scripts'));
});
test('archive traversal, links and duplicate filenames are refused without extraction', async () => {
  const link = await modifiedArchive(async (_p, dir) => symlink('/etc/passwd', join(dir, 'package/secret')));
  assert((await inspect(link.entry, link.options)).denials.includes('unsafe-tarball-link'));
  const traversal = await modifiedArchive(() => {}, { prefix: '../escape' });
  assert((await inspect(traversal.entry, traversal.options)).denials.includes('unsafe-tarball'));
  const duplicate = await modifiedArchive(() => {}, { files: ['package/package.json', 'package/package.json'] });
  assert((await inspect(duplicate.entry, duplicate.options)).denials.includes('unsafe-tarball'));
});

import { Header } from 'tar';
import { gzipSync } from 'node:zlib';
function archiveEntries(entries) {
  const blocks = [];
  for (const [path, type, text = '{}'] of entries) {
    const bytes = Buffer.from(type === 'Directory' ? '' : text);
    const header = new Header({ path, type, size: bytes.length, mode: 0o644, uid: 0, gid: 0 });
    header.encode();
    blocks.push(header.block, bytes, Buffer.alloc((512 - bytes.length % 512) % 512));
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
}
test('canonical archive paths retain ordinary npm directories and files', async () => {
  for (const root of ['package', 'package/']) {
    const result = await unpack(archiveEntries([
      [root, 'Directory'], ['package/lib/', 'Directory'],
      ['package/package.json', 'File'], ['package/lib/index.js', 'File', 'export const x=1;'],
    ]));
    assert.deepEqual([...result.files.keys()], ['package.json', 'lib/index.js']);
  }
});
test('archive names must denote one canonical extraction target', async () => {
  for (const path of ['package//package.json', 'package/lib//index.js', 'package/./package.json']) {
    await assert.rejects(unpack(archiveEntries([[path, 'File']])), /unsafe-tarball/);
  }
  for (const entries of [
    [['package/package.json', 'File'], ['package//package.json', 'File']],
    [['package/lib/', 'Directory'], ['package/lib', 'Directory']],
    [['package/lib/', 'Directory'], ['package/lib', 'File']],
    [['package', 'Directory'], ['package/', 'Directory']],
  ]) await assert.rejects(unpack(archiveEntries(entries)), /unsafe-tarball/);
});
test('archive paths reject Windows filename suffixes and stream separators', async () => {
  for (const path of [
    'package/package.json.', 'package/package.json ', 'package/package.json:stream',
    'package/lib./index.js', 'package/lib /index.js', 'package/lib:stream/index.js',
  ]) await assert.rejects(unpack(archiveEntries([[path, 'File']])), /unsafe-tarball/);
  for (const path of ['package/lib./', 'package/lib /', 'package/lib:stream/']) {
    await assert.rejects(unpack(archiveEntries([[path, 'Directory']])), /unsafe-tarball/);
  }
});
test('archive targets cannot collide by case while distinct mixed-case names remain valid', async () => {
  for (const entries of [
    [['package/package.json', 'File'], ['package/Package.json', 'File']],
    [['package/lib/index.js', 'File'], ['package/LIB/Index.js', 'File']],
    [['package/lib/', 'Directory'], ['package/LIB', 'Directory']],
    [['package/lib/', 'Directory'], ['package/LIB', 'File']],
  ]) await assert.rejects(unpack(archiveEntries(entries)), /unsafe-tarball/);
  const result = await unpack(archiveEntries([
    ['package/package.json', 'File'], ['package/README.md', 'File'],
    ['package/lib/', 'Directory'], ['package/lib/Widget.js', 'File'],
  ]));
  assert.deepEqual([...result.files.keys()], ['package.json', 'README.md', 'lib/Widget.js']);
});
