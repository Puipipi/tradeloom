// Runs the plugin against the plugin-kit test host (the bridge's own manifest and effect code),
// so these are the answers the app would get.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createTestHost } from '../../../../sdk/plugin-kit/lib/testing.js'
import { apply } from '../lib/index.js'
import { createReadings } from '../lib/reading.js'
import { captionAt, plan, plainText, synthesize } from '../lib/speech.js'

const dir = fileURLToPath(new URL('..', import.meta.url))
const ALL = ['audio', 'voice', 'micro', 'overlay']
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function host(features = ALL) {
  const h = createTestHost({ dir, caps: { features } })
  apply(h.ctx)
  return h
}

test('manifest: one reply action that needs audio; everything declared, no issues', () => {
  const row = host().contributions()
  assert.equal(row.state, 'ok')
  assert.deepEqual(row.issues, [])
  assert.deepEqual(row.capabilities, ALL)
  assert.deepEqual(row.contributes['message.actions'].map((a) => [a.id, a.label, a.ready, a.requires]), [['read', '朗读', true, ['audio']]])
  assert.deepEqual(row.contributes.overlays, [{ id: 'subtitle', channel: 'caption' }])
  assert.equal(host().contributions({ locale: 'en' }).contributes['message.actions'][0].label, 'Read aloud')
})

test('an app without audio never shows 朗读 and cannot invoke it', async () => {
  const h = host([])
  assert.equal(h.contributions().contributes['message.actions'][0].ready, false)
  await assert.rejects(h.invoke('read', { context: { message: '你好' } }), { status: 409, code: 'unsupported' })
})

test('朗读: play, listen and caption on one instance; the clip is a WAV of the reply', async () => {
  const h = host()
  const { effects, issues } = await h.invoke('read', { context: { message: '## 结论\n\n今天**天气**不错，适合出门。' }, scope: { sessionId: 's1' } })
  assert.deepEqual(issues, [])
  assert.deepEqual(effects.map((e) => [e.type, e.op, e.instance]), [
    ['audio', 'play', 'reading'],
    ['voice', 'start', 'reading'],
    ['overlay', 'show', 'reading'],
  ])
  const clip = await h.media('speech', { sessionId: 's1' }, { key: effects[0].key })
  assert.equal(clip.contentType, 'audio/wav')
  assert.equal(clip.body.subarray(0, 4).toString(), 'RIFF')
  await assert.rejects(h.media('speech', { sessionId: 's1' }, { key: 'someone-else' }))
  const empty = await h.invoke('read', { context: { message: '```js\nx\n```' }, scope: { sessionId: 's1' } })
  assert.deepEqual(empty.effects, [{ type: 'toast', text: '这条回复没有可读的文字' }])
})

test('the caption follows the sound, stops when the person speaks, and idles without a timer', async () => {
  let t = 1000
  const readings = createReadings({ now: () => t, lead: 0 })
  const shown = []
  const key = readings.begin({ sessionId: 's1' }, '你好，世界。再见！')
  const cancel = readings.watch({ sessionId: 's1' }, (v) => shown.push(v))
  assert.equal(readings.ticking(), false, 'nothing ticks before the sound starts')
  assert.ok(readings.clip({ sessionId: 's1' }, key))
  assert.equal(readings.ticking(), true)
  t += 230
  await sleep(120)
  assert.equal(shown.at(-1).text, '你好，')
  readings.end({ sessionId: 's1' }) // voice.speechStart
  assert.equal(readings.ticking(), false)
  const count = shown.length
  t += 1000
  await sleep(150)
  assert.equal(shown.length, count, 'no caption after the stop')
  cancel()
})

test('speech plan and caption', () => {
  assert.equal(plainText('看 [文档](https://x) 和 `code`\n> 引用'), '看 文档 和 code 引用')
  const p = plan('一二三，四五。')
  assert.deepEqual(p.clauses.map((c) => c.text), ['一二三，', '四五。'])
  assert.deepEqual(captionAt(p, 0), { text: '一', progress: 0 })
  assert.equal(captionAt(p, p.clauses[1].start + 10).text, '四')
  assert.equal(captionAt(p, p.duration).progress, 1)
  const long = plan('字'.repeat(500))
  assert.ok(long.duration < 16000, `capped at ${long.duration} ms`)
  const wav = synthesize(plan('你好'))
  assert.equal(wav.readUInt32LE(24), 16000)
  assert.ok(wav.length < 16 * 1024 * 1024)
})

test('capability events end the reading; their return values are never effects', async () => {
  const h = host()
  const { effects } = await h.invoke('read', { context: { message: '一句话。' }, scope: { sessionId: 's2' } })
  await h.media('speech', { sessionId: 's2' }, { key: effects[0].key })
  assert.equal(await h.capabilityEvent({ sessionId: 's2' }, { instance: 'reading', event: 'voice.speechStart', seq: 1 }), undefined)
  const feed = h.subscribeMicro('caption', { sessionId: 's2' })
  await sleep(150)
  assert.equal(feed.history.length, 0, 'a stopped reading shows no caption')
  feed.stop()
  h.dispose()
})
