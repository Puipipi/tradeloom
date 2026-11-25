import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// The real backend and headless parser run; only the documented process handle
// and clocks are controlled. No readiness implementation or private field access.
export async function createReadinessFixture(t, prefix, label, options = {}) {
  const trace = { case: label, steps: [], output: [], writes: [], inspections: [], timeouts: [], fixtureFailures: [] };
  const watched = [];
  const restores = [];
  const openingAbort = new AbortController();
  let mono = 0, wall = 1_000_000, timersEnabled = false;
  let ctx, session, terminal, opening;
  let foreground = { processGroupId: 11, inputWaiting: true };
  let afterWriteForeground;
  let terminated = false;
  const output = new EventEmitter();
  const done = Promise.withResolvers();
  const stamp = () => ({ mono, wall });
  const fail = (stage, error) => trace.fixtureFailures.push({ stage, message: String(error?.message ?? error) });
  const fixtureError = (message) => new Error(`TERMINAL_CLOCK_FIXTURE: ${message}`);
  function watch(promise, name) {
    const item = { name, state: 'pending', value: undefined };
    watched.push(item);
    // Attach both handlers immediately; a rejected product promise is a fixture
    // failure, never one of the expected clock assertions.
    item.observed = promise.then(value => { item.state = 'fulfilled'; item.value = value; }, error => {
      item.state = 'rejected'; item.error = error; fail(name, error);
    });
    return item;
  }
  async function pump() {
    // Headless WriteBuffer schedules a zero-delay write, then resolves parser
    // callbacks/microtasks. setImmediate yields a turn without a real sleep.
    for (let turn = 0; turn < 3; turn++) {
      t.mock.timers.tick(0);
      for (let n = 0; n < 20; n++) await Promise.resolve();
      await yieldTurn();
    }
  }
  async function advance(ms) {
    if (!Number.isSafeInteger(ms) || ms < 0) throw fixtureError('invalid virtual advance');
    for (let left = ms; left > 0;) {
      const step = Math.min(50, left);
      mono += step; wall += step; left -= step;
      t.mock.timers.tick(step);
      await pump();
    }
  }
  t.after(async () => {
    const attempt = async (stage, action) => { try { await action(); } catch (error) { fail(stage, error); } };
    await attempt('abort opening', () => openingAbort.abort(fixtureError('fixture closing')));
    await attempt('opening delivery', async () => {
      if (timersEnabled) await pump();
      if (!session && opening?.state === 'fulfilled') session = opening.value;
    });
    await attempt('session.close', async () => { if (session) await session.close('clock fixture complete'); });
    // Also covers setup failing before backend.spawn returns its session.
    await attempt('terminal.terminate', async () => { if (terminal) await terminal.terminate(); });
    await attempt('pending delivery', async () => {
      if (timersEnabled) await pump();
      for (const item of watched) if (item.state === 'pending') throw fixtureError(`${item.name} still pending after close`);
    });
    await attempt('ctx.fiber.dispose', async () => { if (ctx) await ctx.fiber.dispose(); });
    for (const restore of restores.reverse()) await attempt(restore.name, restore.run);
    await attempt('timers.reset', () => { if (timersEnabled) t.mock.timers.reset(); });
    // This explicit array is required even when a body AssertionError is the
    // first error: Node may otherwise hide an after-hook error behind it.
    t.diagnostic(`TERMINAL_CLOCK_TRACE ${JSON.stringify(trace)}`);
    assert.deepEqual(trace.fixtureFailures, [], 'TERMINAL_CLOCK_FIXTURE cleanup/setup failures');
  });
  try {
    const require = createRequire(resolve(prefix, 'package.json'));
    const { BashTerminalBackend } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-terminal-bash')));
    const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
    ctx = new Context();
    const owner = { id: `clock-${label}`, ctx, session: {} };
    terminal = {
      pid: 11, output, done: done.promise,
      async inspectForeground() {
        if (terminated) throw fixtureError('inspection after termination');
        const value = foreground === undefined ? undefined : { ...foreground };
        trace.inspections.push({ ...stamp(), foreground: value ?? null });
        return value;
      },
      async write(data) {
        if (terminated) throw fixtureError('write after termination');
        trace.writes.push({ ...stamp(), data });
        if (data.endsWith('\r')) foreground = afterWriteForeground;
      },
      async signalForeground() { return foreground?.processGroupId ?? 11; },
      async terminate() {
        if (terminated) return;
        terminated = true;
        output.emit('end');
        done.resolve({ exitCode: 0, signal: null });
      },
    };
    const config = { backendType: 'shell', shellDialect: 'bash', shellPath: '/fixture/bash', shellArgs: [],
      rows: 40, cols: 160, scrollbackLines: 10000, scrollbackMaxBytes: 4 * 1024 * 1024,
      maxReadBytes: 256 * 1024, pollIntervalMs: 50, exactProbeAfterMs: 150,
      idleSilenceMs: 3000, handoffGraceMs: 500, promptTailGraceMs: 0,
      timeoutMs: options.timeoutMs ?? 30000, disposeGraceMs: 3000 };
    const services = { terminals: {}, sessionProjections: {}, sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access' }) } };
    const backend = new BashTerminalBackend(services, config, async () => terminal);
    t.mock.timers.enable({ apis: ['setTimeout'], now: 0 }); timersEnabled = true;
    const dateMock = t.mock.method(Date, 'now', () => wall);
    restores.push({ name: 'Date.now.restore', run: () => dateMock.mock.restore() });
    const performanceMock = t.mock.method(performance, 'now', () => mono);
    restores.push({ name: 'performance.now.restore', run: () => performanceMock.mock.restore() });
    const virtualTimeout = globalThis.setTimeout;
    // Same omitted-delay adapter as the existing tail fixture. Node MockTimers
    // otherwise stores undefined+now, while headless legitimately omits delay.
    const timeoutAdapter = (fn, delay = 0, ...args) => {
      trace.timeouts.push({ ...stamp(), delay });
      return virtualTimeout(fn, delay, ...args);
    };
    globalThis.setTimeout = timeoutAdapter;
    // Keep this adapter outside MockTracker: its automatic second restore must
    // not resurrect a captured virtual timer after timers.reset().
    restores.push({ name: 'setTimeout.restore', run: () => { globalThis.setTimeout = virtualTimeout; } });
    opening = watch(backend.spawn({ owner, sessionId: `terminal-${label}`, cwd: '/fixture', signal: openingAbort.signal }), 'startup');
    await pump();
    if (output.listenerCount('data') !== 1 || trace.inspections.length === 0) throw fixtureError('backend startup did not attach its real output consumer');
    output.emit('data', Buffer.from('\x1b]133;D;0\x07dsh> '));
    await pump();
    await advance(50);
    if (opening.state !== 'fulfilled') throw fixtureError(`startup did not settle at its verified prompt: ${opening.state}`);
    session = opening.value;
    if (session.motd !== 'dsh> ' || session.status().kind !== 'running') throw fixtureError('unexpected startup response');
    trace.steps.push({ phase: 'startup-ready', ...stamp(), motd: session.motd });
    return {
      async start(text, nextForeground) {
        try {
          foreground = { processGroupId: 11, inputWaiting: true };
          afterWriteForeground = nextForeground;
          const before = trace.writes.length;
          const operation = session.startSend({ text, submit: true });
          const observed = watch(operation.done, `send-${watched.length}`);
          await pump();
          if (!trace.writes.slice(before).some(write => write.data === `${text}\r`)) throw fixtureError('public send did not reach the controlled process write');
          trace.steps.push({ phase: 'send-started', ...stamp(), text });
          return observed;
        } catch (error) { fail('send setup', error); throw fixtureError(`send setup failed: ${String(error)}`); }
      },
      async emit(data) {
        try {
          trace.output.push({ ...stamp(), data });
          output.emit('data', Buffer.from(data));
          await pump();
        } catch (error) { fail('output delivery', error); throw fixtureError(`output delivery failed: ${String(error)}`); }
      },
      jumpWall(delta) { wall += delta; trace.steps.push({ phase: 'wall-jump', ...stamp(), delta }); },
      advance,
      snapshot(observed, phase, requireCurrentInspection = true) {
        if (requireCurrentInspection && !trace.inspections.some(item => item.mono === mono)) {
          const error = fixtureError(`no actual foreground inspection at ${phase}`);
          fail('observation prerequisite', error);
          throw error;
        }
        if (observed.state === 'rejected') throw fixtureError(`public done rejected: ${String(observed.error)}`);
        const result = observed.state === 'fulfilled' ? observed.value : null;
        trace.steps.push({ phase, ...stamp(), result });
        return { settled: observed.state === 'fulfilled', waitReason: result?.waitReason ?? null };
      },
    };
  } catch (error) {
    fail('setup', error);
    throw fixtureError(`setup failed: ${String(error?.message ?? error)}`);
  }
}
