// Type-level test: compiled with tsc --noEmit by test/sync.test.js.
import { stack, row, metric, chart, list, keyValue, progress, table, actions, image, text, callout, confirm, options, bind, action, toolCard, localize, adaptView, effects, type View, type DshGoService, type InvokeHandler, type Manifest } from '../../types/index.js'
import { createTestHost } from '../../types/testing.js'

const view: View = stack([
  row([metric({ label: '本对话', value: bind('data.session'), tone: 'good' }), metric({ label: '今日', value: 12 })]),
  chart({ kind: 'bar', categories: ['a', 'b'], series: [{ name: 'x', values: [1, null] }], unit: '元' }),
  list([{ title: 'deepseek-chat', trailing: '12k', icon: 'robot', action: action('open', { row: 1 }) }]),
  keyValue([['输入', '1.2k'], ['输出', bind('data.out')]]),
  progress(42, { label: '额度' }),
  table({ columns: ['名称', { label: '金额', align: 'end' }], rows: [['a', 1], ['b', null]] }),
  actions([{ label: '刷新', action: 'refresh', style: 'primary' }]),
  image('asset:icons/a.png', { aspect: 1.5 }),
  text('数据：Open-Meteo', { tone: 'muted' }),
  callout('注意', { tone: 'warn' }),
  options({ id: 'pick', options: [{ label: 'A', value: 'a' }, 'B'] }),
  confirm('go', { confirmLabel: '开始' }),
], { title: '用量' })

// @ts-expect-error unknown component type
const bad: View = { type: 'gauge', value: 1 }
// @ts-expect-error tone outside the whitelist
metric({ label: 'x', value: 1, tone: 'red' })

const card = toolCard((_args: { city: string }, value: { t: number }) => stack([metric({ label: 'T', value: value.t })]))
const meta: Record<string, unknown> = card({ city: 'x' }, { t: 1 })

const manifest: Manifest = {
  v: 1,
  title: { zh: '快捷', en: 'Quick' },
  wants: ['clipboard'],
  contributes: {
    'composer.actions': [{ id: 'summarize', label: '总结', effect: { type: 'insert', text: '总结' } }],
    panels: [{ id: 'usage', title: '用量', placement: ['session.tab'] }],
  },
}

const handler: InvokeHandler = (scope, event) => (scope.clipboard ? { insert: scope.clipboard } : [effects.toast(event.locale)])

declare const dshGo: DshGoService
dshGo.on('translate', handler)
dshGo.panel('usage', { view: (scope, caps) => adaptView(view as any, caps)!, data: (_scope, emit) => { emit({ a: 1 }); return () => {} } })
dshGo.strip('today', (_scope, emit) => emit({ text: '今日 12k', tone: 'muted' }))

const host = createTestHost({ dir: '.' })
void host.invoke('translate', { context: { clipboard: 'x' } }).then((r) => r.effects.map((e) => e.type))
const started: Promise<void> = host.subscribe('today').settled
const microStarted: Promise<void> = host.subscribeMicro('caption').settled
void started
void microStarted
void localize('en-US', { zh: '用量', en: 'Usage' })
void bad
void meta
void manifest

const slow: InvokeHandler = (scope) => effects.deferred(async (signal) => {
  signal.throwIfAborted()
  return { insert: scope.clipboard ?? '' }
}, { label: '正在翻译' })
const literal: InvokeHandler = () => ({ pending: true, result: Promise.resolve([effects.copy('x'), { toast: '已复制' }]) })
// @ts-expect-error command is not allowed in a deferred result
const badDeferred: InvokeHandler = () => ({ pending: true, result: Promise.resolve(effects.command('compact')) })
void slow
void literal
void badDeferred

import { checkView as check, checkPlugin, SchemaSet } from '../../types/check.js'
const vc = check({ type: 'text', text: 'x' }, { budget: 'toolCard' })
const fatal: boolean = vc.fatal
void fatal
void checkPlugin('.', { load: true }).then((r) => r.views.length)
void new SchemaSet().validate({}, 'view.schema.json')

// v1.2 additions remain opt-in; static/deferred effects do not gain audio.
import type { DshGoService as VoiceService, Effect as VoiceEffect, DeferredEffect as VoiceDeferred } from '../../types/index.js'
declare const voiceService: VoiceService
voiceService.media('clip', (scope, event) => { event.signal.throwIfAborted(); return { body: new Uint8Array([1]), contentType: 'audio/wav' } })
voiceService.micro('caption', { data(scope, emit) { emit({ text: 'hello', progress: 0.5 }); return () => {} } })
voiceService.onCapability((scope, event) => { const sequence: number = event.seq; void sequence })
const playVoice: VoiceEffect = { type: 'audio', op: 'play', instance: 'one', src: 'media:clip' }
// @ts-expect-error play must identify its declared media source
const badPlayVoice: VoiceEffect = { type: 'audio', op: 'play', instance: 'one' }
// @ts-expect-error audio cannot be a v1.1 deferred result
const deferredVoice: VoiceDeferred = { type: 'audio', op: 'play', instance: 'one', src: 'media:clip' }
void playVoice; void badPlayVoice; void deferredVoice
