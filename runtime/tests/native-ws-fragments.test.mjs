// Finite retained-fragment observations on the real codec, without changing its API.
// node --test runtime/tests/native-ws-fragments.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Session } from 'node:inspector/promises';
import { Duplex } from 'node:stream';
import { WsConnection, encodeFrame } from '../bridge/dsh-go-bridge/lib/native/ws.js';

class Pipe extends Duplex {
  out = [];
  _read() {}
  _write(chunk, encoding, done) { this.out.push(chunk); done(); }
}

async function retainedFragments(ws) {
  const key = `__dshWsFragments_${randomUUID().replaceAll('-', '')}`;
  const session = new Session();
  assert.equal(Object.hasOwn(globalThis, key), false);
  globalThis[key] = ws;
  let connected = false;
  try {
    session.connect();
    connected = true;
    const evaluated = await session.post('Runtime.evaluate', {
      expression: `globalThis.${key}`, objectGroup: key,
    });
    assert.equal(evaluated.exceptionDetails, undefined);
    assert.equal(evaluated.result.type, 'object');
    assert.equal(typeof evaluated.result.objectId, 'string');
    const properties = await session.post('Runtime.getProperties', {
      objectId: evaluated.result.objectId, ownProperties: true,
    });
    assert.equal(properties.exceptionDetails, undefined);
    assert.ok(Array.isArray(properties.privateProperties), 'Inspector must expose private properties');
    const fragments = properties.privateProperties.find(p => p.name === '#fragments')?.value;
    assert.equal(fragments?.subtype, 'array');
    assert.equal(typeof fragments.objectId, 'string');
    const entries = await session.post('Runtime.getProperties', {
      objectId: fragments.objectId, ownProperties: true,
    });
    assert.equal(entries.exceptionDetails, undefined);
    const length = entries.result.find(p => p.name === 'length')?.value;
    assert.equal(length?.type, 'number');
    assert.ok(Number.isSafeInteger(length.value) && length.value >= 0);
    return length.value;
  } finally {
    try {
      if (connected) await session.post('Runtime.releaseObjectGroup', { objectGroup: key });
    } finally {
      delete globalThis[key];
      if (connected) session.disconnect();
    }
  }
}

for (const first of ['', '{"t":"ping"}']) {
  test(`ws: empty continuations retain bounded entries after ${first.length} initial bytes`, async t => {
    const socket = new Pipe();
    const ws = new WsConnection(socket, Buffer.alloc(0), 4096);
    t.after(() => { socket.emit('end'); socket.destroy(); });
    const messages = [];
    let activity = 0;
    ws.on('message', message => messages.push(message));
    ws.on('activity', () => { activity++; });
    socket.emit('data', encodeFrame(1, first, { mask: true, fin: false }));
    const count = 2048;
    for (let i = 0; i < count; i++) {
      socket.emit('data', encodeFrame(0, '', { mask: true, fin: false }));
    }
    assert.equal(ws.closed, false);
    assert.equal(activity, count + 1);
    assert.deepEqual(messages, []);
    const retained = await retainedFragments(ws);
    const bytes = Buffer.byteLength(first);
    t.diagnostic(JSON.stringify({ firstBytes: bytes, emptyContinuations: count, retained }));
    assert.ok(retained <= bytes + 1, `${retained} entries exceed ${bytes + 1} for ${bytes} payload bytes`);
    socket.emit('data', encodeFrame(0, '', { mask: true }));
    assert.deepEqual(messages, [first]);
    assert.equal(await retainedFragments(ws), 0);
  });
}

test('ws: empty fragments preserve message boundaries, UTF-8 and interleaved control frames', t => {
  const socket = new Pipe();
  const ws = new WsConnection(socket, Buffer.alloc(0), 64);
  t.after(() => { socket.emit('end'); socket.destroy(); });
  const messages = [];
  ws.on('message', message => messages.push(message));
  const feed = (opcode, payload, fin = true) => socket.emit('data', encodeFrame(opcode, payload, { mask: true, fin }));
  feed(1, '');
  feed(1, '', false);
  feed(0, '', false);
  feed(0, '');
  feed(1, '', false);
  const smile = Buffer.from('😀');
  feed(0, smile.subarray(0, 2), false);
  feed(9, 'control');
  feed(0, '', false);
  feed(0, smile.subarray(2), false);
  feed(0, '');
  assert.deepEqual(messages, ['', '', '😀']);
  assert.equal(ws.closed, false);
  assert.deepEqual(socket.out, [encodeFrame(10, 'control')]);
  let closeCode;
  ws.on('close', code => { closeCode = code; });
  // A completed empty message must not leave continuation permission behind.
  feed(0, '');
  assert.equal(closeCode, 1002);
});
