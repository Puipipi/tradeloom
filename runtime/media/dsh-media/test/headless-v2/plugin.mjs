import assert from 'node:assert/strict';
import { open, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Config, inject as productionInject, installMedia } from '../../src/index.js';
import { createHttpTransport } from '../../src/http.js';
import { createStreamStager } from '../../src/stream-staging.js';
export { Config };
export const name = 'media-v2-headless-probe';
export const inject = [...productionInject, 'sessions'];
async function durableReplace(path, text) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
export async function apply(ctx, config) {
  assert.equal(process.env.DSH_MEDIA_HEADLESS_PROBE, '1');
  const output = process.env.DSH_MEDIA_PROBE_CAPTURE_DIR;
  const origin = process.env.DSH_MEDIA_PROBE_IMAGE_ORIGIN;
  assert.ok(isAbsolute(output)); assert.equal(await realpath(output), resolve(output));
  const endpoint = new URL(origin); assert.equal(endpoint.protocol, 'http:'); assert.equal(endpoint.hostname, '127.0.0.1'); assert.equal(endpoint.origin, origin);
  const http = createHttpTransport({ allowLoopback: true });
  const transport = (url, options) => {
    const parsed = new URL(url);
    assert.ok(['api.openai.com', 'ark.cn-beijing.volces.com', 'result.example'].includes(parsed.hostname), 'forbid external traffic');
    return http(origin + parsed.pathname, options);
  };
  ctx.on('approval/request', async (req, next) => {
    if (!['generate_image', 'generate_video', 'edit_image'].includes(req.toolName)) return next();
    assert.ok(req.reason.includes('不是报价或供应商扣费上限'));
    return 'allowed-once'; // Test-only explicit synthetic consent; production answerers are untouched.
  });
  ctx.jobs.events.subscribe({ owners: 'all' }, event => {
    if (event.type === 'settled' && event.job.kind === 'media') {
      void durableReplace(join(output, 'job-settled.json'), JSON.stringify(event.job)).catch(noteFailure);
    }
  });
  let captured;
  let failure;
  let pending = Promise.resolve();
  const noteFailure = error => { failure ??= error; };
  function captureSession(session) {
    if (captured) {
      assert.equal(session, captured.session, 'one fresh root session per process');
      return;
    }
    assert.equal(session.firstLiveSeq, 0);
    assert.equal(session.header.isSeeded === true, false);
    assert.equal(session.header.origin, undefined);
    assert.equal(session.header.parentSession, undefined);
    captured = { session, header: session.header, lines: [], bytes: 0 };
  }
  ctx.on('session/created', session => {
    // Another creation listener may already have appended a real event.
    // The event listener below captures it; do not assume listener order.
    captureSession(session);
    assert.equal(session.seq, captured.lines.length, 'capture missed an initial event');
  });
  ctx.on('session/event', (session, event) => {
    try {
      captureSession(session);
      assert.equal(event.seq, captured.lines.length, 'post-commit event sequence gap');
      const line = JSON.stringify(event);
      captured.bytes += Buffer.byteLength(line, 'utf8') + 1;
      assert.ok(captured.lines.length < 4096 && captured.bytes <= 16 * 1024 * 1024);
      captured.lines.push(line);
    } catch (error) {
      // session/event isolates listener failures. Preserve the failure and
      // reject the awaited session/flush checkpoint instead of silently passing.
      noteFailure(error);
    }
  });
  ctx.on('session/flush', session => {
    // A prior session/event observer may request flush from inside commit().
    // Our own post-commit observer can therefore still be later in the same
    // synchronous dispatch. Queue the checkpoint before validating/copying;
    // never manufacture the unobserved event or relax per-event continuity.
    const throughAtRequest = session.seq;
    pending = pending.then(async () => {
      if (failure) throw failure;
      assert.equal(session, captured?.session);
      assert.ok(captured.lines.length >= throughAtRequest,
        'capture has not reached the requested durability checkpoint');
      assert.equal(session.seq, captured.lines.length);
      const events = captured.lines.join('\n') + '\n';
      const receipt = JSON.stringify({
        kind: 'actual-post-commit-session-events',
        sessionId: session.id, header: captured.header, throughSeqExclusive: session.seq,
        eventCount: captured.lines.length, eventBytes: captured.bytes,
      }, null, 2) + '\n';
      await durableReplace(join(output, 'session-events.jsonl'), events);
      await durableReplace(join(output, 'capture-receipt.json'), receipt);
    }).catch(error => {
      noteFailure(error);
      throw error;
    });
    return pending;
  });
  ctx.effect(() => async () => { await pending; });


  const installed = installMedia(ctx, config, { engineOptions: {
    transport, pollMs: 20,
    stageDownload(url, options) {
      assert.equal(url, 'https://result.example/video.mp4');
      return createStreamStager({ allowLoopback: true })(origin + '/video.mp4', options);
    },
  } });
  await installed.ready;
}
