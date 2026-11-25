// No retry, polling loop, downloader, persistent state, credentials lookup, or Session effects.
import { createHttpTransport, parseMediaUrl } from './http.js';
import { fail } from './errors.js';
import { PROVIDERS, buildProviderCreate, buildProviderQuery, normalizeProviderImage, normalizeProviderCreated, normalizeProviderTask } from './provider-protocol.js';

function endpoint(name, value, allowLoopback) {
  const url = parseMediaUrl(value, { allowLoopback });
  if (url.pathname !== '/' || url.search) fail('invalid_request');
  if (allowLoopback && url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)) return url.origin;
  if (url.port || (name.startsWith('ark-') ? url.hostname !== 'ark.cn-beijing.volces.com'
    : !/^(?:dashscope\.aliyuncs\.com|[a-zA-Z0-9-]+\.cn-beijing\.maas\.aliyuncs\.com)$/.test(url.hostname))) fail('invalid_request');
  return url.origin;
}
function safeCode(status) { return status === 401 || status === 403 ? 'authentication' : status === 429 ? 'rate_limit' : 'provider'; }

export function createProviderClient({ allowLoopback = false, transport = createHttpTransport({ allowLoopback }) } = {}) {
  async function run(name, descriptor, target, normalize, signal) {
    // Target is internal caller-owned credentials, not a plugin configuration/wire schema.
    if (!target || typeof target.apiKey !== 'string' || !target.apiKey || target.apiKey.length > 8192 || /[\r\n]/.test(target.apiKey)) fail('invalid_request');
    const origin = endpoint(name, target.baseUrl, allowLoopback);
    const limit = target.maxResponseBytes ?? 32 * 1024 * 1024;
    const timeout = target.timeoutMs ?? 30_000;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1024 * 1024
      || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 300_000) fail('invalid_request');
    if (signal?.aborted) return { outcome: 'not_submitted', code: 'cancelled' };
    const post = descriptor.method === 'POST';
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, timeout);
    try {
      const response = await transport(origin + descriptor.path, {
        method: descriptor.method,
        headers: { ...descriptor.headers, Authorization: `Bearer ${target.apiKey}`, 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
        body: descriptor.body ? Buffer.from(JSON.stringify(descriptor.body)) : undefined,
        signal: controller.signal, maxBytes: limit,
      });
      // A custom transport may resolve after abort; never publish that late result.
      if (controller.signal.aborted) return { outcome: post ? 'submission_unknown' : 'query_failed', code: 'cancelled' };
      if (response.status < 200 || response.status >= 300) {
        // Even explicit rejections give no no-charge or safe-refund promise.
        return { outcome: post ? (response.status >= 500 || response.status === 408 || response.status < 400 ? 'submission_unknown' : 'rejected') : 'query_failed', code: safeCode(response.status), httpStatus: response.status };
      }
      const bytes = response.body;
      if (!Buffer.isBuffer(bytes) || bytes.length > limit) throw new Error('invalid body');
      const result = normalize(JSON.parse(bytes.toString('utf8')));
      return { outcome: 'ok', result };
    } catch {
      // May already have been accepted/billed. Never re-POST; caller retains reservation.
      return { outcome: post ? 'submission_unknown' : 'query_failed', code: controller.signal.aborted ? 'cancelled' : 'response' };
    } finally {
      clearTimeout(timer); signal?.removeEventListener('abort', cancel);
    }
  }
  return Object.freeze({
    create(name, options, target, { signal } = {}) {
      const descriptor = buildProviderCreate(name, options);
      return run(name, descriptor, target, value => PROVIDERS[name].kind === 'image' ? normalizeProviderImage(name, value) : normalizeProviderCreated(name, value), signal);
    },
    query(name, id, target, { signal } = {}) {
      return run(name, buildProviderQuery(name, id), target, value => normalizeProviderTask(name, id, value), signal);
    },
  });
}
