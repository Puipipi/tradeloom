import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventEmitter } from 'node:events';
import { mock } from 'node:test';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
export async function createFixture(prefix, text, maxReadBytes = 256 * 1024) {
  const require = createRequire(resolve(prefix, 'package.json'));
  const { BashTerminalBackend } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-terminal-bash')));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const ctx = new Context();
  const owner = { id: 'fixture-agent', ctx, session: {} };
  const output = new EventEmitter(); const done = Promise.withResolvers();
  const terminal = { pid: 1, output, done: done.promise,
    async inspectForeground() { return { processGroupId: 1, inputWaiting: true }; },
    async write() {}, async signalForeground() { return 1; },
    async terminate() { output.emit('end'); done.resolve({exitCode:0,signal:null}); },
  };
  const config = { backendType:'shell',shellDialect:'bash',shellPath:'/fixture/bash',shellArgs:[],rows:40,cols:160,
    scrollbackLines:10000,scrollbackMaxBytes:4*1024*1024,maxReadBytes,pollIntervalMs:50,exactProbeAfterMs:150,
    idleSilenceMs:3000,handoffGraceMs:500,promptTailGraceMs:0,timeoutMs:30000,disposeGraceMs:3000 };
  const services = { terminals: {}, sessionProjections: {}, sandboxPolicy: {resolve:()=>({mode:'danger-full-access'})} };
  const backend = new BashTerminalBackend(services, config, async () => terminal);
  mock.timers.enable({apis:['Date','setTimeout'],now:100000});
  let monotonic = 0;
  let monotonicMock;
  const virtualTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, delay = 0, ...args) => virtualTimeout(fn, delay, ...args);
  let result, failure;
  try {
    monotonicMock = mock.method(performance, 'now', () => monotonic);
    const pending = backend.spawn({owner,sessionId:'fixture-terminal',cwd:'/fixture'}).then(x=>{result=x;},e=>{failure=e;});
    for(let i=0;i<10;i++) await Promise.resolve();
    output.emit('data', Buffer.from('\x1b]133;D;0\x07dsh> '));
    for(let i=0;i<100 && !result && !failure;i++) {monotonic += 50;mock.timers.tick(50);for(let j=0;j<20;j++)await Promise.resolve();await yieldTurn();}
    if(failure)throw failure;
    if(!result)throw new Error('fixture startup did not settle under virtual time');
    await pending;
  } finally {globalThis.setTimeout = virtualTimeout;try {monotonicMock?.mock.restore();} finally {mock.timers.reset();}}
  output.emit('data', Buffer.from('\n'+text));
  // End the controlled PTY producer to close its real emulator and all output work.
  await terminal.terminate();
  await terminal.done;
  await Promise.resolve();
  return { session:result, async close(){await result.close('fixture complete');await ctx.fiber.dispose();} };
}
