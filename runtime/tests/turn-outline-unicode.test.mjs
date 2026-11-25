import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
let loaded;
async function fixture(t) {
  if (!loaded) {
    const prefix = process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
    if (!prefix) throw new Error('Set DSH_TEST_PREFIX or DSH_PREFIX');
    const load = name => import(pathToFileURL(join(resolve(prefix), 'node_modules/@deepseek-ai', name, 'lib/index.js')));
    loaded = Promise.all(['cordis', 'dsh-session', 'dsh-session-projection', 'dsh-session-turn-outline', 'dsh-llm'].map(load));
  }
  const [{ Context }, { SessionStore }, { SessionProjectionRegistry }, outline, llm] = await loaded;
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await ctx.plugin(SessionStore).await();
  await ctx.plugin(SessionProjectionRegistry).await();
  await ctx.plugin(outline).await();
  const session = ctx.sessions.create('turn-outline-test');
  const projection = ctx.sessionProjections;
  const view = () => projection.snapshot(session, ['turnOutline']).values.turnOutline;
  function prompt(content) {
    session.append('turn/start', { turn: 1 });
    session.append('user/message', { content, source: { kind: 'user' } }, { surfaceOp: 'append' });
  }
  function response(text) {
    const stream = new llm.AssistantStreamAccumulator();
    stream.push({ time: 1, chunk: { type: 'text-delta', index: 0, text } });
    stream.push({ time: 2, chunk: { type: 'finish', reason: { kind: 'stop' } } });
    session.append('assistant/message', {
      turn: 1, step: 1,
      message: llm.createAssistantMessage({ source: { provider: 'own-fixture', model: 'own-model' }, content: [{ type: 'text', text }] }),
      stream: stream.snapshot(),
    }, { surfaceOp: 'append' });
  }
  const end = () => session.append('turn/end', { turn: 1, reason: { kind: 'completed' } });
  return { ctx, session, projection, prompt, response, end, view };
}
const text = value => [{ type: 'text', text: value }];
for (const [name, prompt, response, expectedPrompt, expectedResponse] of [
  ['prompt final', 'a'.repeat(48) + '🙂tail', 'done', 'a'.repeat(48) + '…', 'done'],
  ['response final', 'hello', 'a'.repeat(118) + '🙂tail', 'hello', 'a'.repeat(118) + '…'],
  ['prompt inner', ' '.repeat(99) + '🙂tail', 'done', '…', 'done'],
  ['response inner', 'hello', ' '.repeat(239) + '🙂tail', 'hello', '…'],
  ['ASCII budgets', 'a'.repeat(60), 'b'.repeat(130), 'a'.repeat(49) + '…', 'b'.repeat(119) + '…'],
  ['short Unicode', '中文🙂', '回答🙂', '中文🙂', '回答🙂'],
  ['complete pair before cut', 'a'.repeat(47) + '🙂tail', 'b'.repeat(117) + '🙂tail', 'a'.repeat(47) + '🙂…', 'b'.repeat(117) + '🙂…'],
]) {
  test(`${name}: public turnOutline preserves scalar text and UTF16 budgets`, async t => {
    const f = await fixture(t);
    f.prompt(text(prompt));
    f.session.append('step/start', { turn: 1, step: 1 });
    f.response(response);
    f.session.append('step/end', { turn: 1, step: 1 });
    f.end();
    const [entry] = f.view();
    assert.equal(entry.prompt, expectedPrompt);
    assert.equal(entry.response, expectedResponse);
    assert.ok(entry.prompt.isWellFormed() && entry.response.isWellFormed());
    assert.ok(entry.prompt.length <= 50 && entry.response.length <= 120);
  });
}

test('multiblock whitespace and response commit preserve three wire changes', async t => {
  const f = await fixture(t);
  const changes = [];
  f.projection.onChanged((session, key, value) => {
    if (session === f.session && key === 'turnOutline') changes.push(value);
  });
  f.prompt([...text('  first\n'), ...text('\tsecond  '), ...text('🙂')]);
  const promptView = f.view();
  assert.equal(promptView[0].prompt, 'first second 🙂');
  assert.equal(changes.length, 2);
  f.session.append('step/start', { turn: 1, step: 1 });
  f.response('early answer');
  assert.deepEqual(f.view(), promptView);
  f.response('final answer 🙂');
  assert.deepEqual(f.view(), promptView);
  assert.equal(f.view()[0].response, '');
  assert.equal(changes.length, 2);
  f.session.append('step/end', { turn: 1, step: 1 });
  f.end();
  assert.equal(changes.length, 3);
  assert.equal(f.view()[0].response, 'final answer 🙂');
});

test('actual version2 checkpoint requires replay and leaves source events unchanged', async t => {
  const f = await fixture(t);
  const raw = await readFile(new URL('./fixtures/turn-outline-v2-checkpoint.json', import.meta.url), 'utf8');
  const old = JSON.parse(raw);
  assert.equal(old.checkpoint.turnOutline.ver, 2);
  assert.equal(old.checkpoint.turnOutline.val.turns[0].prompt.isWellFormed(), false);
  const before = JSON.stringify(old);
  assert.equal(f.projection.restoreFloor(old.checkpoint), 0);
  assert.deepEqual(f.projection.viewCheckpoint(old.checkpoint, ['turnOutline']), {});
  const restored = f.projection.restore(old.checkpoint, old.events, 0, old.header, old.inheritedEventCount);
  assert.equal(restored.checkpoint.turnOutline.ver, 3);
  assert.equal(restored.snapshot.values.turnOutline[0].prompt, 'a'.repeat(48) + '…');
  assert.ok(restored.snapshot.values.turnOutline[0].prompt.isWellFormed());
  assert.equal(JSON.stringify(old), before);
  assert.equal(await readFile(new URL('./fixtures/turn-outline-v2-checkpoint.json', import.meta.url), 'utf8'), raw);
});
