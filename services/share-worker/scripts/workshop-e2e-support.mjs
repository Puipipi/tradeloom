// Helpers for the local rehearsal only. No production request path imports this.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { registerHooks, stripTypeScriptTypes } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const PET_ID = 'workshop-local-pet';
export const KEEP_ID = 'workshop-local-keep';
export const COMPANION_ID = 'workshop-local-companion';
export const DART_TEST = 'local Worker catalog installs and uninstalls through the real Dart stack';
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export const ACCOUNT_ORIGIN = 'https://github.com';
// Synthetic OAuth App id: shows the configured var reaching capabilities; no GitHub app exists.
export const REHEARSAL_CLIENT_ID = 'Iv1.local_rehearsal';
export const REHEARSAL_PREVIEW = { schema: 1, sources: ['pet-idle', 'companion-preview'], format: 'png',
  maxWidth: 512, maxHeight: 512, maxPixels: 262144, maxBytes: 2097152 };

export function check(value, code) {
  if (!value) throw Object.assign(new Error(code), { rehearsalCode: code });
}

export function previewDescriptor(value, meta) {
  check(value && typeof value === 'object' && !Array.isArray(value) && typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/.test(value.sha256) &&
    Number.isSafeInteger(value.size) && value.size > 0 && value.size <= REHEARSAL_PREVIEW.maxBytes &&
    Number.isSafeInteger(value.width) && value.width > 0 && value.width <= REHEARSAL_PREVIEW.maxWidth &&
    Number.isSafeInteger(value.height) && value.height > 0 && value.height <= REHEARSAL_PREVIEW.maxHeight &&
    value.width * value.height <= REHEARSAL_PREVIEW.maxPixels &&
    value.path === `/market/workshop/${meta.kind}/${meta.id}/${meta.version}/${meta.sha256}/preview/${value.sha256}.png`,
  'preview_descriptor_mismatch');
  // Canonical field order makes later equality independent of JSON key order.
  return { path: value.path, sha256: value.sha256, size: value.size, width: value.width, height: value.height };
}

export function previewResponse(response, preview, { head = false } = {}) {
  check(response.status === 200 && response.headers['content-type'] === 'image/png' &&
    response.headers['content-length'] === String(preview.size) && response.headers['cache-control'] === 'private, no-store' &&
    response.headers['x-content-type-options'] === 'nosniff', 'preview_response_headers_mismatch');
  if (head) { check(response.bytes.length === 0, 'preview_head_has_body'); return; }
  check(response.bytes.length === preview.size && sha256(response.bytes) === preview.sha256, 'preview_response_bytes_mismatch');
  check(response.bytes.length >= 33 && response.bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
    response.bytes.readUInt32BE(8) === 13 && response.bytes.subarray(12, 16).toString('ascii') === 'IHDR' &&
    response.bytes.readUInt32BE(16) === preview.width && response.bytes.readUInt32BE(20) === preview.height,
  'preview_response_png_mismatch');
}

export function loopbackOrigin(value) {
  const url = new URL(value);
  check(url.protocol === 'https:' && url.hostname === '127.0.0.1' && url.port &&
    !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash,
  'expected_numeric_loopback_https_origin');
  return url.origin;
}

export function parseJsonc(source) {
  return JSON.parse(source.replace(/"(?:\\.|[^"\\])*"|\/\/[^\n]*/g, text => text.startsWith('"') ? text : '')
    .replace(/,(\s*[}\]])/g, '$1'));
}

export function localConfig(worker, original, githubApi, { uploads = true, companion = true, port }) {
  loopbackOrigin(githubApi);
  // Copy only bindings used by the real entry point. No account, route,
  // cron, remote resource, analytics destination, or production URL is copied.
  return {
    name: 'workshop-local-rehearsal', main: resolve(worker, 'src/index.ts'),
    compatibility_date: original.compatibility_date, compatibility_flags: original.compatibility_flags,
    workers_dev: false, preview_urls: false, send_metrics: false,
    assets: { ...original.assets, directory: resolve(worker, original.assets.directory) },
    r2_buckets: original.r2_buckets.map(({ binding }) => ({ binding, bucket_name: `local-${binding.toLowerCase()}`, remote: false })),
    kv_namespaces: original.kv_namespaces.map(({ binding }) => ({ binding, id: '0'.repeat(32), remote: false })),
    durable_objects: original.durable_objects, migrations: original.migrations,
    // The production burst is 5/minute. This protocol rehearsal is not a
    // rate-limit test; the unchanged per-owner create quota still applies.
    ratelimits: original.ratelimits.map(limit => ({ ...limit, simple: { ...limit.simple, limit: 1000 } })),
    vars: { PET_MARKET_ENABLED: '0', WORKSHOP_GITHUB_API_URL: githubApi, WORKSHOP_GITHUB_CLIENT_ID: REHEARSAL_CLIENT_ID,
      WORKSHOP_UPLOAD_ENABLED: uploads ? '1' : '0', WORKSHOP_COMPANION_ENABLED: companion ? '1' : '0',
      MAX_BYTES: '20971520', UPLOADS_PER_HOUR: '20', DOWNLOAD_ACCESS: 'public', DL_BASE_URL: '', CN_BASE_URL: '' },
    dev: { ip: '127.0.0.1', port, inspector_port: 0, local_protocol: 'https', enable_containers: false },
    observability: { enabled: false },
  };
}

export function localEnvironment(parent, extra = {}) {
  const result = { ...parent };
  for (const key of Object.keys(result)) {
    if (/^(?:CLOUDFLARE_|CF_|WRANGLER_|DSH_WORKSHOP_E2E_)/i.test(key) ||
      /^(?:ADMIN_KEY|USER_API_KEY|GITHUB_TOKEN|GH_TOKEN|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|NO_PROXY|NODE_OPTIONS|NODE_TLS_REJECT_UNAUTHORIZED)$/i.test(key)) delete result[key];
  }
  return { ...result, CI: 'true', NO_COLOR: '1', DO_NOT_TRACK: '1',
    WRANGLER_SEND_METRICS: 'false', WRANGLER_HIDE_BANNER: 'true', WRANGLER_WRITE_LOGS: 'false',
    CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
    CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false', FLUTTER_SUPPRESS_ANALYTICS: 'true', ...extra };
}

// Assemble complete lines before redaction: a key split across data events
// must never be printed as two harmless-looking fragments. Discard oversized
// lines whole instead of truncating through an unknown part of a secret.
export function diagnosticLines(secrets, onLine = () => {}) {
  let pending = '', discarding = false;
  const tail = [];
  const redact = text => secrets.reduce((value, secret) => secret ? value.split(secret).join('[REDACTED]') : value, text);
  const accept = line => {
    const safe = redact(line).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
    onLine(safe); tail.push(safe); if (tail.length > 16) tail.shift();
  };
  return {
    write(chunk) {
      for (const character of chunk) {
        if (character === '\n') {
          accept(discarding ? '[oversized diagnostic line omitted]' : pending);
          pending = ''; discarding = false;
        } else if (!discarding) {
          pending += character;
          if (pending.length > 16384) { pending = ''; discarding = true; }
        }
      }
    },
    end() {
      if (discarding) accept('[oversized diagnostic line omitted]');
      else if (pending) accept(pending);
      pending = ''; discarding = false;
    },
    summary: () => tail.join('\n'),
  };
}

export function dartResultObserver() {
  let id, completed = false, done = false;
  return {
    line(line) {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'testStart' && event.test?.name === DART_TEST) id = event.test.id;
      if (event.type === 'testDone' && id !== undefined && event.testID === id) {
        completed = event.result === 'success' && event.skipped === false;
      }
      if (event.type === 'done') done = event.success === true;
    },
    passed: () => completed && done,
    evidence: () => completed && done ? { name: DART_TEST, result: 'success', skipped: false } : null,
  };
}

// Called only after stopping this run's child processes. Windows can retain a
// just-closed SQLite file briefly; six attempts add at most 3s of backoff.
export async function removeTemporaryStorage(directory, { remove = rm, wait = delay } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      await remove(directory, { recursive: true, force: true });
      return attempt + 1;
    } catch (error) {
      if (attempt === 5 || !['EBUSY', 'EMFILE', 'ENFILE', 'ENOTEMPTY', 'EPERM'].includes(error.code)) throw error;
      await wait((attempt + 1) * 200);
    }
  }
}

/// The Worker sources use parameter properties, which plain type stripping
/// rejects, so the transform mode is needed. A Node without it is named as
/// such instead of failing on the first fixture.
function stripTransform(code) {
  try {
    return stripTypeScriptTypes(code, { mode: 'transform' });
  } catch (error) {
    if (error?.code === 'ERR_INVALID_ARG_VALUE') check(false, 'node_type_transform_unavailable');
    throw error;
  }
}

export async function rehearsalFixtures(worker) {
  // Only resolve/strip the repository's local TS fixture graph. This does not
  // replace fetch, Worker auth, R2, or an API response.
  const root = resolve(worker) + sep;
  const inRoot = url => url.startsWith('file:') && fileURLToPath(url).startsWith(root);
  const hooks = registerHooks({
    resolve(specifier, context, next) {
      if (context.parentURL && inRoot(context.parentURL) && specifier.startsWith('.') && !extname(specifier)) {
        return next(new URL(specifier + '.ts', context.parentURL).href, context);
      }
      return next(specifier, context);
    },
    load(url, context, next) {
      if (inRoot(url) && url.endsWith('.ts')) {
        return { format: 'module', source: stripTransform(readFileSync(fileURLToPath(url), 'utf8')), shortCircuit: true };
      }
      return next(url, context);
    },
  });
  try {
    const fixture = await import(pathToFileURL(resolve(worker, 'test/workshop-fixtures.ts')).href);
    const pet = (id, version, ms) => {
      const manifest = { ...fixture.petManifest(), id };
      manifest.animations.idle.frames[0].ms = ms;
      const bytes = fixture.pet(manifest);
      return { bytes, meta: fixture.metaFor(bytes, { id, version, minApp: '1.0.0', title: { zh: '本地演练小宠物', en: 'Local rehearsal pet' } }) };
    };
    const bytes = fixture.companion();
    const v1 = pet(PET_ID, '1.0.0', 100), v2 = pet(PET_ID, '2.0.0', 125);
    v1.meta.previewSource = 'pet-idle'; v2.meta.previewSource = 'pet-idle';
    return {
      v1, v2,
      keep: pet(KEEP_ID, '1.0.0', 100), keepNext: pet(KEEP_ID, '2.0.0', 125),
      companion: { bytes, meta: fixture.metaFor(bytes, { kind: 'companion', id: COMPANION_ID, version: '1.0.0', minApp: '1.0.0' }) },
    };
  } finally { hooks.deregister(); }
}
