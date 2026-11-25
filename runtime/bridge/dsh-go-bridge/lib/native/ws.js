// Minimal RFC 6455 WebSocket server side (text messages, ping/pong, close; no extensions), so the
// bridge stays dependency-free. Also exports a client-side frame encoder for the tests.
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const decoder = new TextDecoder("utf-8", { fatal: true });

/** Encodes one frame. Server frames are unmasked; pass `mask: true` for client frames. */
export function encodeFrame(opcode, payload, { mask = false, fin = true } = {}) {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : (payload ?? Buffer.alloc(0));
  const len = body.length;
  const head = [(fin ? 0x80 : 0) | opcode];
  const m = mask ? 0x80 : 0;
  if (len < 126) head.push(m | len);
  else if (len < 65536) head.push(m | 126, len >> 8, len & 255);
  else {
    head.push(m | 127, 0, 0, 0, 0);
    head.push((len >>> 24) & 255, (len >>> 16) & 255, (len >>> 8) & 255, len & 255);
  }
  if (!mask) return Buffer.concat([Buffer.from(head), body]);
  const key = randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = body[i] ^ key[i & 3];
  return Buffer.concat([Buffer.from(head), key, masked]);
}

/**
 * Completes the handshake on a live upgrade request. Returns a WsConnection, or undefined if
 * the socket has ended or after answering 400 for an invalid version-13 WebSocket upgrade.
 */
export function acceptUpgrade(req, socket, head, { maxMessage }) {
  if (socket.destroyed || socket.readableEnded) {
    socket.destroy();
    return undefined;
  }
  const key = req.headers["sec-websocket-key"];
  const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
  const valid = req.method === "GET" && upgrade === "websocket" && req.headers["sec-websocket-version"] === "13"
    && typeof key === "string" && Buffer.from(key, "base64").length === 16;
  if (!valid) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return undefined;
  }
  const accept = createHash("sha1").update(key + GUID).digest("base64");
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\nCache-Control: no-store\r\n\r\n`);
  socket.setNoDelay?.(true);
  socket.setTimeout?.(0);
  return new WsConnection(socket, head, maxMessage);
}

export class WsConnection extends EventEmitter {
  closed = false;
  #socket;
  #buf = Buffer.alloc(0);
  #storage;
  #fragments = [];
  #fragmentBytes = 0;
  #maxMessage;
  #closeTimer;

  constructor(socket, head, maxMessage) {
    super();
    this.#socket = socket;
    this.#maxMessage = maxMessage;
    socket.on("data", (chunk) => this.#onData(chunk));
    socket.on("close", () => { clearTimeout(this.#closeTimer); this.#finish(1006); });
    // An upgraded HTTP socket may remain half-open after peer FIN. Release owners now.
    socket.on("end", () => {
      socket.end();
      this.#closeTimer ??= setTimeout(() => this.#socket.destroy(), 1000);
      this.#closeTimer.unref?.();
      this.#finish(1006);
    });
    socket.on("error", () => this.#finish(1006));
    if (head && head.length > 0) queueMicrotask(() => this.#onData(head));
  }

  get bufferedAmount() {
    return this.#socket.writableLength ?? 0;
  }

  send(text) {
    if (this.closed) return false;
    this.#socket.write(encodeFrame(0x1, text));
    return true;
  }

  ping(payload = "") {
    if (!this.closed) this.#socket.write(encodeFrame(0x9, payload));
  }

  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(reason.slice(0, 100), "utf8");
    const payload = Buffer.alloc(2 + r.length);
    payload.writeUInt16BE(code, 0);
    r.copy(payload, 2);
    try { this.#socket.write(encodeFrame(0x8, payload)); } catch {}
    this.#socket.end();
    this.#closeTimer = setTimeout(() => this.#socket.destroy(), 1000);
    this.#closeTimer.unref?.();
    this.#finish(code);
  }

  #finish(code) {
    if (this.closed) return;
    this.closed = true;
    this.#storage = undefined;
    this.#buf = Buffer.alloc(0);
    this.emit("close", code);
  }

  #onData(chunk) {
    if (this.closed) return;
    const previous = this.#buf;
    const size = previous.length + chunk.length;
    // Keep complete socket chunks borrowed. Only partial frames need owned storage.
    // The cap is one maximum frame, not a limit on a TCP chunk containing many frames.
    const capacity = this.#maxMessage + 14;
    if (previous.length === 0) this.#buf = chunk;
    else if (size > capacity) this.#buf = Buffer.concat([previous, chunk]);
    else {
      let storage = this.#storage;
      if (!storage || storage.length < size) {
        storage = Buffer.alloc(Math.min(capacity, Math.max(size, (storage?.length ?? 32) * 2)));
      }
      if (previous.buffer !== storage.buffer || previous.byteOffset !== storage.byteOffset) {
        previous.copy(storage, 0);
      }
      chunk.copy(storage, previous.length);
      this.#storage = storage;
      this.#buf = storage.subarray(0, size);
    }
    while (!this.closed) {
      const b = this.#buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0;
      const rsv = b[0] & 0x70;
      const opcode = b[0] & 0x0f;
      const masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f;
      let off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        const hi = b.readUInt32BE(2);
        len = hi !== 0 ? Infinity : b.readUInt32BE(6);
        off = 10;
      }
      if (rsv !== 0 || !masked) return this.close(1002, "protocol error");
      if (opcode >= 0x8 && (!fin || len > 125)) return this.close(1002, "bad control frame");
      if (len > this.#maxMessage) return this.close(1009, "message too big");
      if (b.length < off + 4 + len) return;
      const key = b.subarray(off, off + 4);
      const payload = Buffer.alloc(len);
      for (let i = 0; i < len; i++) payload[i] = b[off + 4 + i] ^ key[i & 3];
      this.#buf = b.subarray(off + 4 + len);
      this.#frame(fin, opcode, payload);
    }
  }

  #frame(fin, opcode, payload) {
    this.emit("activity");
    switch (opcode) {
      case 0x0: case 0x1: {
        if (opcode === 0x1 && this.#fragments.length > 0) return this.close(1002, "unexpected text frame");
        if (opcode === 0x0 && this.#fragments.length === 0) return this.close(1002, "unexpected continuation");
        this.#fragmentBytes += payload.length;
        if (this.#fragmentBytes > this.#maxMessage) return this.close(1009, "message too big");
        // Keep the first fragment as the message marker, without accumulating empty continuations.
        if (payload.length > 0 || this.#fragments.length === 0) this.#fragments.push(payload);
        if (!fin) return;
        const whole = this.#fragments.length === 1 ? this.#fragments[0] : Buffer.concat(this.#fragments);
        this.#fragments = [];
        this.#fragmentBytes = 0;
        let text;
        try { text = decoder.decode(whole); } catch { return this.close(1007, "invalid utf-8"); }
        this.emit("message", text);
        return;
      }
      case 0x2: return this.close(1003, "binary frames are not supported");
      case 0x8: {
        const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
        if (!this.closed) {
          try { this.#socket.write(encodeFrame(0x8, payload.subarray(0, 2))); } catch {}
          this.#socket.end();
          this.#closeTimer = setTimeout(() => this.#socket.destroy(), 1000);
          this.#closeTimer.unref?.();
        }
        this.#finish(code);
        return;
      }
      case 0x9: this.#socket.write(encodeFrame(0xa, payload)); return;
      case 0xa: this.emit("pong"); return;
      default: return this.close(1002, "unknown opcode");
    }
  }
}
