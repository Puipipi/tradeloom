// Host-only DeepSeek speech proxy. Credentials never enter a client payload,
// bridge state, persistence or logging. Requires only Node >= 20 built-ins.
import { once } from "node:events";

const ROOT = "/dsh-go/v1/speech";
const OFFICIAL_ORIGIN = "https://api.deepseek.com";
const STATUS_URL = `${OFFICIAL_ORIGIN}/v1/tools/tts`;
const TTS_LIMIT = 64 * 1024;
const ASR_LIMIT = 8 * 1024 * 1024;
const ERROR_LIMIT = 64 * 1024;
const RESULT_LIMIT = 1024 * 1024;
const PCM_TYPES = new Set(["application/octet-stream", "audio/pcm", "audio/x-pcm"]);
const AUDIO_HEADERS = {
  "content-type": "application/octet-stream",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

class SpeechError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
const rejected = (message) => new SpeechError(400, "speech/rejected", message);
const protocolError = () => new SpeechError(502, "speech/upstream-unreachable", "DeepSeek returned an invalid speech response");
const noCredential = () => new SpeechError(401, "speech/no-credential", "Sign in to DeepSeek or configure a host DeepSeek API key");
const interrupted = () => new Error("Speech request interrupted");

// Race host credential lookups as well as I/O against the request lifetime. A
// late resolver must not start a billable request after the App has disconnected.
function abortable(promise, signal) {
  const pending = Promise.resolve(promise);
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const abort = () => { cleanup(); reject(interrupted()); };
    // The caller may already have started I/O. Always consume its rejection,
    // even when the signal was cancelled before this helper was entered.
    pending.then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
  });
}

function credentialValue(value) {
  // These are HTTP header credentials, never arbitrary objects or multiline data.
  return typeof value === "string" && value.trim() && !/[\x00-\x20\x7f-\uffff]/.test(value)
    ? value : undefined;
}

async function credentialFor(ctx, account, url, apiKeyEnv, signal) {
  try {
    const token = credentialValue(await abortable(Promise.resolve().then(() => {
      if (!signal.aborted) return account?.resolveToken?.(url);
    }), signal));
    if (token) return { kind: "account", secret: token, headers: { "x-dsh-auth-token": token } };
  } catch {
    if (signal.aborted) throw interrupted();
  }
  if (!apiKeyEnv) return undefined;
  try {
    const hit = await abortable(Promise.resolve().then(() => {
      if (!signal.aborted) return ctx.get("credentials")?.resolve(apiKeyEnv);
    }), signal);
    const key = credentialValue(hit?.value);
    if (key) return { kind: "api-key", secret: key, headers: { authorization: `Bearer ${key}` } };
  } catch {
    if (signal.aborted) throw interrupted();
  }
  return undefined;
}

function endpointFor(account, operation) {
  const origin = new URL(account?.inferenceOrigin ?? OFFICIAL_ORIGIN);
  if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password ||
      origin.pathname !== "/" || origin.search || origin.hash) throw protocolError();
  return new URL(`/v1/tools/${operation}`, origin).href;
}

function readBody(req, limit, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const cleanup = () => {
      req.off("data", data);
      req.off("end", end);
      signal.removeEventListener("abort", abort);
    };
    const fail = (error) => { cleanup(); reject(error); };
    const abort = () => fail(interrupted());
    const tooLarge = () => {
      fail(new SpeechError(413, "speech/too-large", "Speech request body is too large"));
      req.resume();
    };
    const data = (chunk) => {
      size += chunk.length;
      if (size > limit) return tooLarge();
      chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks, size)); };
    if (signal.aborted || req.aborted || (req.destroyed && !req.complete)) return abort();
    if (Number(req.headers["content-length"]) > limit) return tooLarge();
    if (req.readableEnded) return end();
    req.on("data", data);
    req.on("end", end);
    signal.addEventListener("abort", abort, { once: true });
  });
}

function ttsPayload(bytes) {
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw rejected("Speech request body must be valid UTF-8 JSON"); }
  if (!value || Array.isArray(value) || typeof value !== "object" || typeof value.text !== "string" || !value.text.trim()) {
    throw rejected("Speech text must be a non-empty string");
  }
  const voice = value.voice === undefined ? "stella" : value.voice;
  if (voice !== "stella" && voice !== "tide") throw rejected("Speech voice must be stella or tide");
  return { text: value.text, voice_id: voice, format: "pcm", filter_markdown: true };
}

// Only JSON/error bodies are collected, and each has a fixed memory bound.
// An oversized error is discarded in full, not returned as a possibly partial
// credential cut off at the size boundary.
async function boundedBody(body, limit, signal) {
  if (!body) return undefined;
  const reader = body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (done) return Buffer.concat(chunks, size);
      size += value.byteLength;
      if (size > limit) return undefined;
      chunks.push(Buffer.from(value));
    }
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

function secretForms(secret) {
  return new Set([secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret),
    Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("base64url")]);
}

function safeReason(bytes, secret) {
  if (!bytes) return "";
  let message = bytes.toString("utf8");
  try {
    const value = JSON.parse(message);
    message = typeof value === "string" ? value : value?.error?.message ?? value?.message ?? value?.detail ?? value?.error ?? "";
  } catch {}
  if (typeof message !== "string") return "";
  // Redact before clipping. JSON decoding above also catches escaped credentials;
  // these encodings cover common plain-text upstream diagnostics.
  for (const value of secretForms(secret)) {
    message = message.split(value).join("[redacted]");
  }
  message = message.replace(/\bBearer\s+[^\s,;"'<>]+/gi, "Bearer [redacted]")
    .replace(/((?:x-dsh-auth-token|x-api-key|api[_-]?key|access[_-]?token|authorization)\s*[=:]\s*)[^\s,;"'<>]+/gi, "$1[redacted]")
    .replace(/[\x00-\x1f\x7f]+/g, " ").trim();
  return message.slice(0, 1000);
}

async function upstreamError(response, credential, signal) {
  const status = response.status;
  let code, mapped = status;
  if (status === 401) code = credential.kind === "account" ? "speech/sign-in-required" : "speech/unauthorized";
  else if (status === 402) code = "speech/insufficient-balance";
  else if (status === 413) code = "speech/too-large";
  else if (status === 429) code = "speech/rate-limited";
  else if (status >= 500 && status <= 599) code = "speech/busy";
  else if (status >= 400 && status <= 499) { mapped = 400; code = "speech/rejected"; }
  else { mapped = 502; code = "speech/upstream-unreachable"; }
  let reason = "";
  try { reason = safeReason(await boundedBody(response.body, ERROR_LIMIT, signal), credential.secret); }
  catch { if (signal.aborted) throw interrupted(); }
  return new SpeechError(mapped, code, `DeepSeek speech request failed (HTTP ${status})${reason ? `: ${reason}` : ""}`);
}

// Read exactly one chunk at a time; never read the next chunk until the outgoing
// response has drained. Headers are committed only once there is actual audio.
async function relayPcm(response, res, signal) {
  if (!response.body) throw protocolError();
  const reader = response.body.getReader();
  let started = false;
  // A source failure must also interrupt a response currently waiting for drain.
  reader.closed.catch(() => { if (started) res.destroy(); });
  try {
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal);
      if (signal.aborted) throw interrupted();
      if (done) break;
      if (!value.byteLength) continue;
      if (!started) { res.writeHead(200, AUDIO_HEADERS); started = true; }
      if (!res.write(value)) await once(res, "drain", { signal });
    }
    if (!started) throw protocolError();
    res.end();
  } finally {
    try { await reader.cancel(); } catch {}
    reader.releaseLock();
  }
}

// The injectable transport is a host test seam, never a request-body option.
// The caller must mount this behind the bridge's existing rejectionOf guard.
export function createSpeechRoutes(ctx, { send, fetch: fetchImpl = globalThis.fetch, apiKeyEnv = "DEEPSEEK_API_KEY" }) {
  const active = new Set();
  let disposed = false;
  // Fail closed on malformed host configuration; never guess another secret.
  const keyRef = typeof apiKeyEnv === "string" && apiKeyEnv.trim() ? apiKeyEnv.trim() : undefined;
  return {
    dispose() {
      disposed = true;
      for (const request of active) { request.controller.abort(); request.res.destroy(); }
      active.clear();
    },
    async handle(req, res, path) {
      if (path !== ROOT && path !== `${ROOT}/tts` && path !== `${ROOT}/asr`) return false;
      const controller = new AbortController();
      const { signal } = controller;
      const request = { controller, res };
      const abort = () => controller.abort();
      const requestClose = () => { if (!req.complete) abort(); };
      const responseClose = () => { if (!res.writableFinished) abort(); };
      const requestAborted = () => {
        // Node may emit ECONNRESET after 'aborted', including after our finally.
        req.once("error", () => {});
        abort();
      };
      req.on("aborted", requestAborted);
      req.on("close", requestClose);
      req.on("error", abort);
      res.on("close", responseClose);
      res.on("error", abort);
      active.add(request);
      if (req.aborted || (req.destroyed && !req.complete) || res.destroyed) abort();
      try {
        if (signal.aborted) return true;
        if (disposed) throw new SpeechError(503, "speech/busy", "Speech bridge is unavailable");
        const statusOnly = path === ROOT;
        if (req.method !== (statusOnly ? "GET" : "POST")) {
          throw new SpeechError(405, "method-not-allowed", "Method not allowed");
        }
        const account = ctx.get("deepseekAccount");
        if (statusOnly) {
          req.resume();
          // Contract #1 deliberately specifies this canonical URL, even when a
          // host's inferenceOrigin is different (see speech1-notes.md).
          const credential = await credentialFor(ctx, account, STATUS_URL, keyRef, signal);
          if (!signal.aborted) send(res, 200, { v: 1, credential: credential?.kind ?? null });
          return true;
        }
        const tts = path === `${ROOT}/tts`;
        const type = String(req.headers["content-type"]).split(";", 1)[0].trim().toLowerCase();
        if (tts ? type !== "application/json" : type !== "audio/wav" && type !== "audio/ogg") {
          throw new SpeechError(415, "unsupported-media-type", tts
            ? "Content-Type must be application/json" : "Content-Type must be audio/wav or audio/ogg");
        }
        const bytes = await readBody(req, tts ? TTS_LIMIT : ASR_LIMIT, signal);
        let body;
        if (tts) body = JSON.stringify(ttsPayload(bytes));
        else {
          body = new FormData();
          body.append("file", new Blob([bytes], { type }), type === "audio/wav" ? "speech.wav" : "speech.ogg");
        }
        const endpoint = endpointFor(account, tts ? "tts" : "asr");
        const credential = await credentialFor(ctx, account, endpoint, keyRef, signal);
        if (signal.aborted) return true;
        if (!credential) throw noCredential();
        const response = await fetchImpl(endpoint, {
          method: "POST", body, signal, redirect: "manual",
          headers: { ...credential.headers, ...(tts ? { "content-type": "application/json" } : {}) },
        });
        if (!response.ok) throw await upstreamError(response, credential, signal);
        if (tts) {
          const type = (response.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
          // Do not relay a JSON/text error (including an echoed credential) as
          // audio just because a gateway mistakenly returned a success status.
          if (type && !PCM_TYPES.has(type)) throw await upstreamError(response, credential, signal);
          await relayPcm(response, res, signal);
        }
        else {
          const result = await boundedBody(response.body, RESULT_LIMIT, signal);
          let value;
          try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result)); }
          catch { throw protocolError(); }
          if (typeof value?.text !== "string" || typeof value?.duration_ms !== "number" ||
              !Number.isFinite(value.duration_ms) || value.duration_ms < 0) throw protocolError();
          // A malformed upstream must not smuggle our request credential back
          // through an otherwise valid transcript. Preserve real text verbatim.
          if ([...secretForms(credential.secret)].some(secret => value.text.includes(secret))) throw protocolError();
          if (!signal.aborted) send(res, 200, { text: value.text, duration_ms: value.duration_ms });
        }
      } catch (error) {
        if (!res.destroyed && !signal.aborted) {
          if (res.headersSent) res.destroy(); // A partial PCM stream must fail, never end normally or append JSON.
          else {
            const failure = error instanceof SpeechError ? error : new SpeechError(502,
              "speech/upstream-unreachable", "Unable to reach the DeepSeek speech service");
            send(res, failure.status, { error: { code: failure.code, message: failure.message } });
          }
        }
      } finally {
        controller.abort();
        active.delete(request);
        req.off("aborted", requestAborted);
        req.off("close", requestClose);
        req.off("error", abort);
        res.off("close", responseClose);
        res.off("error", abort);
        req.resume();
      }
      return true;
    },
  };
}
