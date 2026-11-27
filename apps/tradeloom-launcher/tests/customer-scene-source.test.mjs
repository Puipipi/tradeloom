import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { BUSINESS_ROUTE_PATHS, validateSceneConfig } from '../../../packages/tradeloom-shell/scene-layout.js'

const shellBase = '../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/'
const read = name => readFile(new URL(shellBase + name, import.meta.url), 'utf8')

const defaults = JSON.parse(await readFile(new URL('../../../packages/tradeloom-shell/scenes.json', import.meta.url), 'utf8'))
const roles = await readFile(new URL('../../../packages/tradeloom-shell/roles.js', import.meta.url), 'utf8')
const clientScenes = await readFile(new URL('../../../packages/tradeloom-shell/client.scenes.js', import.meta.url), 'utf8')
const baseTemplate = await readFile(new URL('../../../workbench/templates/workbench/base.html', import.meta.url), 'utf8')
const customersTemplate = await readFile(new URL('../../../workbench/templates/workbench/customers.html', import.meta.url), 'utf8')

test('客户场景在宿主配置、布局模板与受控路由三处保持一致', async () => {
  const [shell, renderer, bridge, fallback] = await Promise.all([
    read('scenes-data.js'), read('renderer.js'), read('business-bridge.js'), read('scenes.json'),
  ])

  const context = { window: {} }
  runInNewContext(shell, context)
  const templates = context.window.__SCENES__
  assert.deepEqual(JSON.parse(JSON.stringify(templates)), JSON.parse(fallback))

  const host = defaults.scenes.find(scene => scene.id === 'customers')
  assert.ok(host, 'scenes.json 缺客户场景')
  assert.equal(host.defaultBusinessRoute, '/customers')
  assert.equal(host.roleId, 'product')
  assert.deepEqual(defaults.businessRoutes['/customers'], { sceneId: 'customers', panelId: 'business-main' })

  const order = defaults.scenes.findIndex(scene => scene.id === 'order-production')
  assert.equal(defaults.scenes[order + 1].id, 'customers')
  assert.ok(BUSINESS_ROUTE_PATHS.includes('/customers'))
  assert.doesNotThrow(() => validateSceneConfig(structuredClone(defaults)))

  const template = templates.scenes.find(scene => scene.id === 'customers')
  assert.ok(template, '布局模板缺客户场景')
  assert.equal(template.name, '客户')

  context.configurationTemplates = templates.scenes
  const projection = renderer.slice(renderer.indexOf('const hostPanelFor'), renderer.indexOf('function applyTrustedSceneConfiguration'))
  runInNewContext(projection, context)
  const projected = context.projectTrustedScene(host)
  assert.equal(projected.id, 'customers')
  assert.deepEqual(JSON.parse(JSON.stringify(projected.panels.map(panel => [panel.id, panel.hostPanelId]))), [
    ['customers-main', 'business-main'], ['files', 'files'], ['preview', 'preview'], ['customers-chat', 'native-chat'],
  ])
  assert.equal(projected.panels.find(panel => panel.id === 'customers-main').path, '/customers')

  assert.match(renderer, /customers: 'M13 6\.5a3 3 0 1 1-6 0/)
  assert.match(bridge, /customers: '\/customers'/)
  assert.match(bridge, /const allowedRoutes = new Set\(Object\.values\(routeByUiScene\)\)/)
})

test('客户入口在宿主导航与业务页导航中都是一级模块', () => {
  assert.match(roles, /\{ id: 'customers', label: '客户', path: '\/customers' \}/)
  assert.match(clientScenes, /customers: 'M13 7\.2a3 3 0 1 1-6 0/)

  assert.match(baseTemplate, /data-testid="nav-customers"[^>]*>客户<\/a>/)
  const orders = baseTemplate.indexOf('data-testid="nav-orders"')
  const customers = baseTemplate.indexOf('data-testid="nav-customers"')
  const agentCenter = baseTemplate.indexOf('data-testid="nav-agent-center"')
  assert.ok(orders < customers && customers < agentCenter, '客户应排在订单与生产之后')
  assert.doesNotMatch(baseTemplate, /customer-context-nav/)

  assert.match(customersTemplate, /\{% block page_title %\}客户\{% endblock %\}/)
  assert.match(customersTemplate, /data-testid="pending-aliases-panel"/)
})
