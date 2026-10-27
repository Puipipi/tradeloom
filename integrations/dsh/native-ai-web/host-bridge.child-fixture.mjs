import { createChildAiWebAskClient } from './host-bridge.ts'

const client = createChildAiWebAskClient(process)
const mode = process.argv[2]
const waitForResult = requestId => new Promise(resolve => {
  const listener = message => {
    if (message?.type === 'ai-web-ask-result' && message.requestId === requestId) {
      process.off('message', listener)
      resolve(message)
    }
  }
  process.on('message', listener)
})
const send = message => new Promise((resolve, reject) => {
  process.send(message, error => error ? reject(error) : resolve())
})
if (mode === 'correlate') {
  const results = await Promise.all([
    client.ask('deepseek', 'slow request'),
    client.ask('doubao', 'fast request'),
  ])
  process.send({ fixture: 'correlate', texts: results.map(result => result.text) })
} else if (mode === 'cancel') {
  const controller = new AbortController()
  const request = client.ask('deepseek', 'cancel me', controller.signal).catch(error => error.message)
  setTimeout(() => controller.abort(), 25)
  process.send({ fixture: 'cancel', result: await request })
} else if (mode === 'exit-pending') {
  void client.ask('deepseek', 'exit pending').catch(() => undefined)
  process.send({ fixture: 'pending' })
  setTimeout(() => process.exit(0), 25)
} else if (mode === 'duplicate-completed') {
  const request = { type: 'ai-web-ask', requestId: 1, provider: 'deepseek', question: 'once' }
  const firstResult = waitForResult(1)
  await send(request)
  const first = await firstResult
  const duplicateResult = waitForResult(1)
  await send(request)
  const duplicate = await duplicateResult
  process.send({ fixture: 'duplicate-completed', firstOk: first.ok, duplicateError: duplicate.errorCode })
} else if (mode === 'duplicate-active') {
  const request = { type: 'ai-web-ask', requestId: 1, provider: 'deepseek', question: 'slow once' }
  let resultCount = 0
  process.on('message', message => {
    if (message?.type === 'ai-web-ask-result' && message.requestId === 1) resultCount++
  })
  const response = waitForResult(1)
  await send(request)
  setTimeout(() => { void send(request) }, 25)
  const result = await response
  await new Promise(resolve => setTimeout(resolve, 180))
  process.send({ fixture: 'duplicate-active', ok: result.ok, errorCode: result.errorCode, resultCount })
}
