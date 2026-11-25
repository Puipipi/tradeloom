// Real rc4 parser and Cordis credential service; synthetic files, no engine account or network.
// DSH_TEST_PREFIX=/private/locked/prefix node --test runtime/tests/credentials-numeric-refs.test.mjs
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

assert.ok(process.env.DSH_TEST_PREFIX, 'set DSH_TEST_PREFIX to the locked rc4 npm prefix');
const require = createRequire(join(resolve(process.env.DSH_TEST_PREFIX), 'package.json'));
assert.equal(require('@deepseek-ai/dsh-credentials-local/package.json').version, '0.2.2-rc.1');
const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
const { LocalCredentialProvider, parseCredentialsDocument } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-credentials-local')));
const parse = text => parseCredentialsDocument(text, 'synthetic.credentials.yaml');

for (const digits of ['123456789', '0', '00012345', '9007199254740993', '9'.repeat(400)]) {
  test(`decimal reference keeps its exact spelling (${digits.length} digits, prefix ${digits.slice(0, 5)})`, () => {
    const result = parse(`version: 1\nrefs:\n  QQBOT_CRED_APP_ID: ${digits}\n  KEY: "synthetic-key"\n`);
    assert.equal(result.refs.get('QQBOT_CRED_APP_ID'), digits);
    assert.equal(result.refs.get('KEY'), 'synthetic-key');
  });
}

test('ordinary strings and record JSON types are unchanged', () => {
  const result = parse('version: 1\nrefs:\n  KEY: "000123"\n  WORD: trueish\nrecords:\n  fixture/account:\n    kind: grant\n    payload: {count: 12, enabled: true}\n');
  assert.equal(result.refs.get('KEY'), '000123');
  assert.equal(result.refs.get('WORD'), 'trueish');
  assert.deepEqual(result.records.get('fixture/account'), { kind: 'grant', payload: { count: 12, enabled: true } });
});

for (const value of ['true', 'null', '1.25', '1e3', '.inf', '.nan', '0x12', '-12', '!!float 1.25', '!!int 00123', '&numeric 00123', '[synthetic-secret]', '{nested: synthetic-secret}']) {
  test(`unsupported reference form remains rejected (${value.split(':')[0]})`, () => {
    assert.throws(() => parse(`version: 1\nrefs:\n  KEY: ${value}\n`), error => {
      assert.match(error.message, /must be a string/);
      assert.ok(!error.message.includes('synthetic-secret'));
      return true;
    });
  });
}

for (const text of ['version: 2\nrefs: {KEY: 123}\n', 'version: 1\nrefs: [123]\n',
  'version: 1\nrefs:\n  KEY: 123\n  KEY: 456\n', 'version: 1\nrefs: {KEY: 123}\nrecords: []\n']) {
  test(`malformed document is rejected (${text.split('\n').slice(0, 2).join(' / ')})`, () => assert.throws(() => parse(text)));
}

test('an anchored refs mapping cannot change a record payload through an alias', () => {
  const text = 'version: 1\nrefs: &shared\n  APP_ID: 123\nrecords:\n  fixture/account:\n    kind: grant\n    payload: *shared\n';
  assert.throws(() => parse(text), /must be a string/);
});

test('real service activates without rewriting and preserves numeric entries across another key write', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-numeric-refs-'));
  const filename = join(directory, '.credentials.yaml');
  const huge = '9'.repeat(400);
  const original = '# synthetic only\nversion: 1\nrefs:\n  QQBOT_CRED_APP_ID: 00012345 # keep spelling\n  LARGE_ID: 9007199254740993\n  HUGE_ID: ' + huge + '\n  KEY: "synthetic-key"\nrecords:\n  fixture/account:\n    kind: grant\n    payload: {count: 12, enabled: true}\n';
  await writeFile(filename, original, { mode: 0o600 });
  const ctx = new Context();
  try {
    await ctx.plugin(LocalCredentialProvider, { path: filename, watch: false });
    assert.deepEqual(await ctx.credentials.resolve('QQBOT_CRED_APP_ID'), { value: '00012345', source: 'file' });
    assert.equal(await readFile(filename, 'utf8'), original, 'activation must not rewrite the file');
    await ctx.credentials.set('OTHER', '009876');
    const written = await readFile(filename, 'utf8');
    assert.ok(written.includes('# keep spelling'));
    assert.ok(written.includes('QQBOT_CRED_APP_ID: "00012345"'));
    assert.equal(parse(written).refs.get('LARGE_ID'), '9007199254740993');
    assert.equal(parse(written).refs.get('HUGE_ID'), huge);
    assert.equal(parse(written).refs.get('OTHER'), '009876');
    assert.equal(parse(written).refs.get('QQBOT_CRED_APP_ID'), '00012345');
    assert.deepEqual(parse(written).records.get('fixture/account'), { kind: 'grant', payload: { count: 12, enabled: true } });
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
    await ctx.credentials.modifyRecord('fixture/account', current => ({ ...current, payload: { count: 13 } }));
    const afterRecord = await readFile(filename, 'utf8');
    assert.equal(parse(afterRecord).refs.get('QQBOT_CRED_APP_ID'), '00012345');
    assert.equal(parse(afterRecord).refs.get('HUGE_ID'), huge);
    await ctx.credentials.set('QQBOT_CRED_APP_ID', '0006789');
    const replaced = await readFile(filename, 'utf8');
    assert.equal(parse(replaced).refs.get('QQBOT_CRED_APP_ID'), '0006789', 'explicit replacement must not reuse the old token');
    await ctx.credentials.unset('QQBOT_CRED_APP_ID');
    const removed = parse(await readFile(filename, 'utf8'));
    assert.equal(removed.refs.has('QQBOT_CRED_APP_ID'), false);
    assert.equal(removed.refs.get('HUGE_ID'), huge);
    assert.equal(removed.refs.get('LARGE_ID'), '9007199254740993');
    await writeFile(filename, original, { mode: 0o600 });
    await ctx.credentials.reconcileFromDisk();
    assert.equal((await ctx.credentials.resolve('QQBOT_CRED_APP_ID')).value, '00012345');
    // An external malformed edit must block the lock-protected write, preserving every byte.
    const broken = original.replace('KEY: "synthetic-key"', 'KEY: {nested: synthetic-secret}');
    await writeFile(filename, broken, { mode: 0o600 });
    await assert.rejects(ctx.credentials.set('OTHER', 'next'), /must be a string/);
    assert.equal(await readFile(filename, 'utf8'), broken);
  } finally {
    await ctx.fiber.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
