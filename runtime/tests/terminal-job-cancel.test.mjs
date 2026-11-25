import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const { apply } = await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX), 'node_modules/@deepseek-ai/dsh-tool-terminal/lib/index.js')));

const SESSION_ID = 'pty-0123456789abcdef';
const JOB_ID = 'pty-send-0123456789abcdef';
const RESULT = {
  viewport: 'ready', waitReason: 'inferred_idle',
  sessionStatus: { kind: 'running' }, truncated: false,
};

// Capture hooks made by the actual public tool. Jobs and terminal operations
// are controlled peers; this does not run a registry, terminal backend or PTY.
function fixture(cancel = () => true) {
  const tools = new Map();
  const starts = [];
  const admitted = [];
  const pending = Promise.withResolvers();
  let cancelCalls = 0;
  const operation = {
    done: pending.promise,
    cancel() { cancelCalls++; return cancel(); },
    readOutput() { return { delta: '', truncated: false }; },
  };
  const jobs = {
    start(spec) {
      const hooks = spec.run();
      admitted.push({ spec, hooks });
      return JOB_ID;
    },
  };
  apply({
    tools: { register(tool) { tools.set(tool.name, tool); } },
    systemPrompt: { section() {}, getSectionOrder() { return 0; } },
    get(name) { assert.equal(name, 'jobs'); return jobs; },
    terminals: {
      startSend(owner, id, request) {
        starts.push({ owner, id, request });
        return operation;
      },
    },
  });
  assert.equal(tools.size, 6);
  return {
    tool: tools.get('terminal_send'), starts, admitted, pending,
    cancels: () => cancelCalls,
    exec: {
      agent: { id: 'session-test' }, callId: 'call-test', rootCallId: 'root-test',
      signal: new AbortController().signal,
    },
  };
}

test('background job forwards one successful cancellation before operation completion', async () => {
  const f = fixture();
  const ack = await f.tool.execute({ sessionId: SESSION_ID, text: 'input', run_in_background: true }, f.exec);
  assert.deepEqual(ack, { kind: 'background', jobId: JOB_ID });
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].owner, f.exec.agent);
  assert.equal(f.starts[0].id, SESSION_ID);
  assert.deepEqual(f.starts[0].request, { text: 'input', submit: true });
  assert.equal(f.admitted.length, 1);
  const { spec, hooks } = f.admitted[0];
  assert.equal(spec.owner, f.exec.agent.id);
  assert.deepEqual(spec.toolCall, { callId: 'call-test', rootCallId: 'root-test' });
  hooks.cancel('job kill');
  assert.equal(f.cancels(), 1);
  hooks.cancel('owner disposed');
  assert.equal(f.cancels(), 1);
  f.pending.resolve(RESULT);
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'wait: inferred_idle' });
});

test('uncancelled background operation retains completed outcome', async () => {
  const f = fixture();
  await f.tool.execute({ sessionId: SESSION_ID, text: 'input', run_in_background: true }, f.exec);
  f.pending.resolve(RESULT);
  assert.deepEqual(await f.admitted[0].hooks.done, { status: 'completed', detail: 'wait: inferred_idle' });
  assert.equal(f.cancels(), 0);
});

test('background operation rejection retains failed outcome after cancellation', async () => {
  const f = fixture();
  await f.tool.execute({ sessionId: SESSION_ID, text: 'input', run_in_background: true }, f.exec);
  const { hooks } = f.admitted[0];
  hooks.cancel();
  const error = new Error('operation failed');
  f.pending.reject(error);
  assert.deepEqual(await hooks.done, { status: 'failed', detail: String(error) });
});

test('foreground operation keeps its signal and result without job admission', async () => {
  const f = fixture();
  const result = f.tool.execute({ sessionId: SESSION_ID, text: 'input', submit: false }, f.exec);
  assert.equal(f.admitted.length, 0);
  assert.equal(f.starts.length, 1);
  assert.equal(f.starts[0].owner, f.exec.agent);
  assert.deepEqual(f.starts[0].request, { text: 'input', submit: false, signal: f.exec.signal });
  f.pending.resolve(RESULT);
  assert.deepEqual(await result, { kind: 'foreground', ...RESULT });
  assert.equal(f.cancels(), 0);
});

test('synchronous cancellation errors keep retrying until a normal false return', async () => {
  const error = new Error('cancel unavailable');
  let throws = true;
  const f = fixture(() => { if (throws) throw error; return false; });
  await f.tool.execute({ sessionId: SESSION_ID, text: 'input', run_in_background: true }, f.exec);
  const { hooks } = f.admitted[0];
  assert.throws(() => hooks.cancel(), value => value === error);
  assert.throws(() => hooks.cancel(), value => value === error);
  assert.equal(f.cancels(), 2);
  throws = false;
  hooks.cancel();
  assert.equal(f.cancels(), 3);
  hooks.cancel();
  assert.equal(f.cancels(), 3);
  f.pending.resolve(RESULT);
  assert.deepEqual(await hooks.done, { status: 'killed', detail: 'wait: inferred_idle' });
});
