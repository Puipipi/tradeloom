import { Script, runInNewContext } from 'node:vm';
import { createHash, webcrypto } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WORKSHOP_ADMIN_HTML, WORKSHOP_ADMIN_SCRIPT } from '../src/workshop-admin-page';

// Exercise the exact inline script served to the browser, not a test-side
// implementation of its request or state rules. No browser, network or package
// renderer is used by these tests.
const delivered = /<script>([\s\S]*?)<\/script>/.exec(WORKSHOP_ADMIN_HTML)![1]!;
function section(name: string) {
  const start = `/* WORKSHOP_ADMIN_${name}_START */`, end = `/* WORKSHOP_ADMIN_${name}_END */`;
  expect(delivered.split(start)).toHaveLength(2); expect(delivered.split(end)).toHaveLength(2);
  return delivered.slice(delivered.indexOf(start) + start.length, delivered.indexOf(end));
}
function logic(): any { return runInNewContext(section('LOGIC') + '\nadminLogic;', { Uint8Array }); }
function thrown(action: () => unknown): any {
  try { action(); } catch (error) { return error; }
  throw new Error('Expected a rejected input');
}
const SID = 'a'.repeat(32), OTHER = 'b'.repeat(32), RID = 'c'.repeat(32), KEY = 'synthetic-admin-key-'.repeat(2);
const special = '<名字 "引号"> & \'单引号\'';
function submission(id = SID, status = 'pending'): any {
  return { submissionId: id, status, owner: { accountOrigin: 'https://github.com', accountId: 42, username: special },
    metadata: { kind: 'pet', id: 'ordinary-pet', version: '1.0.0', minApp: '1.0.0', title: { zh: special, en: 'Example' },
      author: special, license: 'CC0-1.0', source: 'https://example.org/source', description: special, tags: [special],
      size: 1234, sha256: 'd'.repeat(64), rightsConfirmed: true },
    createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:01:00.000Z', submittedAt: '2026-11-12T00:01:00.000Z',
    validation: { validator: 'synthetic-validator', files: 2, expandedBytes: 2345 } };
}
function file(index = 0, mediaType = 'image/png'): any {
  return { index, path: '图片/' + special + '.png', size: 90, compressedSize: 80, previewIssue: null,
    preview: { url: 'https://unused.example/not-an-api', mediaType, width: 1, height: 1,
      validation: mediaType === 'image/png' ? 'full-png' : 'structure-only' } };
}
function detail(id = SID, status = 'pending'): any {
  return { submission: submission(id, status), current: status === 'approved', inspection: { status: 'valid', validator: 'synthetic-validator',
    summary: { validator: 'synthetic-validator', files: 2, expandedBytes: 2345 }, checks: [{ level: 'pass', code: 'package_validation_passed', message: special }],
    files: [file()], nextFileCursor: null } };
}
// A complete synthetic 1x1 RGBA PNG. The controlled DOM below still does not
// decode pixels: each test explicitly supplies the browser load/error event.
const publicPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNwaDjwHwAFBAKAPJ4DgAAAAABJRU5ErkJggg==', 'base64'));
const publicHash = createHash('sha256').update(publicPng).digest('hex');
function publicDetail(id = SID, status = 'pending'): any {
  const value = detail(id, status), m = value.submission.metadata;
  m.previewSource = 'pet-idle';
  value.submission.preview = { path: `/market/workshop/${m.kind}/${m.id}/${m.version}/${m.sha256}/preview/${publicHash}.png`,
    sha256: publicHash, size: publicPng.length, width: 1, height: 1 };
  return value;
}
// Synthetic 4x2 PNGs with eXIf orientation and density metadata. Tests below
// supply browser callbacks; no claim is made that this fake DOM decodes EXIF.
const orientationPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAGmVYSWZJSSoACAAAAAEAEgEDAAEAAAAGAAAAAAAAALdIESkAAAASSURBVHicY3BoOPAfGTOgCwAASbUT+UK3jwUAAAAASUVORK5CYII=', 'base64'));
const densityPng = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAACCAYAAAB/qH1jAAAAbGVYSWZJSSoACAAAAAQAGgEFAAEAAAA+AAAAGwEFAAEAAABGAAAAKAEDAAEAAAACAAAAaYcEAAEAAABOAAAAAAAAAJAAAAABAAAAkAAAAAEAAAACAAKgBAABAAAAAgAAAAOgBAABAAAAAQAAAAAAAABVIRXPAAAAEklEQVR4nGNwaDjwHxkzoAsAAEm1E/lCt48FAAAAAElFTkSuQmCC', 'base64'));
function publicDetailForPng(bytes: Uint8Array, width: number, height: number): any {
  const value = publicDetail(), m = value.submission.metadata, hash = createHash('sha256').update(bytes).digest('hex');
  m.kind = 'companion'; m.previewSource = 'companion-preview';
  value.submission.preview = { path: `/market/workshop/${m.kind}/${m.id}/${m.version}/${m.sha256}/preview/${hash}.png`,
    sha256: hash, size: bytes.length, width, height };
  return value;
}
function report(id = RID, status = 'open'): any {
  return { reportId: id, status, kind: 'pet', id: 'ordinary-pet', version: '1.0.0', reason: special,
    reporter: submission().owner, createdAt: '2026-11-12T00:02:00.000Z',
    ...(status === 'resolved' ? { resolution: { at: '2026-11-12T00:03:00.000Z', decision: 'handled', reason: special, actor: 'admin' } } : {}) };
}
function reportDetail(id = RID, status = 'open'): any {
  return { report: report(id, status), target: { release: { kind: 'pet', id: 'ordinary-pet', version: '1.0.0',
    sha256: 'd'.repeat(64), size: 1234, owner: submission().owner, approvedAt: '2026-11-12T00:01:00.000Z' }, current: true, withdrawal: null } };
}

describe('delivered admin document and pure contracts', () => {
  it('ships one parseable inline script and no third-party resource or storage sink', () => {
    expect(delivered).toBe(WORKSHOP_ADMIN_SCRIPT); expect(() => new Script(delivered)).not.toThrow();
    expect(WORKSHOP_ADMIN_HTML.match(/<script\b/g)).toHaveLength(1);
    expect(WORKSHOP_ADMIN_HTML).not.toMatch(/<(?:script|link|iframe|object|embed)\b[^>]*(?:src|href|data)\s*=/i);
    expect(WORKSHOP_ADMIN_HTML).not.toMatch(/\son(?:click|load|error)\s*=/i);
    expect(delivered).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function|localStorage|sessionStorage|console\./);
    expect(delivered).not.toContain('visibilitychange'); expect(delivered).toContain("addEventListener('pagehide'");
  });
  it('puts the key only in a fixed same-origin header and constructs every read endpoint', () => {
    const L = logic();
    const commands = [
      ['submissions', { status: 'pending', kind: 'companion', cursor: SID }, `/submissions?status=pending&kind=companion&limit=20&cursor=${SID}`],
      ['reports', { status: 'open' }, '/reports?status=open&limit=20'],
      ['submission', { id: SID, filesCursor: '50' }, `/submissions/${SID}?filesLimit=50&filesCursor=50`],
      ['report', { id: RID }, `/reports/${RID}`], ['audit', {}, '/audit?limit=20'],
      ['preview', { id: SID, file: 0, url: 'https://unused.example/' }, `/submissions/${SID}/preview?file=0`],
    ] as const;
    for (const [operation, params, suffix] of commands) {
      const request = L.request(operation, params, KEY);
      expect(request.path).toBe('/api/workshop/v1/admin' + suffix);
      expect(request.options).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error', headers: { 'X-Admin-Key': KEY } });
      expect(request.path).not.toContain(KEY); expect(request.options.body).toBeUndefined();
    }
  });
  it('builds action bodies from the captured object and preserves quoted reasons as data', () => {
    const L = logic();
    for (const [operation, params, suffix, expected] of [
      ['review', { id: SID, decision: 'reject', reason: special }, `/submissions/${SID}/review`, { decision: 'reject', reason: special }],
      ['withdraw', { id: SID, reason: special }, `/submissions/${SID}/withdraw`, { reason: special }],
      ['resolve', { id: RID, decision: 'handled', reason: special }, `/reports/${RID}/resolve`, { decision: 'handled', reason: special }],
      ['releaseWithdraw', { kind: 'pet', releaseId: 'ordinary-pet', version: '1.0.0', reason: special }, '/releases/withdraw', { kind: 'pet', id: 'ordinary-pet', version: '1.0.0', reason: special }],
    ] as const) {
      const request = L.request(operation, params, KEY);
      expect(request.path).toBe('/api/workshop/v1/admin' + suffix); expect(request.options.method).toBe('POST');
      expect(JSON.parse(request.options.body)).toEqual(expected); expect(request.options.body).not.toContain(KEY);
    }
  });
  it('rejects invalid target, filter, key and blank reason before constructing a request', () => {
    const L = logic();
    expect(thrown(() => L.request('preview', { id: SID, file: -1 }, KEY)).code).toBe('console_invalid_target');
    expect(thrown(() => L.request('submission', { id: 'https://example.org' }, KEY)).code).toBe('console_invalid_target');
    expect(thrown(() => L.request('submissions', { kind: 'unknown' }, KEY)).code).toBe('console_invalid_filter');
    expect(thrown(() => L.request('audit', {}, 'short')).code).toBe('console_invalid_key');
    for (const reason of ['', ' \u0085\u00a0 ', 'line\nbreak']) expect(L.reasonValid(reason)).toBe(false);
    expect(L.reasonValid(special)).toBe(true); expect(L.reasonValid('猫'.repeat(2000))).toBe(true);
    expect(L.reasonValid('猫'.repeat(2001))).toBe(false);
  });
  it('preserves name, description, filename and username text through the actual DOM helpers', () => {
    const L = logic(), doc = new FakeDocument();
    const helpers = runInNewContext(section('TEXT_DOM') + '\n({node,pair});', { document: doc, L });
    for (const value of [submission().metadata.title.zh, submission().metadata.description, file().path, submission().owner.username, special]) {
      const parent = helpers.node('div'); helpers.pair(parent, '字段', value);
      expect(parent.textContent).toBe('字段：' + value);
      expect(parent.children[0].children[1].tagName).toBe('#text');
      expect(parent.querySelectorAll('img')).toHaveLength(0);
      const pre = helpers.node('pre', L.jsonText({ field: value })); expect(pre.textContent).toBe(JSON.stringify({ field: value }, null, 2));
    }
    expect(L.actor('admin')).toBe('管理密钥持有人（admin）'); expect(L.actor(submission().owner)).toContain(special);
  });
  it('keeps a failed refresh or next-page read on the last successful page', () => {
    const L = logic(), first = {}, next = {}, rows = [submission()];
    let page = L.beginPage(L.emptyPage({ status: 'pending' }), first, { status: 'pending' }, null, []);
    page = L.finishPage(page, first, { rows, next: OTHER }, null);
    const loading = L.beginPage(page, next, { status: 'pending' }, OTHER, [null]);
    expect(loading.rows).toBe(rows);
    const failed = L.finishPage(loading, next, null, { code: 'console_network' });
    expect(failed.rows).toBe(rows); expect(failed.cursor).toBeNull(); expect(failed.back).toEqual([]); expect(failed.next).toBe(OTHER);
    const changed = L.beginPage(failed, {}, { status: 'approved' }, null, []); expect(changed.rows).toEqual([]);
    expect(L.finishPage(loading, {}, { rows: [], next: null }, null)).toBe(loading);
  });
  it('drops late list, detail and preview tickets after replacement or logout', () => {
    const L = logic();
    for (const lane of ['list:submissions', 'submission', 'preview']) {
      const first = L.nextTicket(L.book(2), lane, SID), second = L.nextTicket(first.book, lane, OTHER);
      expect(L.current(second.book, first.ticket, SID)).toBe(false);
      expect(L.current(second.book, second.ticket, OTHER)).toBe(true);
      expect(L.current(second.book, second.ticket, SID)).toBe(false);
      expect(L.current(L.book(3), second.ticket, OTHER)).toBe(false);
    }
  });
  it('binds confirmation to the displayed target, exact read, reason and session', () => {
    const L = logic(), read = L.nextTicket(L.book(1), 'submission', SID), params = { id: SID, decision: 'approve', reason: special };
    const command = L.confirmation('review', params, special, 1, 'submission:' + SID, read.ticket);
    params.reason = 'edited after confirmation'; params.id = OTHER;
    expect(command.params).toMatchObject({ id: SID, reason: special }); expect(Object.isFrozen(command.params)).toBe(true);
    expect(L.canConfirm(command, read.book, 'submission:' + SID, false)).toBe(true);
    expect(L.canConfirm(command, read.book, 'submission:' + OTHER, false)).toBe(false);
    expect(L.canConfirm(command, read.book, 'submission:' + SID, true)).toBe(false);
    expect(L.canConfirm(command, L.nextTicket(read.book, 'submission', SID).book, 'submission:' + SID, false)).toBe(false);
    expect(L.canConfirm(command, L.book(2), 'submission:' + SID, false)).toBe(false);
  });
  it('distinguishes an acknowledged write, known rejection and unknown response', () => {
    const L = logic(), target = 'submission:' + SID;
    expect(L.writeState(target, null).phase).toBe('acknowledged');
    const denied = L.failure(409, { error: 'workshop_submission_state' }, true); expect(denied.unknown).toBe(false);
    expect(L.writeState(target, denied).phase).toBe('rejected');
    for (const status of [0, 302, 503]) expect(L.failure(status, null, true).unknown).toBe(true);
    expect(L.failure(503, null, false).unknown).toBe(false);
    const unknown = L.writeState(target, L.failure(0, null, true)); expect(unknown.requiresRead).toBe(true);
    expect(L.observed(unknown, 'submission:' + OTHER)).toBe(unknown);
    expect(L.observed(unknown, target)).toMatchObject({ phase: 'unknown', requiresRead: false, observed: true });
  });
  it('matches read and write identities and does not equate approved with current', () => {
    const L = logic(), oldApproved = detail(SID, 'approved'); oldApproved.current = false;
    expect(L.detail(oldApproved, SID).current).toBe(false);
    expect(thrown(() => L.detail(oldApproved, OTHER)).code).toBe('console_bad_response');
    expect(L.reportDetail(reportDetail(), RID).target.current).toBe(true);
    const wrong = reportDetail(); wrong.target.release.version = '2.0.0';
    expect(thrown(() => L.reportDetail(wrong, RID)).code).toBe('console_bad_response');
    expect(thrown(() => L.writeResult({ submission: submission(OTHER, 'approved') }, { operation: 'review', params: { id: SID, decision: 'approve' } })).code).toBe('console_bad_response');
  });
  it('requires a permitted image type and matching signature before making a Blob', () => {
    const L = logic(), png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    // This is only the browser-side type/signature guard. Server validation is
    // separately required; these header bytes are not a complete valid image.
    expect(L.previewBytes(png, 'image/png')).toBe(true); expect(L.previewBytes(png, 'image/jpeg')).toBe(false);
    expect(L.previewBytes(new Uint8Array([60, 115, 118, 103, 62]), 'image/svg+xml')).toBe(false);
    expect(L.previewBytes(new Uint8Array([255, 216, 255]), 'image/jpeg')).toBe(true);
    expect(L.previewBytes(new Uint8Array([82, 73, 70, 70, 0, 0, 0, 0, 87, 69, 66, 80]), 'image/webp')).toBe(true);
  });
});

type Listener = (event: any) => unknown;
class FakeElement {
  readonly children: FakeElement[] = [];
  readonly listeners = new Map<string, Listener[]>();
  readonly attributes = new Map<string, string>();
  value = ''; className = ''; type = ''; isConnected = true;
  onload: null | (() => void) = null; onerror: null | (() => void) = null;
  naturalWidth = 0; naturalHeight = 0;
  private content = ''; private invisible = false; private inactive = false; private source = '';
  constructor(readonly tagName: string, readonly document: FakeDocument) {}
  set innerHTML(_: string) { throw new Error('HTML insertion is forbidden'); }
  set textContent(value: string) { this.content = String(value); this.children.length = 0; this.document.changed(); }
  get textContent(): string { return this.content + this.children.map(child => child.textContent).join(''); }
  set hidden(value: boolean) { this.invisible = value; this.document.changed(); } get hidden() { return this.invisible; }
  set disabled(value: boolean) { this.inactive = value; this.document.changed(); } get disabled() { return this.inactive; }
  set src(value: string) { this.source = value; this.document.changed(); } get src() { return this.source; }
  append(...elements: FakeElement[]) { this.children.push(...elements); this.document.changed(); }
  replaceChildren(...elements: FakeElement[]) { this.content = ''; this.children.splice(0, this.children.length, ...elements); this.document.changed(); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  fire(type: string, event: any = {}): Promise<void> {
    const pending = (async () => {
      if (type === 'click' && this.disabled) return;
      for (const listener of this.listeners.get(type) || []) await listener({ preventDefault() {}, ...event });
    })();
    this.document.tasks.add(pending);
    void pending.then(() => this.document.tasks.delete(pending), () => this.document.tasks.delete(pending));
    return pending;
  }
  focus() { this.document.activeElement = this; }
  querySelectorAll(tag: string): FakeElement[] { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
}
class FakeDocument {
  readonly elements = new Map<string, FakeElement>();
  readonly listeners = new Map<string, Listener[]>();
  readonly tasks = new Set<Promise<unknown>>();
  readonly lookupErrors: Error[] = [];
  activeElement: FakeElement | null = null;
  createElement(tag: string) { return new FakeElement(tag, this); }
  createTextNode(text: string) { const result = this.createElement('#text'); result.textContent = text; return result; }
  getElementById(id: string) {
    const node = this.elements.get(id);
    if (!node) {
      const error = new Error('Unknown DOM id: ' + id); this.lookupErrors.push(error); throw error;
    }
    return node;
  }
  querySelectorAll(selector: string) {
    const match = /^#([\w-]+) (\w+)$/.exec(selector); if (!match) throw new Error('Unexpected selector: ' + selector);
    return this.getElementById(match[1]!).querySelectorAll(match[2]!);
  }
  addEventListener(type: string, listener: Listener) { this.listeners.set(type, [...(this.listeners.get(type) || []), listener]); }
  changed() { /* No rendering engine; event promises are the completion gates. */ }
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}
function response(body: unknown, status = 200): any {
  return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => structuredClone(body) };
}
function imageResponse(type = 'image/png'): any {
  const bytes = type === 'image/png' ? new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]) : new Uint8Array([255, 216, 255]);
  return { ok: true, status: 200, headers: { get: (name: string) => name === 'content-type' ? type : String(bytes.length) }, arrayBuffer: async () => bytes.buffer };
}
function publicImageResponse(bytes: Uint8Array = publicPng, type = 'image/png', length: number | null = bytes.length) {
  const headers: Record<string, string> = { 'content-type': type };
  if (length !== null) headers['content-length'] = String(length);
  return new Response(new Uint8Array(bytes).buffer, { headers });
}
function loadedPublicImage(f: ReturnType<typeof browser>, width = 1, height = 1) {
  const image = f.byId('public-preview-image'); image.naturalWidth = width; image.naturalHeight = height;
  expect(image.onload).not.toBeNull(); image.onload!();
}
function browser(handler: (path: string, init: any) => Promise<any> | any) {
  const document = new FakeDocument(), windowEvents = new Map<string, Listener>(), calls: { path: string; init: any }[] = [];
  const tasks: Promise<unknown>[] = [], timers = new Map<number, () => void>(), urls: string[] = [], revoked: string[] = [];
  // Include numbered HTML headings (especially h2#confirm-title). The fixture
  // maps this fixed document; it is not a general-purpose HTML parser.
  for (const match of WORKSHOP_ADMIN_HTML.matchAll(/<([a-z][a-z0-9]*)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = document.createElement(match[1]!); element.hidden = /\bhidden\b/.test(match[2]!); document.elements.set(match[3]!, element);
  }
  let timerId = 0;
  runInNewContext(delivered, { document, window: { addEventListener: (name: string, listener: Listener) => windowEvents.set(name, listener) },
    location: { origin: 'https://worker.example' }, Uint8Array, Blob, AbortController, crypto: webcrypto,
    URL: { createObjectURL: () => { const url = 'blob:synthetic-' + urls.length; urls.push(url); return url; }, revokeObjectURL: (url: string) => revoked.push(url) },
    setTimeout: (callback: () => void) => { timers.set(++timerId, callback); return timerId; }, clearTimeout: (id: number) => timers.delete(id),
    fetch: (path: string, init: any) => {
      calls.push({ path, init });
      const pending = Promise.resolve().then(() => handler(path, init)); tasks.push(pending.catch(() => undefined)); return pending;
    },
  });
  const byId = (id: string) => document.getElementById(id);
  return { document, byId, calls, urls, revoked, timers, windowEvents,
    async login() { byId('admin-key').value = KEY; await byId('connect').fire('click'); },
    async open(id = SID) {
      const buttons = byId('submissions-rows').querySelectorAll('button');
      const index = byId('submissions-rows').children.findIndex(row => row.textContent.includes(id));
      await buttons[index]!.fire('click');
      expect(byId('submission-refresh').disabled).toBe(false); expect(byId('submission-summary').textContent).toContain(id);
    },
    async cleanup() { await byId('logout').fire('click'); await Promise.allSettled([...document.tasks, ...tasks]); },
  };
}

describe('same delivered script with controlled DOM and fetch', () => {
  it('starts publicly without a data request and clears private state after an invalid key response', async () => {
    const f = browser(() => response({ error: 'workshop_admin_auth_required' }, 401));
    try {
      expect(f.calls).toEqual([]); expect(f.byId('auth').hidden).toBe(false); expect(f.byId('console').hidden).toBe(true);
      await f.login(); expect(f.calls).toHaveLength(1); expect(f.byId('admin-key').value).toBe('');
      expect(f.byId('console').hidden).toBe(true); expect(f.byId('submissions-rows').textContent).toBe('');
      expect(f.byId('auth-error').textContent).toContain('workshop_admin_auth_required');
    } finally { await f.cleanup(); }
  });
  it('renders incoming metadata and file names as text and keeps the key out of DOM', async () => {
    const f = browser(path => response(path.includes('?status=') ? { submissions: [submission()], nextCursor: null } : detail()));
    try {
      await f.login(); await f.open();
      expect(f.byId('submissions-rows').textContent).toContain(special); expect(f.byId('submission-metadata').textContent).toContain(special.replaceAll('"', '\\"'));
      expect(f.byId('submission-files').textContent).toContain(file().path); expect(f.byId('submission-summary').querySelectorAll('img')).toHaveLength(0);
      expect([...f.document.elements.values()].map(node => node.textContent + node.value).join('')).not.toContain(KEY);
      expect(f.calls.every(call => call.init.headers['X-Admin-Key'] === KEY && call.init.redirect === 'error')).toBe(true);
    } finally { await f.cleanup(); }
  });
  it('keeps old list content after an explicitly refreshed read fails', async () => {
    let fail = false;
    const f = browser(() => { if (fail) throw new Error('synthetic read failure'); return response({ submissions: [submission()], nextCursor: null }); });
    try {
      await f.login(); fail = true; await f.byId('submissions-refresh').fire('click');
      expect(f.byId('submissions-rows').textContent).toContain(special);
      expect(f.byId('submissions-status').textContent).toContain('保留上一次'); expect(f.byId('submissions-refresh').disabled).toBe(false);
    } finally { await f.cleanup(); }
  });
  it.each(['普通审核理由', special])('requires confirmation, then refreshes the exact submission after an acknowledged action: %s', async (reason) => {
    let status = 'pending';
    const f = browser((path, init) => {
      if (init.method === 'POST') { status = 'approved'; return response({ submission: submission(SID, status) }); }
      return response(path.includes('?status=') ? { submissions: [submission(SID, status)], nextCursor: null } : detail(SID, status));
    });
    try {
      await f.login(); await f.open(); f.byId('review-reason').value = reason;
      await f.byId('approve').fire('click'); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
      // Preserve the original lookup Error/stack even if the page catches it
      // and displays only its generic public error notice.
      expect(f.document.lookupErrors).toEqual([]);
      expect(f.byId('confirm').hidden).toBe(false); expect(f.byId('confirm-target').textContent).toContain(SID);
      expect(f.byId('confirm-title').tagName).toBe('h2'); expect(f.byId('confirm-reason').textContent).toBe(reason);
      await f.byId('confirm-send').fire('click');
      expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(1);
      expect(JSON.parse(f.calls.find(call => call.init.method === 'POST')!.init.body)).toEqual({ decision: 'approve', reason });
      expect(f.calls.at(-1)!.path).toBe(`/api/workshop/v1/admin/submissions/${SID}?filesLimit=50`);
      expect(f.byId('submission-status-text').textContent).toContain('随后重新读取'); expect(f.byId('withdraw').disabled).toBe(false);
      expect(f.byId('submissions-rows').textContent).not.toContain(SID);
    } finally { await f.cleanup(); }
  });
  it('does not retry an unknown write and requires a target read without claiming previous success', async () => {
    let posts = 0, detailReads = 0;
    const f = browser((path, init) => {
      if (init.method === 'POST') { posts++; throw new Error('synthetic lost response'); }
      if (path.includes('?status=')) return response({ submissions: [submission()], nextCursor: null });
      detailReads++; return response(detail());
    });
    try {
      await f.login(); await f.open(); f.byId('review-reason').value = special;
      await f.byId('approve').fire('click');
      expect(f.document.lookupErrors).toEqual([]); expect(f.byId('confirm').hidden).toBe(false);
      await f.byId('confirm-send').fire('click');
      expect(posts).toBe(1); expect(detailReads).toBe(1); expect(f.byId('approve').disabled).toBe(true);
      expect(f.byId('submission-status-text').textContent).toContain('可能已生效');
      await f.byId('submission-refresh').fire('click');
      expect(posts).toBe(1); expect(detailReads).toBe(2); expect(f.byId('approve').disabled).toBe(false);
      expect(f.byId('submission-status-text').textContent).toContain('不据此认定先前请求成功');
    } finally { await f.cleanup(); }
  });
  it('ignores an old detail response after another ordinary row is selected', async () => {
    const first = deferred<any>();
    const f = browser(path => path.includes('?status=') ? response({ submissions: [submission(), submission(OTHER)], nextCursor: null })
      : path.includes(SID) ? first.promise : response(detail(OTHER)));
    try {
      await f.login(); const buttons = f.byId('submissions-rows').querySelectorAll('button');
      const pending = buttons[0]!.fire('click'); await buttons[1]!.fire('click');
      expect(f.byId('submission-summary').textContent).toContain(OTHER);
      first.resolve(response(detail())); await pending;
      expect(f.byId('submission-summary').textContent).toContain(OTHER); expect(f.byId('submission-summary').textContent).not.toContain(SID);
    } finally { first.resolve(response(detail())); await f.cleanup(); }
  });
  it('uses authenticated fixed preview paths and releases each displayed Blob on close or logout', async () => {
    const f = browser(path => path.includes('/preview?') ? imageResponse() : response(path.includes('?status=') ? { submissions: [submission()], nextCursor: null } : detail()));
    try {
      await f.login(); await f.open(); await f.byId('submission-files').querySelectorAll('button')[0]!.fire('click');
      expect(f.byId('preview-image').onload).not.toBeNull();
      f.byId('preview-image').onload!(); expect(f.byId('preview-image').src).toBe('blob:synthetic-0');
      const call = f.calls.find(call => call.path.includes('/preview?'))!;
      expect(call.path).toBe(`/api/workshop/v1/admin/submissions/${SID}/preview?file=0`); expect(call.init.headers['X-Admin-Key']).toBe(KEY);
      await f.byId('preview-clear').fire('click'); expect(f.revoked).toEqual(['blob:synthetic-0']);
      await f.byId('submission-files').querySelectorAll('button')[0]!.fire('click');
      expect(f.byId('preview-image').onload).not.toBeNull();
      await f.byId('logout').fire('click'); expect(f.revoked).toEqual(['blob:synthetic-0', 'blob:synthetic-1']);
      expect(f.byId('preview-image').src).toBe(''); expect(f.byId('admin-key').value).toBe('');
    } finally { await f.cleanup(); }
  });
  it('never creates a Blob for a preview that finishes after the selection changes', async () => {
    const image = deferred<any>();
    const f = browser(path => path.includes('/preview?') ? image.promise : response(path.includes('?status=')
      ? { submissions: [submission(), submission(OTHER)], nextCursor: null } : detail(path.includes(OTHER) ? OTHER : SID)));
    try {
      await f.login(); await f.open(); const pending = f.byId('submission-files').querySelectorAll('button')[0]!.fire('click');
      await f.open(OTHER); image.resolve(imageResponse()); await pending;
      expect(f.urls).toEqual([]); expect(f.byId('preview').hidden).toBe(true); expect(f.byId('submission-summary').textContent).toContain(OTHER);
    } finally { image.resolve(imageResponse()); await f.cleanup(); }
  });
  it('refuses a mismatched image response and reports an ordinary decode failure without losing the file list', async () => {
    let matching = false; const value = detail(); value.inspection.files = [file(0, 'image/jpeg')];
    const f = browser(path => path.includes('/preview?') ? imageResponse(matching ? 'image/jpeg' : 'image/png')
      : response(path.includes('?status=') ? { submissions: [submission()], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); await f.byId('submission-files').querySelectorAll('button')[0]!.fire('click');
      expect(f.urls).toEqual([]); expect(f.byId('preview-status').textContent).toContain('console_preview_type');
      matching = true; await f.byId('submission-files').querySelectorAll('button')[0]!.fire('click');
      expect(f.byId('preview-caption').textContent).toContain('不等于完整像素解码验证');
      expect(f.byId('preview-image').onerror).not.toBeNull(); f.byId('preview-image').onerror!();
      expect(f.revoked).toEqual(['blob:synthetic-0']); expect(f.byId('preview-image').hidden).toBe(true);
      expect(f.byId('preview-status').textContent).toContain('浏览器未能解码'); expect(f.byId('submission-files').textContent).toContain(file().path);
    } finally { await f.cleanup(); }
  });
  it.each(['普通审核理由', special])('keeps report resolution separate from withdrawing its release: %s', async (reason) => {
    let resolved = false;
    const f = browser((path, init) => {
      if (path.includes('/submissions?')) return response({ submissions: [], nextCursor: null });
      if (path.includes('/reports?')) return response({ reports: [report()], nextCursor: null });
      if (init.method === 'POST') { resolved = true; return response(reportDetail(RID, 'resolved')); }
      return response(reportDetail(RID, resolved ? 'resolved' : 'open'));
    });
    try {
      await f.login(); await f.byId('tab-reports').fire('click');
      expect(f.byId('reports-rows').children).toHaveLength(1);
      await f.byId('reports-rows').querySelectorAll('button')[0]!.fire('click');
      expect(f.byId('report-content').textContent).toContain(RID); expect(f.byId('report-refresh').disabled).toBe(false);
      f.byId('report-reason').value = reason; await f.byId('resolve-handled').fire('click');
      expect(f.document.lookupErrors).toEqual([]); expect(f.byId('confirm').hidden).toBe(false);
      expect(f.byId('confirm-title').tagName).toBe('h2'); expect(f.byId('confirm-reason').textContent).toBe(reason);
      expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
      expect(f.byId('confirm-impact').textContent).toContain('不会撤回'); await f.byId('confirm-send').fire('click');
      expect(f.calls.filter(call => call.init.method === 'POST').map(call => call.path)).toEqual([`/api/workshop/v1/admin/reports/${RID}/resolve`]);
      expect(JSON.parse(f.calls.find(call => call.init.method === 'POST')!.init.body)).toEqual({ decision: 'handled', reason });
      expect(f.byId('resolve-handled').disabled).toBe(true); expect(f.byId('report-withdraw').disabled).toBe(false);
      expect(f.byId('report-content').textContent).toContain('管理密钥持有人（admin）');
    } finally { await f.cleanup(); }
  });
  it('clears private state on pagehide and ignores late reads without visibility-change logout', async () => {
    const read = deferred<any>(); let first = true;
    const f = browser(() => { if (first) { first = false; return response({ submissions: [submission()], nextCursor: null }); } return read.promise; });
    try {
      await f.login(); const pending = f.byId('submissions-refresh').fire('click');
      f.windowEvents.get('pagehide')!({}); read.resolve(response({ submissions: [submission(OTHER)], nextCursor: null })); await pending;
      expect(f.byId('console').hidden).toBe(true); expect(f.byId('submissions-rows').textContent).toBe(''); expect(f.byId('admin-key').value).toBe('');
      expect(f.windowEvents.has('visibilitychange')).toBe(false); expect(f.timers.size).toBe(0);
    } finally { read.resolve(response({ submissions: [], nextCursor: null })); await f.cleanup(); }
  });
});

describe('registered public preview in the same delivered admin script', () => {
  it('constructs only the fixed authenticated candidate endpoint and validates its optional descriptor', () => {
    const L = logic(), item = publicDetail().submission;
    const plan = L.request('publicPreview', { id: SID, url: 'https://unused.example', file: 99 }, KEY);
    expect(plan.path).toBe(`/api/workshop/v1/admin/submissions/${SID}/public-preview`);
    expect(plan.options).toMatchObject({ method: 'GET', credentials: 'omit', cache: 'no-store', redirect: 'error',
      headers: { 'X-Admin-Key': KEY, Accept: 'image/png' } });
    expect(L.submission(item)).toBe(item); expect(L.submission(submission()).preview).toBeUndefined();
    for (const fields of [null, { ...item.preview, path: 'https://unused.example/image.png' },
      { ...item.preview, path: item.preview.path + '?file=1' }, { ...item.preview, size: 2097153 },
      { ...item.preview, width: 513 }, { ...item.preview, height: 0 }, { ...item.preview, sha256: 'e'.repeat(64) }]) {
      expect(thrown(() => L.submission({ ...item, preview: fields })).code).toBe('console_bad_response');
    }
  });
  it('explicitly shows no image for a legacy candidate and does not borrow another current image', async () => {
    const value = detail(); value.current = false;
    const f = browser(path => response(path.includes('?status=') ? { submissions: [submission()], nextCursor: null } : value));
    try {
      await f.login(); await f.open();
      expect(f.byId('public-preview').hidden).toBe(false); expect(f.byId('public-preview-caption').textContent).toContain('本次没有');
      expect(f.byId('public-preview-retry').hidden).toBe(true); expect(f.byId('approve').disabled).toBe(false);
      expect(f.calls.some(call => call.path.endsWith('/public-preview'))).toBe(false); expect(f.urls).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it('binds approval to the fetched digest, PNG pixel dimensions and successful load of this candidate', async () => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse()
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); expect(f.byId('approve').disabled).toBe(true); expect(f.byId('reject').disabled).toBe(false);
      const call = f.calls.find(call => call.path.endsWith('/public-preview'))!;
      expect(call.path).toBe(`/api/workshop/v1/admin/submissions/${SID}/public-preview`);
      expect(call.init.headers['X-Admin-Key']).toBe(KEY); expect(call.init.redirect).toBe('error');
      loadedPublicImage(f); expect(f.byId('approve').disabled).toBe(false); expect(f.byId('public-preview-image').hidden).toBe(false);
      f.byId('review-reason').value = special; await f.byId('approve').fire('click');
      expect(f.byId('confirm-impact').textContent).toContain(publicHash); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it.each(['approve', 'reject'])('reloads the registered image after an acknowledged %s while the write guard is active', async (decision) => {
    let status = 'pending';
    const f = browser((path, init) => {
      if (init.method === 'POST') {
        status = decision === 'approve' ? 'approved' : 'rejected'; return response({ submission: publicDetail(SID, status).submission });
      }
      if (path.endsWith('/public-preview')) return publicImageResponse();
      return response(path.includes('?status=') ? { submissions: [publicDetail(SID, status).submission], nextCursor: null } : publicDetail(SID, status));
    });
    try {
      await f.login(); await f.open(); loadedPublicImage(f); f.byId('review-reason').value = special;
      await f.byId(decision).fire('click'); await f.byId('confirm-send').fire('click');
      expect(f.calls.filter(call => call.path.endsWith('/public-preview'))).toHaveLength(2);
      expect(f.byId('public-preview').hidden).toBe(false); expect(f.byId('public-preview-image').src).toBe('blob:synthetic-1');
      expect(f.revoked).toEqual(['blob:synthetic-0']); loadedPublicImage(f);
      expect(f.byId('public-preview-image').hidden).toBe(false); expect(f.byId('submission-status-text').textContent).toContain('随后重新读取');
    } finally { await f.cleanup(); }
  });
  it.each(['type', 'hash', 'declared-size', 'body-overflow', 'body-truncated'])('refuses %s mismatch before creating a public Blob and permits a manual retry', async (mode) => {
    let repaired = false; const value = publicDetail(), changed = new Uint8Array(publicPng); changed[changed.length - 1]! ^= 1;
    const f = browser(path => {
      if (!path.endsWith('/public-preview')) return response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value);
      if (repaired) return publicImageResponse();
      if (mode === 'type') return publicImageResponse(publicPng, 'image/jpeg');
      if (mode === 'hash') return publicImageResponse(changed);
      if (mode === 'declared-size') return publicImageResponse(publicPng, 'image/png', publicPng.length + 1);
      if (mode === 'body-overflow') return publicImageResponse(new Uint8Array([...publicPng, 0]), 'image/png', null);
      return publicImageResponse(publicPng.subarray(0, publicPng.length - 1), 'image/png', null);
    });
    try {
      await f.login(); await f.open(); expect(f.urls).toEqual([]); expect(f.byId('approve').disabled).toBe(true);
      expect(f.byId('reject').disabled).toBe(false); expect(f.byId('public-preview-retry').disabled).toBe(false);
      expect(f.byId('public-preview-status').textContent).toContain('console_public_preview_');
      repaired = true; await f.byId('public-preview-retry').fire('click'); loadedPublicImage(f);
      expect(f.byId('approve').disabled).toBe(false); expect(f.byId('submission-files').textContent).toContain(file().path);
    } finally { await f.cleanup(); }
  });
  it('keeps a decode failure recoverable without approving an unseen image', async () => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse()
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open();
      f.byId('public-preview-image').onerror!();
      expect(f.revoked).toEqual(['blob:synthetic-0']); expect(f.byId('public-preview-image').src).toBe('');
      expect(f.byId('approve').disabled).toBe(true); expect(f.byId('reject').disabled).toBe(false);
      expect(f.byId('public-preview-retry').disabled).toBe(false);
      await f.byId('public-preview-retry').fire('click'); loadedPublicImage(f); expect(f.byId('approve').disabled).toBe(false);
    } finally { await f.cleanup(); }
  });
  it.each(['short-header', 'header-type', 'header-length', 'pixel-dimensions'])('rejects %s after digest verification and before creating a Blob', async (mode) => {
    const bytes = mode === 'short-header' ? publicPng.slice(0, 8) : new Uint8Array(publicPng);
    if (mode === 'header-type') bytes[12] = 74;
    if (mode === 'header-length') bytes[11] = 12;
    const value = publicDetailForPng(bytes, mode === 'pixel-dimensions' ? 2 : 1, 1);
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse(bytes)
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); expect(f.urls).toEqual([]); expect(f.byId('approve').disabled).toBe(true);
      expect(f.byId('reject').disabled).toBe(false);
      expect(f.byId('public-preview-status').textContent).toContain(mode === 'pixel-dimensions'
        ? 'console_public_preview_dimensions' : 'console_public_preview_type');
    } finally { await f.cleanup(); }
  });
  it.each(['orientation', 'density'])('allows a successfully loaded %s-adjusted natural size while binding raw PNG dimensions', async (mode) => {
    const bytes = mode === 'orientation' ? orientationPng : densityPng, value = publicDetailForPng(bytes, 4, 2);
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse(bytes)
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); expect(f.byId('approve').disabled).toBe(true);
      loadedPublicImage(f, 2, mode === 'orientation' ? 4 : 1);
      expect(f.byId('approve').disabled).toBe(false); expect(f.byId('public-preview-image').hidden).toBe(false);
      expect(f.revoked).toEqual([]); expect(f.byId('public-preview-caption').textContent).toContain('4 × 2');
    } finally { await f.cleanup(); }
  });
  it('drops a public image response that arrives after a different submission is selected', async () => {
    const image = deferred<any>(), started = deferred<null>(), value = publicDetail();
    const f = browser(path => {
      if (path.endsWith('/public-preview')) { started.resolve(null); return image.promise; }
      return response(path.includes('?status=') ? { submissions: [value.submission, submission(OTHER)], nextCursor: null }
        : path.includes(OTHER) ? detail(OTHER) : value);
    });
    let pending: Promise<void> | undefined;
    try {
      await f.login(); pending = f.byId('submissions-rows').querySelectorAll('button')[0]!.fire('click');
      await started.promise;
      await f.open(OTHER); image.resolve(publicImageResponse()); await pending;
      expect(f.urls).toEqual([]); expect(f.byId('public-preview-caption').textContent).toContain('本次没有');
      expect(f.byId('submission-summary').textContent).toContain(OTHER); expect(f.byId('approve').disabled).toBe(false);
    } finally { image.resolve(publicImageResponse()); await pending; await f.cleanup(); }
  });
  it('clears a previous candidate Blob before displaying a different no-image submission', async () => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse() : response(path.includes('?status=')
      ? { submissions: [value.submission, submission(OTHER)], nextCursor: null } : path.includes(OTHER) ? detail(OTHER) : value));
    try {
      await f.login(); await f.open(); const lateLoad = f.byId('public-preview-image').onload!;
      await f.open(OTHER); lateLoad();
      expect(f.revoked).toEqual(['blob:synthetic-0']); expect(f.byId('public-preview-image').hidden).toBe(true);
      expect(f.byId('public-preview-image').src).toBe(''); expect(f.byId('public-preview-caption').textContent).toContain('本次没有');
    } finally { await f.cleanup(); }
  });
  it('clears the session when the authenticated registered-image read is rejected', async () => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? response({ error: 'workshop_admin_auth_required' }, 401)
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.byId('submissions-rows').querySelectorAll('button')[0]!.fire('click');
      expect(f.byId('console').hidden).toBe(true); expect(f.byId('auth-error').textContent).toContain('workshop_admin_auth_required');
      expect(f.byId('submission-summary').textContent).toBe(''); expect(f.urls).toEqual([]);
    } finally { await f.cleanup(); }
  });
  it('invalidates a confirmation on explicit image retry and ignores the old load event', async () => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse()
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); const oldLoad = f.byId('public-preview-image').onload!; loadedPublicImage(f);
      f.byId('review-reason').value = special; await f.byId('approve').fire('click'); expect(f.byId('confirm').hidden).toBe(false);
      await f.byId('public-preview-retry').fire('click'); expect(f.byId('confirm').hidden).toBe(true);
      oldLoad(); expect(f.byId('approve').disabled).toBe(true); expect(f.revoked).toEqual(['blob:synthetic-0']);
      loadedPublicImage(f); expect(f.byId('approve').disabled).toBe(false); expect(f.calls.filter(call => call.init.method === 'POST')).toHaveLength(0);
    } finally { await f.cleanup(); }
  });
  it('keeps the registered image independent from optional private member previews', async () => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse() : path.includes('/preview?') ? imageResponse()
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); loadedPublicImage(f);
      await f.byId('submission-files').querySelectorAll('button')[0]!.fire('click'); f.byId('preview-image').onload!();
      await f.byId('preview-clear').fire('click');
      expect(f.byId('public-preview-image').src).toBe('blob:synthetic-0'); expect(f.byId('approve').disabled).toBe(false);
      expect(f.revoked).toEqual(['blob:synthetic-1']);
    } finally { await f.cleanup(); }
  });
  it.each(['logout', 'pagehide'])('revokes the public Blob and ignores its late load after %s', async (event) => {
    const value = publicDetail();
    const f = browser(path => path.endsWith('/public-preview') ? publicImageResponse()
      : response(path.includes('?status=') ? { submissions: [value.submission], nextCursor: null } : value));
    try {
      await f.login(); await f.open(); const lateLoad = f.byId('public-preview-image').onload!;
      if (event === 'logout') await f.byId('logout').fire('click'); else f.windowEvents.get('pagehide')!({});
      lateLoad(); expect(f.revoked).toEqual(['blob:synthetic-0']); expect(f.byId('public-preview-image').src).toBe('');
      expect(f.byId('public-preview').hidden).toBe(true); expect(f.byId('console').hidden).toBe(true); expect(f.timers.size).toBe(0);
    } finally { await f.cleanup(); }
  });
});
