import assert from 'node:assert/strict'
import test from 'node:test'
import { createNativeAiWebAskController, NativeAiWebAskError } from './ask.ts'

function fixture({ snapshots = [], onSend, initial = {} } = {}) {
  let index = 0
  const sent = []
  const adapter = {
    provider: 'fixture-site',
    origin: 'https://fixture.invalid',
    async inspect() {
      if (snapshots.length) return snapshots[Math.min(index++, snapshots.length - 1)]
      return { open: true, loggedIn: true, inputAvailable: true, answerAvailable: true,
        draftText: '', attachmentCount: 0, messages: [], ...initial }
    },
    async send(question) {
      sent.push(question)
      return onSend ? onSend(question, sent.length) : { turnId: `turn-${sent.length}` }
    },
  }
  return { adapter, sent }
}

const state = (messages = [], overrides = {}) => ({ open: true, loggedIn: true,
  inputAvailable: true, answerAvailable: true, draftText: '', attachmentCount: 0, messages, ...overrides })

test('同站询问串行，且仅返回关联到本次 turnId 的新回答', async () => {
  const { adapter, sent } = fixture()
  let seq = 0
  let turn = 0
  adapter.send = async question => { sent.push(question); turn++; return { turnId: `turn-${turn}` } }
  adapter.inspect = async () => {
    seq++
    if (turn > 1) return state([
      { id: 'second-answer', role: 'assistant', text: '第二次回答', turnId: 'turn-2', generating: false },
    ])
    if (seq < 4) return state([
      { id: 'old-answer', role: 'assistant', text: '旧历史回答', turnId: 'old-turn' },
    ])
    if (seq < 6) return state([
      { id: 'old-answer', role: 'assistant', text: '旧历史回答', turnId: 'old-turn' },
      { id: 'new-answer', role: 'assistant', text: '新回答', turnId: 'turn-1', generating: true },
    ])
    return state([
      { id: 'old-answer', role: 'assistant', text: '旧历史回答', turnId: 'old-turn' },
      { id: 'new-answer', role: 'assistant', text: '新回答', turnId: 'turn-1', generating: false },
    ])
  }
  const controller = createNativeAiWebAskController(adapter)
  const phases = []
  const first = controller.ask(' first ', { stableMs: 15, pollMs: 3, onPhase: p => phases.push(p) })
  const second = controller.ask('second', { stableMs: 0, pollMs: 2 })
  const result = await first
  assert.equal(result.text, '新回答')
  assert.equal(result.answerMessageId, 'new-answer')
  assert.equal(result.provider, 'fixture-site')
  assert.equal(result.origin, 'https://fixture.invalid')
  assert.ok(phases.indexOf('first-chunk') < phases.indexOf('completed'))
  await second
  assert.deepEqual(sent, ['first', 'second'])
})

test('已有草稿或附件时拒绝且不调用发送 adapter', async () => {
  for (const overrides of [{ draftText: '用户正在写的草稿' }, { attachmentCount: 1 }]) {
    const { adapter, sent } = fixture({ initial: overrides })
    const controller = createNativeAiWebAskController(adapter)
    await assert.rejects(controller.ask('不要覆盖'), error =>
      error instanceof NativeAiWebAskError && ['draft-present', 'attachments-present'].includes(error.code))
    assert.equal(sent.length, 0)
  }
})

test('生成中不算完成；窗口关闭明确失败', async () => {
  let observations = 0
  const { adapter } = fixture()
  adapter.inspect = async () => {
    observations++
    if (observations < 3) return state([])
    if (observations < 5) return state([{ id: 'a', role: 'assistant', text: '部分', turnId: 'turn-1', generating: true }])
    return state([], { open: false })
  }
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('问题', { pollMs: 2, timeoutMs: 500 }), error =>
    error instanceof NativeAiWebAskError && error.code === 'window-closed')
})

test('取消与超时均可区分', async () => {
  const cancelled = new AbortController()
  const { adapter } = fixture()
  adapter.inspect = async () => state([])
  const controller = createNativeAiWebAskController(adapter)
  const cancelPromise = controller.ask('取消', { signal: cancelled.signal, pollMs: 2, timeoutMs: 500 })
  setTimeout(() => cancelled.abort(), 8)
  await assert.rejects(cancelPromise, error => error instanceof NativeAiWebAskError && error.code === 'cancelled')
  await assert.rejects(controller.ask('超时', { pollMs: 2, timeoutMs: 15 }), error =>
    error instanceof NativeAiWebAskError && error.code === 'timeout')
})

test('首段已出现但内容仍变化时继续等待稳定', async () => {
  let index = 0
  const { adapter } = fixture()
  adapter.inspect = async () => {
    index++
    if (index <= 2) return state([])
    const text = index < 4 ? '第一段' : '第一段，完整回答'
    return state([{ id: 'answer-1', role: 'assistant', text, turnId: 'turn-1', generating: index < 4 }])
  }
  const controller = createNativeAiWebAskController(adapter)
  const phases = []
  const result = await controller.ask('内容', { stableMs: 8, pollMs: 2, onPhase: p => { phases.push(p); throw new Error('observer secret') } })
  assert.equal(result.text, '第一段，完整回答')
  assert.equal(phases.filter(p => p === 'first-chunk').length, 1)
})

test('悬挂的只读 inspect 受 deadline 截止，且下一条可以继续', async () => {
  let calls = 0
  const { adapter } = fixture()
  adapter.inspect = async () => {
    calls++
    if (calls === 1) return new Promise(() => {})
    return state([])
  }
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('first', { timeoutMs: 25 }), e => e.code === 'timeout')
  // First inspect is read-only; its abandoned operation cannot trigger a send.
  await assert.rejects(controller.ask('second', { timeoutMs: 20 }), e => e.code === 'timeout')
  assert.equal(calls, 4)
})

test('悬挂 send 超时后保留站点锁，直到 send 结束才允许下一次发送', async () => {
  let release
  const sent = []
  const { adapter } = fixture()
  adapter.send = async (question, signal) => {
    sent.push(question)
    if (question === 'first') {
      await new Promise(resolve => { release = resolve })
      return { turnId: 'turn-1' }
    }
    return { turnId: 'turn-2' }
  }
  adapter.inspect = async () => state([])
  const controller = createNativeAiWebAskController(adapter)
  const first = controller.ask('first', { timeoutMs: 20 })
  await assert.rejects(first, e => e.code === 'timeout')
  const second = controller.ask('second', { timeoutMs: 100 })
  await new Promise(resolve => setTimeout(resolve, 15))
  assert.deepEqual(sent, ['first'])
  release()
  await assert.rejects(second, e => e.code === 'first-chunk-timeout' || e.code === 'timeout')
  assert.deepEqual(sent, ['first', 'second'])
})

test('排队时取消立即返回，且取消项不会在之后发送', async () => {
  let release
  const sent = []
  const { adapter } = fixture()
  adapter.send = async question => {
    sent.push(question)
    if (question === 'first') await new Promise(resolve => { release = resolve })
    return { turnId: `turn-${sent.length}` }
  }
  adapter.inspect = async () => state([])
  const controller = createNativeAiWebAskController(adapter)
  const first = controller.ask('first', { timeoutMs: 500 })
  await new Promise(resolve => setTimeout(resolve, 5))
  const abort = new AbortController()
  const queued = controller.ask('queued', { signal: abort.signal })
  abort.abort()
  await assert.rejects(queued, e => e.code === 'cancelled')
  release()
  await assert.rejects(first, e => e.code === 'first-chunk-timeout' || e.code === 'timeout')
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.deepEqual(sent, ['first'])
})

test('generating 未知或 true 都不视为完成，超时需区分首段期限', async () => {
  for (const generating of [undefined, true]) {
    let count = 0
    const { adapter } = fixture()
    adapter.inspect = async () => {
      if (++count <= 2) return state([])
      return state([{ id: 'a', role: 'assistant', text: '停住但未确认完成', turnId: 'turn-1', generating }])
    }
    const controller = createNativeAiWebAskController(adapter)
    await assert.rejects(controller.ask('问题', { timeoutMs: 30, firstChunkTimeoutMs: 20, pollMs: 2 }), e =>
      e.code === 'timeout')
  }
  let inspections = 0
  const { adapter } = fixture()
  adapter.inspect = async () => { inspections++; return state([]) }
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('无首段', { timeoutMs: 100, firstChunkTimeoutMs: 15, pollMs: 2 }), e =>
    e.code === 'first-chunk-timeout')
})

test('拒绝基线里已存在的 turnId 和旧回答行', async () => {
  const { adapter } = fixture()
  let count = 0
  adapter.inspect = async () => {
    count++
    return state([{ id: 'old-answer', role: 'assistant', text: '历史', turnId: 'old-turn', generating: false }])
  }
  adapter.send = async () => ({ turnId: 'old-turn', userMessageId: 'old-user' })
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('问题'), e => e.code === 'send-failed')
  assert.equal(count, 2)
})

test('空白草稿也是用户内容；提交前重新读取草稿', async () => {
  let count = 0
  const { adapter, sent } = fixture()
  adapter.inspect = async () => state([], { draftText: ++count === 1 ? '' : '   ' })
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('问题'), e => e.code === 'draft-present')
  assert.equal(sent.length, 0)
})

test('adapter 和阶段回调异常不泄露原始错误信息', async () => {
  const { adapter } = fixture()
  adapter.inspect = async () => { throw new Error('C:\\private\\profile\\secret token') }
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('问题'), e => e.code === 'adapter-failed'
    && !e.message.includes('private') && !e.message.includes('secret'))
})

test('参数使用整型上限，答案长度超限明确失败', async () => {
  const { adapter } = fixture()
  const controller = createNativeAiWebAskController(adapter)
  await assert.rejects(controller.ask('小数', { timeoutMs: 1.5 }), e => e.code === 'invalid-request')
  await assert.rejects(controller.ask('超时', { timeoutMs: 600_001 }), e => e.code === 'invalid-request')
  await assert.rejects(controller.ask('x'.repeat(60_001)), e => e.code === 'invalid-request')

  let reads = 0
  adapter.inspect = async () => {
    reads++
    if (reads <= 2) return state([])
    return state([{ id: 'answer', role: 'assistant', text: 'long answer', turnId: 'turn-1', generating: false }])
  }
  await assert.rejects(controller.ask('cap', { maxAnswerChars: 4, pollMs: 1 }), e => e.code === 'answer-too-long')
})
