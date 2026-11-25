import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { apply } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai/dsh-tool-terminal/lib/index.js')));

// Capture actual public tool definitions. No terminal backend or PTY is simulated.
function registered(maxResultBytes = 262144) {
  const tools = new Map();
  apply({
    tools: { register(tool) { tools.set(tool.name, tool); } },
    systemPrompt: { section() {}, getSectionOrder() { return 0; } },
  }, { maxResultBytes });
  assert.equal(tools.size, 6);
  return tools;
}

function rendered(tool, value, args = {}) {
  const content = tool.output.render(args, value);
  return tool.finalizeContent({}, { content });
}

function encodedDuring(action) {
  const original = TextEncoder.prototype.encode;
  let calls = 0;
  let bytes = 0;
  TextEncoder.prototype.encode = function (...args) {
    const value = Reflect.apply(original, this, args);
    calls++;
    bytes += value.byteLength;
    return value;
  };
  try { return { value: action(), counts: () => ({ calls, bytes }) }; }
  finally { TextEncoder.prototype.encode = original; }
}

for (const [label, text] of [
  ['ASCII', 'a'.repeat(128 * 1024)],
  ['BMP', '数'.repeat(32 * 1024)],
  ['supplementary', '😀'.repeat(24 * 1024)],
]) {
  test(`terminal_read render and finalizer count ${label} bytes without an encoded copy`, t => {
    const tool = registered().get('terminal_read');
    const value = { text, totalLines: 3, lineBegin: 1, lineEnd: 3, truncated: false };
    const sample = encodedDuring(() => rendered(tool, value));
    assert.deepEqual(sample.value, [{ type: 'text', text: `${text}\n[lines: 1-3 of 3]` }]);
    t.diagnostic(JSON.stringify({ label, ...sample.counts() }));
    assert.deepEqual(sample.counts(), { calls: 0, bytes: 0 });
  });
}

test('all six registered renderers preserve their complete acknowledgements', () => {
  const tools = registered();
  const fixtures = [
    ['terminal_open', { sessionId: 'pty-1', name: 'main', type: 'shell', motd: '欢迎\n😀' }, {}, 'started terminal session pty-1 (main) [type: shell]\n欢迎\n😀'],
    ['terminal_send', { kind: 'foreground', viewport: 'ready', waitReason: 'inferred_idle', sessionStatus: { kind: 'running' }, truncated: false }, {}, 'ready\n[wait: inferred_idle]\n[session: running]'],
    ['terminal_send', { kind: 'foreground', viewport: '', waitReason: 'session_exit', sessionStatus: { kind: 'exited', exitCode: 2, signal: null }, truncated: true }, {}, '(no new output)\n[wait: session_exit]\n[session: exited code=2 signal=null]\n[output truncated]'],
    ['terminal_send', { kind: 'background', jobId: 'job-1' }, {}, 'started background job job-1'],
    ['terminal_read', { text: '', totalLines: 0, lineBegin: 0, lineEnd: 0, truncated: false }, {}, '(no retained output)\n[lines: 0-0 of 0]'],
    ['terminal_signal', { delivered: true, targetPgid: 123 }, { signal: 'SIGINT' }, 'delivered SIGINT to foreground process group 123'],
    ['terminal_close', { sessionId: 'pty-1', outcome: 'closed' }, {}, 'closed terminal session pty-1'],
    ['terminal_close', { sessionId: 'pty-1', outcome: 'already-closing' }, {}, 'terminal session pty-1 was already closing'],
    ['terminal_list', [], {}, '(no terminal sessions)'],
    ['terminal_list', [{ sessionId: 'pty-1', type: 'shell', name: 'main', pid: 123, status: { kind: 'running' } }], {}, 'pty-1 (main) [shell] running pid=123'],
  ];
  for (const [name, value, args, expected] of fixtures) {
    assert.deepEqual(rendered(tools.get(name), value, args), [{ type: 'text', text: expected }]);
  }
});

test('64-byte finalizer boundary preserves BMP, pairs, isolated surrogates and BOM', () => {
  const tool = registered(64).get('terminal_read');
  for (const unit of ['A', '数', '😀', '\ud800', '\udc00', '\ufeff']) {
    const width = Buffer.byteLength(unit, 'utf8');
    const exact = `${'x'.repeat(64 - width)}${unit}`;
    const finalize = text => tool.finalizeContent({}, { content: [{ type: 'text', text }] });
    assert.deepEqual(finalize(exact), [{ type: 'text', text: exact }]);
    const over = finalize(`${exact}z`)[0].text;
    assert.equal(over, `${'x'.repeat(45)}\n[output truncated]`);
    assert.equal(Buffer.byteLength(over, 'utf8'), 64);
  }
});

test('actual retention still encodes truncated text and preserves UTF-8 tail plus metadata', t => {
  const tool = registered(64).get('terminal_read');
  const text = '😀'.repeat(50);
  const sample = encodedDuring(() => rendered(tool, { text, totalLines: 3, lineBegin: 1, lineEnd: 3, truncated: false }));
  assert.deepEqual(sample.value, [{ type: 'text', text: `${'😀'.repeat(6)}\n[lines: 1-3 of 3]\n[output truncated]` }]);
  t.diagnostic(JSON.stringify(sample.counts()));
  assert.equal(sample.counts().calls, 1);
  assert.equal(sample.counts().bytes, 200);
});

test('non-single-text finalizer remains a no-op and errors keep their message', () => {
  const tool = registered(64).get('terminal_read');
  for (const content of [[], [{ type: 'image', url: 'example' }], [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }]]) {
    assert.equal(tool.finalizeContent({}, { content }), undefined);
  }
  assert.deepEqual(tool.finalizeContent({}, { isError: true, content: [{ type: 'text', text: 'failure 😀' }] }), [{ type: 'text', text: 'failure 😀' }]);
});
