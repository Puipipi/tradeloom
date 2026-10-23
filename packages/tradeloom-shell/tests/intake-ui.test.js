import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

// A real DOM exercises the shipped handlers. Fetch is synthetic: this does not test a browser or Electron.
const require = createRequire(import.meta.url);
const { JSDOM } = require(process.env.TRADELOOM_DOM_MODULE || 'jsdom');
const template = readFileSync(new URL('../../../workbench/templates/workbench/artifacts.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../../../workbench/static/workbench/intake.js', import.meta.url), 'utf8');
const linkScript = readFileSync(new URL('../../../workbench/static/workbench/intake-links.js', import.meta.url), 'utf8');
const executionPlanScript = readFileSync(new URL('../../../workbench/static/workbench/execution-plans.js', import.meta.url), 'utf8');
const candidateA = 'a'.repeat(32);
const candidateB = 'b'.repeat(32);
const sourceA = '1'.repeat(32);
const sourceB = '2'.repeat(32);
const narrativeId = 'c'.repeat(32);
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)); };
const response = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function revision(number, description = 'A') {
  return {
    id: `revision-${description}-${number}`, revision: number, status: 'needs_confirmation',
    fields: { description, quantity: number === 1 ? '10' : '50', pack_quantity: '5', carton_count: '2', unit: 'synthetic-unit', pack_unit: 'synthetic-pack' },
    source_refs: {}, unresolved_fields: {},
    source_arithmetic_check: { state: 'calculated', whole_packages: String(number === 1 ? 2 : 10), remainder: '0', source_carton_count: '2' },
    packaging_check: 'needs_confirmation',
  };
}
function result(id = candidateA, number = 2) {
  const selected = revision(number, id === candidateA ? 'A' : 'B');
  return { ok: true, draft: { id: `draft-${id}`, record_kind: 'historical_reference', current_revision: number }, revision: selected,
    source_arithmetic_check: selected.source_arithmetic_check, packaging_check: 'needs_confirmation' };
}

async function fixture(t, override = () => undefined) {
  const dom = new JSDOM(template.replace(/{%[\s\S]*?%}/g, ''), { url: 'http://localhost/artifacts', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const { window } = dom;
  const document = window.document;
  const root = document.querySelector('[data-testid="intake-workbench"]');
  const planRoot = document.querySelector('[data-testid="execution-plan-workbench"]');
  planRoot.dataset.planCollectionUrl = '/execution-plans/__REQUIREMENT__';
  Object.assign(root.dataset, {
    sourcesUrl: '/sources', candidatesUrl: '/candidates', candidateUrl: '/candidates/__CANDIDATE__',
    candidateLinksUrl: '/candidates/__CANDIDATE__/links',
    previewUrl: '/previews/__SNAPSHOT__',
    narrativesUrl: '/narratives', narrativeLinesUrl: '/narratives/__NARRATIVE__/lines',
    narrativeAnnotationsUrl: '/narratives/__NARRATIVE__/annotations',
    requirementDraftUrl: '/candidates/__CANDIDATE__/drafts', requirementUrl: '/requirements/__REQUIREMENT__',
    requirementHistoryUrl: '/requirements/__REQUIREMENT__/revisions', requirementConfirmUrl: '/requirements/__REQUIREMENT__/confirm',
  });
  const schema = document.createElement('script'); schema.id = 'intake-field-schemas'; schema.textContent = '{}'; document.body.append(schema);
  const calls = [], errors = [];
  window.addEventListener('error', event => { errors.push(event.error); event.preventDefault(); });
  window.fetch = async (url, options) => {
    const parsed = new URL(url, 'http://localhost');
    const call = { path: parsed.pathname, query: parsed.searchParams, options, method: options.method || 'GET' };
    calls.push(call);
    const custom = override(call);
    if (custom !== undefined) return custom;
    if (call.path === '/sources') return response({ sources: [] });
    if (call.path === '/narratives') return response({ narratives: [{ id: narrativeId, display_name: 'Synthetic note', line_count: 65, byte_size: 128, sha256: '0'.repeat(64) }] });
    if (call.path.endsWith('/annotations')) return response({ source: { id: narrativeId, sha256: '0'.repeat(64) }, current: null, history: [], next_offset: null });
    if (call.path.startsWith('/execution-plans/')) return response({ latest_revision: 0, revisions: [], next_offset: null });
    if (call.path === '/candidates') return response({ candidates: [candidateA, candidateB].map(id => ({ id, candidate_type: 'production_instruction', status: 'unconfirmed' })) });
    for (const id of [candidateA, candidateB]) {
      if (call.path === `/candidates/${id}`) return response({ candidate: { id, candidate_type: 'production_instruction' } });
      if (call.path === `/candidates/${id}/drafts`) return response({ requirement: result(id) });
      if (call.path === `/requirements/draft-${id}/revisions`) return response({ current_revision: 2, revisions: [revision(2, id === candidateA ? 'A' : 'B'), revision(1, id === candidateA ? 'A' : 'B')], next_offset: null });
    }
    throw new Error(`Unexpected synthetic request ${call.method} ${call.path}`);
  };
  // Match artifacts.html defer order: the listener is installed before intake emits its first viewed event.
  window.eval(executionPlanScript);
  window.eval(script);
  window.eval(linkScript);
  await tick();
  const clickCandidate = async id => { document.querySelector(`[data-candidate-id="${id}"]`).click(); await tick(); };
  const button = text => [...root.querySelectorAll('button')].find(element => element.textContent === text);
  return { window, document, root, calls, errors, clickCandidate, button };
}

test('artifacts installs the independent plan listener before intake and forwards the exact viewed revision', async t => {
  assert.ok(template.indexOf('execution-plans.js') < template.indexOf('intake.js'));
  const app = await fixture(t);
  const contexts = [];
  app.root.addEventListener('tradeloom:requirement-context', event => contexts.push(event.detail));
  await app.clickCandidate(candidateA);
  const viewed = contexts.find(item => item.phase === 'viewed');
  assert.equal(viewed.candidateId, candidateA);
  assert.equal(viewed.requirementId, `draft-${candidateA}`);
  assert.equal(viewed.revision.revision, 2);
  assert.equal(viewed.revision.status, 'needs_confirmation');
  assert.match(app.document.querySelector('[data-testid="execution-plan-content"]').textContent, /只有已确认需求版本/);
});

test('cross-file link workspace exposes paired source and candidate selectors with manual judgment history', async t => {
  const app = await fixture(t);
  const workspace = app.root.querySelector('[data-testid="intake-links"]');
  assert.ok(workspace, 'candidate page must provide a cross-file link workspace');
  assert.ok(workspace.querySelector('[data-link-source="left"]'));
  assert.ok(workspace.querySelector('[data-link-source="right"]'));
  assert.ok(workspace.querySelector('[data-link-candidate="left"]'));
  assert.ok(workspace.querySelector('[data-link-candidate="right"]'));
  assert.match(workspace.textContent, /人工关联判断/);
  assert.match(workspace.textContent, /不自动合并/);
  assert.match(workspace.textContent, /资料候选关联/);
  assert.match(workspace.textContent, /同一来源或不同来源的两条候选/);
  assert.match(workspace.textContent, /最近判断在前/);
  assert.match(workspace.textContent, /载入较早记录/);
});

test('candidate detail labels the latest-link preview and points to full history when server marks more', async t => {
  const app = await fixture(t, call => {
    if (call.path === `/candidates/${candidateA}`) return response({
      candidate: { id: candidateA, candidate_type: 'production_instruction', fields: {}, provenance: {} },
      links: Array.from({ length: 2 }, (_, index) => ({ id: String(index), decision: 'suggested' })),
      links_next_offset: 20,
    });
  });
  await app.clickCandidate(candidateA);
  const detail = app.root.querySelector('[data-intake-candidate-detail]');
  assert.match(detail.textContent, /最近\s*2\s*条/);
  assert.match(detail.textContent, /还有更早记录/);
  assert.match(detail.textContent, /资料候选关联工作区/);
});

test('link workspace filters by each source, escapes bilateral history, and retries the same write key', async t => {
  const seen = [];
  let writes = 0;
  const pendingWrite = deferred();
  const app = await fixture(t, call => {
    if (call.path === '/sources' && call.query.has('limit')) {
      return response({ sources: [{ id: sourceA, display_name: 'Source A' }, { id: sourceB, display_name: 'Source B' }], next_offset: null });
    }
    if (call.path === '/candidates' && call.query.has('source_id')) {
      return response({ candidates: [{ id: call.query.get('source_id') === sourceA ? candidateA : candidateB,
        candidate_type: 'product_identity', status: 'unconfirmed' }], next_offset: null });
    }
    if (call.path.endsWith('/links') && call.method === 'GET') {
      return response({ links: [{ id: 'd'.repeat(32), left_candidate_id: candidateA, right_candidate_id: candidateB,
        decision: 'suggested', actor: 'local_workbench', created_at: '2026-10-22T03:00:00Z',
        evidence: { reason: '<img src=x onerror=alert(1)>', secret: 'must-not-render' } }], next_offset: null });
    }
    if (call.path.endsWith('/links') && call.method === 'POST') {
      writes++;
      seen.push({ headers: call.options.headers, body: call.options.body });
      return writes === 1 ? pendingWrite.promise : response({
        status: 'succeeded', link: { id: 'e'.repeat(32) },
      }, 201);
    }
  });
  const leftSource = app.root.querySelector('[data-link-source="left"]');
  const rightSource = app.root.querySelector('[data-link-source="right"]');
  leftSource.value = sourceA; leftSource.dispatchEvent(new app.window.Event('change')); await tick();
  rightSource.value = sourceB; rightSource.dispatchEvent(new app.window.Event('change')); await tick();
  assert.ok(app.calls.some(call => call.path === '/candidates' && call.query.get('source_id') === sourceA));
  assert.ok(app.calls.some(call => call.path === '/candidates' && call.query.get('source_id') === sourceB));
  const leftCandidate = app.root.querySelector('[data-link-candidate="left"]');
  const rightCandidate = app.root.querySelector('[data-link-candidate="right"]');
  leftCandidate.value = candidateA; leftCandidate.dispatchEvent(new app.window.Event('change')); await tick();
  rightCandidate.value = candidateB; rightCandidate.dispatchEvent(new app.window.Event('change')); await tick();
  assert.ok(app.calls.some(call => call.path === `/candidates/${candidateA}/links`));
  assert.ok(app.calls.some(call => call.path === `/candidates/${candidateB}/links`));
  const history = app.root.querySelector('[data-link-history="left"]');
  assert.match(history.textContent, /建议关联/);
  assert.match(history.textContent, /<img src=x/);
  assert.equal(history.querySelector('img'), null);
  assert.equal(history.textContent.includes('must-not-render'), false);

  const form = app.root.querySelector('[data-link-form]');
  form.elements.decision.value = 'confirmed';
  form.elements.reason.value = 'Reviewed <svg onload=alert(1)>';
  form.elements.reason.dispatchEvent(new app.window.Event('input'));
  form.dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(form.elements.reason.disabled, true, 'inputs stay frozen while the result is pending');
  pendingWrite.resolve(response({ error_code: 'unavailable' }, 503)); await tick();
  assert.match(app.root.querySelector('[data-link-message]').textContent, /重试同一请求/);
  form.dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers['Idempotency-Key'], seen[1].headers['Idempotency-Key']);
  assert.equal(seen[0].body, seen[1].body);
  assert.deepEqual(JSON.parse(seen[0].body), {
    other_candidate_id: candidateB, decision: 'confirmed', reason: 'Reviewed <svg onload=alert(1)>',
  });
  assert.deepEqual(app.errors, []);
});

test('late link history from a prior candidate cannot replace the current history', async t => {
  const pending = deferred();
  const app = await fixture(t, call => {
    if (call.path === '/sources' && call.query.has('limit')) {
      return response({ sources: [{ id: sourceA, display_name: 'Source A' }, { id: sourceB, display_name: 'Source B' }], next_offset: null });
    }
    if (call.path === '/candidates' && call.query.has('source_id')) {
      return response({ candidates: [{ id: call.query.get('source_id') === sourceA ? candidateA : candidateB,
        candidate_type: 'product_identity' }], next_offset: null });
    }
    if (call.path === `/candidates/${candidateA}/links`) return pending.promise;
    if (call.path === `/candidates/${candidateB}/links`) return response({ links: [], next_offset: null });
  });
  const source = app.root.querySelector('[data-link-source="left"]');
  source.value = sourceA; source.dispatchEvent(new app.window.Event('change')); await tick();
  let candidate = app.root.querySelector('[data-link-candidate="left"]');
  candidate.value = candidateA; candidate.dispatchEvent(new app.window.Event('change')); await tick();
  source.value = sourceB; source.dispatchEvent(new app.window.Event('change')); await tick();
  candidate = app.root.querySelector('[data-link-candidate="left"]');
  candidate.value = candidateB; candidate.dispatchEvent(new app.window.Event('change')); await tick();
  pending.resolve(response({ links: [{ id: 'd'.repeat(32), left_candidate_id: candidateA, right_candidate_id: candidateB,
    decision: 'confirmed', evidence: { reason: 'stale response marker' } }], next_offset: null }));
  await tick();
  assert.doesNotMatch(app.root.querySelector('[data-link-history="left"]').textContent, /stale response marker/);
  assert.deepEqual(app.errors, []);
});

test('right-side source pagination is wired to its own button', async t => {
  const app = await fixture(t, call => {
    if (call.path === '/sources' && call.query.has('limit')) {
      const offset = Number(call.query.get('offset'));
      return response({ sources: offset === 0 ? [
        { id: sourceA, display_name: 'Source A' }, { id: sourceB, display_name: 'Source B' },
      ] : [], next_offset: offset === 0 ? 2 : null });
    }
  });
  app.root.querySelector('[data-link-more-sources="right"]').click(); await tick();
  assert.ok(app.calls.some(call => call.path === '/sources' && call.query.get('offset') === '2'),
    'the right-side button must load the next bounded page');
});

test('candidate picker labels use readable source fields instead of only English type and opaque ID', async t => {
  const app = await fixture(t, call => {
    if (call.path === '/sources' && call.query.has('limit')) {
      return response({ sources: [{ id: sourceA, display_name: 'Source A' }], next_offset: null });
    }
    if (call.path === '/candidates' && call.query.has('source_id')) {
      return response({ candidates: [{ id: candidateA, candidate_type: 'product_identity', fields: {
        description: [{ state: 'present', value: '<img src=x> Synthetic label' }],
      } }], next_offset: null });
    }
  });
  const source = app.root.querySelector('[data-link-source="left"]');
  source.value = sourceA; source.dispatchEvent(new app.window.Event('change')); await tick();
  const option = app.root.querySelector('[data-link-candidate="left"]').options[1];
  assert.match(option.textContent, /产品身份候选.*描述：<img src=x> Synthetic label/);
  assert.equal(option.querySelector('img'), null);
});

test('candidate loading keeps an empty selection and ignores a late result after clearing its source', async t => {
  const pending = deferred();
  const app = await fixture(t, call => {
    if (call.path === '/sources' && call.query.has('limit')) {
      return response({ sources: [{ id: sourceA, display_name: 'Source A' }, { id: sourceB, display_name: 'Source B' }], next_offset: null });
    }
    if (call.path === '/candidates' && call.query.has('source_id')) {
      if (call.query.get('source_id') === sourceB) return response({ candidates: [{ id: candidateB,
        candidate_type: 'product_identity' }], next_offset: null });
      return pending.promise;
    }
  });
  const rightSource = app.root.querySelector('[data-link-source="right"]');
  rightSource.value = sourceB; rightSource.dispatchEvent(new app.window.Event('change')); await tick();
  const right = app.root.querySelector('[data-link-candidate="right"]');
  right.value = candidateB; right.dispatchEvent(new app.window.Event('change'));
  const form = app.root.querySelector('[data-link-form]');
  form.elements.reason.value = 'Synthetic reason';
  form.elements.reason.dispatchEvent(new app.window.Event('input'));

  const leftSource = app.root.querySelector('[data-link-source="left"]');
  leftSource.value = sourceA; leftSource.dispatchEvent(new app.window.Event('change'));
  const left = app.root.querySelector('[data-link-candidate="left"]');
  assert.equal(left.value, '');
  assert.equal(app.button('保存关联判断').disabled, true);
  leftSource.value = ''; leftSource.dispatchEvent(new app.window.Event('change'));
  pending.resolve(response({ candidates: [{ id: candidateA, candidate_type: 'product_identity' }], next_offset: null }));
  await tick();
  assert.equal(left.value, '');
  assert.equal(left.disabled, true);
  assert.equal(app.button('保存关联判断').disabled, true);
});

test('choosing the other side does not discard the first side pending history', async t => {
  const leftPending = deferred();
  const app = await fixture(t, call => {
    if (call.path === '/sources' && call.query.has('limit')) {
      return response({ sources: [{ id: sourceA, display_name: 'Source A' }, { id: sourceB, display_name: 'Source B' }], next_offset: null });
    }
    if (call.path === '/candidates' && call.query.has('source_id')) {
      return response({ candidates: [{ id: call.query.get('source_id') === sourceA ? candidateA : candidateB,
        candidate_type: 'product_identity', fields: { description: [{ state: 'present', value: 'Synthetic label' }] } }], next_offset: null });
    }
    if (call.path === `/candidates/${candidateA}/links`) return leftPending.promise;
    if (call.path === `/candidates/${candidateB}/links`) return response({ links: [], next_offset: null });
  });
  const leftSource = app.root.querySelector('[data-link-source="left"]');
  leftSource.value = sourceA; leftSource.dispatchEvent(new app.window.Event('change')); await tick();
  const left = app.root.querySelector('[data-link-candidate="left"]');
  left.value = candidateA; left.dispatchEvent(new app.window.Event('change')); await tick();
  const rightSource = app.root.querySelector('[data-link-source="right"]');
  rightSource.value = sourceB; rightSource.dispatchEvent(new app.window.Event('change')); await tick();
  const right = app.root.querySelector('[data-link-candidate="right"]');
  right.value = candidateB; right.dispatchEvent(new app.window.Event('change')); await tick();
  leftPending.resolve(response({ links: [{ id: 'd'.repeat(32), left_candidate_id: candidateA,
    right_candidate_id: candidateB, decision: 'suggested', evidence: { reason: 'left history retained' } }], next_offset: null }));
  await tick();
  assert.match(app.root.querySelector('[data-link-history="left"]').textContent, /left history retained/);
});

test('failed requirement save keeps the parent dirty gate asserted for execution plans', async t => {
  const app = await fixture(t, call => call.method === 'POST' && call.path.endsWith('/revisions')
    ? response({ error_code: 'unavailable' }, 503) : undefined);
  const states = [];
  app.root.addEventListener('tradeloom:requirement-context', event => {
    if (event.detail.phase === 'state') states.push(event.detail);
  });
  await app.clickCandidate(candidateA);
  const quantity = app.root.querySelector('[name="quantity"]');
  quantity.value = '77'; quantity.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  quantity.closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  await tick();
  assert.equal(states.at(-1).saving, false);
  assert.equal(states.at(-1).dirty, true);
});

test('a new draft requires an explicit record kind', async t => {
  const app = await fixture(t, call => call.path.endsWith('/drafts') ? response({ requirement: null }) : undefined);
  await app.clickCandidate(candidateA);
  const select = app.root.querySelector('select[aria-label="记录用途"]');
  assert.equal(select.value, '');
  assert.equal(app.button('创建草稿').disabled, true);
  select.value = 'historical_reference'; select.dispatchEvent(new app.window.Event('change'));
  assert.equal(app.button('创建草稿').disabled, false);
});

test('confirm uses the actual workspace and only sends a unit pair after explicit selection', async t => {
  const app = await fixture(t, call => call.path.endsWith('/confirm') ? response(result()) : undefined);
  await app.clickCandidate(candidateA);
  app.button('确认此版本').click(); await tick();
  assert.deepEqual(app.errors, []);
  const posted = app.calls.find(call => call.path.endsWith('/confirm'));
  assert.ok(posted, 'confirmation must reach the API');
  assert.equal(JSON.parse(posted.options.body).confirmed_unit_pair, undefined);
  const pair = app.root.querySelector('[data-confirm-unit-pair]');
  assert.ok(pair, 'the operator can explicitly confirm unit compatibility');
  pair.checked = true;
  app.button('确认此版本').click(); await tick();
  const second = app.calls.filter(call => call.path.endsWith('/confirm')).at(-1);
  assert.deepEqual(JSON.parse(second.options.body).confirmed_unit_pair, { unit: 'synthetic-unit', pack_unit: 'synthetic-pack' });
});

test('old revisions are read-only and show their own arithmetic', async t => {
  const app = await fixture(t);
  await app.clickCandidate(candidateA);
  app.button('版本 1 · 待确认').click();
  assert.equal(app.root.querySelector('[name="quantity"]').disabled, true);
  assert.match(app.root.querySelector('.intake-check-note').textContent, /整包装 2，/);
  assert.equal(app.button('确认此版本'), undefined);
  app.button('返回当前版本 2').click(); await tick();
  assert.equal(app.root.querySelector('[name="quantity"]').disabled, false);
});

test('manual zero does not inherit a source and unchanged values can receive new statement evidence', async t => {
  let posted;
  const app = await fixture(t, call => {
    if (call.method === 'POST' && call.path.endsWith('/revisions')) { posted = JSON.parse(call.options.body); return response(result()); }
  });
  await app.clickCandidate(candidateA);
  const input = app.root.querySelector('[name="quantity"]'); input.value = '0';
  input.closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(posted.fields, { quantity: '0' });
  assert.deepEqual(posted.field_sources, {});
  posted = null;
  app.root.querySelector('[data-source-for="quantity"]').value = narrativeId;
  app.root.querySelector('[name="quantity"]').closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.ok(posted, 'a source-only correction must be saved without changing the value');
  assert.equal(posted.field_sources.quantity[0].kind, 'operator_statement');
});

test('a late save response cannot replace a different selected candidate', async t => {
  const pending = deferred();
  const app = await fixture(t, call => call.method === 'POST' && call.path.endsWith('/revisions') ? pending.promise : undefined);
  await app.clickCandidate(candidateA);
  const input = app.root.querySelector('[name="quantity"]'); input.value = '15';
  input.closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  await app.clickCandidate(candidateB);
  pending.resolve(response(result(candidateA, 3))); await tick();
  assert.equal(app.root.querySelector('[name="description"]').value, 'B');
});

test('a late history failure cannot overwrite another candidate workspace', async t => {
  const pending = deferred();
  const app = await fixture(t, call => call.path === `/requirements/draft-${candidateA}/revisions` ? pending.promise : undefined);
  await app.clickCandidate(candidateA);
  await app.clickCandidate(candidateB);
  pending.resolve(response({ error_code: 'unavailable' }, 503)); await tick();
  assert.equal(app.root.querySelector('[name="description"]')?.value, 'B');
});

test('narrative lines paginate and render untrusted text as text', async t => {
  const app = await fixture(t, call => {
    if (call.path.endsWith('/lines')) {
      const offset = Number(call.query.get('offset'));
      return response({ source: { id: narrativeId, display_name: 'Synthetic note', sha256: '0'.repeat(64) },
        lines: [{ line_number: offset + 1, text: '<img src=x onerror=alert(1)>', truncated: false }], next_offset: offset === 0 ? 30 : null });
    }
  });
  app.root.querySelector('[data-testid="intake-narratives"] button').click(); await tick();
  const viewer = app.root.querySelector('[data-testid="intake-narrative-lines"]');
  assert.equal(viewer.querySelector('img'), null);
  assert.match(viewer.textContent, /<img/);
  app.button('后 30 行').click(); await tick();
  assert.ok(app.calls.some(call => call.path.endsWith('/lines') && call.query.get('offset') === '30'));
  assert.match(viewer.textContent, /31/);
});

test('invalid statement ranges stop a save without silently discarding its source', async t => {
  const app = await fixture(t);
  await app.clickCandidate(candidateA);
  app.root.querySelector('[data-source-for="quantity"]').value = narrativeId;
  app.root.querySelector('[data-line-end-for="quantity"]').value = '66';
  app.root.querySelector('[name="quantity"]').closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(app.calls.filter(call => call.method === 'POST').length, 0);
  assert.match(app.root.querySelector('[data-intake-requirement-message]').textContent, /有效的出处行范围/);
});

test('revision conflicts preserve unsaved input and provide an explicit refresh', async t => {
  const app = await fixture(t, call => call.method === 'POST' && call.path.endsWith('/revisions') ? response({ error_code: 'stale_requirement' }, 409) : undefined);
  await app.clickCandidate(candidateA);
  const input = app.root.querySelector('[name="quantity"]'); input.value = '77';
  input.closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.equal(app.root.querySelector('[name="quantity"]').value, '77');
  assert.match(app.root.querySelector('[data-intake-requirement-message]').textContent, /其他操作已更新/);
  app.button('重新读取当前版本').click(); await tick();
  assert.equal(app.root.querySelector('[name="quantity"]').value, '50');
});

test('narrative retry keeps its key and refreshing sources does not erase unsaved fields', async t => {
  let uploads = 0;
  const app = await fixture(t, call => {
    if (call.method === 'POST' && call.path === '/narratives') {
      uploads++;
      return uploads === 1 ? response({ error_code: 'unavailable' }, 503)
        : response({ narrative: { id: narrativeId, display_name: 'Synthetic note', line_count: 65 } });
    }
    if (call.path.endsWith('/lines')) return response({ source: { display_name: 'Synthetic note', sha256: '0'.repeat(64) }, lines: [], next_offset: null });
  });
  await app.clickCandidate(candidateA);
  app.root.querySelector('[name="quantity"]').value = '77';
  const input = app.root.querySelector('[data-intake-narrative-file]');
  Object.defineProperty(input, 'files', { value: [new app.window.File(['Synthetic note'], 'synthetic.txt', { type: 'text/plain' })] });
  const form = app.root.querySelector('[data-intake-narrative-upload]');
  form.dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  form.dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  const requests = app.calls.filter(call => call.method === 'POST' && call.path === '/narratives');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.headers['Idempotency-Key'], requests[1].options.headers['Idempotency-Key']);
  assert.equal(requests[0].options.body.getAll('file').length, 1);
  assert.deepEqual([...requests[0].options.body.keys()], ['file']);
  assert.equal(app.calls.some(call => call.method === 'POST' && call.path.endsWith('/annotations')), false);
  assert.equal(app.root.querySelector('[name="quantity"]').value, '77');
});

test('intake task tabs expose one work area and preserve existing nodes, input values, and scroll state', async t => {
  const app = await fixture(t);
  const tabs = [...app.root.querySelectorAll('[data-intake-task-tab]')];
  assert.equal(tabs.length, 6);
  const panels = [...app.root.querySelectorAll('[data-intake-task-panel]')];
  assert.equal(panels.length, 6);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(panels[0].hidden, false);
  assert.equal(panels.filter(panel => !panel.hidden).length, 1);
  const input = app.root.querySelector('[data-intake-row-start]');
  input.value = '17';
  const sourceList = app.root.querySelector('[data-testid="intake-sources"]');
  sourceList.scrollTop = 42;
  const before = app.calls.length;
  tabs[0].focus();
  tabs[0].dispatchEvent(new app.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].tabIndex, 0);
  assert.equal(panels.filter(panel => !panel.hidden).length, 1);
  assert.strictEqual(app.root.querySelector('[data-intake-row-start]'), input);
  assert.equal(input.value, '17');
  assert.equal(sourceList.scrollTop, 42);
  tabs[0].click();
  assert.equal(input.value, '17');
  assert.equal(app.calls.length, before, 'switching intake tasks does not refetch or post');
});

test('opening a production instruction candidate switches to its visible requirement work area', async t => {
  const app = await fixture(t, call => {
    if (call.path.endsWith('/candidates/' + candidateA)) return response({ candidate: { id: candidateA, candidate_type: 'production_instruction', status: 'unconfirmed' }, links: [] });
    if (call.path.endsWith('/requirement-drafts')) return response({ requirement: null });
  });
  const tabs = [...app.root.querySelectorAll('[data-intake-task-tab]')];
  const candidate = app.root.querySelector('[data-testid="intake-candidates"] button');
  candidate?.click();
  if (!candidate) await app.clickCandidate(candidateA);
  await tick();
  const requirementTab = app.root.querySelector('[data-intake-task-tab="requirements"]');
  assert.equal(requirementTab.getAttribute('aria-selected'), 'true');
  assert.equal(app.root.querySelector('[data-intake-task-panel="requirements"]').hidden, false);
  assert.equal(app.root.querySelectorAll('[data-intake-task-panel]:not([hidden])').length, 1);
  app.root.querySelector('[data-intake-open-plan]').click();
  assert.equal(app.root.querySelector('[data-intake-task-tab="plans"]').getAttribute('aria-selected'), 'true');
  assert.ok(tabs.length);
});

test('narrative annotation metadata renders beside the line viewer for missing current DTOs', async t => {
  const app = await fixture(t, call => {
    if (call.path.endsWith('/lines')) return response({ source: { id: narrativeId, display_name: 'Synthetic note', sha256: '0'.repeat(64) }, lines: [{ line_number: 1, text: 'safe excerpt', truncated: false }], next_offset: null });
    if (call.path.endsWith('/annotations')) return response({ source: { id: narrativeId, sha256: '0'.repeat(64) }, current: null, history: [], next_offset: null });
  });
  app.root.querySelector('[data-testid="intake-narratives"] button').click(); await tick();
  const viewer = app.root.querySelector('[data-testid="intake-narrative-lines"]');
  const panel = app.root.querySelector('[data-testid="intake-narrative-annotation"]');
  assert.ok(panel, 'source notes have an independent annotation panel');
  assert.equal(panel.contains(viewer), false);
  assert.match(panel.textContent, /尚未记录/);
  assert.equal(panel.querySelector('[name="recording_date"]').value, '');
  assert.equal(panel.querySelector('[name="recording_date"]').required, false);
  assert.equal(panel.querySelector('[name="content_status"]').value, 'unconfirmed');
  assert.equal(panel.querySelector('[name="content_status"]').readOnly, true);
  assert.match(viewer.textContent, /safe excerpt/);
});

test('annotation failures and late source responses never replace selected source text or metadata', async t => {
  const pendingA = deferred();
  const app = await fixture(t, call => {
    if (call.path === '/narratives') return response({ narratives: [
      { id: narrativeId, display_name: 'Synthetic A', line_count: 1, byte_size: 10, sha256: 'a'.repeat(64) },
      { id: sourceB, display_name: 'Synthetic B', line_count: 1, byte_size: 10, sha256: 'b'.repeat(64) },
    ] });
    if (call.path.endsWith('/lines')) return response({ source: { id: call.path.includes(sourceB) ? sourceB : narrativeId, display_name: 'Synthetic text', sha256: 'c'.repeat(64) }, lines: [{ line_number: 1, text: 'line body', truncated: false }], next_offset: null });
    if (call.path === `/narratives/${narrativeId}/annotations`) return pendingA.promise;
    if (call.path === `/narratives/${sourceB}/annotations`) return response({ current: { revision: 2, source_kind: 'unknown', recording_date: null, audio_review_status: 'not_checked', content_status: 'unconfirmed' }, history: [], next_offset: null });
  });
  const buttons = app.root.querySelectorAll('[data-testid="intake-narratives"] button');
  buttons[0].click(); await tick();
  buttons[1].click(); await tick();
  pendingA.resolve(response({ current: { revision: 99, source_kind: '<img src=x>', recording_date: null, audio_review_status: 'unknown', content_status: 'unconfirmed' }, history: [], next_offset: null }));
  await tick();
  const panel = app.root.querySelector('[data-testid="intake-narrative-annotation"]');
  assert.ok(panel, 'annotation panel exists');
  assert.match(panel.textContent, /2/);
  assert.equal(panel.querySelector('img'), null);
  assert.match(app.root.querySelector('[data-testid="intake-narrative-lines"]').textContent, /line body/);
});

test('annotation GET failure leaves the independently loaded narrative lines readable', async t => {
  const app = await fixture(t, call => {
    if (call.path === '/narratives') return response({ narratives: [{ id: narrativeId, display_name: 'Synthetic text', line_count: 1,
      byte_size: 12, sha256: 'e'.repeat(64), current_annotation: { revision: 4, source_kind: 'user_supplement',
        recording_date: null, audio_review_status: 'operator_claimed_checked', content_status: 'unconfirmed' } }] });
    if (call.path.endsWith('/lines')) return response({ source: { id: narrativeId, display_name: 'Synthetic text', sha256: 'e'.repeat(64) }, lines: [{ line_number: 1, text: 'retained body', truncated: false }], next_offset: null });
    if (call.path.endsWith('/annotations')) return response({ error_code: 'unavailable' }, 503);
  });
  app.root.querySelector('[data-testid="intake-narratives"] button').click(); await tick();
  assert.match(app.root.querySelector('[data-testid="intake-narrative-lines"]').textContent, /retained body/);
  assert.match(app.root.querySelector('[data-intake-annotation-message]').textContent, /暂时不可用/);
  assert.match(app.root.querySelector('[data-intake-annotation-summary]').textContent, /第 4 版/);
  assert.doesNotMatch(app.root.querySelector('[data-intake-annotation-summary]').textContent, /尚未记录/);
  assert.ok(app.root.querySelector('[data-intake-annotation-retry]'));
});

test('annotation history paging preserves drafts and renders returned metadata as text', async t => {
  const app = await fixture(t, call => {
    if (call.path.endsWith('/annotations')) return response({ current: { revision: 2, source_kind: 'user_supplement', recording_date: null, audio_review_status: 'unknown', content_status: 'unconfirmed' },
      history: [{ revision: 1, source_kind: '<img src=x onerror=alert(1)>', recording_date: null, audio_review_status: 'unknown', content_status: 'unconfirmed' }], next_offset: call.query.get('offset') === '0' ? 1 : null });
  });
  app.root.querySelector('[data-testid="intake-narratives"] button').click(); await tick();
  const panel = app.root.querySelector('[data-testid="intake-narrative-annotation"]');
  assert.ok(panel, 'annotation panel exists');
  panel.querySelector('[data-intake-annotation-edit]').click();
  const draft = panel.querySelector('[name="source_kind"]');
  draft.value = 'transcript_excerpt';
  draft.dispatchEvent(new app.window.Event('change', { bubbles: true }));
  panel.querySelector('[data-intake-annotation-history]').click(); await tick();
  const more = [...panel.querySelectorAll('button')].find(button => /后续版本/.test(button.textContent));
  assert.ok(more, 'history can load the next bounded page');
  assert.equal(more.textContent, '载入后续版本');
  more.click(); await tick();
  assert.equal(draft.value, 'transcript_excerpt');
  assert.equal(panel.querySelector('img'), null);
  assert.match(panel.textContent, /用户补充|转写摘录/);
  assert.match(panel.textContent, /录入者表示已核听|未知|未核听/);
  assert.ok(app.calls.some(call => call.path.endsWith('/annotations') && call.query.get('offset') === '1'));
});

test('annotation retries reuse a key, edits rotate it, and stale saves keep the draft', async t => {
  let posts = 0;
  let pendingPost;
  const app = await fixture(t, call => {
    if (call.path.endsWith('/annotations') && call.method === 'GET') return response({ current: null, history: [], next_offset: null });
    if (call.path.endsWith('/annotations') && call.method === 'POST') {
      posts++;
      if (posts === 1) return response({ error_code: 'unavailable' }, 503);
      if (posts === 2) { pendingPost = deferred(); return pendingPost.promise; }
      return response({ error_code: 'stale_annotation' }, 409);
    }
  });
  app.root.querySelector('[data-testid="intake-narratives"] button').click(); await tick();
  const panel = app.root.querySelector('[data-testid="intake-narrative-annotation"]');
  assert.ok(panel, 'annotation form exists');
  const form = panel.querySelector('[data-intake-annotation-form]');
  panel.querySelector('[name="source_kind"]').value = 'user_supplement';
  panel.querySelector('[name="recording_date"]').value = '';
  panel.querySelector('[name="audio_review_status"]').value = 'operator_claimed_checked';
  const submit = () => form.dispatchEvent(new app.window.Event('submit', { cancelable: true }));
  submit(); await tick();
  const first = app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/annotations'))[0];
  submit(); await tick();
  const second = app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/annotations'))[1];
  assert.equal(first.options.headers['Idempotency-Key'], second.options.headers['Idempotency-Key']);
  assert.equal(JSON.parse(second.options.body).recording_date, null);
  assert.equal(JSON.parse(second.options.body).audio_review_status, 'operator_claimed_checked');
  assert.equal(JSON.parse(second.options.body).expected_revision, 0);
  assert.equal(submit(), false);
  assert.equal(posts, 2, 'busy form ignores a repeated submission');
  panel.querySelector('[name="source_kind"]').value = 'secondary_summary_analysis';
  panel.querySelector('[name="source_kind"]').dispatchEvent(new app.window.Event('change', { bubbles: true }));
  pendingPost.resolve(response({ annotation: { revision: 1 }, current: { revision: 1, content_status: 'unconfirmed' } })); await tick();
  assert.equal(panel.querySelector('[name="source_kind"]').value, 'secondary_summary_analysis', 'edits made while saving remain in the form');
  assert.equal(panel.querySelector('[data-intake-annotation-form]').dataset.dirty, 'true');
  submit(); await tick();
  const third = app.calls.filter(call => call.method === 'POST' && call.path.endsWith('/annotations'))[2];
  assert.notEqual(second.options.headers['Idempotency-Key'], third.options.headers['Idempotency-Key']);
  assert.match(panel.textContent, /刷新/);
});

test('source inspection reads the exact frozen cell without leaving the draft', async t => {
  const app = await fixture(t, call => {
    if (call.path.endsWith('/drafts')) {
      const body = result();
      body.revision.source_refs.description = [{ kind: 'source_record', snapshot_id: 'd'.repeat(32), sheet_index: 1, coordinate: 'B56' }];
      return response({ requirement: body });
    }
    if (call.path.startsWith('/previews/')) return response({ rows: [[{ coordinate: 'B56', normalized_value: '<img src=x>', formula: '', raw_value: null }]], images: [] });
  });
  await app.clickCandidate(candidateA);
  app.button('查看原始单元格 B56').click(); await tick();
  const request = app.calls.find(call => call.path.startsWith('/previews/'));
  assert.equal(request.query.get('row_start'), '56');
  assert.equal(request.query.get('col_start'), '2');
  assert.equal(request.query.get('row_count'), '1');
  assert.equal(request.query.get('col_count'), '1');
  assert.equal(app.root.querySelector('[name="description"]').value, 'A');
  const peek = app.root.querySelector('.intake-provenance-peek');
  assert.match(peek.textContent, /<img src=x>/);
  assert.equal(peek.querySelector('img'), null);
});

test('saving another field does not trim unchanged source text', async t => {
  let posted;
  const app = await fixture(t, call => {
    if (call.path.endsWith('/drafts')) {
      const body = result(); body.revision.fields.description = '  Synthetic\r\nsource text  ';
      body.revision.fields.customer_ref = { name: 'Synthetic customer', doctype: 'Customer' };
      return response({ requirement: body });
    }
    if (call.method === 'POST' && call.path.endsWith('/revisions')) { posted = JSON.parse(call.options.body); return response(result()); }
  });
  await app.clickCandidate(candidateA);
  const input = app.root.querySelector('[name="quantity"]'); input.value = '77';
  input.closest('form').dispatchEvent(new app.window.Event('submit', { cancelable: true })); await tick();
  assert.deepEqual(posted.fields, { quantity: '77' });
});

test('unsaved fields cannot confirm an older value that differs from the visible form', async t => {
  const app = await fixture(t);
  await app.clickCandidate(candidateA);
  const input = app.root.querySelector('[name="quantity"]'); input.value = '77';
  input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(app.button('确认此版本').disabled, true);
  assert.match(app.root.querySelector('[data-unsaved-requirement]').textContent, /未保存/);
  input.value = '50'; input.dispatchEvent(new app.window.Event('input', { bubbles: true }));
  assert.equal(app.button('确认此版本').disabled, false);
});
