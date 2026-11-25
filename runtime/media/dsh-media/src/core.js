import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { imageSize } from 'image-size';
import { MediaError, checkAbort, safeFailure, fail } from './errors.js';
import { requestBytes, parseMediaUrl } from './http.js';
import { prepareImageStore } from './storage.js';
import { base64DecodedLength } from './base64.js';

export const LIMITS = Object.freeze({
  maxImages: 4, maxImageBytes: 20 * 1024 * 1024,
  maxResponseBytes: 32 * 1024 * 1024, maxTotalImageBytes: 64 * 1024 * 1024,
});
const MIME = Object.freeze({
  png: ['image/png', 'png'], jpg: ['image/jpeg', 'jpg'],
  jpeg: ['image/jpeg', 'jpg'], webp: ['image/webp', 'webp'], gif: ['image/gif', 'gif'],
});
const POLICY_CODES = new Set([
  'moderation_blocked', 'content_policy_violation',
  'DataInspectionFailed', 'IPInfringementSuspect',
]);
const encodedBytes = value => Buffer.byteLength(value, 'utf8');

function shortString(value, max) {
  return typeof value === 'string' && value.trim().length > 0
    && encodedBytes(value) <= max && !/[\u0000-\u001f]/.test(value);
}

function normalize(request, settings = {}) {
  if (!request || typeof request.prompt !== 'string' || !request.prompt.trim()
    || encodedBytes(request.prompt) > 4096) fail('invalid_request');
  const limits = {};
  for (const [name, ceiling] of Object.entries(LIMITS)) {
    const value = settings[name] ?? ceiling;
    if (!Number.isSafeInteger(value) || value < 1 || value > ceiling) fail('invalid_request');
    limits[name] = value;
  }
  const n = request.n ?? 1;
  if (!Number.isSafeInteger(n) || n < 1 || n > limits.maxImages) fail('invalid_request');
  const service = request.service;
  const model = request.model;
  if (!service || !model || !/^[a-z][a-z0-9_]{0,31}$/.test(service.id ?? '')
    || !shortString(service.provider, 80) || !shortString(model.id, 160)
    || !shortString(model.label, 160)
    || !['openai-compatible', 'openai-gpt-image'].includes(service.profile)) {
    fail('invalid_request');
  }
  if (service.responseFormat !== undefined
    && !['url', 'b64_json'].includes(service.responseFormat)) fail('invalid_request');
  if (service.profile === 'openai-gpt-image' && service.responseFormat !== undefined) {
    fail('invalid_request');
  }
  let size = request.size;
  const aspect = request.aspect;
  if (aspect !== undefined) {
    if (!shortString(aspect, 12) || !/^[1-9]\d?:[1-9]\d?$/.test(aspect)) fail('invalid_request');
    const mapped = model.aspectSizes?.[aspect];
    if (typeof mapped !== 'string' || (size !== undefined && size !== mapped)) fail('invalid_request');
    size = mapped;
  }
  if (size !== undefined && (!shortString(size, 40)
    || !Array.isArray(model.sizes) || !model.sizes.includes(size))) fail('invalid_request');
  const quality = request.quality;
  if (quality !== undefined && (!shortString(quality, 40)
    || !Array.isArray(model.qualities) || !model.qualities.includes(quality))) fail('invalid_request');
  return { prompt: request.prompt, n, aspect, size, quality, service, model, limits };
}

function jsonBody(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch { fail('response'); }
}

function policyRejected(value) {
  return value?.is_image_safe === false
    || POLICY_CODES.has(value?.error?.code)
    || POLICY_CODES.has(value?.error?.type);
}

function checkResponse(status, value) {
  if (policyRejected(value)) fail('policy');
  if (status === 401 || status === 403) fail('authentication');
  if (status === 429) fail('rate_limit');
  if (status < 200 || status >= 300 || value?.error) fail('provider');
}

export function inspectImage(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 12) fail('response');
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const gif = ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'));
  const webp = bytes.subarray(0, 4).toString('ascii') === 'RIFF'
    && bytes.subarray(8, 12).toString('ascii') === 'WEBP';
  if (!png && !jpeg && !gif && !webp) fail('response');
  let measured;
  try { measured = imageSize(bytes); } catch { fail('response'); }
  const type = MIME[measured.type];
  if (!type || !Number.isSafeInteger(measured.width) || !Number.isSafeInteger(measured.height)
    || measured.width < 1 || measured.height < 1
    || measured.width > 16384 || measured.height > 16384
    || measured.width * measured.height > 64 * 1024 * 1024) fail('response');
  // This inspects container headers, not a full pixel decode or C2PA validation.
  return { mime: type[0], extension: type[1], width: measured.width, height: measured.height };
}

function decodeBase64(value, limit) {
  const expected = base64DecodedLength(value, limit);
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expected) fail('response');
  return bytes;
}

export function containsSecret(value, secret) {
  if (typeof value === 'string') return value.includes(secret);
  if (Array.isArray(value)) return value.some(item => containsSecret(item, secret));
  if (value && typeof value === 'object') {
    return Object.entries(value).some(([key, item]) => key.includes(secret) || containsSecret(item, secret));
  }
  return false;
}

function fitsMeta(meta) {
  return encodedBytes(JSON.stringify({ 'dsh-go/media': meta })) <= 8192;
}

function revisedText(data, secret) {
  const candidates = [...new Set(data.map(item => item?.revised_prompt)
    .filter(value => typeof value === 'string' && value.trim()))];
  if (candidates.length !== 1 || encodedBytes(candidates[0]) > 2048) return undefined;
  const text = candidates[0].split(secret).join('[密钥已隐藏]')
    .replace(/https?:\/\/[^\s<>"']+/gi, '[链接已隐藏]');
  return encodedBytes(text) <= 2048 ? text : undefined;
}

async function storage(promise) {
  try { return await promise; }
  catch (error) { throw error instanceof MediaError ? error : new MediaError('storage'); }
}

async function download(url, transport, signal, maxBytes) {
  let current = url;
  for (let hop = 0; hop <= 3; hop += 1) {
    // Authentication is NEVER forwarded to a temporary result URL.
    const response = await transport(current, {
      method: 'GET', headers: { accept: 'image/*', 'accept-encoding': 'identity' },
      signal, maxBytes,
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      if (hop === 3 || typeof response.headers.location !== 'string') fail('response');
      try { current = new URL(response.headers.location, current).href; }
      catch { fail('unsafe_url'); }
      continue; // Transport validates and pins every hop independently.
    }
    if (response.status < 200 || response.status >= 300) fail('provider');
    return response.body;
  }
  fail('response');
}

/**
 * The plugin passes selected non-secret configuration and Host-only callbacks.
 * context.transport is an internal test seam, never a tool/config parameter.
 * All provider traffic in this repository's tests uses a local mock server.
 */
export async function generateImage(request, context) {
  const selected = normalize(request, context?.limits);
  if (!context || typeof context.resolveCredential !== 'function'
    || typeof context.authorizeWorkspace !== 'function'
    || !shortString(context.sessionId, 256)) fail('invalid_request');
  const timerController = new AbortController();
  const signal = timerController.signal;
  const forwardAbort = () => timerController.abort(new MediaError('cancelled'));
  if (context.signal?.aborted) forwardAbort();
  else context.signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => timerController.abort(new MediaError('timeout')), 180000);
  timer.unref?.();
  const started = performance.now();
  const createdAt = new Date().toISOString();
  const date = createdAt.slice(0, 10);
  const rid = 'm_' + randomUUID();
  let store;
  let secret;
  try {
    checkAbort(signal);
    const { prompt, n, aspect, size, quality, service, model, limits } = selected;
    // Preserve the user-configured API prefix; never insert a guessed /v1.
    let base;
    try { base = new URL(service.baseUrl); } catch { fail('unsafe_url'); }
    if (base.search || base.hash || base.username || base.password) fail('unsafe_url');
    const endpoint = base.href.replace(/\/+$/, '') + '/images/generations';
    const transport = context.transport ?? requestBytes;
    // Production has no plain HTTP or private-network escape hatch.
    if (!context.transport) parseMediaUrl(endpoint);

    store = await storage(prepareImageStore({
      authorizeWorkspace: context.authorizeWorkspace,
      hostStateDir: context.hostStateDir, signal, rid, date,
    }));
    const requestMeta = {
      provider: service.provider, model: model.id, label: model.label, n, refs: 0,
      ...(aspect === undefined ? {} : { aspect }),
      ...(quality === undefined ? {} : { quality }),
    };
    const meta = { v: 1, rid, kind: 'image', status: 'done', items: [], request: requestMeta, prompt };
    const maximumItems = Array.from({ length: n }, (_, i) => ({
      path: join(store.cwd, 'generated', date, rid + '-' + (i + 1) + '.webp'),
      mime: 'image/jpeg', width: 16384, height: 16384, bytes: limits.maxImageBytes,
    }));
    if (!fitsMeta({ ...meta, items: maximumItems })) fail('metadata');
    try { secret = await context.resolveCredential(); } catch { fail('credential'); }
    if (typeof secret !== 'string' || !secret || secret.length > 16384 || /[\r\n]/.test(secret)) {
      fail('credential');
    }
    if (containsSecret({ meta: { ...meta, items: maximumItems },
      sessionId: context.sessionId, createdAt, cwd: store.cwd }, secret)) fail('credential');
    await storage(store.recheck());
    checkAbort(signal);
    const payload = { model: model.id, prompt, n };
    if (size !== undefined) payload.size = size;
    if (quality !== undefined) payload.quality = quality;
    if (service.profile === 'openai-compatible' && service.responseFormat !== undefined) {
      payload.response_format = service.responseFormat;
    }
    const requestBody = Buffer.from(JSON.stringify(payload), 'utf8');
    let response = await transport(endpoint, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + secret,
        'content-type': 'application/json',
        'content-length': String(requestBody.length),
        accept: 'application/json',
        'accept-encoding': 'identity',
      },
      body: requestBody, signal, maxBytes: limits.maxResponseBytes,
    });
    let value;
    try { value = jsonBody(response.body); }
    catch (error) {
      checkResponse(response.status, undefined);
      throw error;
    }
    checkResponse(response.status, value);
    response = undefined;
    if (!Array.isArray(value?.data) || value.data.length !== n) fail('response');
    if (value.data.some(policyRejected)) fail('policy');
    const revised = revisedText(value.data, secret);
    let total = 0;
    for (const item of value.data) {
      checkAbort(signal);
      if (!item || item.error || typeof item !== 'object') fail('provider');
      const hasBase64 = typeof item.b64_json === 'string';
      const hasUrl = typeof item.url === 'string';
      if (hasBase64 === hasUrl) fail('response');
      const bytes = hasBase64 ? decodeBase64(item.b64_json, limits.maxImageBytes)
        : await download(item.url, transport, signal, limits.maxImageBytes);
      total += bytes.length;
      if (bytes.length > limits.maxImageBytes || total > limits.maxTotalImageBytes) fail('too_large');
      const info = inspectImage(bytes);
      const path = await storage(store.stage(bytes, info.extension));
      meta.items.push({ path, mime: info.mime, width: info.width, height: info.height, bytes: bytes.length });
      // Discard provider data; it is never included in the index or tool result.
      delete item.b64_json;
      delete item.url;
      delete item.revised_prompt;
    }
    if (revised !== undefined && fitsMeta({ ...meta, revisedPrompt: revised })) {
      meta.revisedPrompt = revised;
    }
    if (!fitsMeta(meta)) fail('metadata');
    if (containsSecret({ meta, sessionId: context.sessionId, createdAt, cwd: store.cwd }, secret)) {
      fail('credential');
    }
    // Unknown price and unverified provenance are omitted, never false/zero.
    checkAbort(signal);
    await storage(store.commit(meta, { sessionId: context.sessionId, createdAt }));
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    const text = 'AI 生成图片已保存。用时 ' + seconds + ' 秒。\n'
      + meta.items.map(item => item.path + '（' + item.width + ' × ' + item.height + '）').join('\n')
      + (meta.revisedPrompt ? '\n服务改写后的描述：' + meta.revisedPrompt : '');
    return { meta, text };
  } catch (error) {
    const cleaned = store ? await store.abort().catch(() => false) : true;
    if (!cleaned) throw new MediaError('cleanup_failed');
    throw safeFailure(error, signal);
  } finally {
    secret = undefined;
    clearTimeout(timer);
    context.signal?.removeEventListener('abort', forwardAbort);
  }
}
