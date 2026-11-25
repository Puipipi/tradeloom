import { createPrivateKey, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Agent, createServer, request } from 'node:https';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DART_TEST, dartResultObserver, diagnosticLines, localConfig, localEnvironment,
  loopbackOrigin, parseJsonc, previewDescriptor, previewResponse, removeTemporaryStorage, sha256 } from '../scripts/workshop-e2e-support.mjs';
import { localTlsCredentials } from '../scripts/workshop-e2e-tls.mjs';
import { png } from './workshop-fixtures';

const worker = fileURLToPath(new URL('..', import.meta.url));
const config = () => parseJsonc(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));

describe('local rehearsal configuration and result boundaries', () => {
  it('retains URL strings while removing JSONC comments and trailing commas', () => {
    expect(parseJsonc('{ "url": "https://127.0.0.1:1234/", // local\n"items": [1,],}'))
      .toEqual({ url: 'https://127.0.0.1:1234/', items: [1] });
  });

  it('accepts only an explicit numeric loopback HTTPS origin', () => {
    expect(loopbackOrigin('https://127.0.0.1:1234/')).toBe('https://127.0.0.1:1234');
    for (const value of ['http://127.0.0.1:1234', 'https://example.org:1234', 'https://127.0.0.1:1234/path']) {
      expect(() => loopbackOrigin(value)).toThrow('expected_numeric_loopback_https_origin');
    }
  });

  it('uses isolated local bindings and does not change the production configuration', () => {
    const original = config(), before = JSON.stringify(original);
    const local = localConfig(worker, original, 'https://127.0.0.1:1234', { uploads: false, companion: true, port: 1235 });
    expect(JSON.stringify(original)).toBe(before);
    expect(local).not.toHaveProperty('account_id');
    expect(local).not.toHaveProperty('routes');
    expect(local).not.toHaveProperty('triggers');
    expect(local).not.toHaveProperty('analytics_engine_datasets');
    expect(local).not.toHaveProperty('build');
    expect(local.vars).toMatchObject({ WORKSHOP_GITHUB_API_URL: 'https://127.0.0.1:1234', WORKSHOP_GITHUB_CLIENT_ID: 'Iv1.local_rehearsal', WORKSHOP_UPLOAD_ENABLED: '0', WORKSHOP_COMPANION_ENABLED: '1', DL_BASE_URL: '', CN_BASE_URL: '' });
    expect(local.dev).toMatchObject({ ip: '127.0.0.1', port: 1235, local_protocol: 'https', inspector_port: 0 });
    expect(local.r2_buckets.every(bucket => bucket.remote === false && bucket.bucket_name.startsWith('local-'))).toBe(true);
    expect(local.kv_namespaces.every(namespace => namespace.remote === false && namespace.id === '0'.repeat(32))).toBe(true);
    expect(local.ratelimits.every(limit => limit.simple.limit === 1000)).toBe(true);
    expect(original.ratelimits.find(limit => limit.name === 'UPLOAD_BURST').simple.limit).toBe(5);
    expect(local.assets.run_worker_first).toContain('/workshop/admin');
  });

  it('does not inherit real credentials, proxies, Node hooks, or Wrangler telemetry settings', () => {
    const parent = { PATH: '/tools', ADMIN_KEY: 'parent-admin', USER_API_KEY: 'parent-user',
      CLOUDFLARE_API_TOKEN: 'parent-cloud', CF_ACCOUNT_ID: 'parent-account', WRANGLER_WRITE_LOGS: 'true',
      GITHUB_TOKEN: 'parent-github', HTTPS_PROXY: 'http://proxy.invalid', NODE_OPTIONS: '--require arbitrary',
      NODE_TLS_REJECT_UNAUTHORIZED: '0', DSH_WORKSHOP_E2E_ORIGIN: 'https://example.org' };
    const child = localEnvironment(parent, { NODE_EXTRA_CA_CERTS: '/local/test-ca.pem' });
    for (const key of ['ADMIN_KEY', 'USER_API_KEY', 'CLOUDFLARE_API_TOKEN', 'CF_ACCOUNT_ID', 'GITHUB_TOKEN', 'HTTPS_PROXY', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED', 'DSH_WORKSHOP_E2E_ORIGIN']) {
      expect(child).not.toHaveProperty(key);
    }
    expect(child).toMatchObject({ PATH: '/tools', NODE_EXTRA_CA_CERTS: '/local/test-ca.pem',
      WRANGLER_HIDE_BANNER: 'true', WRANGLER_SEND_METRICS: 'false', WRANGLER_WRITE_LOGS: 'false',
      CLOUDFLARE_CF_FETCH_ENABLED: 'false', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false',
      CLOUDFLARE_INCLUDE_PROCESS_ENV: 'false' });
    expect(parent.ADMIN_KEY).toBe('parent-admin');
  });

  it('redacts a synthetic key split across output chunks before exposing the line', () => {
    const seen: string[] = [], output = diagnosticLines(['synthetic-private-value'], line => seen.push(line));
    output.write('message synthetic-pri');
    expect(seen).toEqual([]);
    output.write('vate-value done\nsecond synthetic-private-value'); output.end();
    expect(seen).toEqual(['message [REDACTED] done', 'second [REDACTED]']);
    expect(output.summary()).not.toContain('synthetic-private-value');
  });

  it('omits an oversized diagnostic whole and keeps later complete lines', () => {
    const output = diagnosticLines(['synthetic-secret']);
    output.write('x'.repeat(16380) + 'synthetic-'); output.write('secret\nready\n'); output.end();
    expect(output.summary()).toBe('[oversized diagnostic line omitted]\nready');
  });

  it('requires the named Dart test and the complete run to pass', () => {
    const observer = dartResultObserver();
    observer.line(JSON.stringify({ type: 'testStart', test: { id: 7, name: DART_TEST } }));
    observer.line(JSON.stringify({ type: 'testDone', testID: 7, result: 'success', skipped: false }));
    expect(observer.passed()).toBe(false);
    expect(observer.evidence()).toBeNull();
    observer.line(JSON.stringify({ type: 'done', success: true }));
    expect(observer.passed()).toBe(true);
    expect(observer.evidence()).toEqual({ name: DART_TEST, result: 'success', skipped: false });
  });

  it('does not count a skipped Dart test as an HTTP pass', () => {
    const observer = dartResultObserver();
    observer.line(JSON.stringify({ type: 'testStart', test: { id: 7, name: DART_TEST } }));
    observer.line(JSON.stringify({ type: 'testDone', testID: 7, result: 'success', skipped: true }));
    observer.line(JSON.stringify({ type: 'done', success: true }));
    expect(observer.passed()).toBe(false);
    expect(observer.evidence()).toBeNull();
  });

  it('does not accept another test or a failed run as the required Dart result', () => {
    for (const [name, success] of [['some other test', true], [DART_TEST, false]] as const) {
      const observer = dartResultObserver();
      observer.line(JSON.stringify({ type: 'testStart', test: { id: 7, name } }));
      observer.line(JSON.stringify({ type: 'testDone', testID: 7, result: 'success', skipped: false }));
      observer.line(JSON.stringify({ type: 'done', success }));
      expect(observer.passed()).toBe(false);
    }
  });

  it('generates a fresh matching key and short-lived certificate limited to loopback', () => {
    const now = new Date(), tls = localTlsCredentials(now), certificate = new X509Certificate(tls.cert);
    const key = createPrivateKey(tls.key), another = new X509Certificate(localTlsCredentials(now).cert);
    expect(certificate.checkPrivateKey(key)).toBe(true);
    expect(certificate.verify(certificate.publicKey)).toBe(true);
    expect(certificate.ca).toBe(true);
    expect(certificate.subjectAltName).toBe('IP Address:127.0.0.1');
    expect(certificate.checkIP('127.0.0.1')).toBe('127.0.0.1');
    expect(certificate.checkIP('127.0.0.2')).toBeUndefined();
    expect(certificate.checkHost('example.org')).toBeUndefined();
    expect(Math.abs(Date.parse(certificate.validFrom) - now.getTime() + 300000)).toBeLessThan(1000);
    expect(Math.abs(Date.parse(certificate.validTo) - now.getTime() - 86400000)).toBeLessThan(1000);
    expect(another.fingerprint256).not.toBe(certificate.fingerprint256);
    expect(another.checkPrivateKey(key)).toBe(false);
  });

  it('encodes the X509 time boundary without a fixed certificate expiry', () => {
    const certificate = new X509Certificate(localTlsCredentials(new Date('2049-12-31T12:00:00Z')).cert);
    expect(new Date(certificate.validFrom).toISOString()).toBe('2049-12-31T11:55:00.000Z');
    expect(new Date(certificate.validTo).toISOString()).toBe('2050-01-01T12:00:00.000Z');
    expect(certificate.verify(certificate.publicKey)).toBe(true);
  });

  it('serves real loopback HTTPS with only the generated certificate trusted', async () => {
    const tls = localTlsCredentials(), trusted = new Agent({ ca: tls.cert, keepAlive: false });
    const untrusted = new Agent({ keepAlive: false });
    const server = createServer(tls, (_, response) => { response.end('local-only'); });
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
      const port = (server.address() as AddressInfo).port;
      const read = (agent: Agent) => new Promise<number | undefined>((resolve, reject) => {
        const outgoing = request({ hostname: '127.0.0.1', port, path: '/', agent }, incoming => {
          incoming.resume(); incoming.once('error', reject); incoming.once('end', () => resolve(incoming.statusCode));
        });
        outgoing.once('error', reject); outgoing.setTimeout(3000, () => outgoing.destroy(new Error('local TLS timeout'))); outgoing.end();
      });
      expect(await read(trusted)).toBe(200);
      await expect(read(untrusted)).rejects.toThrow();
    } finally {
      trusted.destroy(); untrusted.destroy(); server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });

  it('retries transient removal errors for only the supplied run directory', async () => {
    let attempts = 0;
    const waits: number[] = [];
    const result = await removeTemporaryStorage('owned-temporary-directory', {
      remove: async (directory: string, options: object) => {
        expect(directory).toBe('owned-temporary-directory');
        expect(options).toEqual({ recursive: true, force: true });
        if (++attempts < 3) throw Object.assign(new Error('transient lock'), { code: attempts === 1 ? 'EPERM' : 'EBUSY' });
      },
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
    });
    expect(result).toBe(3); expect(attempts).toBe(3); expect(waits).toEqual([200, 400]);
  });

  it('bounds persistent lock retries and preserves the failure', async () => {
    let attempts = 0;
    const waits: number[] = [], locked = Object.assign(new Error('persistent lock'), { code: 'ENOTEMPTY' });
    await expect(removeTemporaryStorage('owned-temporary-directory', {
      remove: async () => { attempts++; throw locked; },
      wait: async (milliseconds: number) => { waits.push(milliseconds); },
    })).rejects.toBe(locked);
    expect(attempts).toBe(6); expect(waits).toEqual([200, 400, 600, 800, 1000]);
  });

  it('does not retry an unrelated filesystem failure', async () => {
    let attempts = 0, waits = 0;
    const failure = Object.assign(new Error('I/O failure'), { code: 'EIO' });
    await expect(removeTemporaryStorage('owned-temporary-directory', {
      remove: async () => { attempts++; throw failure; },
      wait: async () => { waits++; },
    })).rejects.toBe(failure);
    expect(attempts).toBe(1); expect(waits).toBe(0);
  });
});

describe('public PNG rehearsal assertions', () => {
  const meta = { kind: 'pet', id: 'workshop-local-pet', version: '2.0.0', sha256: 'a'.repeat(64) };
  const bytes = png(), imageSha = sha256(bytes);
  const preview = { path: `/market/workshop/pet/${meta.id}/${meta.version}/${meta.sha256}/preview/${imageSha}.png`,
    sha256: imageSha, size: bytes.length, width: 1, height: 1 };
  const response = () => ({ status: 200, bytes: Buffer.from(bytes), headers: {
    'content-type': 'image/png', 'content-length': String(bytes.length), 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  } });

  it('binds all descriptor fields and compares independent of JSON key ordering', () => {
    expect(previewDescriptor({ height: 1, size: bytes.length, sha256: imageSha, path: preview.path, width: 1 }, meta)).toEqual(preview);
    for (const value of [null, { ...preview, path: preview.path.replace('/2.0.0/', '/1.0.0/') },
      { ...preview, path: 'https://example.org' + preview.path }, { ...preview, width: 513 }, { ...preview, size: 2097153 }]) {
      expect(() => previewDescriptor(value, meta)).toThrow('preview_descriptor_mismatch');
    }
  });

  it('requires exact PNG headers, advertised length, actual bytes and SHA', () => {
    expect(() => previewResponse(response(), preview)).not.toThrow();
    for (const [key, value] of [['content-type', 'application/octet-stream'], ['content-length', String(bytes.length + 1)],
      ['cache-control', 'public'], ['x-content-type-options', '']]) {
      const wrong = response(); wrong.headers[key as keyof typeof wrong.headers] = value!;
      expect(() => previewResponse(wrong, preview)).toThrow('preview_response_headers_mismatch');
    }
    const different = response(); different.bytes[different.bytes.length - 1] ^= 1;
    expect(() => previewResponse(different, preview)).toThrow('preview_response_bytes_mismatch');
  });

  it('checks the PNG signature and IHDR dimensions after the byte identity check', () => {
    expect(() => previewResponse(response(), { ...preview, width: 2 })).toThrow('preview_response_png_mismatch');
    const wrong = response(); wrong.bytes[0] = 0;
    expect(() => previewResponse(wrong, { ...preview, sha256: sha256(wrong.bytes) })).toThrow('preview_response_png_mismatch');
  });

  it('requires HEAD metadata and an empty body without hashing a nonexistent body', () => {
    const head = response(); head.bytes = Buffer.alloc(0);
    expect(() => previewResponse(head, preview, { head: true })).not.toThrow();
    expect(() => previewResponse(response(), preview, { head: true })).toThrow('preview_head_has_body');
    head.headers['content-length'] = '0';
    expect(() => previewResponse(head, preview, { head: true })).toThrow('preview_response_headers_mismatch');
  });
});
