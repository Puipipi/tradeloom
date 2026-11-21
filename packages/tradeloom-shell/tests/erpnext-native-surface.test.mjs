import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { runInNewContext } from 'node:vm'

const clientUrl = new URL('../client.js', import.meta.url)
const packageUrl = new URL('../package.json', import.meta.url)

test('ERPNext native scene component replaces the generic DSH root in its child window', async () => {
  const source = await readFile(clientUrl, 'utf8')
  const start = source.indexOf("if (descriptor.kind === 'scene-component') {")
  const end = source.indexOf("if (descriptor.kind === 'role') reportRoleGuestPhase", start)
  assert.ok(start >= 0 && end > start, 'scene component registration branch is present')
  const sceneComponentBranch = source.slice(start, end)

  assert.match(sceneComponentBranch, /descriptor\.componentKey === 'erpnext-status-native'[\s\S]*?descriptor\.sceneId === 'erpnext'[\s\S]*?descriptor\.panelId === 'business-main'[\s\S]*?SourceErpNextStatus/)
  assert.match(sceneComponentBranch, /ctx\.slots\.inject\('root'/,
    'the native child must render a root presenter instead of retaining the generic DSH shell')
  assert.match(sceneComponentBranch, /data-source-owned-scene-component/)
  assert.match(sceneComponentBranch, /body:has\(\[data-source-owned-scene-component\]\) \.dshwv-root\s*\{\s*display:\s*none;\s*\}/)
  assert.match(sceneComponentBranch, /h\(SourceSceneComponent,\s*\{\s*renderFactorySlot\s*\}\)/)
})

test('ERPNext status UI chunk is included and dynamically loadable by the business shell', async () => {
  const [source, packageJson] = await Promise.all([
    readFile(clientUrl, 'utf8'),
    readFile(packageUrl, 'utf8').then(JSON.parse),
  ])
  assert.ok(packageJson.files.includes('client.scenes.js'))
  assert.match(source, /require\.async\('\.\/client\.scenes\.js'\)/)
})

test('ERPNext status component renders the unconfigured and connected states', async () => {
  const source = await readFile(new URL('../client.scenes.js', import.meta.url), 'utf8')

  for (const status of [
    { configured: false, connected: false, status: 'not_configured', error_code: '', site_url: '' },
    { configured: true, connected: true, status: 'connected', error_code: '', site_url: 'https://erp.example.test/site' },
  ]) {
    let registration
    let state
    let dependencies
    const React = {
      Fragment: Symbol.for('react.fragment'),
      createElement(type, props, ...children) { return { type, props: props ?? {}, children } },
      useState(initial) {
        if (state === undefined) state = typeof initial === 'function' ? initial() : initial
        return [state, next => { state = typeof next === 'function' ? next(state) : next }]
      },
      useEffect(effect, nextDependencies) {
        if (!dependencies || nextDependencies.some((value, index) => value !== dependencies[index])) {
          dependencies = [...nextDependencies]
          effect()
        }
      },
    }
    runInNewContext(source, {
      React,
      URL,
      URLSearchParams,
      fetch: async path => {
        assert.equal(path, '/business-api/erpnext/status')
        return { ok: true, async json() { return status } }
      },
      window: { __ModuleLoader__: { load(value) { registration = value } } },
    })

    const component = registration.factory(() => React).ERPNextStatus
    component({ refreshKey: 0 })
    await new Promise(resolve => setImmediate(resolve))
    const tree = component({ refreshKey: 0 })
    const nodes = []
    const visit = node => {
      if (Array.isArray(node)) return node.forEach(visit)
      if (!node || typeof node !== 'object') return
      nodes.push(node)
      visit(node.children)
    }
    visit(tree)
    if (status.connected) {
      assert.ok(nodes.some(node => node.type === 'h3' && node.children.includes('ERPNext 已连接')))
    } else {
      const paneState = nodes.find(node => node.type?.name === 'PaneState')
      assert.equal(paneState?.props.title, 'ERPNext 尚未配置')
      assert.equal(paneState?.props.action.label, '检查连接')
    }
  }
})
