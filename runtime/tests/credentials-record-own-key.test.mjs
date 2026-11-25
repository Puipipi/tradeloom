import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
const options = { skip: !prefix && 'prepared DSH prefix required' };
let modules;
function api() {
  return modules ??= (async () => {
    const require = createRequire(resolve(prefix, 'package.json'));
    const load = name => import(pathToFileURL(require.resolve(`@deepseek-ai/${name}`)));
    const [{ Context }, { LocalCredentialProvider, parseCredentialsDocument }, { credentialKey }] = await Promise.all([
      load('cordis'), load('dsh-credentials-local'), load('dsh-credentials'),
    ]);
    return { Context, LocalCredentialProvider, parseCredentialsDocument, credentialKey };
  })();
}

for (const item of [
  { name: 'changed own __proto__ JSON field', before: JSON.parse('{"__proto__":{}}'), after: { x: 1 }, events: 1 },
  { name: 'ordinary changed grant', before: { count: 1 }, after: { count: 2 }, events: 1 },
  { name: 'same JSON with reordered keys', before: { alpha: 1, beta: { enabled: true } }, after: { beta: { enabled: true }, alpha: 1 }, events: 0 },
]) {
  test(`public credential reconcile notifies ${item.name}`, options, async () => {
    const { Context, LocalCredentialProvider, parseCredentialsDocument, credentialKey } = await api();
    const root = await mkdtemp(join(tmpdir(), 'credentials-record-own-key-'));
    const filename = join(root, 'credentials.yaml');
    const key = credentialKey('fixture', 'account');
    const contexts = [];
    async function open() {
      const ctx = new Context();
      contexts.push(ctx);
      await ctx.plugin(LocalCredentialProvider, { path: filename, watch: false });
      return ctx;
    }
    try {
      const first = await open();
      const before = { kind: 'grant', payload: item.before };
      const after = { kind: 'grant', payload: item.after };
      await first.credentials.modifyRecord(key, async () => before);
      assert.deepEqual(parseCredentialsDocument(await readFile(filename, 'utf8'), filename).records.get(key), before);
      const second = await open();
      const notified = [];
      first.on('credentials/record-updated', changed => notified.push(changed));
      await second.credentials.modifyRecord(key, async () => after);
      const disk = await readFile(filename, 'utf8');
      assert.deepEqual(parseCredentialsDocument(disk, filename).records.get(key), after);
      // The public no-op mutation reads under the real document lock and
      // reconciles external edits, then declines its own write/notification.
      await first.credentials.modifyRecord(key, async current => {
        assert.deepEqual(current, after);
        return undefined;
      });
      assert.equal(await readFile(filename, 'utf8'), disk, 'declined mutation must not rewrite the external document');
      assert.deepEqual(await first.credentials.readRecord(key), after);
      const restarted = await open();
      assert.deepEqual(await restarted.credentials.readRecord(key), after);
      assert.deepEqual(notified, item.events ? [key] : [], 'record change notification is independent of successful read/durability');
    } finally {
      for (const ctx of contexts.reverse()) await ctx.fiber.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}
