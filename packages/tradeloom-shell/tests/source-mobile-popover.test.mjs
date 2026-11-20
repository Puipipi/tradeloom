import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

test('desktop mobile toolbar anchors a compact QR and isolates reopened requests', async () => {
  const renderer = await readFile(new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/renderer.js', import.meta.url), 'utf8')
  const requests = [], copies = [], document = node(), body = node()
  const window = Object.assign(node(), { innerWidth: 260, innerHeight: 220, businessBridge: {
    isDesktop: () => true,
    globalAction: action => new Promise(resolve => { assert.equal(action, 'mobile'); requests.push(resolve) }),
  } })
  const overflow = node(), button = node()
  overflow.getBoundingClientRect = () => ({ bottom: 42, right: 228 })
  let focused
  function node(type, children = []) {
    const handlers = new Map(), attributes = new Map()
    const element = { type, children, attributes, style: {}, namespaceURI: 'http://www.w3.org/2000/svg',
      isConnected: false, offsetWidth: 232, offsetHeight: 186, classList: { add() {} },
      append(...values) { children.push(...values); for (const value of values) if (typeof value === 'object') value.isConnected = true },
      replaceChildren(...values) { children.length = 0; this.append(...values) },
      remove() { this.isConnected = false; body.children.splice(body.children.indexOf(this), 1) },
      contains(target) { return this === target || children.some(child => child.contains?.(target)) },
      setAttribute(name, value) { attributes.set(name, value) }, focus() { focused = this },
      addEventListener(name, fn) { handlers.set(name, fn) }, removeEventListener(name) { handlers.delete(name) },
      dispatch(name, event = {}) { return handlers.get(name)?.(event) },
      getClientRects() { return [this.getBoundingClientRect()] },
      getBoundingClientRect() { return { bottom: 30, right: 250 } },
    }
    return element
  }
  Object.assign(document, { body, createElementNS: (_ns, tag) => node(tag) })
  const make = (tag, _class, value) => node(tag, value === undefined ? [] : [value])
  const context = {
    window, document, queueMicrotask, navigator: { clipboard: { writeText: async value => copies.push(value) } },
    make, el: (tag, _class, ...values) => node(tag, values), $: () => overflow,
  }
  const start = renderer.indexOf('function positionToolbarPanel(')
  const end = renderer.indexOf('let webAiAuthController', start)
  runInNewContext(renderer.slice(start, end), context)
  const open = () => context.showMobileLink({ currentTarget: button })
  const tick = () => new Promise(resolve => setImmediate(resolve))
  const result = suffix => ({ ok: true, value: { url: `https://example.invalid/${suffix}`,
    qrMatrix: { size: 21, quietZone: 4, modules: Array.from({ length: 21 }, () => '1'.repeat(21)) },
  } })
  const escape = () => document.dispatch('keydown', { key: 'Escape', preventDefault() {}, stopPropagation() {} })
  button.closest = () => undefined
  open(); await tick()
  assert.equal(focused, body.children[0])
  assert.equal(body.children[0].style.top, '30px')
  assert.equal(body.children[0].style.right, '10px')
  escape()
  assert.equal(focused, button)
  button.closest = () => overflow
  open(); await tick()
  assert.equal(body.children[0].style.right, '24px')
  requests[0](result('stale')); await tick()
  assert.equal(body.children[0].children[0].children[0], '正在请求手机连接信息…')
  requests[1](result('fresh')); await tick()
  const [qr, , copy] = body.children[0].children[0].children
  const [background, path] = qr.children
  assert.equal(qr.attributes.get('viewBox'), '0 0 29 29')
  assert.equal(background.attributes.get('width'), '29')
  assert.equal(background.attributes.get('height'), '29')
  assert.match(path.attributes.get('d'), /^M4 4.*M24 24h1v1h-1z$/)
  await copy.dispatch('click')
  assert.deepEqual(copies, ['https://example.invalid/fresh'])
  escape()
  assert.equal(focused, overflow)
  open()
  document.dispatch('pointerdown', { target: node() })
  requests[2](result('dismissed')); await tick()
  assert.equal(body.children.length, 0)
  open()
  const malformed = result('invalid')
  malformed.value.qrMatrix.quietZone = 3
  requests[3](malformed); await tick()
  assert.equal(body.children[0].children[0].children[0], '手机连接信息暂不可用；未生成可确认的二维码。')
  escape()
})
