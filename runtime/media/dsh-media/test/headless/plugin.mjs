import assert from 'node:assert/strict';
import { open, readFile, realpath, rename } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Config, inject as productionInject, installMedia } from '../../src/index.js';
import { generateImage } from '../../src/core.js';
import { createHttpTransport } from '../../src/http.js';

export { Config };
export const name = 'dsh-media-headless-probe';
export const inject = [...productionInject, 'sessions'];

async function durableReplace(path, text) {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(text, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

export async function apply(ctx, config) {
  assert.equal(process.env.DSH_MEDIA_HEADLESS_PROBE, '1', 'test plugin requires explicit harness launch');
  const output = process.env.DSH_MEDIA_PROBE_CAPTURE_DIR;
  const origin = process.env.DSH_MEDIA_PROBE_IMAGE_ORIGIN;
  assert.ok(typeof output === 'string' && isAbsolute(output));
  assert.equal(await realpath(output), resolve(output), 'capture directory must already exist and be canonical');
  const loaded = {};
  for (const [label, specifier] of [
    ['src/index.js', '../../src/index.js'], ['src/config.js', '../../src/config.js'],
    ['src/core.js', '../../src/core.js'], ['src/http.js', '../../src/http.js'],
    ['src/generated-digests.js', '../../src/generated-digests.js'],
    ['src/storage.js', '../../src/storage.js'], ['src/errors.js', '../../src/errors.js'],
    ['src/base64.js', '../../src/base64.js'], ['src/header.js', '../../src/header.js'],
    ['package.json', '../../package.json'], ['data/models.json', '../../data/models.json'],
  ]) {
    const url = import.meta.resolve(specifier);
    const bytes = await readFile(new URL(url));
    loaded[label] = { url, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
  }
  const dependencies = {};
  for (const name of [
    '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-tools',
    '@deepseek-ai/dsh-credentials', '@deepseek-ai/dsh-fs',
    '@deepseek-ai/dsh-working-directory', '@deepseek-ai/dsh-sandbox-policy',
    '@deepseek-ai/dsh-system-prompt',
  ]) dependencies[name] = import.meta.resolve(name);
  await durableReplace(join(output, 'loaded-modules.json'), JSON.stringify({ loaded, dependencies }, null, 2) + '\n');
  const endpoint = new URL(origin);
  assert.equal(endpoint.protocol, 'http:');
  assert.equal(endpoint.hostname, '127.0.0.1');
  assert.ok(/^[1-9]\d*$/.test(endpoint.port));
  assert.equal(endpoint.origin, origin);
  assert.equal(endpoint.pathname, '/');
  assert.equal(endpoint.search + endpoint.hash + endpoint.username + endpoint.password, '');
  const allowedUrl = origin + '/v1/images/generations';
  const localTransport = createHttpTransport({ allowLoopback: true });
  const transport = (url, options) => {
    // allowLoopback itself still permits public HTTPS. The harness narrows it
    // to one exact bound server and one endpoint before every request.
    assert.equal(url, allowedUrl, 'no other image network destination is permitted');
    assert.equal(options.method, 'POST');
    return localTransport(url, options);
  };

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

  const installed = installMedia(ctx, config, {
    async generate(request, context) {
      assert.equal(request.service.id, 'probe');
      assert.equal(request.service.baseUrl, 'https://media-probe.invalid/v1');
      assert.equal(request.service.profile, 'openai-compatible');
      assert.equal(request.service.responseFormat, 'b64_json');
      assert.equal(request.model.id, 'gemini-2.5-flash-image');
      // Test-only routing substitution. Production Config and apply are not
      // changed. Real credentials, authorization, core and storage remain.
      return generateImage({
        ...request,
        service: { ...request.service, baseUrl: origin + '/v1' },
      }, { ...context, transport });
    },
  });
  await installed.ready;
}
