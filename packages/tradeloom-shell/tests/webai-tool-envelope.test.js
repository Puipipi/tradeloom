import assert from 'node:assert/strict'
import test from 'node:test'
import { createWebAiFileTools } from '../webai-file-tools.js'
import { createWebAiToolEnvelope } from '../webai-tool-envelope.js'

function memoryFileTools() {
  const files = new Map()
  let writes = 0
  const root = Object.freeze({ root: true })
  const fs = {
    resolve: async (path, { cwd } = {}) => path === '/approved' ? root : cwd ? `${cwd}/${path}` : path,
    processPath: target => target === root ? '/approved' : target,
    contains: (base, target) => base === root && (target === root || typeof target === 'string' && !target.startsWith('../')),
    stat: async target => target === root ? { type: 'directory', size: 0 } : files.has(target) ? { type: 'file', size: Buffer.byteLength(files.get(target)) } : null,
    lstat: async (path, { cwd } = {}) => {
      const target = `${cwd}/${path}`
      return files.has(target) ? { type: 'file', size: Buffer.byteLength(files.get(target)) } : null
    },
    readBytes: async target => Buffer.from(files.get(target) ?? ''),
    writeText: async (target, content, options) => {
      assert.deepEqual(options, { kind: 'createIfAbsent' })
      writes++
      if (files.has(target)) return { operation: 'exists' }
      files.set(target, content)
      return { operation: 'create' }
    },
    listDirBounded: async target => target === root
      ? [...files.entries()].map(([name, content]) => ({ name: name.slice('/approved/'.length), type: 'file', size: Buffer.byteLength(content) }))
      : [],
  }
  return { files, fs, get writes() { return writes } }
}

function assistantObservation(messageId, content, overrides = {}) {
  return {
    source: 'native-assistant-observation',
    role: 'assistant',
    isNew: true,
    // Supplied by the trusted native observer, never read from envelope JSON.
    complete: true,
    messageId,
    conversationId: 'conversation-a',
    taskNonce: 'nonce-a',
    content,
    ...overrides,
  }
}

const envelope = (overrides = {}) => JSON.stringify({
  version: 1,
  kind: 'tradeloom-file-task',
  taskId: 'task-a',
  requestId: 'request-a',
  op: 'write_new',
  path: 'note.txt',
  content: 'hello',
  ...overrides,
})

async function fixture({ isCurrent = () => true } = {}) {
  const memory = memoryFileTools()
  const fileTools = createWebAiFileTools({ fs: memory.fs })
  const grant = await fileTools.issueGrant({ providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a', root: '/approved' })
  const bridge = createWebAiToolEnvelope({ fileTools })
  const capability = bridge.issueTask({
    taskId: 'task-a', taskNonce: 'nonce-a', providerId: 'deepseek', windowId: 'window-a',
    conversationId: 'conversation-a', grant,
    nativeContext: { providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a' },
    isCurrent,
  })
  return { memory, fileTools, grant, bridge, capability }
}

test('整个新 assistant 消息中的受限 envelope 只执行一次 write_new，重渲染与新 message 不重复 I/O', async () => {
  const f = await fixture()
  const first = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-1', envelope()))
  const rerender = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-1', envelope()))
  const repeatedInNewMessage = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-2', envelope()))

  assert.equal(first.status, 'completed')
  assert.equal(first.source, 'native-assistant-observation')
  assert.equal(first.requestId, 'request-a')
  assert.equal(rerender.status, 'duplicate-message')
  assert.equal(repeatedInNewMessage.status, 'completed')
  assert.deepEqual(repeatedInNewMessage.result, first.result)
  assert.equal(f.memory.writes, 1)
  assert.equal(f.memory.files.get('/approved/note.txt'), 'hello')
})

test('list/read/write_new 通过同一现有 executor；响应保留操作与requestId', async () => {
  const f = await fixture()
  f.memory.files.set('/approved/readme.txt', 'ready')
  const listRequest = { version: 1, kind: 'tradeloom-file-task', taskId: 'task-a', requestId: 'list-1', op: 'list', path: '.' }
  const readRequest = { version: 1, kind: 'tradeloom-file-task', taskId: 'task-a', requestId: 'read-1', op: 'read', path: 'readme.txt' }
  const listResult = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('list-msg', JSON.stringify(listRequest)))
  const readResult = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('read-msg', JSON.stringify(readRequest)))
  assert.deepEqual(listResult.result, { ok: true, entries: [{ name: 'readme.txt', type: 'file', size: 5 }] })
  assert.deepEqual(readResult.result, { ok: true, content: 'ready' })
  assert.equal(listResult.operation, 'list')
  assert.equal(readResult.requestId, 'read-1')
})

test('仅解析完整消息或单一 JSON 围栏；不从正文引文、旧消息或用户消息抽取对象', async () => {
  const f = await fixture()
  const quoted = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-quoted', `Example only: ${envelope()}`))
  const old = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-old', envelope(), { isNew: false }))
  const user = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-user', envelope(), { role: 'user' }))
  const fenced = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-fenced', `\n\`\`\`json\n${envelope()}\n\`\`\`\n`))
  assert.equal(quoted.status, 'rejected')
  assert.equal(old.status, 'ignored')
  assert.equal(user.status, 'ignored')
  assert.equal(fenced.status, 'completed')
  assert.equal(f.memory.writes, 1)
})

test('exact keys、task binding、requestId body binding 与大小上限拒绝无效请求', async () => {
  const f = await fixture()
  const extras = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-extra', envelope({ source: 'assistant', root: 'C:/' })))
  const wrongTask = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-task', envelope({ taskId: 'other' })))
  const first = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-first', envelope()))
  const reused = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-reused', envelope({ content: 'changed' })))
  const tooLarge = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-large', 'x'.repeat(90000)))
  assert.equal(extras.status, 'rejected')
  assert.equal(wrongTask.status, 'rejected')
  assert.equal(first.status, 'completed')
  assert.equal(reused.status, 'rejected')
  assert.equal(tooLarge.status, 'rejected')
  assert.equal(f.memory.writes, 1)
})

test('不可由 envelope 自报来源，且能力、会话或 grant 撤销后拒绝处理', async () => {
  const f = await fixture()
  const forged = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-forged', envelope({ source: 'native', providerId: 'fake' })))
  assert.equal(forged.status, 'rejected')
  assert.equal(f.memory.writes, 0)
  f.bridge.revokeTask(f.capability)
  const revoked = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-revoked', envelope()))
  assert.equal(revoked.status, 'rejected')
  assert.equal(f.memory.writes, 0)
})

test('native task binding 变更后旧能力不能继续执行，也不读取用户消息/旧历史', async () => {
  let current = true
  const f = await fixture({ isCurrent: () => current })
  current = false
  const result = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-stale', envelope()))
  assert.equal(result.status, 'rejected')
  assert.equal(result.error.code, 'TASK_NOT_CURRENT')
  assert.equal(f.memory.writes, 0)
})

test('partial流不占用messageId；同ID complete到达时只执行一次', async () => {
  const f = await fixture()
  const partial = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('stream-1', envelope(), { complete: false }))
  assert.equal(partial.status, 'ignored')
  assert.equal(f.memory.writes, 0)
  const final = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('stream-1', envelope(), { complete: true }))
  const rerender = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('stream-1', envelope(), { complete: true }))
  assert.equal(final.status, 'completed')
  assert.equal(rerender.status, 'duplicate-message')
  assert.equal(f.memory.writes, 1)
})

test('issueTask拒绝声明provider/window/conversation与nativeContext不一致', async () => {
  const memory = memoryFileTools()
  const fileTools = createWebAiFileTools({ fs: memory.fs })
  const grant = await fileTools.issueGrant({ providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a', root: '/approved' })
  const bridge = createWebAiToolEnvelope({ fileTools })
  assert.throws(() => bridge.issueTask({
    taskId: 'task-a', taskNonce: 'nonce-a', providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a', grant,
    nativeContext: { providerId: 'deepseek', windowId: 'window-b', conversationId: 'conversation-a' }, isCurrent: () => true,
  }), /inconsistent/)
  assert.equal(memory.writes, 0)
})

test('执行期间会话切换或撤销后不返回迟到结果内容', async () => {
  for (const revoke of [false, true]) {
    let release
    let started
    const gate = new Promise(resolve => { release = resolve })
    const ready = new Promise(resolve => { started = resolve })
    const memory = memoryFileTools()
    memory.files.set('/approved/readme.txt', 'sensitive-content')
    const fs = { ...memory.fs, readBytes: async target => { started(); await gate; return Buffer.from(memory.files.get(target) ?? '') } }
    const fileTools = createWebAiFileTools({ fs })
    const grant = await fileTools.issueGrant({ providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a', root: '/approved' })
    const bridge = createWebAiToolEnvelope({ fileTools })
    let current = true
    const capability = bridge.issueTask({
      taskId: 'task-a', taskNonce: 'nonce-a', providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a', grant,
      nativeContext: { providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a' }, isCurrent: () => current,
    })
    const request = { version: 1, kind: 'tradeloom-file-task', taskId: 'task-a', requestId: 'late-read', op: 'read', path: 'readme.txt' }
    const pending = bridge.observeAssistantMessage(capability, assistantObservation(`late-${revoke}`, JSON.stringify(request)))
    await ready
    if (revoke) bridge.revokeTask(capability)
    else current = false
    release()
    const result = await pending
    assert.equal(result.status, 'rejected')
    assert.equal(result.error.code, 'TASK_NOT_CURRENT')
    assert.equal(JSON.stringify(result).includes('sensitive-content'), false)
    assert.equal(Object.hasOwn(result, 'result'), false)
  }
})

test('结果采用固定有界响应结构；执行器错误不会泄露本地错误文本', async () => {
  const f = await fixture()
  const readEnvelope = JSON.parse(envelope({ op: 'read', path: 'missing.txt', requestId: 'missing' }))
  delete readEnvelope.content
  const response = await f.bridge.observeAssistantMessage(f.capability, assistantObservation('message-result', JSON.stringify(readEnvelope)))
  assert.deepEqual(response, {
    version: 1,
    taskId: 'task-a',
    requestId: 'missing',
    source: 'native-assistant-observation',
    operation: 'read',
    status: 'failed',
    result: { ok: false, error: { code: 'NOT_FOUND' } },
  })
  assert.ok(Buffer.byteLength(JSON.stringify(response)) < 4096)

  const noisyBridge = createWebAiToolEnvelope({ fileTools: {
    execute: async () => { throw new Error('C:\\private\\profile\\secret.txt') },
    revoke: () => true,
  } })
  const noisyCapability = noisyBridge.issueTask({
    taskId: 'task-a', taskNonce: 'nonce-a', providerId: 'deepseek', windowId: 'window-a',
    conversationId: 'conversation-a', grant: {},
    nativeContext: { providerId: 'deepseek', windowId: 'window-a', conversationId: 'conversation-a' },
    isCurrent: () => true,
  })
  const noisyResult = await noisyBridge.observeAssistantMessage(noisyCapability, assistantObservation('message-noisy', JSON.stringify(readEnvelope)))
  assert.equal(noisyResult.result.error.code, 'TOOL_FAILED')
  assert.equal(JSON.stringify(noisyResult).includes('private'), false)
})
