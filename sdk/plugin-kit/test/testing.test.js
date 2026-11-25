import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createTestHost } from '../lib/testing.js'

const pkg = (dshGo) => ({ name: 'demo', version: '1.0.0', dshGo })

const manifest = {
  v: 1,
  title: { zh: '演示', en: 'Demo' },
  wants: ['clipboard'],
  contributes: {
    'composer.actions': [
      { id: 'static', label: '静态', effect: { type: 'insert', text: 'hi' } },
      { id: 'dyn', label: '动态' },
    ],
    'composer.strip': [{ id: 'line', panel: 'main' }],
    panels: [{ id: 'main', title: '面板' }],
  },
}

test('newer places: tools, chat actions and turn notes run as the bridge does', async () => {
  const host = createTestHost({
    pkg: pkg({
      v: 1,
      wants: ['draft'],
      contributes: {
        panels: [{ id: 'main', title: '面板', presentation: 'sheet', placement: ['plugin'] }],
        'composer.tools': [{ id: 'open', label: '打开', panel: 'main' }, { id: 'count', label: '数字' }],
        'session.actions': [{ id: 'export', label: '导出' }],
        'turn.note': [{ id: 'cost' }],
      },
    }),
    dir: '/nonexistent',
  })
  host.ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('main', { view: { type: 'text', text: 'x' } })
    ctx.dshGo.on('count', (scope) => ({ toast: scope.draft }))
    ctx.dshGo.on('export', (scope) => ({ toast: scope.sessionId }))
    ctx.dshGo.turnNote('cost', (scope, emit) => {
      emit({ 1: { text: '一二三四五六七八九十一二三四五六七', tone: 'good' }, 2: { text: ' ' }, 3: 'junk' })
      return () => {}
    })
  })
  const row = host.contributions()
  assert.deepEqual(row.issues, [])
  assert.deepEqual(row.contributes['composer.tools'][0].effect, [{ type: 'open', page: 'panel:main' }])
  assert.equal(row.contributes.panels[0].presentation, 'sheet')
  assert.deepEqual(row.contributes.panels[0].placement, ['plugin'])
  assert.deepEqual(row.contributes['turn.note'], [{ id: 'cost', ready: true }])
  const count = await host.invoke('count', { surface: 'composer.tools', context: { draft: '草稿' } })
  assert.equal(count.effects[0].text, '草稿')
  const exported = await host.invoke('export', { surface: 'session.actions', scope: { sessionId: 's1' } })
  assert.equal(exported.effects[0].text, 's1')
  const feed = host.subscribe('cost', { sessionId: 's1' })
  assert.deepEqual(feed.data, { 1: { text: '一二三四五六七八九十一二三四五六', tone: 'good' } })
  feed.stop()
})

test('an app without a newer placement gets the panel where it can draw it', () => {
  const host = createTestHost({
    pkg: pkg({ v: 1, contributes: { panels: [{ id: 'main', title: '面板', view: undefined, placement: ['plugin'] }] } }),
    dir: '/nonexistent',
  })
  const row = host.contributions({ surfaces: ['panels'] })
  assert.deepEqual(row.contributes.panels[0].placement, ['session.tab'])
})

test('ready flags and runtime issues follow registrations', () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  let row = host.contributions()
  assert.deepEqual(row.issues.map((i) => [i.path, i.code]), [
    ['/dshGo/contributes/composer.actions/1', 'no-handler'],
    ['/dshGo/contributes/panels/0', 'no-handler'],
  ])
  host.ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('dyn', () => ({ toast: 'ok' }))
    ctx.dshGo.panel('main', { view: { type: 'text', text: 'x' } })
    ctx.dshGo.on('nope', () => {})
  })
  row = host.contributions()
  assert.deepEqual(row.issues.map((i) => [i.path, i.code]), [['/runtime/nope', 'undeclared']])
  assert.equal(row.contributes['composer.actions'][1].ready, true)
})

test('invoke: shorthand expands, bad effects are dropped with an issue, errors carry status', async () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.on('dyn', (scope) => ({ insert: scope.clipboard, link: 'http://insecure.example' }))
  })
  const r = await host.invoke('dyn', { context: { clipboard: 'abc', draft: 'dropped' } })
  assert.deepEqual(r.effects, [{ type: 'insert', text: 'abc' }])
  assert.equal(r.issues[0].code, 'bad-effect')
  await assert.rejects(host.invoke('static'), { status: 409, code: 'no-handler' })
  await assert.rejects(host.invoke('missing'), { status: 404 })
})

test('a throwing handler is a 500 plugin-error and a violation', async () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.on('dyn', () => { throw new Error('boom') }))
  await assert.rejects(host.invoke('dyn'), { status: 500, code: 'plugin-error' })
  assert.equal(host.violations.length, 1)
})

test('subscribe: strip values are cleaned like the bridge does', () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.strip('line', (_s, emit) => {
    emit({ text: '一二三四五六七八九十一二三四五六七八九十一二三四五六', tone: 'loud', icon: 'BAD' })
  }))
  const feed = host.subscribe('line')
  assert.deepEqual(feed.data, { text: '一二三四五六七八九十一二三四五六七八九十一二三四' })
})

test('view: static object or function, with stats', async () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.panel('main', { view: (scope, caps) => ({ type: 'text', text: `${scope.sessionId} ${caps.locale}` }) }))
  const r = await host.view('main', { sessionId: 's' })
  assert.deepEqual(r.view, { type: 'text', text: 's zh-CN' })
  assert.deepEqual(r.stats, { bytes: 32, nodes: 1, depth: 1 })
})

test('deferred results: pending at once, done later, only the deferred whitelist', async () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.on('dyn', (scope) => ({
    pending: { label: '处理中', timeoutMs: 999_999 },
    result: async () => [{ insert: scope.clipboard }, { type: 'command', name: 'compact' }],
  })))
  const r = await host.invoke('dyn', { context: { clipboard: 'abc' } })
  assert.deepEqual(r.effects, [])
  assert.deepEqual({ label: r.pending.label, timeoutMs: r.pending.timeoutMs }, { label: '处理中', timeoutMs: 60000 }, 'timeout clamped to 60 s')
  const settled = await r.settled
  assert.equal(settled.t, 'done')
  assert.deepEqual(settled.effects, [{ type: 'insert', text: 'abc' }])
  assert.match(settled.issues[0].message, /not allowed in a deferred result/)
})

test('deferred results: timeout aborts the work; at most 2 pending', async () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent' })
  let aborted = 0
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.on('dyn', () => ({
    pending: { timeoutMs: 1000 },
    result: (signal) => new Promise((resolve) => signal.addEventListener('abort', () => { aborted++; resolve({ toast: 'late' }) })),
  })))
  const a = await host.invoke('dyn')
  await host.invoke('dyn')
  await assert.rejects(host.invoke('dyn'), { status: 429, code: 'too-many-pending' })
  assert.deepEqual(await a.settled, { t: 'void', reason: 'timeout' })
  host.dispose()
  assert.equal(aborted, 2)
})

test('strip and panel data functions get caps with the locale', () => {
  const host = createTestHost({ pkg: pkg(manifest), dir: '/nonexistent', caps: { locale: 'en-US' } })
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.strip('line', (_s, emit, caps) => emit({ text: caps.locale })))
  assert.deepEqual(host.subscribe('line').data, { text: 'en-US' })
})

test('turn notes come out as the bridge cleans them', () => {
  const host = createTestHost({ pkg: pkg({ v: 1, contributes: { 'turn.note': [{ id: 'cost' }] } }), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.turnNote('cost', (_s, emit) => {
    emit({ 1: { text: '  一\u2028二\u0085  三 ' } })
    return () => {}
  }))
  assert.deepEqual(host.subscribe('cost', { sessionId: 's' }).data, { 1: { text: '一 二 三' } })
})

test('subscribe goes by what the manifest says an id is', () => {
  const host = createTestHost({ pkg: pkg({ v: 1, contributes: { panels: [{ id: 'main', title: '面板' }] } }), dir: '/nonexistent' })
  host.ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.panel('main', { view: { type: 'text', text: 'x' }, data: (_s, emit) => { emit({ from: 'panel' }); return () => {} } })
    ctx.dshGo.turnNote('main', (_s, emit) => { emit({ 1: { text: 'note' } }); return () => {} })
  })
  assert.deepEqual(host.subscribe('main').data, { from: 'panel' })
})

test('an async data function: its late cleanup still runs, its failure is recorded', async () => {
  const host = createTestHost({ pkg: pkg({ v: 1, contributes: { 'turn.note': [{ id: 'slow' }], 'composer.strip': [{ id: 'bad' }] } }), dir: '/nonexistent' })
  let cleaned = 0
  let emitLate
  host.ctx.inject(['dshGo'], (ctx) => {
    ctx.dshGo.turnNote('slow', async (_s, emit) => {
      await null
      emitLate = emit
      return () => { cleaned++ }
    })
    ctx.dshGo.strip('bad', async () => { throw new Error('boom') })
  })
  const slow = host.subscribe('slow', { sessionId: 's' })
  slow.stop()
  await slow.settled
  assert.equal(cleaned, 1)
  emitLate({ 1: { text: 'x' } })
  assert.deepEqual(slow.history, [], 'nothing after stop')
  const bad = host.subscribe('bad')
  await bad.settled
  assert.deepEqual(bad.errors, ['boom'])
})

test('removing a registration ends its feeds, as the bridge does', () => {
  const host = createTestHost({ pkg: pkg({ v: 1, contributes: { 'turn.note': [{ id: 'note' }], 'composer.strip': [{ id: 'line' }], panels: [{ id: 'main', title: '面板' }] } }), dir: '/nonexistent' })
  const cleaned = []
  const emits = {}
  const data = (id) => (_s, emit) => {
    emits[id] = emit
    return () => { cleaned.push(id) }
  }
  const dispose = {}
  host.ctx.inject(['dshGo'], (ctx) => {
    dispose.note = ctx.dshGo.turnNote('note', data('note'))
    dispose.line = ctx.dshGo.strip('line', data('line'))
    dispose.main = ctx.dshGo.panel('main', { view: { type: 'text', text: 'x' }, data: data('main') })
  })
  const feeds = { note: host.subscribe('note'), line: host.subscribe('line'), main: host.subscribe('main') }
  for (const id of ['note', 'line', 'main']) {
    dispose[id]()
    assert.ok(cleaned.includes(id), id)
    emits[id](id === 'note' ? { 1: { text: 'late' } } : { text: 'late' })
    assert.deepEqual(feeds[id].history, [], `${id}: nothing after removal`)
  }
  dispose.note()
  assert.equal(cleaned.length, 3, 'a second dispose does nothing')
})

test('replacing a registration ends the old feed; the old disposer leaves the new one alone', () => {
  const host = createTestHost({ pkg: pkg({ v: 1, contributes: { 'turn.note': [{ id: 'note' }] } }), dir: '/nonexistent' })
  const cleaned = []
  const data = (name) => () => () => { cleaned.push(name) }
  let first
  host.ctx.inject(['dshGo'], (ctx) => {
    first = ctx.dshGo.turnNote('note', data('first'))
    host.subscribe('note')
    ctx.dshGo.turnNote('note', data('second'))
    assert.deepEqual(cleaned, ['first'])
    const second = host.subscribe('note')
    first()
    assert.deepEqual(cleaned, ['first'], 'the second registration and its feed are still there')
    assert.deepEqual(host.registrations().notes, ['note'])
    second.stop()
    assert.deepEqual(cleaned, ['first', 'second'])
  })
})

test('a cleanup that fails is recorded, however it fails', async () => {
  const subscribe = (data) => {
    const host = createTestHost({ pkg: pkg({ v: 1, contributes: { 'turn.note': [{ id: 'note' }] } }), dir: '/nonexistent' })
    host.ctx.inject(['dshGo'], (ctx) => ctx.dshGo.turnNote('note', data))
    return host.subscribe('note')
  }
  const tick = () => new Promise((done) => setImmediate(done))
  const throws = subscribe(() => () => { throw new Error('thrown') })
  throws.stop()
  assert.deepEqual(throws.errors, ['thrown'])
  const rejects = subscribe(() => async () => { throw new Error('rejected') })
  rejects.stop()
  await tick()
  assert.deepEqual(rejects.errors, ['rejected'])
  const late = subscribe(async () => async () => { throw new Error('late') })
  late.stop()
  await late.settled
  await tick()
  assert.deepEqual(late.errors, ['late'])
})
