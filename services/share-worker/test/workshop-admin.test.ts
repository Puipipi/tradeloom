import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { WORKSHOP_ADMIN_HTML, WORKSHOP_ADMIN_SCRIPT } from '../src/workshop-admin-page';
import { assetUrl, blobKey } from '../src/workshop-common';
import { STATE_KEY } from '../src/workshop-state';
import { fakeAssets, makeCtx, makeEnv, serve, workerFirst } from './fakes';
import { PetBucket, sha } from './pet-market-fakes';
import { BASE_META, companion, metaFor, pet, petManifest, png, zip } from './workshop-fixtures';
import { jpeg, losslessWebp } from './workshop-image-fixtures';

const API = '/api/workshop/v1', ADMIN = API + '/admin';
beforeEach(() => vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ id: 42, login: 'Synthetic reviewer fixture' }))));
afterEach(() => vi.restoreAllMocks());
function setup() {
  const bucket = new PetBucket(), bindings = makeEnv({ BUCKET: bucket as unknown as R2Bucket }); let serial = 0;
  const call = (path: string, method = 'GET', body?: object | Uint8Array, authenticated = true, extra = {}) => worker.fetch(new Request('https://example.org' + path, {
    method, headers: { Authorization: 'Bearer synthetic_github_token', 'X-Workshop-Account-Origin': 'https://github.com',
      ...(authenticated ? { 'X-Admin-Key': bindings.env.ADMIN_KEY! } : {}),
      ...(body ? { 'Content-Type': body instanceof Uint8Array ? 'application/zip' : 'application/json' } : {}), ...extra },
    ...(body ? { body: body instanceof Uint8Array ? body : JSON.stringify(body) } : {}),
  }), bindings.env, makeCtx().ctx);
  const create = async (bytes = pet(), overrides = {}, upload = true) => {
    const meta = metaFor(bytes, overrides), made = await call(API + '/submissions', 'POST', { ...meta, requestId: `admin_fixture_request_${++serial}` });
    expect(made.status).toBe(201); const { submission } = await made.json() as any;
    if (upload) expect((await call(`${API}/submissions/${submission.submissionId}/archive`, 'PUT', bytes)).status).toBe(200);
    return { sid: submission.submissionId, meta, bytes };
  };
  const review = (sid: string, decision = 'approve', reason = 'Synthetic moderation reason') => call(`${ADMIN}/submissions/${sid}/review`, 'POST', { decision, reason });
  const publish = async () => { const item = await create(); expect((await review(item.sid)).status).toBe(200); return item; };
  const report = async () => {
    const response = await call(API + '/reports', 'POST', { kind: 'pet', id: 'sample', version: '1.0.0', reason: 'Synthetic complaint' });
    expect(response.status).toBe(201); return (await response.json() as any).reportId as string;
  };
  const state = () => JSON.parse(new TextDecoder().decode(bucket.objects.get(STATE_KEY)!.bytes));
  return { ...bindings, bucket, call, create, review, publish, report, state };
}
function imageCompanion() {
  return zip([
    ['character/character.json', Buffer.from(JSON.stringify({ schema: 1, name: 'Image fixture', model: 'sample.model3.json', author: BASE_META.author, license: BASE_META.license, source: BASE_META.source }))],
    ['character/sample.model3.json', Buffer.from(JSON.stringify({ Version: 3, FileReferences: { Moc: 'sample.moc3', Textures: ['photo.jpg', 'lossless.webp'] } }))],
    ['character/sample.moc3', Buffer.from([77, 79, 67, 51, 6, 0])],
    ['character/photo.jpg', jpeg()], ['character/lossless.webp', losslessWebp()],
    ['character/not-an-image.jpg', Buffer.from('An ordinary text file with a misleading suffix')],
  ]);
}

it('serves the public single document with a hash for its exact inline script and no state access', async () => {
  const f = setup(), response = await f.call('/workshop/admin', 'GET', undefined, false);
  expect(response.status).toBe(200); expect(await response.text()).toBe(WORKSHOP_ADMIN_HTML);
  const hash = Buffer.from(sha(WORKSHOP_ADMIN_SCRIPT), 'hex').toString('base64');
  expect(response.headers.get('Content-Security-Policy')).toContain(`script-src 'sha256-${hash}'`);
  expect(response.headers.get('Content-Security-Policy')).not.toContain("script-src 'unsafe-inline'");
  expect(response.headers.get('Referrer-Policy')).toBe('no-referrer'); expect(response.headers.get('Cache-Control')).toBe('no-store');
  expect(WORKSHOP_ADMIN_HTML).toContain(`<script>${WORKSHOP_ADMIN_SCRIPT}</script>`);
  const head = await f.call('/workshop/admin', 'HEAD', undefined, false); expect(head.status).toBe(200); expect(await head.text()).toBe('');
  expect((await f.call('/workshop/admin', 'POST', undefined, false)).status).toBe(405);
  expect(f.bucket.gets).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
it('routes the admin page through the Worker before a same-path static asset', async () => {
  const f = setup(), asset = vi.spyOn(fakeAssets, 'fetch').mockResolvedValue(new Response('Synthetic conflicting static asset'));
  expect(workerFirst('/workshop/admin')).toBe(true);
  const response = await serve(new Request('https://example.org/workshop/admin'), f.env);
  expect(response.status).toBe(200); expect(await response.text()).toBe(WORKSHOP_ADMIN_HTML); expect(asset).not.toHaveBeenCalled();
  expect(response.headers.get('Content-Security-Policy')).toContain('script-src');
});
it('authenticates every moderation data path before state, archive, or account access', async () => {
  const f = setup(), id = '1'.repeat(32);
  for (const [path, method] of [
    ['/submissions', 'GET'], [`/submissions/${id}`, 'GET'], [`/submissions/${id}/preview?file=0`, 'GET'],
    [`/submissions/${id}/archive`, 'GET'], [`/submissions/${id}/review`, 'POST'], [`/submissions/${id}/withdraw`, 'POST'],
    ['/reports', 'GET'], [`/reports/${id}`, 'GET'], [`/reports/${id}/resolve`, 'POST'], ['/audit', 'GET'], ['/releases/withdraw', 'POST'],
  ]) {
    const response = await f.call(ADMIN + path, method, undefined, false);
    expect(response.status).toBe(401); expect(await response.json()).toEqual({ error: 'workshop_admin_auth_required' });
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  }
  expect(f.bucket.gets).toEqual([]); expect(f.bucket.writes).toEqual([]); expect(fetch).not.toHaveBeenCalled();
});
it('filters pending kind before stable-ID pagination without exposing other statuses', async () => {
  const f = setup(); await f.create();
  const first = await f.create(companion(), { kind: 'companion' });
  await f.create(pet(), {}, false);
  const second = await f.create(companion(), { kind: 'companion' });
  const approved = await f.create(); expect((await f.review(approved.sid)).status).toBe(200);
  const expected = [first.sid, second.sid].sort(), one = await (await f.call(ADMIN + '/submissions?status=pending&kind=companion&limit=1')).json() as any;
  expect(one.submissions.map((item: any) => item.submissionId)).toEqual(expected.slice(0, 1)); expect(one.nextCursor).toBe(expected[0]);
  const two = await (await f.call(ADMIN + '/submissions?status=pending&kind=companion&limit=1&cursor=' + one.nextCursor)).json() as any;
  expect(two.submissions.map((item: any) => item.submissionId)).toEqual(expected.slice(1)); expect(two.nextCursor).toBeNull();
  expect(two.submissions[0]).toMatchObject({ owner: { username: 'Synthetic reviewer fixture' }, status: 'pending', validation: { files: 4 } });
  for (const query of ['kind=wallpaper', 'status=other', 'limit=0', 'cursor=invalid']) expect((await f.call(ADMIN + '/submissions?' + query)).status).toBe(400);
});
it('returns complete metadata and exact file paths as JSON, with bounded file pagination and no writes', async () => {
  const f = setup(), pack = petManifest(), name = '<sheet "雪">.png'; pack.animations.idle.sheet = name;
  const bytes = zip([['pack.json', Buffer.from(JSON.stringify(pack))], [name, png()]]);
  const item = await f.create(bytes, { title: { zh: '<名字 "示例">', en: 'A "quoted" title' }, description: '<简介> "plain text"' });
  const before = f.state(), response = await f.call(`${ADMIN}/submissions/${item.sid}?filesLimit=1`), detail = await response.json() as any;
  expect(detail.submission.metadata.title.zh).toBe('<名字 "示例">'); expect(detail.submission.metadata.description).toBe('<简介> "plain text"');
  expect(detail.current).toBe(false); expect(detail.inspection.status).toBe('valid');
  expect(detail.inspection.summary).toMatchObject({ files: 2, sheets: 1 });
  expect(detail.inspection.files[0]).toMatchObject({ index: 0, path: name, size: png().length, preview: { mediaType: 'image/png', width: 1, height: 1 }, previewIssue: null });
  expect(detail.inspection.files[0].compressedSize).toBeGreaterThan(0); expect(detail.inspection.nextFileCursor).toBe('1');
  const next = await (await f.call(`${ADMIN}/submissions/${item.sid}?filesLimit=1&filesCursor=1`)).json() as any;
  expect(next.inspection.files.map((file: any) => file.path)).toEqual(['pack.json']); expect(next.inspection.nextFileCursor).toBeNull();
  expect(next.inspection.files[0].preview).toBeNull(); expect(f.state()).toEqual(before);
  expect(response.headers.get('Content-Type')).toBe('application/json; charset=utf-8'); expect(response.headers.get('Cache-Control')).toBe('private, no-store');
});
it('shows a draft without reading nonexistent archive bytes', async () => {
  const f = setup(), item = await f.create(pet(), {}, false); f.bucket.gets = [];
  const value = await (await f.call(`${ADMIN}/submissions/${item.sid}`)).json() as any;
  expect(value.inspection).toMatchObject({ status: 'not_uploaded', files: [], nextFileCursor: null });
  expect(f.bucket.gets.map(item => item.key)).toEqual([STATE_KEY]);
});
it('serves only the selected authenticated PNG with fixed private image headers', async () => {
  const f = setup(), item = await f.create(), path = `${ADMIN}/submissions/${item.sid}/preview?file=0`;
  const response = await f.call(path); expect(response.status).toBe(200); expect(Buffer.from(await response.arrayBuffer())).toEqual(png());
  expect(response.headers.get('Content-Type')).toBe('image/png'); expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store'); expect(response.headers.get('Content-Length')).toBe(String(png().length));
  const head = await f.call(path, 'HEAD'); expect(head.status).toBe(200); expect(await head.text()).toBe('');
  expect((await f.call(path, 'GET', undefined, false)).status).toBe(401);
  expect(await (await f.call(`${ADMIN}/submissions/${item.sid}/preview?file=1`)).json()).toEqual({ error: 'workshop_preview_unsupported' });
  expect((await f.call(`${ADMIN}/submissions/${item.sid}/preview?file=999`)).status).toBe(404);
  expect((await f.call(assetUrl(item.meta))).status).toBe(404);
});
it('offers JPEG/WebP structural previews and keeps a failed image local to its file row', async () => {
  const f = setup(), item = await f.create(imageCompanion(), { kind: 'companion' });
  const detail = await (await f.call(`${ADMIN}/submissions/${item.sid}`)).json() as any;
  expect(detail.inspection.status).toBe('valid');
  const bad = detail.inspection.files.find((file: any) => file.path.endsWith('not-an-image.jpg'));
  expect(bad.preview).toBeNull(); expect(bad.previewIssue.code).toBe('workshop_preview_format');
  for (const [name, expected, type] of [['photo.jpg', jpeg(), 'image/jpeg'], ['lossless.webp', losslessWebp(), 'image/webp']] as const) {
    const file = detail.inspection.files.find((file: any) => file.path.endsWith(name));
    expect(file.preview).toMatchObject({ mediaType: type, width: 2, height: 1, validation: 'structure-only' });
    const response = await f.call(`${ADMIN}/submissions/${item.sid}/preview?file=${file.index}`);
    expect(response.status).toBe(200); expect(response.headers.get('Content-Type')).toBe(type); expect(Buffer.from(await response.arrayBuffer())).toEqual(expected);
  }
  expect(await (await f.call(`${ADMIN}/submissions/${item.sid}/preview?file=${bad.index}`)).json()).toEqual({ error: 'workshop_preview_format' });
});
it('treats reports without resolution as open and reads their current release target', async () => {
  const f = setup(), item = await f.publish(), rid = await f.report(); expect(f.state().reports[0]).not.toHaveProperty('resolution');
  const list = await (await f.call(ADMIN + '/reports?status=open&kind=pet')).json() as any;
  expect(list.reports).toHaveLength(1); expect(list.reports[0]).toMatchObject({ reportId: rid, status: 'open' });
  const detail = await (await f.call(`${ADMIN}/reports/${rid}`)).json() as any;
  expect(detail.target).toMatchObject({ release: { kind: 'pet', id: item.meta.id, version: item.meta.version }, current: true, withdrawal: null });
  expect((await (await f.call(ADMIN + '/reports?status=open&kind=companion')).json() as any).reports).toEqual([]);
});
it('requires resolution reasons, keeps the first terminal result, and does not implicitly withdraw', async () => {
  const f = setup(), item = await f.publish(), rid = await f.report(), path = `${ADMIN}/reports/${rid}/resolve`;
  for (const reason of ['', '   ', '\u0085']) expect((await f.call(path, 'POST', { decision: 'handled', reason })).status).toBe(400);
  expect((await f.call(path, 'POST', { decision: 'other', reason: 'Reason' })).status).toBe(400);
  const response = await f.call(path, 'POST', { decision: 'handled', reason: 'Checked the source and retained this version' });
  expect(response.status).toBe(200); const resolved = await response.json() as any;
  expect(resolved.report).toMatchObject({ status: 'resolved', resolution: { decision: 'handled', actor: 'admin' } }); expect(resolved.target.current).toBe(true);
  const events = f.state().audit.filter((event: any) => event.action === 'resolve_report');
  expect(events).toHaveLength(1); expect(events[0]).toMatchObject({ actor: 'admin', reportId: rid, releaseId: 'pet/sample/1.0.0', reason: resolved.report.resolution.reason });
  expect(events[0].at).toBe(resolved.report.resolution.at);
  expect((await f.call(path, 'POST', { decision: 'handled', reason: 'A different retry reason' })).status).toBe(200);
  expect(f.state().reports[0].resolution).toEqual(resolved.report.resolution); expect(f.state().audit.filter((event: any) => event.action === 'resolve_report')).toHaveLength(1);
  expect(await (await f.call(path, 'POST', { decision: 'dismissed', reason: 'Another outcome' })).json()).toEqual({ error: 'workshop_report_state' });
  expect((await (await f.call(ADMIN + '/reports?status=open')).json() as any).reports).toEqual([]);
  expect((await (await f.call(ADMIN + '/reports?status=resolved')).json() as any).reports).toHaveLength(1);
  expect((await f.call(assetUrl(item.meta))).status).toBe(200);
  expect((await f.call(ADMIN + '/releases/withdraw', 'POST', { kind: 'pet', id: 'sample', version: '1.0.0', reason: '' })).status).toBe(400);
  expect((await f.call(ADMIN + '/releases/withdraw', 'POST', { kind: 'pet', id: 'sample', version: '1.0.0', reason: 'Separate release decision' })).status).toBe(200);
  const after = await (await f.call(`${ADMIN}/reports/${rid}`)).json() as any;
  expect(after.target.current).toBe(false); expect(after.target.withdrawal.reason).toBe('Separate release decision'); expect(after.report.resolution).toEqual(resolved.report.resolution);
});
it('leaves the winning report decision and single audit intact after a normal CAS conflict', async () => {
  const f = setup(); await f.publish(); const rid = await f.report(), path = `${ADMIN}/reports/${rid}/resolve`, put = f.bucket.put.bind(f.bucket); let raced = false;
  vi.spyOn(f.bucket, 'put').mockImplementation(async (key, value, options) => {
    if (key === STATE_KEY && !raced) {
      raced = true; expect((await f.call(path, 'POST', { decision: 'dismissed', reason: 'Concurrent administrator decision' })).status).toBe(200);
    }
    return put(key, value, options);
  });
  const result = await f.call(path, 'POST', { decision: 'handled', reason: 'Original administrator decision' });
  expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: 'workshop_state_conflict' });
  const after = await (await f.call(`${ADMIN}/reports/${rid}`)).json() as any;
  expect(after.report.resolution.decision).toBe('dismissed'); expect(f.state().audit.filter((event: any) => event.action === 'resolve_report')).toHaveLength(1);
});
it('permits readback after an uncertain successful state write without duplicating resolution', async () => {
  const f = setup(); await f.publish(); const rid = await f.report(), path = `${ADMIN}/reports/${rid}/resolve`, put = f.bucket.put.bind(f.bucket);
  vi.spyOn(f.bucket, 'put').mockImplementationOnce(async (key, value, options) => { await put(key, value, options); throw new Error('Synthetic response loss'); });
  const result = await f.call(path, 'POST', { decision: 'handled', reason: 'Recorded before response loss' });
  expect(result.status).toBe(503); expect(await result.json()).toEqual({ error: 'workshop_storage_unavailable' });
  const read = await (await f.call(`${ADMIN}/reports/${rid}`)).json() as any; expect(read.report.resolution.reason).toBe('Recorded before response loss');
  expect((await f.call(path, 'POST', { decision: 'handled', reason: 'Explicit same-result retry' })).status).toBe(200);
  expect(f.state().audit.filter((event: any) => event.action === 'resolve_report')).toHaveLength(1);
});
it('keeps administrator rejection, withdrawal and report handling available while uploads are off', async () => {
  const f = setup(), published = await f.publish(), rid = await f.report(), pending = await f.create();
  expect((await f.review(pending.sid, 'approve', '')).status).toBe(400);
  expect((await f.review(pending.sid, 'reject', ' ')).status).toBe(400);
  expect((await f.call(`${ADMIN}/submissions/${published.sid}/withdraw`, 'POST', { reason: '' })).status).toBe(400);
  f.env.WORKSHOP_UPLOAD_ENABLED = '0'; f.env.WORKSHOP_COMPANION_ENABLED = '0';
  expect((await f.review(pending.sid)).status).toBe(503);
  expect((await f.review(pending.sid, 'reject')).status).toBe(200);
  expect((await f.call(`${ADMIN}/reports/${rid}/resolve`, 'POST', { decision: 'handled', reason: 'Handled during pause' })).status).toBe(200);
  expect((await f.call(`${ADMIN}/submissions/${published.sid}/withdraw`, 'POST', { reason: 'Withdraw during pause' })).status).toBe(200);
});
it('paginates read-only audit records with explicit shared-admin and GitHub-owner identities', async () => {
  const f = setup(); await f.publish(); const rid = await f.report(); await f.call(`${ADMIN}/reports/${rid}/resolve`, 'POST', { decision: 'dismissed', reason: 'Read-only audit fixture' });
  const expected = f.state().audit.map((event: any) => event.eventId).sort(), actual: string[] = []; let cursor: string | null = null;
  do {
    const response = await f.call(ADMIN + '/audit?limit=2' + (cursor ? '&cursor=' + cursor : '')), page = await response.json() as any;
    expect(response.headers.get('Cache-Control')).toBe('private, no-store'); actual.push(...page.events.map((event: any) => event.eventId)); cursor = page.nextCursor;
  } while (cursor);
  expect(actual).toEqual(expected); expect(new Set(actual).size).toBe(expected.length);
  expect(f.state().audit.some((event: any) => event.actor === 'admin')).toBe(true);
  expect(f.state().audit.some((event: any) => event.actor?.accountId === 42)).toBe(true);
  expect(JSON.stringify(f.state())).not.toContain(f.env.ADMIN_KEY!);
});
it('bounds repeated inspection before reading the archive and rejects missing storage privately', async () => {
  const f = setup(), item = await f.create(); f.readLimit.allow = 0; f.bucket.gets = [];
  const limited = await f.call(`${ADMIN}/submissions/${item.sid}`); expect(limited.status).toBe(429); expect(f.bucket.gets).toEqual([]);
  f.readLimit.allow = Infinity; f.bucket.objects.delete(blobKey(item.meta.sha256));
  const missing = await f.call(`${ADMIN}/submissions/${item.sid}`); expect(missing.status).toBe(503); expect(await missing.json()).toEqual({ error: 'workshop_storage_unavailable' });
  expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
});
