// Test-only native plugin (runtime/tests/native-capabilities-live.mjs): a 0.3 s WAV made on the
// Host, a caption channel that emits much faster than 10 Hz, and a record of capability events.
export const name = "dsh-go-fixture-voice";

const V = (globalThis.__dshGoFixtureVoice ??= { events: [], media: 0, keys: [] });

/** 16 kHz mono PCM16 sine, as a WAV file. */
function wav(ms = 300, hz = 440) {
  const n = Math.round(16000 * ms / 1000);
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + n * 2, 4); b.write("WAVE", 8); b.write("fmt ", 12);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(16000, 24);
  b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write("data", 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / 16000) * 8000), 44 + i * 2);
  return b;
}

export function apply(ctx) {
  ctx.inject(["dshGo"], (ctx) => {
    ctx.dshGo.on("read", (scope) => [
      { type: "audio", op: "play", instance: "reading", src: "media:speech", key: `m_${scope.messageId ?? "x"}` },
      { type: "voice", op: "start", instance: "reading" },
      { type: "overlay", op: "show", instance: "reading", id: "line" },
    ]);
    ctx.dshGo.on("events", () => ({ copy: JSON.stringify(V) }));
    ctx.dshGo.panel("captions", { view: { type: "text", text: "字幕" } });
    ctx.dshGo.media("speech", (scope, { key }) => {
      V.media++;
      V.keys.push(key ?? null);
      return { body: wav(), contentType: "audio/wav" };
    });
    ctx.dshGo.micro("caption", {
      data(scope, emit) {
        let i = 0;
        emit({ text: "第 0 句", progress: 0 });
        const t = setInterval(() => { i++; emit({ text: `第 ${i} 句`, progress: Math.min(1, i / 100) }); }, 20);
        return () => clearInterval(t);
      },
    });
    ctx.dshGo.onCapability((scope, event) => { V.events.push(`${event.event}@${scope.sessionId ?? ""}`); });
  });
}
