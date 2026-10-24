import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const qrChunkUrl = new URL('../client.mobile-qr.js', import.meta.url)
const clientUrl = new URL('../client.js', import.meta.url)

function loadQrFactory(source) {
  let registration
  runInNewContext(source, {
    window: { __ModuleLoader__: { load(value) { registration = value } } },
  })
  assert.equal(registration?.chunk, 'client.mobile-qr.js')
  return registration.factory(() => { throw new Error('QR encoder chunk has no runtime dependencies') })
}

test('local QR encoder returns a valid matrix for the exact synthetic authorization URL input', async () => {
  const qr = loadQrFactory(await readFile(qrChunkUrl, 'utf8'))
  const authorizationUrl = 'http://192.168.1.23:3088/?auth=SYNTHETIC_ONLY_4f3a'
  const matrix = qr.createQrMatrix(authorizationUrl)

  assert.equal(matrix.quietZone, 4)
  assert.equal(matrix.size, matrix.modules.length)
  assert.ok(matrix.size >= 21 && (matrix.size - 17) % 4 === 0)
  assert.ok(matrix.modules.every(row => typeof row === 'string' && row.length === matrix.size && /^[01]+$/.test(row)))
  assert.ok(matrix.modules.some(row => row.includes('1')), 'the generated symbol contains dark QR modules')
  assert.ok(matrix.modules.some(row => row.includes('0')), 'the generated symbol contains light QR modules')
  assert.equal(matrix.modules[0].slice(0, 7), '1111111', 'the real encoder emitted the standard upper-left finder pattern')

  const changedUrl = qr.createQrMatrix(`${authorizationUrl}&device=other`)
  assert.notDeepEqual(changedUrl.modules, matrix.modules, 'changing the authorization URL changes the real encoded symbol')
})

test('mobile link panel renders a local QR, keeps copy fallback, and ignores stale link responses', async () => {
  const hookValues = []
  let hookIndex = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props, children }),
    useState(initial) {
      const index = hookIndex++
      if (!(index in hookValues)) hookValues[index] = initial
      return [hookValues[index], next => { hookValues[index] = typeof next === 'function' ? next(hookValues[index]) : next }]
    },
    useRef(initial) { const index = hookIndex++; return hookValues[index] ??= { current: initial } },
    useEffect() {},
  }
  const qrEncoder = loadQrFactory(await readFile(qrChunkUrl, 'utf8'))
  const requests = []
  const copiedLinks = []
  const encodedUrls = []
  let qrLoadCalls = 0
  const qr = { createQrMatrix(value) { encodedUrls.push(value); return qrEncoder.createQrMatrix(value) } }
  const entryRequire = name => {
    if (name === 'react') return React
    if (name === 'react-dom') return { createPortal: child => child }
    assert.fail(`unexpected entry dependency: ${name}`)
  }
  entryRequire.async = async name => {
    if (name === './client.scenes.js') return { register() {}, SceneTabs() { return null } }
    if (name === './client.mobile-qr.js') {
      qrLoadCalls++
      if (qrLoadCalls === 1) throw new Error('synthetic-chunk-load-failure')
      return qr
    }
    assert.fail(`unexpected async entry dependency: ${name}`)
  }

  let plugin
  runInNewContext(await readFile(clientUrl, 'utf8'), {
    window: {
      __ModuleLoader__: { load(value) { plugin = value.factory(entryRequire) } },
      document: { querySelectorAll: () => [], addEventListener() {}, removeEventListener() {} },
      addEventListener() {}, removeEventListener() {}, location: { origin: 'http://127.0.0.1:3088' },
    },
    document: { addEventListener() {}, removeEventListener() {} },
    fetch(url, options) {
      requests.push({ url, options })
      return new Promise(resolve => { requests.at(-1).resolve = resolve })
    },
    navigator: { clipboard: { async writeText(value) { copiedLinks.push(value) } } },
  })

  const registrations = []
  await plugin.apply({
    layout: { selectPanel() {}, toggleSidebar() {} }, uiWorkspace: {},
    theme: { getTheme: () => ({ active: { colorScheme: 'light' } }) },
    on() {}, effect() {},
    slots: {
      inject(_name, register) { register() },
      register(spec, component) { registrations.push({ spec, component }); return () => {} },
    },
  })
  const top = registrations.find(item => item.spec.name === 'shell.top')?.component
  assert.equal(typeof top, 'function')
  const find = (node, predicate) => {
    if (!node || typeof node !== 'object') return undefined
    if (predicate(node)) return node
    for (const child of node.children ?? []) {
      const found = Array.isArray(child) ? child.map(item => find(item, predicate)).find(Boolean) : find(child, predicate)
      if (found) return found
    }
    return undefined
  }
  const topTree = top({ usePanelInfo: selector => selector({ activePanelId: 'scene-workbench' }) })
  const toolsMenu = find(topTree, node => node?.type?.name === 'ShellToolsMenu')?.type
  assert.equal(typeof toolsMenu, 'function')
  hookValues.length = 0
  hookIndex = 0
  const renderTools = () => { hookIndex = 0; return toolsMenu() }
  const clickMenuAction = label => {
    let tree = renderTools()
    find(tree, node => node.type === 'button' && node.props?.['aria-label'] === '打开工具菜单').props.onClick()
    tree = renderTools()
    find(tree, node => node.type === 'button' && node.children?.includes(label)).props.onClick()
    return renderTools()
  }
  const resolveRequest = async (index, url, ok = true) => {
    requests[index].resolve({ ok, async json() { return { url } } })
    for (let pass = 0; pass < 8; pass++) await new Promise(resolve => setImmediate(resolve))
  }
  const closePanel = () => {
    const tree = renderTools()
    find(tree, node => node.type === 'button' && node.props?.['aria-label'] === '关闭手机连接面板').props.onClick()
    return renderTools()
  }

  let tree = clickMenuAction('连接手机')
  assert.equal(requests[0].url, '/tradeloom/mobile-link')
  assert.equal(requests[0].options.credentials, 'same-origin')
  assert.ok(find(tree, node => node.props?.role === 'dialog'))
  assert.ok(find(tree, node => node.props?.role === 'status' && node.children?.includes('正在生成链接…')))
  assert.equal(find(tree, node => node.type === 'svg' && node.props?.['aria-label'] === '手机授权链接二维码'), undefined)

  const firstUrl = 'http://192.168.1.23:3088/?auth=SYNTHETIC_FIRST'
  await resolveRequest(0, firstUrl)
  tree = renderTools()
  assert.equal(find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '手机授权链接')?.props.value, firstUrl)
  assert.equal(find(tree, node => node.type === 'svg' && node.props?.['aria-label'] === '手机授权链接二维码'), undefined)
  assert.ok(find(tree, node => node.props?.role === 'status' && node.children?.includes('二维码暂不可用，请复制下方授权链接到手机浏览器打开。')),
    'a local QR chunk load failure retains the URL and gives a copy fallback')
  assert.ok(find(tree, node => node.type === 'button' && node.children?.includes('复制链接')))
  assert.match(JSON.stringify(tree), /扫码或复制授权链接/)
  find(tree, node => node.type === 'button' && node.children?.includes('复制链接')).props.onClick()
  for (let pass = 0; pass < 2; pass++) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(copiedLinks, [firstUrl], 'copy still receives the exact complete URL represented by the QR')

  closePanel()
  tree = clickMenuAction('连接手机')
  assert.equal(find(tree, node => node.type === 'svg' && node.props?.['aria-label'] === '手机授权链接二维码'), undefined,
    'reopening clears a prior QR while the next link is loading')
  await resolveRequest(1, 'http://192.168.1.23:3088/?auth=SYNTHETIC_RETRY')
  tree = renderTools()
  const firstSvg = find(tree, node => node.type === 'svg' && node.props?.['aria-label'] === '手机授权链接二维码')
  assert.ok(firstSvg, 'reopening retries a rejected lazy chunk and renders the local QR')
  assert.equal(firstSvg.props.viewBox.split(' ').length, 4)
  assert.deepEqual(encodedUrls, ['http://192.168.1.23:3088/?auth=SYNTHETIC_RETRY'],
    'the successful retry passes the exact returned URL to the real QR encoder')

  closePanel()
  tree = clickMenuAction('连接手机')
  closePanel()
  tree = clickMenuAction('连接手机')
  assert.equal(requests.length, 4)
  await resolveRequest(2, 'http://192.168.1.23:3088/?auth=SYNTHETIC_STALE')
  tree = renderTools()
  assert.equal(find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '手机授权链接'), undefined,
    'a response from a closed prior panel cannot populate a reopened panel')
  const latestUrl = 'http://192.168.1.23:3088/?auth=SYNTHETIC_LATEST'
  await resolveRequest(3, latestUrl)
  tree = renderTools()
  assert.equal(find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '手机授权链接')?.props.value, latestUrl)
  assert.ok(find(tree, node => node.type === 'svg' && node.props?.['aria-label'] === '手机授权链接二维码'))
  assert.deepEqual(encodedUrls, ['http://192.168.1.23:3088/?auth=SYNTHETIC_RETRY', latestUrl], 'the stale response was never encoded in place of the current authorization URL')

  closePanel()
  tree = clickMenuAction('连接手机')
  await resolveRequest(4, '', false)
  tree = renderTools()
  assert.ok(find(tree, node => node.props?.role === 'status' && node.children?.includes('暂时无法生成手机连接链接，请确认电脑已连接局域网后重试。')))
  assert.equal(find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '手机授权链接'), undefined,
    'an unavailable protected endpoint does not leave a previous URL or QR visible')

  closePanel()
  tree = clickMenuAction('连接手机')
  const boundedFailureUrl = `http://192.168.1.23:3088/?x=${'x'.repeat(4100)}`
  await resolveRequest(5, boundedFailureUrl)
  tree = renderTools()
  assert.equal(find(tree, node => node.type === 'input' && node.props?.['aria-label'] === '手机授权链接')?.props.value, boundedFailureUrl,
    'an encoder limitation does not hide the returned copyable URL')
  assert.equal(find(tree, node => node.type === 'svg' && node.props?.['aria-label'] === '手机授权链接二维码'), undefined)
  assert.ok(find(tree, node => node.props?.role === 'status' && node.children?.includes('二维码暂不可用，请复制下方授权链接到手机浏览器打开。')))
  assert.ok(find(tree, node => node.type === 'button' && node.children?.includes('复制链接')))
})
