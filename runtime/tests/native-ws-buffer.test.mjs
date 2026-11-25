// Exercise the production socket parser with deterministic TCP segmentation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { WsConnection, encodeFrame } from "../bridge/dsh-go-bridge/lib/native/ws.js";
import { LIMITS } from "../bridge/dsh-go-bridge/lib/native/limits.js";

class Socket extends EventEmitter {
  out = [];
  write(chunk) { this.out.push(chunk); }
  end() {}
  destroy() {}
}

function connection() {
  const socket = new Socket();
  const ws = new WsConnection(socket, Buffer.alloc(0), LIMITS.streamInboundFrameBytes);
  const messages = [];
  ws.on("message", (text) => messages.push(text));
  return { socket, ws, messages };
}

// Count only explicit buffer assembly, not masking, UTF-8 decoding or elapsed CPU.
// The window is synchronous and all wire fixtures are built beforehand.
function copiedBytes(run) {
  const concat = Buffer.concat;
  const copy = Buffer.prototype.copy;
  let bytes = 0;
  let inConcat = false;
  Buffer.concat = function (list, length) {
    inConcat = true;
    try {
      const result = concat.call(this, list, length);
      bytes += result.length;
      return result;
    } finally { inConcat = false; }
  };
  Buffer.prototype.copy = function (...args) {
    const count = copy.apply(this, args);
    if (!inConcat) bytes += count;
    return count;
  };
  try { run(); } finally {
    Buffer.concat = concat;
    Buffer.prototype.copy = copy;
  }
  return bytes;
}

for (const size of [1, 16, 256, 8192]) {
  test(`ws buffer: 4096-byte text in ${size}-byte TCP chunks`, (t) => {
    const text = "x".repeat(LIMITS.streamInboundFrameBytes);
    const wire = encodeFrame(1, text, { mask: true });
    const { socket, messages } = connection();
    const copied = copiedBytes(() => {
      for (let start = 0; start < wire.length; start += size) socket.emit("data", wire.subarray(start, start + size));
    });
    assert.deepEqual(messages, [text]);
    t.diagnostic(`wire=${wire.length} chunk=${size} copied=${copied}`);
    assert.ok(copied <= 3 * wire.length, `assembly copied ${copied} bytes for ${wire.length} wire bytes`);
    if (size >= wire.length) assert.equal(copied, 0, "complete frame keeps its zero-copy input path");
  });
}

test("ws buffer: coalesced frames, partial tail and UTF-8/control fragmentation", () => {
  const text = "z".repeat(4000);
  const first = encodeFrame(1, text, { mask: true });
  const tail = encodeFrame(1, "after", { mask: true });
  const { socket, messages, ws } = connection();
  socket.emit("data", first.subarray(0, 1));
  // Exceeds the staging cap; includes many complete frames and a partial next frame.
  socket.emit("data", Buffer.concat([first.subarray(1), first, tail.subarray(0, 3)]));
  for (const byte of tail.subarray(3)) socket.emit("data", Buffer.from([byte]));
  const utf8 = Buffer.from("中");
  const frames = Buffer.concat([
    encodeFrame(1, utf8.subarray(0, 1), { mask: true, fin: false }),
    encodeFrame(9, "ping", { mask: true }),
    encodeFrame(0, utf8.subarray(1), { mask: true }),
  ]);
  for (const byte of frames) socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(messages, [text, text, "after", "中"]);
  assert.equal(socket.out[0][0], 0x8a);
  assert.equal(ws.closed, false);
});

test("ws buffer: compact a consumed prefix before extending its partial tail", () => {
  const one = encodeFrame(1, "first", { mask: true });
  const two = encodeFrame(1, "second", { mask: true });
  const { socket, messages } = connection();
  socket.emit("data", one.subarray(0, 1));
  socket.emit("data", Buffer.concat([one.subarray(1), two.subarray(0, 2)]));
  for (const byte of two.subarray(2)) socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(messages, ["first", "second"]);
});

test("ws buffer: split extended headers retain size and UTF-8 failures", () => {
  for (const [wire, expected] of [
    [encodeFrame(1, "x".repeat(4097), { mask: true }), 1009],
    [Buffer.from([0x81, 0xff, 0, 0, 0, 1, 0, 0, 0, 0]), 1009],
    [encodeFrame(1, Buffer.from([0xff]), { mask: true }), 1007],
    [encodeFrame(1, "unmasked"), 1002],
  ]) {
    const { socket, ws, messages } = connection();
    let code;
    ws.on("close", (c) => { code = c; });
    for (const byte of wire) socket.emit("data", Buffer.from([byte]));
    assert.equal(code, expected);
    assert.deepEqual(messages, []);
  }
});


test("ws buffer: borrowed nonzero-offset input stays untouched and close ignores more input", () => {
  const frame = encodeFrame(1, "borrowed", { mask: true });
  const backing = Buffer.concat([Buffer.from("padding"), frame, Buffer.from("trailer")]);
  const before = Buffer.from(backing);
  const { socket, ws, messages } = connection();
  socket.emit("data", backing.subarray(7, 10));
  for (const byte of frame.subarray(3)) socket.emit("data", Buffer.from([byte]));
  assert.deepEqual(backing, before);
  assert.deepEqual(messages, ["borrowed"]);
  socket.emit("end");
  const copied = copiedBytes(() => socket.emit("data", frame));
  assert.equal(copied, 0);
  assert.equal(ws.closed, true);
  assert.deepEqual(messages, ["borrowed"]);
});

test("ws buffer: upgrade head can be a partial frame", async () => {
  const frame = encodeFrame(1, "head", { mask: true });
  const socket = new Socket();
  const ws = new WsConnection(socket, frame.subarray(0, 1), LIMITS.streamInboundFrameBytes);
  const messages = [];
  ws.on("message", (text) => messages.push(text));
  await new Promise(queueMicrotask);
  socket.emit("data", frame.subarray(1));
  assert.deepEqual(messages, ["head"]);
});
