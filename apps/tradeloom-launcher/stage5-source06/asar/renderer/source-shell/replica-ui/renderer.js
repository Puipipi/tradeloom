/* ============================================================
   织贸工作台（独立 UI 预览）· 渲染器
   外壳布局与交互照搬 upstream 12-源码照搬/外壳（renderer.js + renderers.js）
   面板内容为中性界面示例，不连接业务服务、账户或真实数据
   ============================================================ */
const $ = s => document.querySelector(s)
const grid = $('#grid')
let data
let configurationTemplates, trustedSceneConfiguration
const visibleConfiguredScenes = value => value.scenes.filter(scene => configurationTemplates.some(template => template.id === (scene.templateSceneId ?? scene.id)))
const hostPanelFor = (scene, panel) => scene.panels.find(item => !isComponentInstance(item) && (
  panel.hostPanelId ? item.id === panel.hostPanelId : panel.type === 'chat'
    ? item.type === 'native-chat' && item.optional !== true
    : item.type === 'business-iframe' && item.path === panel.path))
const isComponentInstance = panel => /^component-[a-z0-9-]{1,38}$/.test(panel.id) && panel.type === 'business-iframe' && typeof panel.componentId === 'string'
function projectTrustedScene(scene) {
  const template = configurationTemplates.find(value => value.id === (scene.templateSceneId ?? scene.id))
  if (!template) throw Error('scene template unavailable')
  // Preserve the accepted shell's own account/web/plugin panels and ids. Only
  // fields actually owned by the Host scene document are updated here.
  const panels = template.panels.map(panel => {
    const host = hostPanelFor(scene, panel)
    return host ? { ...panel, hostPanelId: host.id, roleId: host.roleId ?? scene.roleId,
      title: host.title, col: host.col, row: host.row, w: host.w, h: host.h, componentId: host.componentId, ...(host.path ? { path: host.path } : {}) } : { ...panel }
  })
  if (scene.templateSceneId) panels.push(...scene.panels.filter(isComponentInstance).map(panel =>
    ({ ...panel, type: 'doc', hostPanelId: panel.id, roleId: scene.roleId })))
  if ((scene.templateSceneId ?? scene.id) === 'agent-center' && !scene.panels.some(panel => panel.id === 'business-plan')) {
    const legacy = panels.filter(panel => panel.id !== 'workflow-plan')
    const canvas = legacy.find(panel => panel.id === 'workflow-main')
    if (canvas) Object.assign(canvas, { standaloneCanvas: false, tabs: ['业务计划','工作流画布'], activeTab: '工作流画布' })
    return { ...template, id: scene.id, name: scene.label, templateSceneId: scene.templateSceneId, panels: legacy, workflowLayoutGap: 'custom-legacy-layout' }
  }
  return { ...template, id: scene.id, name: scene.label, templateSceneId: scene.templateSceneId, panels }
}
function applyTrustedSceneConfiguration(value) {
  if (!configurationTemplates || !Array.isArray(value?.scenes)) throw Error('trusted scene configuration unavailable')
  const next = visibleConfiguredScenes(value).map(projectTrustedScene)
  const current = next.find(scene => scene.id === currentTab)
  const previous = data.scenes.find(scene => scene.id === currentTab)
  const layoutChanges = next.flatMap(scene => {
    const prior = data.scenes.find(item => item.id === scene.id)
    if (!prior || ![...prior.panels, ...scene.panels].some(panel => /^component-[a-z0-9-]{1,38}$/.test(panel.id))) return []
    const before = prior.panels.map(layoutGeometry), after = scene.panels.map(layoutGeometry)
    return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ sceneId: scene.id, before, after }]
  })
  if (layoutChanges.length) window.dispatchEvent(new CustomEvent('scene-configuration-layout', { detail: layoutChanges }))
  trustedSceneConfiguration = value
  data.scenes = next
  buildTabs()
  if (!current) { void loadScenario(next[0].id); return }
  // Retain the DOM and the native surface for every unchanged panel. Geometry
  // and labels are updated in place, not via a global scene reload.
  activePanelDragCancel?.()
  for (const element of [...grid.querySelectorAll(':scope > [data-panel-id]')]) {
    const panel = current.panels.find(item => item.id === element.dataset.panelId)
    const before = element.__meta
    if (!panel || ['type', 'roleId', 'path', 'hostPanelId', 'componentId'].some(key => panel[key] !== before[key])) {
      cleanups.get(element.dataset.panelId)?.(); cleanups.delete(element.dataset.panelId); element.remove()
    } else {
      const prior = previous?.panels.find(item => item.id === panel.id)
      const geometry = ['col', 'row', 'w', 'h']
      const changed = !prior || geometry.some(key => prior[key] !== panel[key])
      element.__meta = { ...before, ...panel, ...(!changed && Object.fromEntries(geometry.map(key => [key, Number(element.dataset[key])]))) }
      element.__defaultLayoutGeometry = layoutGeometry(panel)
      if (changed) {
        for (const key of geometry) element.dataset[key] = panel[key]
        applyGeom(element)
      }
      const label = element.querySelector('.panel-title')
      if (label) label.textContent = panel.title
    }
  }
  current.panels.forEach((panel, index) => {
    if (![...grid.children].some(element => element.dataset.panelId === panel.id)) makePanel({ ...panel, sceneId: current.id }, index)
  })
}

async function showSceneConfiguration() {
  if (typeof window.app?.saveSceneConfiguration !== 'function') return disconnectedModal('场景配置', '桌面场景配置入口不可用。')
  const actual = await window.app.sourceConfig()
  let expectedRevision = actual.configurationRevision
  const document = structuredClone(Object.fromEntries(['version', 'grid', 'businessRoutes', 'scenes'].map(key => [key, actual[key]])))
  let selected = document.scenes.find(value => value.id === currentTab) ?? document.scenes[0]
  openModal('场景配置', body => {
    const note = el('div', 'modal-note', '保存以版本校验防止覆盖他人的修改。受影响角色面板须先保存文字草稿；附件边界会另行确认。')
    const fields = el('div', 'scene-configuration-fields'), selector = make('select')
    const redraw = () => {
      selector.replaceChildren(...visibleConfiguredScenes(document).map(scene => { const option = make('option', '', scene.label); option.value = scene.id; return option }))
      selector.value = selected.id; fields.replaceChildren()
      const input = (label, value, change, type = 'text') => {
        const control = make('input'); control.type = type; control.value = value
        if (type === 'number') { control.min = '1'; control.max = '4' }
        control.addEventListener('change', () => change(type === 'number' ? Number(control.value) : control.value))
        fields.append(el('label', 'mdl-row', el('span', '', label), control))
      }
      input('场景名称', selected.label, value => { selected.label = value })
      const roles = make('select')
      roles.replaceChildren(...actual.roles.map(role => { const option = make('option', '', role.label ?? role.id); option.value = role.id; return option }))
      roles.value = selected.roleId; roles.addEventListener('change', () => { selected.roleId = roles.value })
      fields.append(el('label', 'mdl-row', el('span', '', '默认角色'), roles))
      for (const panel of selected.panels.filter(value => value.optional !== true)) {
        fields.append(el('strong', '', panel.id))
        const components = actual.componentCatalog?.filter(value => value.templateSceneId === selected.templateSceneId
          && value.panelId === panel.id && value.type === panel.type) ?? []
        const base = components[0]
        if (base && (panel.path === base.defaultPath || components.some(value => value.id === panel.componentId))) {
          const choice = make('select')
          const original = make('option', '', base.defaultLabel)
          original.value = ''
          choice.append(original, ...components.map(value => {
            const option = make('option', '', value.label); option.value = value.id; return option
          })); choice.value = panel.componentId ?? ''
          choice.addEventListener('change', () => {
            const component = components.find(value => value.id === choice.value)
            if (component) {
              Object.assign(panel, { componentId: component.id, path: component.path, title: component.label, category: component.category })
            } else {
              delete panel.componentId
              Object.assign(panel, { path: base.defaultPath, title: base.defaultLabel })
            }
            redraw()
          })
          fields.append(el('label', 'mdl-row', el('span', '', '面板组件'), choice))
        }
        input('面板名称', panel.title, value => { panel.title = value })
        for (const [key, label] of [['col', '起始列'], ['row', '起始行'], ['w', '宽度（格）'], ['h', '高度（格）']]) {
          input(label, panel[key], value => { panel[key] = value }, 'number')
        }
        if (isComponentInstance(panel)) {
          const removeComponent = make('button', '', `移除组件：${panel.title}`)
          removeComponent.type = 'button'
          removeComponent.addEventListener('click', () => {
            selected.panels = selected.panels.filter(value => value !== panel)
            redraw()
          })
          fields.append(removeComponent)
        }
      }
      if (selected.templateSceneId) {
        const available = actual.componentCatalog?.filter(component => component.allowStandalone
          && !selected.panels.some(panel => panel.path === component.path)) ?? []
        if (available.length) {
          const choices = make('select')
          choices.append(...available.map(component => {
            const option = make('option', '', component.label); option.value = component.id; return option
          }))
          const add = make('button', '', '添加组件')
          add.type = 'button'
          add.addEventListener('click', () => {
            const component = available.find(value => value.id === choices.value) ?? available[0]
            const cells = Array.from({ length: 16 }, (_, index) => ({ col: index % 4 + 1, row: Math.floor(index / 4) + 1 }))
            const free = cells.find(({ col, row }) => !selected.panels.some(panel => panel.optional !== true
              && col >= panel.col && col < panel.col + panel.w && row >= panel.row && row < panel.row + panel.h))
            if (!free || selected.panels.length >= 12) { note.textContent = '没有可用位置。请先缩小或移动现有面板，腾出一个网格。'; return }
            selected.panels.push({ id: `component-${crypto.randomUUID()}`, componentId: component.id,
              type: component.type, path: component.path, category: component.category, title: component.label, ...free, w: 1, h: 1 })
            redraw()
          })
          fields.append(el('label', 'mdl-row', el('span', '', '可添加组件'), choices), add)
        }
      }
    }
    selector.addEventListener('change', () => { selected = document.scenes.find(scene => scene.id === selector.value); redraw() })
    const clone = make('button', '', '复制为新场景'), remove = make('button', '', '移除自建场景')
    clone.type = remove.type = 'button'
    const cloneId = make('input')
    cloneId.type = 'text'
    cloneId.maxLength = 48
    const confirmClone = make('button', '', '确认复制'), cancelClone = make('button', '', '取消复制')
    confirmClone.type = cancelClone.type = 'button'
    const cloneFields = el('div', 'scene-configuration-fields',
      el('label', 'mdl-row', el('span', '', '新场景标识'), cloneId), confirmClone, cancelClone)
    cloneFields.hidden = true
    clone.addEventListener('click', () => {
      cloneFields.hidden = false
      cloneId.focus()
    })
    const closeClone = () => {
      cloneFields.hidden = true
      cloneId.value = ''
      clone.focus()
    }
    cancelClone.addEventListener('click', closeClone)
    confirmClone.addEventListener('click', () => {
      const id = cloneId.value
      if (!/^[a-z0-9-]{1,48}$/.test(id) || document.scenes.some(scene => scene.id === id) || document.scenes.length >= 16) { note.textContent = '场景标识无效、重复或数量已达上限。'; return }
      const next = { ...structuredClone(selected), id, label: `${selected.label}（副本）`, templateSceneId: selected.templateSceneId ?? selected.id }
      delete next.defaultBusinessRoute
      document.scenes.push(next); selected = next; redraw(); closeClone()
    })
    remove.addEventListener('click', () => {
      if (!selected.templateSceneId || Object.values(document.businessRoutes).some(route => route.sceneId === selected.id)) { note.textContent = '五个现有业务入口场景不能在此移除。'; return }
      document.scenes = document.scenes.filter(scene => scene !== selected); selected = document.scenes[0]; redraw()
    })
    const save = make('button', '', '保存并应用'), retry = make('button', '', '应用已保存配置')
    save.type = retry.type = 'button'
    async function perform(operation) {
      save.disabled = retry.disabled = true
      try {
        const result = await operation()
        note.textContent = result.cancelled ? result.saved ? '已取消应用；已保存配置保持，当前面板未销毁。' : '已取消，未保存。' : result.applied ? '场景配置已保存并应用。' : '配置已保存，但未应用。请保留当前面板内容，处理提示后重试应用。'
      } catch { note.textContent = '配置未保存或已被其他编辑更新；请关闭并重新打开配置。' }
      finally { save.disabled = retry.disabled = false }
    }
    save.addEventListener('click', () => void perform(async () => {
      const result = await window.app.saveSceneConfiguration({ expectedRevision, configuration: document })
      if (result.saved === true && typeof result.configurationRevision === 'string') expectedRevision = result.configurationRevision
      return result
    }))
    retry.addEventListener('click', () => void perform(() => window.app.applySceneConfiguration()))
    body.append(note, selector, fields, clone, cloneFields, remove, save, retry); redraw()
  })
}

async function showEngineGenerations() {
  const run = window.app?.engineGeneration
  if (typeof run !== 'function') return disconnectedModal('引擎程序快照', '受控程序恢复入口不可用。')
  openModal('引擎程序快照', body => {
    const status = el('div', 'modal-note', '快照只包含当前受控程序 app，不包含账号、profile、附件或业务数据。'), list = el('div')
    const capture = make('button', '', '保存当前引擎程序快照'); capture.type = 'button'
    async function refresh() {
      const value = await run({ action: 'list' })
      list.replaceChildren()
      for (const row of value.snapshots) {
        const preview = make('button', '', '预览恢复'); preview.type = 'button'
        preview.addEventListener('click', async () => {
          preview.disabled = true
          try {
            const result = await run({ action: 'preview', snapshotId: row.snapshotId })
            const confirm = make('button', '', '正常退出并恢复'), cancel = make('button', '', '取消预览')
            confirm.type = cancel.type = 'button'
            const detail = el('div', 'modal-note', `版本 ${row.runtimeVersion}；程序差异 ${JSON.stringify(result.changes)}。恢复前会再核完整当前代际。`)
            confirm.addEventListener('click', async () => {
              confirm.disabled = true
              try { const accepted = await run({ action: 'restore', previewId: result.previewId }); status.textContent = accepted.cancelled ? '已取消。' : '正在正常退出；受控 worker 会等待真实停机后恢复并重开。' }
              catch { status.textContent = '恢复未启动或当前代际已变化；程序未被强制关闭。'; confirm.disabled = false }
            })
            cancel.addEventListener('click', async () => { await run({ action: 'cancel', previewId: result.previewId }); detail.remove(); confirm.remove(); cancel.remove() })
            list.append(detail, confirm, cancel)
          } catch { status.textContent = '快照校验失败或当前程序代际变化。' }
          finally { preview.disabled = false }
        })
        list.append(el('div', 'mdl-row', el('span', '', `${row.createdAt} · ${row.runtimeVersion} · ${row.fileCount} 文件`), preview))
      }
      if (value.invalid.length) status.textContent = `有 ${value.invalid.length} 个快照无效，未列为可恢复项。`
    }
    capture.addEventListener('click', async () => {
      capture.disabled = true
      try { await run({ action: 'capture' }); status.textContent = '当前程序快照已保存并校验。'; await refresh() }
      catch { status.textContent = '程序快照未保存；请检查受控程序和存储可用性。' }
      finally { capture.disabled = false }
    })
    body.append(status, capture, list); void refresh().catch(() => { status.textContent = '引擎快照服务不可用。' })
  })
}
let currentTab = null
let cleanups = new Map()
let panelExpandStates = []
let panelExpandZ = 100
let activePanelDragCancel = null
let sceneRequestVersion = 0
let sceneHandledVersion = 0
let requestedSceneId = null
let initialSceneCommit
let initialPaintMain = new URLSearchParams(location.search).get('solo') !== '1'
let sceneLoadPromise
const rendererScriptUrl = document.currentScript?.src || ''
let businessBridgeLoad

function ensureBusinessBridge() {
  if (window.businessBridge) return Promise.resolve(window.businessBridge)
  if (businessBridgeLoad) return businessBridgeLoad
  businessBridgeLoad = new Promise(resolve => {
    const script = document.createElement('script')
    script.src = new URL('business-bridge.js', rendererScriptUrl || location.href).href
    script.onload = () => resolve(window.businessBridge)
    script.onerror = () => resolve(undefined)
    document.head.append(script)
  })
  return businessBridgeLoad
}

const make = (tag, className, text) => {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
const el = (tag, className, ...children) => {
  const node = make(tag, className)
  for (const c of children) {
    if (c == null) continue
    node.append(c.nodeType ? c : document.createTextNode(String(c)))
  }
  return node
}

/* ---------------- 小组件（临摹内容用） ---------------- */
function createReplicaIcon(d, viewBox = '0 0 24 24') {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  const path = document.createElementNS(ns, 'path')
  for (const [name, value] of Object.entries({
    class: 'replica-line-icon', viewBox, fill: 'none', stroke: 'currentColor',
    'stroke-width': '1.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    'aria-hidden': 'true', focusable: 'false',
  })) svg.setAttribute(name, value)
  path.setAttribute('d', d)
  svg.append(path)
  return svg
}

function iconBtn(glyph, title, onClick, cls = '') {
  const b = el('button', `icon-control ${cls}`, glyph)
  b.type = 'button'; b.title = title; b.setAttribute('aria-label', title)
  if (onClick) b.onclick = onClick
  return b
}
function chip(text, cls = '') { return el('span', `chip ${cls}`, text) }
function tag(text, cls = '') { return el('span', `tag ${cls}`, text) }
function fileRow(icon, name, size, date, sel, lv = 0) {
  return el('div', `frow ${sel ? 'sel' : ''} lv${lv}`,
    el('span', `ic ${icon}`, icon === 'dir' ? '📁' : icon === 'md' ? '📄' : '📃'),
    el('span', 'nm', name), el('span', `sz${size ? '' : ' empty'}`, size || ''),
    el('span', `dt${date ? '' : ' empty'}`, date || ''))
}

function panelTabs(panel, onSelect) {
  if (!Array.isArray(panel?.tabs) || panel.tabs.length === 0) return null
  const row = el('div', 'file-tabs')
  row.setAttribute('role', 'group')
  row.setAttribute('aria-label', `${panel.title || '面板'}视图`)
  if (!panel.tabs.includes(panel.activeTab)) panel.activeTab = panel.tabs[0]
  const buttons = []
  for (const label of panel.tabs) {
    const button = make('button', `chip chip-tab ${label === panel.activeTab ? 'on' : ''}`, label)
    button.type = 'button'
    button.setAttribute('aria-pressed', String(label === panel.activeTab))
    button.addEventListener('click', () => {
      panel.activeTab = label
      for (const item of buttons) {
        const selected = item.dataset.tabLabel === label
        item.classList.toggle('on', selected)
        item.setAttribute('aria-pressed', String(selected))
      }
      onSelect?.(label)
    })
    button.dataset.tabLabel = label
    buttons.push(button)
    row.append(button)
  }
  return row
}

function renderNeutralTabContent(body, title, description) {
  body.replaceChildren(
    el('div', 'doc-line h1', `${title}（界面预览）`),
    el('div', 'doc-line p', description),
    el('div', 'sep'),
    el('div', 'doc-line h2', '内容区域'),
    el('div', 'doc-line p', '此处仅展示界面位置，不连接业务服务，也不读取或保存真实数据。'))
}

/* ============================================================
   面板渲染器（静态界面示例，无业务连接）
   ============================================================ */
const rendererRegistry = {

  /* ---- 文档预览 ---- */
  doc(panel, content) {
    if (panel.componentId && panel.path === '/artifacts#files' && typeof window.businessBridge?.renderCompanion === 'function') return window.businessBridge.renderCompanion(panel, content, 'files')
    if (typeof window.businessBridge?.renderBusinessPanel === 'function') return window.businessBridge.renderBusinessPanel(panel, content, panel.path)
    const docName = el('span', 'doc-name', `${panel.title || '工作区说明'}.md`)
    const docSub = el('span', 'doc-sub mono', '示例文档 · 仅用于界面预览')
    const head = el('div', 'doc-meta',
      docName, docSub)
    const body = el('div', 'doc-body scroll')
    const lines = [
      ['# 工作区说明（界面示例）', 'h1'],
      ['此内容仅演示文档面板的标题、正文与段落层级。', 'p'],
      ['可以在这里展示说明、备注或普通文本。', 'p'],
      ['示例内容不会读取或保存到真实文件。', 'p'],
      ['---', 'hr'],
      ['## 文档结构示例', 'h2'],
      ['| 字段 | 示例值 | 说明 |', 'code'],
      ['|---|---|---|', 'code'],
      ['| 标题 | 工作区说明 | 当前文档名称 |', 'code'],
      ['| 状态 | 示例 | 不代表已保存 |', 'code'],
      ['| 位置 | 示例路径 | 不对应真实目录 |', 'code'],
      ['---', 'hr'],
      ['## 内容预览', 'h2'],
      ['这里保留常见的标题、列表、分隔线与表格排版。', 'p'],
      ['此独立预览不包含文档编辑或文件存储能力。', 'p'],
    ]
    for (const [text, kind] of lines) {
      if (kind === 'hr') { body.append(el('div', 'sep')); continue }
      body.append(el('div', `doc-line ${kind}`, text))
    }
    const ctx = el('div', 'doc-ctx',
      el('div', 'ctx-title', '关联会话示例'),
      el('div', 'ctx-item on', el('span', 'sdot'), '会话示例 A'),
      el('div', 'ctx-item', el('span', 'sdot gray'), '会话示例 B'))
    const tabDescriptions = {
      '文件': '文件视图用于展示资料浏览区域；当前未连接文件系统。',
      '来源资料': '来源资料视图用于展示资料内容区域；当前未连接资料服务。',
      '交付物': '交付物视图用于展示输出区域；当前没有真实交付内容。',
      '版本': '版本视图用于展示版本信息区域；当前没有真实版本记录。',
    }
    const tabs = panelTabs(panel, label => {
      docName.textContent = `${label}.md`
      docSub.textContent = '界面预览 · 未连接真实资料'
      renderNeutralTabContent(body, label, tabDescriptions[label] || '此视图仅为中性界面示例。')
    })
    content.append(head)
    if (tabs) {
      content.append(tabs)
      const label = panel.tabs.includes(panel.activeTab) ? panel.activeTab : panel.tabs[0]
      docName.textContent = `${label}.md`
      docSub.textContent = '界面预览 · 未连接真实资料'
      renderNeutralTabContent(body, label, tabDescriptions[label] || '此视图仅为中性界面示例。')
    }
    content.append(body, ctx)
    return () => content.replaceChildren()
  },

  /* ---- 文件面板（静态布局示例） ---- */
  files(_panel, content) {
    if (typeof window.businessBridge?.renderCompanion === 'function') return window.businessBridge.renderCompanion(_panel, content, 'files')
    const tabs = el('div', 'file-tabs', chip('目录树', 'on'), chip('页签'), chip('网格'))
    const head = el('div', 'file-head',
      iconBtn('⌂', '主目录'), iconBtn('↑', '上级'), iconBtn('↻', '刷新'),
      el('div', 'path', '示例工作区 / 文档'))
    const list = el('div', 'ftree scroll')
    const rows = [
      ['dir', '文档', '', '', 0],
      ['dir', '图片', '', '', 0],
      ['dir', '项目资料', '', '', 0],
      ['dir', '示例目录 A', '', '', 0],
      ['dir', '示例目录 B', '', '', 0],
      ['dir', '预览内容', '', '', 0],
      ['dir', '归档', '', '', 0],
      ['dir', '临时文件', '', '', 0],
      ['md', '工作区说明.md', '示例', '', 1],
      ['md', '会议记录.md', '示例', '', 0],
      ['md', 'README.md', '示例', '', 0],
    ]
    for (const [ic, nm, sz, dt, sel] of rows) list.append(fileRow(ic, nm, sz, dt, sel))
    content.append(tabs, head, list)
    return () => content.replaceChildren()
  },

  /* ---- 聊天面板（消息动作 / 输入区 / 任务条） ---- */
  chat(panel, content) {
    if (typeof window.businessBridge?.renderRolePanel === 'function') return window.businessBridge.renderRolePanel(panel, content)
    const fixedAgent = String(panel.title || '').includes('🔒')
    const head = el('div', 'p-head',
      el('span', 'name', panel.title),
      fixedAgent ? null : el('span', 'tri', '▾'),
      el('span', 'meta', '会话示例'),
      el('div', 'right', tag('界面预览', 'info')))
    const body = el('div', 'chat-body')
    if (panel.taskbar) {
      body.append(el('div', 'task-bar',
        el('span', '', '任务状态示例'), el('span', 'tri', '▼')))
    }
    body.append(el('div', 'msg sys',
      el('div', 'who', '系统示例'),
      el('div', 'bubble', '这里展示系统提示或工具调用的消息样式。')))
    body.append(el('div', 'msg sys',
      el('div', 'who', '系统示例'),
      el('div', 'bubble', '此处为一条独立的示例消息，不读取真实文件。')))
    body.append(el('div', 'msg',
      el('div', 'who', 'AI'),
      el('div', 'bubble',
        '这是一条用于展示消息排版的示例回复。',
        el('br'),
        '会话内容不会发送或保存。'),
      el('div', 'mrow',
        el('span', 'pill', '用量示例'), el('span', 'pill', '耗时示例'), el('span', 'pill', '时间示例')),
      (() => {
        const a = el('div', 'msg-actions')
        for (const g of ['⧉', '👍', '👎', '⑂', '◔', '⏱']) a.append(iconBtn(g, '消息动作'))
        return a
      })()))
    body.append(el('div', 'msg user', el('div', 'who', '我'), el('div', 'bubble', '请展示一段用户消息。')))
    body.append(el('div', 'msg',
      el('div', 'who', 'AI'),
      el('div', 'bubble', '这里展示另一条示例回复与对话间距。')))
    const composer = el('div', 'composer',
      el('div', 'comp-box',
        el('div', 'comp-ph', '输入消息（界面示例，不会发送）'),
        el('div', 'comp-tools',
          iconBtn('+', '添加示例'), chip('权限示例 ▾'),
          el('div', 'right',
            el('span', 'model-pick', '模型示例 ▾'),
            el('div', 'round-btn send', '↑')))))
    content.append(head, body, composer)
    return () => content.replaceChildren()
  },

  /* ---- 网页内容区示例（静态，不加载真实网站） ---- */
  webai(panel, content) {
    const head = el('div', 'p-head',
      el('span', 'name', '网页助手示例'),
      el('span', 'meta', '静态界面预览'),
      el('div', 'right',
        el('span', 'row', el('span', 'sdot gray'), tag('未连接')),
        iconBtn('↻', '刷新示例'), tag('网页区域示例')))
    const web = el('div', 'web')
    const side = el('div', 'web-side' + (panel.fold ? ' fold' : ''))
    side.append(el('div', 'web-logo', el('span', '', '◉'), '网页预览'))
    side.append(el('div', 'web-new', '＋ 新建示例'))
    const hist = el('div', 'web-hist')
    for (const [t, on] of [['最近', 0], ['会话示例 A', 1], ['会话示例 B', 0], ['文档预览示例', 0], ['工作流示例', 0], ['项目预览示例', 0], ['布局演示', 0]]) {
      hist.append(el('div', `h ${on ? 'on' : ''}`, t))
    }
    side.append(hist)
    side.append(el('div', 'web-logo', el('span', '', '○'), '预览账户'))
    const main = el('div', 'web-main')
    if (panel.welcome) {
      main.append(el('div', 'web-welcome',
          el('div', 'hi', '网页内容布局示例'),
        (() => {
          const box = el('div', 'web-input')
          box.append(el('div', 'ph', '输入区域示例（不会发送）'))
          box.append(el('div', 'tools', chip('模式示例'), chip('搜索示例'), el('div', 'round-blue', '↑')))
          return box
        })()))
    } else {
      const scroll = el('div', 'scroll')
      scroll.append(el('div', 'msg', el('div', 'bubble', '这里是一条静态消息示例。')))
      scroll.append(el('div', 'msg',
        el('div', 'bubble',
          '网页内容区用于展示消息正文和段落间距。此文字为示例，不代表真实模型回复。'),
        el('div', 'bubble',
          '可在此位置呈现多段文本或列表内容。'),
        el('div', 'bubble',
          '独立预览不会连接网页服务或加载账户历史。'),
        el('div', 'mrow', el('span', 'pill', '引用示例'))))
      const actions = el('div', 'msg-actions')
      for (const g of ['⧉', '↻', '👍', '👎', '🔊', '↗']) actions.append(iconBtn(g, '消息动作'))
      scroll.append(actions)
      scroll.style.padding = '14px 18% 20px'
      main.append(scroll)
    }
    web.append(side, main)
    content.append(head, web)
    return () => content.replaceChildren()
  },

  /* ---- 节点画布示例 ---- */
  canvas(panel, content) {
    if (typeof window.businessBridge?.renderWorkflowPanel === 'function') return window.businessBridge.renderWorkflowPanel(panel, content)
    const tools = el('div', 'c-toolbar',
      chip('⊞ 内容节点 ▾', 'on'), chip('⚙ 方式节点 ▾'), chip('🔧 工具节点 ▾'), chip('👁 看板点 ▾'),
      chip('适应'), chip('整理'), chip('状态'), chip('Markdown'), chip('清空'))
    const canvas = el('div', 'canvas')
    const nodes = [
      { x: 3, y: 22, t: '内容输入', av: '◉', lines: ['输入内容示例', '可连接后续步骤'], foot: '节点示例', sel: 0 },
      { x: 30, y: 8, t: '处理步骤', av: '◇', lines: ['步骤说明示例', '参数配置示例'], foot: '节点示例' },
      { x: 32, y: 44, t: '条件判断', av: '◈', lines: ['条件内容示例'], foot: '' },
      { x: 62, y: 20, t: '工具步骤', av: '□', lines: ['未连接工具'], foot: '' },
      { x: 60, y: 48, t: '输出预览', av: '▤', lines: ['输出内容示例', '尚未运行'], foot: '示例节点' },
      { x: 4, y: 52, t: '资料节点', av: '▧', lines: ['资料引用示例'], foot: '' },
      { x: 36, y: 70, t: '结束', av: '○', lines: ['流程示例'], foot: '', run: 1 },
    ]
    for (const n of nodes) {
      const node = el('div', `node ${n.sel ? 'sel' : ''} ${n.run ? 'run' : ''}`)
      node.style.left = n.x + '%'; node.style.top = n.y + '%'
      node.append(el('div', 'n-head', el('span', 'av', n.av), n.t))
      for (const l of n.lines) node.append(el('div', 'n-line', l))
      if (n.foot) node.append(el('div', 'n-foot', el('span', 'tag ok', n.foot)))
      node.append(el('div', 'port r'), el('div', 'port l'))
      canvas.append(node)
    }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('class', 'wire'); svg.setAttribute('width', '100%'); svg.setAttribute('height', '100%')
    const paths = [['22,32', '30,16'], ['32,30', '32,50'], ['50,22', '62,28'], ['48,52', '60,56'], ['16,58', '36,74']]
    for (const [from, to] of paths) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path')
      const [x1, y1] = from.split(',').map(Number); const [x2, y2] = to.split(',').map(Number)
      p.setAttribute('d', `M ${x1 * 6} ${y1 * 4} C ${x1 * 6 + 60} ${y1 * 4}, ${x2 * 6 - 60} ${y2 * 4}, ${x2 * 6} ${y2 * 4}`)
      p.style.stroke = 'var(--line-2)'; p.setAttribute('fill', 'none'); p.setAttribute('stroke-width', '1.5')
      svg.append(p)
    }
    canvas.append(svg)
    const status = el('div', 'c-status',
      el('span', '', '拖动空白=平移 · 滚轮=缩放'), el('span', '', '节点与连线均为布局示例'),
      el('span', '', '节点示例 7 · 连线示例 5 · 缩放 100%'))
    const canvasView = el('div', 'workflow-canvas-view')
    canvasView.append(tools, canvas, status)
    const plan = el('div', 'doc-body scroll')
    plan.setAttribute('role', 'region')
    plan.setAttribute('aria-label', '业务计划内容预览')
    renderNeutralTabContent(plan, '业务计划', '业务计划视图的内容区域预留在此处；没有加载或保存计划数据。')
    const setWorkflowView = label => {
      const isCanvas = label === '工作流画布'
      canvasView.hidden = !isCanvas
      canvasView.style.display = isCanvas ? 'flex' : 'none'
      plan.hidden = isCanvas
      plan.setAttribute('aria-label', `${label}内容预览`)
      const title = content.closest('.panel')?.querySelector('.panel-title')
      if (title) title.textContent = isCanvas ? '工作流' : `工作流 · ${label}`
    }
    const tabs = panelTabs(panel, setWorkflowView)
    if (tabs) content.append(tabs)
    content.append(canvasView, plan)
    setWorkflowView(panel.activeTab)
    return () => {
      const title = content.closest('.panel')?.querySelector('.panel-title')
      if (title) title.textContent = panel.title
      content.replaceChildren()
    }
  },

  /* ---- 预览（媒体/文档） ---- */
  preview(_panel, content) {
    if (typeof window.businessBridge?.renderCompanion === 'function') return window.businessBridge.renderCompanion(_panel, content, 'preview')
    const media = el('div', 'media')
    media.append(el('div', 'frame', '预览区域示例'))
    media.append(el('div', 'bar',
      el('span', 'mono', '示例文件 / preview.md'),
      el('button', 'p-btn pri', '打开示例')))
    const locate = iconBtn('⌖', '定位', () => showLocalPreview('定位预览', '此界面没有真实文件可定位；文件定位功能未连接。'))
    const close = iconBtn('×', '关闭预览', () => {
      media.replaceChildren(el('div', 'frame', '当前没有打开的预览'))
    })
    const head = el('div', 'p-head', el('span', 'name', '预览'),
      el('div', 'right', locate, iconBtn('⤓', '下载'), iconBtn('⤢', '全屏'), close))
    content.append(head, media)
    return () => content.replaceChildren()
  },

  /* ---- 状态卡片示例 ---- */
  monitor(_panel, content) {
    const head = el('div', 'p-head', el('span', 'name', '状态面板示例'),
      el('div', 'right', tag('界面示例', 'info'), iconBtn('↻', '刷新示例')))
    const statGrid = el('div', 'stat-grid')
    const stats = [
      ['指标 A', '示例', '未连接数据源', 38],
      ['指标 B', '示例', '未连接数据源', 34],
      ['指标 C', '示例', '未连接数据源', 25],
      ['指标 D', '示例', '未连接数据源', 55],
      ['状态项', '示例', '仅作布局展示', 100],
      ['进度项', '示例', '仅作布局展示', 90],
    ]
    for (const [lb, vl, sub, pct] of stats) {
      const s = el('div', 'stat')
      s.append(el('div', 'lb', lb), el('div', 'vl', vl), el('div', 'sub', sub))
      const bar = el('div', 'bar'); const fill = el('i'); fill.style.width = pct + '%'
      if (pct >= 90) fill.style.background = 'var(--green)'
      bar.append(fill); s.append(bar)
      statGrid.append(s)
    }
    const tree = el('div', 'pad')
    tree.append(el('div', 'sep'))
    for (const nm of ['服务示例 A', '服务示例 B', '任务示例', '数据源示例', '组件示例']) {
      tree.append(el('div', 'frow', el('span', 'ic', '▸'), el('span', 'nm', nm), tag('未连接', '')))
    }
    content.append(head, statGrid, tree)
    return () => content.replaceChildren()
  },

  /* ---- 命令行布局示例 ---- */
  terminal(_panel, content) {
    const head = el('div', 'p-head', el('span', 'name', '命令行示例'),
      el('div', 'right', tag('未连接', 'info'), iconBtn('↻', '重连示例')))
    const term = make('div', 'term')
    term.innerHTML =
      `<span class="p">workspace</span>:<span class="c">~</span>$ command-example\n` +
      `此处为静态终端布局示例。\n` +
      `未建立本机或远程连接，也不会执行命令。\n` +
      `<span class="p">workspace</span>:<span class="c">~</span>$ <span class="w">_</span>`
    content.append(head, term)
    return () => content.replaceChildren()
  },

  /* ---- 技能管理卡片 ---- */
  skills(_panel, content) {
    const head = el('div', 'p-head', el('span', 'name', '技能管理'),
      el('div', 'right', tag('技能示例'), iconBtn('＋', '新建示例')))
    const cardGrid = el('div', 'card-grid')
    const cards = [
      ['技能示例 A', '用于展示技能卡片标题和说明文本。', 'ok'],
      ['技能示例 B', '静态内容，不对应已安装技能。', 'ok'],
      ['技能示例 C', '用于演示状态标签与辅助信息。', 'ok'],
      ['技能示例 D', '此独立预览不会执行技能。', 'ok'],
      ['技能示例 E', '仅为布局占位内容。', 'warn'],
      ['技能示例 F', '不读取本地目录或个人资料。', 'ok'],
      ['技能示例 G', '用于展示多列卡片排版。', 'ok'],
      ['技能示例 H', '未连接任何工具服务。', 'ok'],
    ]
    for (const [t, d, st] of cards) {
      const c = el('div', 'scard')
      c.append(el('div', 't', el('span', 'sdot ' + (st === 'ok' ? '' : 'gray')), t))
      c.append(el('div', 'd', d))
      c.append(el('div', 'f', tag('示例', st === 'ok' ? 'ok' : 'warn'), chip('预览'), chip('设置示例')))
      cardGrid.append(c)
    }
    content.append(head, cardGrid)
    return () => content.replaceChildren()
  },

  /* ---- 插件卡片示例 ---- */
  tools(_panel, content) {
    const head = el('div', 'p-head', el('span', 'name', '插件界面示例'),
      el('div', 'right', tag('未连接', 'info'), iconBtn('＋', '添加示例')))
    const cardGrid = el('div', 'card-grid')
    for (const [t, v, d] of [
      ['插件示例 A', '示例', '插件说明区域示例'],
      ['插件示例 B', '示例', '状态标签和版本位置示例'],
      ['插件示例 C', '示例', '未安装或启用任何插件'],
      ['插件示例 D', '示例', '不连接工具或MCP服务'],
      ['插件示例 E', '示例', '用于展示卡片布局'],
      ['插件示例 F', '示例', '此列表不是已安装清单'],
    ]) {
      const c = el('div', 'scard')
      c.append(el('div', 't', el('span', 'sdot'), t))
      c.append(el('div', 'd', d))
      c.append(el('div', 'f', tag('示例', 'info'), chip(v)))
      cardGrid.append(c)
    }
    content.append(head, cardGrid)
    return () => content.replaceChildren()
  },

  /* ---- 图片工具布局示例 ---- */
  imagetool(panel, content) {
    const head = el('div', 'p-head', el('span', 'name', panel.title || '图片工具示例'),
      el('div', 'right', iconBtn('↻', '刷新示例'), iconBtn('⤢', '全屏示例')))
    const row1 = el('div', 'tools-row',
      el('span', 'lb', '查看'), chip('适应'), chip('100%'), chip('+'), chip('−'), chip('框选'), chip('打开图片'), chip('系统打开'))
    const row2 = el('div', 'tools-row',
      el('span', 'lb', '编辑'), chip('完成示例'), chip('重置示例'), chip('移除选中项'))
    const row3 = el('div', 'tools-row',
      el('span', 'lb', '工具'), chip('选择示例'), chip('绘制示例'),
      el('span', 'lb', '模式'), chip('预览 ▾'),
      el('span', 'lb', '框高'), el('input', 'num-in'), el('span', 'lb', 'px'),
      el('span', 'lb', '框宽'), el('input', 'num-in'), el('span', 'lb', '%'),
      el('span', 'chk', el('span', 'box on'), '等像素'))
    const media = el('div', 'media')
    media.append(el('div', 'frame', '图片内容预览示例'))
    media.append(el('div', 'bar', tag('输入示例', 'info'), tag('输出示例', 'ok'), el('span', 'mono', '尺寸信息示例')))
    content.append(head, row1, row2, row3, media)
    return () => content.replaceChildren()
  },

  /* ---- 日志面板 ---- */
  log(_panel, content) {
    if (typeof window.businessBridge?.renderBusinessPanel === 'function') return window.businessBridge.renderBusinessPanel(_panel, content, _panel.path)
    const head = el('div', 'p-head', el('span', 'name', '日志界面示例'),
      el('div', 'right', chip('全部', 'on'), chip('错误'), chip('警告'), iconBtn('⤓', '导出')))
    const term = make('div', 'term')
    term.innerHTML =
      `[--:--:--] <span class="p">INFO</span>  示例日志行 A\n` +
      `[--:--:--] <span class="p">INFO</span>  示例日志行 B\n` +
      `[--:--:--] <span class="w">WARN</span>  示例警告信息\n` +
      `[--:--:--] <span class="p">INFO</span>  示例状态记录\n` +
      `[--:--:--] <span class="e">ERROR</span> 示例错误信息\n` +
      `           此处不对应真实调用栈\n` +
      `           未连接运行服务\n` +
      `[--:--:--] <span class="p">INFO</span>  示例事件完成\n` +
      `[--:--:--] <span class="p">INFO</span>  示例工具调用记录\n` +
      `[--:--:--] <span class="p">INFO</span>  示例文件操作记录\n`
    content.append(head, term)
    return () => content.replaceChildren()
  },
}
const unsupportedRenderer = (panel, content) => {
  content.append(el('p', 'reserved-copy', `暂不支持的面板类型：${panel.type}`))
  return () => content.replaceChildren()
}

/* ============================================================
   场景标签栏（照搬源码 initScenarioTabBar：拖拽换位 / 收成图标 / 分离）
   ============================================================ */
const TABBAR_VERSION = 'tabs-2026-09-26.1'
const TAB_COLLAPSED_W = 33
const SCENE_ICONS = Object.freeze({
  center: 'M3 3h5v5H3zM12 3h5v5h-5zM3 12h5v5H3zM12 12h5v5h-5z',
  products: 'm10 2.5 7 4v7l-7 4-7-4v-7l7-4ZM3 6.5l7 4 7-4M10 10.5v7',
  'agent-center': 'M7 3.5H5a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-12a1 1 0 0 0-1-1h-2M7 2.5h6v3H7zM7 8h6M7 11h6M7 14h4',
  deliverables: 'M3 4.5h14v3H3zM4 7.5v9h12v-9M8 11h4m-2-2v5m-2-2 2 2 2-2',
  runs: 'M17.5 10a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0ZM10 5.5v5l3.5 2',
  'user-profile': 'M13 6.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM3.5 17c.7-3.1 3.1-4.8 6.5-4.8s5.8 1.7 6.5 4.8',
  erpnext: 'M3 4a1.5 1.5 0 0 1 1.5-1.5h11A1.5 1.5 0 0 1 17 4v12a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16ZM6 6h8M6 9h8M6 12h3M11.5 12H14M6 15h3M11.5 15H14',
})
function createSceneIcon(scene) {
  const key = scene.templateSceneId ?? scene.id
  const shape = Object.hasOwn(SCENE_ICONS, key) ? SCENE_ICONS[key] : 'M16 10a6 6 0 1 1-12 0 6 6 0 0 1 12 0Z'
  return createReplicaIcon(shape, '0 0 20 20')
}

function tabListOf(nav) {
  return Array.prototype.filter.call(nav.children, n => n && n.classList && n.classList.contains('tab'))
}
/** 落点 → 目标下标（纯函数，规则与浏览器标签页一致） */
function tabDropIndex(rects, dropX) {
  for (let i = 0; i < rects.length; i++) {
    if (dropX < (rects[i].left + rects[i].right) / 2) return i
  }
  return rects.length
}
/** 其它标签平移时用 FLIP 补动画 */
function flipNav(nav, mutate) {
  const tabs = tabListOf(nav)
  tabs.forEach(t => { t.style.transition = 'none'; t.style.transform = '' })
  void nav.offsetWidth
  const before = tabs.map(t => t.getBoundingClientRect().left)
  mutate()
  const after = tabs.map(t => t.getBoundingClientRect().left)
  tabs.forEach((t, i) => {
    const d = before[i] - after[i]
    if (!d || Math.abs(d) < 0.5) return
    t.style.transition = 'none'
    t.style.transform = `translateX(${d}px)`
    requestAnimationFrame(() => { t.style.transition = ''; t.style.transform = '' })
  })
}
/** 收起 / 展开：激活的、悬停的、正在拖的始终展开 */
function applyTabCollapse(nav, keepOpen) {
  tabListOf(nav).forEach(t => {
    const open = t === keepOpen || t.classList.contains('active') || t.classList.contains('tab-dragging')
    t.classList.toggle('tab-collapsed', !open)
  })
}
function measureTabWidths(nav) {
  const tabs = tabListOf(nav)
  tabs.forEach(t => {
    t.classList.remove('tab-collapsed')
    t.style.removeProperty('--tab-w')
    t.style.removeProperty('--label-w')
  })
  tabs.forEach(t => {
    const w = Math.ceil(t.getBoundingClientRect().width)
    if (w > 0) t.style.setProperty('--tab-w', (w + 1) + 'px')
    const lab = t.querySelector('.tab-label')
    if (lab) {
      const lw = Math.ceil(lab.scrollWidth)
      if (lw > 0) t.style.setProperty('--label-w', lw + 'px')
    }
    t.style.setProperty('--tab-cw', TAB_COLLAPSED_W + 'px')
  })
}

function initScenarioTabBar(opts) {
  opts = opts || {}
  const nav = opts.nav || document.getElementById('scenario-tabs')
  if (!nav) return null
  if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) {
    measureTabWidths(nav); applyTabCollapse(nav); return null
  }
  nav.setAttribute('data-tabbar', TABBAR_VERSION)
  measureTabWidths(nav)

  let drag = null, suppressClick = false, suppressTimer = null

  // 悬停丝滑展开（事件委托：标签重建也不用重绑）
  nav.addEventListener('mouseover', e => {
    const t = e.target && e.target.closest ? e.target.closest('.tab') : null
    if (t && t.parentNode === nav) applyTabCollapse(nav, t)
  })
  nav.addEventListener('mouseout', e => {
    const t = e.target && e.target.closest ? e.target.closest('.tab') : null
    if (!t || t.parentNode !== nav) return
    const to = e.relatedTarget
    if (to && t.contains(to)) return
    applyTabCollapse(nav)
  })

  const beginDrag = () => {
    const t = drag.tab
    drag.width = t.offsetWidth; drag.height = t.offsetHeight
    drag.startLeft = t.offsetLeft; drag.startTop = t.offsetTop
    const ph = make('div', 'tab-placeholder')
    ph.style.width = drag.width + 'px'; ph.style.height = drag.height + 'px'
    nav.insertBefore(ph, t)
    drag.ph = ph
    t.classList.add('tab-dragging')
    t.style.position = 'absolute'
    t.style.width = drag.width + 'px'; t.style.height = drag.height + 'px'
    t.style.left = drag.startLeft + 'px'; t.style.top = drag.startTop + 'px'
    nav.classList.add('tabs-dragging')
    drag.started = true
    drag.curTarget = -1
    applyTabCollapse(nav, t)
  }
  const placeTarget = target => {
    const others = tabListOf(nav).filter(x => x !== drag.tab)
    flipNav(nav, () => {
      if (target >= others.length) nav.appendChild(drag.ph)
      else nav.insertBefore(drag.ph, others[target])
    })
  }
  const edgeScroll = clientX => {
    const nr = nav.getBoundingClientRect()
    const max = nav.scrollWidth - nav.clientWidth
    if (max <= 0) return
    if (clientX < nr.left + 30) nav.scrollLeft = Math.max(0, nav.scrollLeft - 8)
    else if (clientX > nr.right - 30) nav.scrollLeft = Math.min(max, nav.scrollLeft + 8)
  }

  const onDown = e => {
    if (e.button !== 0) return
    const t = e.target && e.target.closest ? e.target.closest('.tab') : null
    if (!t || t.parentNode !== nav) return
    if (e.target.closest('.tab-detach')) return          // ⧉ 有自己的逻辑
    if (tabListOf(nav).some(x => x.classList.contains('tab-dragging'))) return
    drag = { tab: t, id: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, scrollAt: nav.scrollLeft }
    try { t.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  }
  const onMove = e => {
    if (!drag || e.pointerId !== drag.id) return
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.startX) < 5 && Math.abs(e.clientY - drag.startY) < 5) return  // 5px 内算点击
      beginDrag()
    }
    if (e.cancelable) e.preventDefault()
    const scrollDelta = nav.scrollLeft - drag.scrollAt
    drag.tab.style.left = (drag.startLeft + (e.clientX - drag.startX) + scrollDelta) + 'px'
    const nr = nav.getBoundingClientRect()
    const dropX = e.clientX - (nr.left + nav.clientLeft) + nav.scrollLeft
    const others = tabListOf(nav).filter(x => x !== drag.tab)
    const rects = others.map(x => ({ left: x.offsetLeft, right: x.offsetLeft + x.offsetWidth }))
    const target = tabDropIndex(rects, dropX)
    if (target !== drag.curTarget) { drag.curTarget = target; placeTarget(target) }
    edgeScroll(e.clientX)
  }
  const onUp = e => {
    if (!drag || e.pointerId !== drag.id) return
    if (!drag.started) { drag = null; return }   // 没拖动 ⇒ 放行 click（正常切场景）
    const t = drag.tab, ph = drag.ph
    suppressClick = true                          // 拖完这一下不算点击
    if (suppressTimer) clearTimeout(suppressTimer)
    suppressTimer = setTimeout(() => { suppressClick = false }, 500)
    drag = null
    t.style.transition = 'left .16s cubic-bezier(.2,.8,.2,1), transform .16s ease'
    t.style.left = ph.offsetLeft + 'px'
    setTimeout(() => {
      nav.insertBefore(t, ph)
      t.classList.remove('tab-dragging')
      ;['position', 'width', 'height', 'left', 'top', 'transition', 'zIndex'].forEach(k => t.style.removeProperty(k))
      if (ph.parentNode) ph.parentNode.removeChild(ph)
      nav.classList.remove('tabs-dragging')
      measureTabWidths(nav); applyTabCollapse(nav)
      if (typeof opts.persist === 'function') {
        try {
          opts.persist(tabListOf(nav).map(x => x.dataset.scId).filter(Boolean))
        } catch { /* 存档失败不影响已换好的位置 */ }
      }
    }, 170)
  }
  nav.addEventListener('click', e => {
    if (!suppressClick) return
    e.stopPropagation(); e.preventDefault()
  }, true)
  nav.addEventListener('pointerdown', onDown)
  nav.addEventListener('pointermove', onMove)
  nav.addEventListener('pointerup', onUp)
  nav.addEventListener('pointercancel', onUp)
  applyTabCollapse(nav)
  return { version: TABBAR_VERSION, refresh: () => { measureTabWidths(nav); applyTabCollapse(nav) } }
}

/* ============================================================
   面板：挂载（序号徽标 + 展开箭头 + 拖拽吸附）
   ============================================================ */
function panelHead(meta) {
  const head = el('div', 'panel-header')
  const grip = make('span', 'grip', '⠿'); grip.title = '拖拽移动面板'
  const badge = el('span', 'panel-badge', String((meta._idx || 0) + 1).padStart(2, '0'))
  badge.title = '面板序号'
  const identity = el('div', 'panel-identity')
  identity.append(el('strong', 'panel-title', meta.title))
  if (meta.sub) identity.append(el('span', 'panel-sub', meta.sub))
  head.append(grip, badge, identity)
  return { head, grip, identity }
}

function createPanelExpandIcon() {
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  icon.setAttribute('viewBox', '0 0 24 20')
  icon.setAttribute('aria-hidden', 'true')
  icon.setAttribute('focusable', 'false')
  const addLayer = (className, layers) => {
    const group = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    group.setAttribute('class', className)
    for (const layer of layers) {
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
      rect.setAttribute('x', layer.x); rect.setAttribute('y', layer.y)
      rect.setAttribute('width', layer.width); rect.setAttribute('height', layer.height)
      rect.setAttribute('rx', '1.1')
      rect.setAttribute('transform', layer.transform)
      rect.setAttribute('fill', layer.front ? 'var(--panel-header)' : 'none')
      rect.setAttribute('stroke', layer.front ? 'currentColor' : 'var(--text-dim)')
      rect.setAttribute('stroke-width', layer.front ? '1.35' : '1.1')
      group.append(rect)
    }
    icon.append(group)
  }
  const horizontal = { x: 2, y: 6, width: 15, height: 8, transform: 'rotate(-4 9.5 10)', front: true }
  const vertical = { x: 9, y: 2.5, width: 8, height: 15, transform: 'rotate(-4 13 10)', front: false }
  addLayer('panel-expand-icon-normal', [vertical, horizontal])
  addLayer('panel-expand-icon-extended', [{ ...horizontal, front: false }, { ...vertical, front: true }])
  return icon
}

function setPanelExpandControl(button, expanded) {
  if (!button) return
  const label = expanded ? '还原面板高度' : '向上延长面板'
  button.dataset.extended = expanded ? 'true' : 'false'
  button.setAttribute('aria-pressed', String(Boolean(expanded)))
  button.setAttribute('aria-label', label)
  button.title = label
}

function layoutGeometry({ id, col, row, w, h }) {
  return { id, col, row, w, h }
}

function makePanel(meta, idx) {
  const wrap = make('section', `panel panel-${meta.type}`)
  if (meta.focus) wrap.classList.add('focus')
  wrap.dataset.panelId = meta.id
  wrap.dataset.col = meta.col; wrap.dataset.row = meta.row
  wrap.dataset.w = meta.w; wrap.dataset.h = meta.h
  wrap.__meta = { ...meta, _idx: idx }
  wrap.__defaultLayoutGeometry = layoutGeometry(meta)
  applyGeom(wrap)
  const { head, grip, identity } = panelHead({ ...meta, _idx: idx })

  // 所有面板都可纵向延长；双击全屏仍由 panel-interactions 单独处理。
  const controls = make('div', 'panel-controls')
  const exp = el('button', 'panel-expand')
  exp.type = 'button'
  exp.append(createPanelExpandIcon())
  setPanelExpandControl(exp, false)
  exp.addEventListener('click', ev => {
    ev.preventDefault(); ev.stopPropagation()
    if (expandedStateOf(wrap)) collapsePanel(wrap)
    else expandPanel(wrap, exp)
  })
  identity.append(exp)
  const refresh = iconBtn(createReplicaIcon('M20 11a8 8 0 1 0-2 6M20 4v7h-7'), '刷新面板', () => {
    try { cleanups.get(meta.id)?.() } catch { /* ignore */ }
    const body = wrap.querySelector('.panel-content'); body.replaceChildren()
    cleanups.set(meta.id, (rendererRegistry[meta.type] || unsupportedRenderer)(meta, body))
  })
  controls.append(refresh)
  head.append(controls)

  const content = make('div', 'panel-content')
  wrap.append(head, content)
  grid.append(wrap)
  cleanups.set(meta.id, (rendererRegistry[meta.type] || unsupportedRenderer)(meta, content))
  attachDrag(wrap, head, grip)
  return wrap
}

function applyGeom(panel, expanded) {
  if (expanded) return   // 展开态由 expandPanel 用内联 fixed 坐标接管
  panel.style.position = ''
  panel.style.gridColumn = `${panel.dataset.col} / span ${panel.dataset.w}`
  panel.style.gridRow = `${panel.dataset.row} / span ${panel.dataset.h}`
  ;['left', 'top', 'width', 'height', 'zIndex'].forEach(k => panel.style.removeProperty(k))
}

function createPanelExpansionSlot(wrap) {
  const slot = make('div', 'panel-slot')
  const gridRect = grid.getBoundingClientRect()
  const wrapRect = wrap.getBoundingClientRect()
  const gridStyle = getComputedStyle(grid)
  const scaleX = gridRect.width / Math.max(1, grid.offsetWidth)
  const scaleY = gridRect.height / Math.max(1, grid.offsetHeight)
  const borderLeft = parseFloat(gridStyle.borderLeftWidth) || 0
  const borderRight = parseFloat(gridStyle.borderRightWidth) || 0
  const borderTop = parseFloat(gridStyle.borderTopWidth) || 0
  const borderBottom = parseFloat(gridStyle.borderBottomWidth) || 0
  const paddingLeft = parseFloat(gridStyle.paddingLeft) || 0
  const paddingRight = parseFloat(gridStyle.paddingRight) || 0
  const paddingTop = parseFloat(gridStyle.paddingTop) || 0
  const paddingBottom = parseFloat(gridStyle.paddingBottom) || 0
  const contentBoxWidth = Math.max(1, grid.offsetWidth - borderLeft - borderRight - paddingLeft - paddingRight)
  const contentBoxHeight = Math.max(1, grid.offsetHeight - borderTop - borderBottom - paddingTop - paddingBottom)
  const originX = gridRect.left + (borderLeft + paddingLeft) * scaleX
  const originY = gridRect.top + (borderTop + paddingTop) * scaleY
  const percent = (value, extent) => `${value / extent * 100}%`
  slot.style.position = 'absolute'
  slot.style.gridColumn = '1 / -1'
  slot.style.gridRow = '1 / -1'
  slot.style.left = percent((wrapRect.left - originX) / scaleX, contentBoxWidth)
  slot.style.top = percent((wrapRect.top - originY) / scaleY, contentBoxHeight)
  slot.style.width = percent(wrapRect.width / scaleX, contentBoxWidth)
  slot.style.height = percent(wrapRect.height / scaleY, contentBoxHeight)
  return slot
}

function restorePanelExpansionLayout(wrap, state) {
  if (state.originalStyle === null) wrap.removeAttribute('style')
  else wrap.setAttribute('style', state.originalStyle)
  if (state.originalManaged === undefined) delete wrap.dataset.splitTreeManaged
  else wrap.dataset.splitTreeManaged = state.originalManaged
}

/* ---- 面板展开/收起（照搬源码：占位格 + position:fixed 撑满网格高，ESC 逐层收） ---- */
function expandedStateOf(wrap) {
  return panelExpandStates.find(s => s.wrap === wrap) || null
}
function expandPanel(wrap, btn) {
  const endGeometry = window.sourcePanelGeometryProof?.begin([wrap], 'extend')
  const originalStyle = wrap.getAttribute('style')
  const originalManaged = wrap.dataset.splitTreeManaged
  let slot
  try {
    slot = createPanelExpansionSlot(wrap)
    grid.insertBefore(slot, wrap)
    const g = grid.getBoundingClientRect()
    const s = slot.getBoundingClientRect()
    const from = wrap.getBoundingClientRect()
    const to = { left: s.left, top: g.top, width: s.width, height: g.height }
    wrap.style.position = 'fixed'
    wrap.style.zIndex = String(++panelExpandZ)
    wrap.style.left = Math.round(from.left) + 'px'
    wrap.style.top = Math.round(from.top) + 'px'
    wrap.style.width = Math.round(from.width) + 'px'
    wrap.style.height = Math.round(from.height) + 'px'
    wrap.classList.add('panel-expanded')
    requestAnimationFrame(() => {
      wrap.classList.add('panel-anim')
      wrap.style.left = Math.round(to.left) + 'px'
      wrap.style.top = Math.round(to.top) + 'px'
      wrap.style.width = Math.round(to.width) + 'px'
      wrap.style.height = Math.round(to.height) + 'px'
      setTimeout(() => { wrap.classList.remove('panel-anim'); endGeometry?.() }, 340)
    })
    if (btn) setPanelExpandControl(btn, true)
    const onResize = () => {
      if (!wrap.isConnected) { collapsePanel(wrap); return }
      try {
        wrap.classList.remove('panel-anim')
        const g2 = grid.getBoundingClientRect()
        const s2 = slot.getBoundingClientRect()
        wrap.style.left = Math.round(s2.left) + 'px'
        wrap.style.top = Math.round(g2.top) + 'px'
        wrap.style.width = Math.round(s2.width) + 'px'
        wrap.style.height = Math.round(g2.height) + 'px'
      } catch { /* ignore */ }
    }
    const onKey = e => {
      if (!wrap.isConnected) { collapsePanel(wrap); return }
      // ESC 只收最上层那个（最后展开的），连按逐个退栈
      if (e.key === 'Escape' && panelExpandStates[panelExpandStates.length - 1] === st) {
        e.preventDefault(); collapsePanel(wrap)
      }
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('keydown', onKey, true)
    const st = { wrap, slot, btn, onResize, onKey, originalStyle, originalManaged }
    panelExpandStates.push(st)
  } catch {
    if (slot?.parentNode) slot.parentNode.removeChild(slot)
    restorePanelExpansionLayout(wrap, { originalStyle, originalManaged })
    endGeometry?.('cancelled') /* 展开失败保持原状 */
  }
}
function collapsePanel(wrap) {
  const idx = panelExpandStates.findIndex(s => s.wrap === wrap)
  if (idx < 0) return
  const st = panelExpandStates[idx]
  const endGeometry = window.sourcePanelGeometryProof?.begin([wrap], 'collapse')
  panelExpandStates.splice(idx, 1)
  window.removeEventListener('resize', st.onResize)
  document.removeEventListener('keydown', st.onKey, true)
  if (st.btn) setPanelExpandControl(st.btn, false)
  try {
    const s = st.slot.getBoundingClientRect()
    const g = grid.getBoundingClientRect()
    wrap.classList.add('panel-anim')
    wrap.style.left = Math.round(s.left) + 'px'
    wrap.style.top = Math.round(s.top) + 'px'
    wrap.style.width = Math.round(s.width) + 'px'
    wrap.style.height = Math.round(Math.min(s.height, g.height)) + 'px'
    setTimeout(() => {
      wrap.classList.remove('panel-anim', 'panel-expanded')
      restorePanelExpansionLayout(wrap, st)
      if (st.slot.parentNode) st.slot.parentNode.removeChild(st.slot)
      endGeometry?.()
    }, 330)
  } catch {
    wrap.classList.remove('panel-anim', 'panel-expanded')
    restorePanelExpansionLayout(wrap, st)
    if (st.slot.parentNode) st.slot.parentNode.removeChild(st.slot)
    endGeometry?.('cancelled')
  }
}

/* ---- 面板拖拽移动 + 自动吸附到网格（交互保留） ---- */
function attachDrag(panel, handle, grip) {
  let pending = null, dragging = false, moveFrame = null, latestPoint = null
  const restoreStyle = state => {
    if (state.originalStyle === null) panel.removeAttribute('style')
    else panel.setAttribute('style', state.originalStyle)
  }
  const applyPoint = point => {
    if (!panel.isConnected || !dragging || !point) return
    const dx = (point.x - pending.x) / pending.scaleX
    const dy = (point.y - pending.y) / pending.scaleY
    panel.style.translate = `${dx}px ${dy}px`
    const target = findSnapTarget(point.x, point.y, panel)
    grid.querySelectorAll('.panel').forEach(p => p.classList.remove('snap-target'))
    if (target) target.panel.classList.add('snap-target')
  }
  const cancel = () => end({ pointerId: pending?.pointerId }, true)
  const onLostPointerCapture = e => {
    if (pending && e.pointerId === pending.pointerId) end(e, true)
  }
  const start = e => {
    if (e.button !== 0) return
    if (e.target.closest('.icon-control, .panel-expand, .pi-component-tabs')) return
    if (expandedStateOf(panel)) return
    if (pending || dragging || activePanelDragCancel) return
    const rect = panel.getBoundingClientRect()
    const layoutWidth = panel.offsetWidth || rect.width
    const layoutHeight = panel.offsetHeight || rect.height
    pending = {
      pointerId: e.pointerId, x: e.clientX, y: e.clientY,
      scaleX: rect.width / layoutWidth || 1,
      scaleY: rect.height / layoutHeight || 1,
      originalStyle: panel.getAttribute('style'),
    }
    try { handle.setPointerCapture?.(e.pointerId) } catch { pending = null; return }
    activePanelDragCancel = cancel
    window.addEventListener('blur', cancel)
  }
  const move = e => {
    if (!pending || e.pointerId !== pending.pointerId) return
    if (!dragging) {
      if (Math.hypot(e.clientX - pending.x, e.clientY - pending.y) < (window.sourcePanelTabs?.dragThreshold ?? 8)) return
      dragging = true
      panel.classList.add('dragging')
      panel.style.zIndex = '10000'
      panel.style.transition = 'none'
    }
    latestPoint = { x: e.clientX, y: e.clientY }
    if (moveFrame !== null) return
    moveFrame = window.requestAnimationFrame(() => {
      moveFrame = null
      applyPoint(latestPoint)
    })
  }
  const end = (e, cancelled = false) => {
    if (!pending && !dragging) return
    if (pending?.pointerId !== e?.pointerId) return
    const state = pending
    if (moveFrame !== null) window.cancelAnimationFrame(moveFrame)
    moveFrame = null
    if (dragging && !cancelled && Number.isFinite(e?.clientX) && Number.isFinite(e?.clientY)) {
      latestPoint = { x: e.clientX, y: e.clientY }
      applyPoint(latestPoint)
    }
    const target = dragging && !cancelled ? findSnapTarget(e.clientX, e.clientY, panel) : null
    const wasDragging = dragging
    pending = null
    dragging = false
    latestPoint = null
    window.removeEventListener('blur', cancel)
    if (activePanelDragCancel === cancel) activePanelDragCancel = null
    panel.classList.remove('dragging', 'snap-target')
    grid.querySelectorAll('.panel').forEach(p => p.classList.remove('snap-target'))
    try {
      if (handle.hasPointerCapture?.(state.pointerId)) handle.releasePointerCapture(state.pointerId)
    } catch { /* capture can be lost before pointerup */ }
    if (!wasDragging) return
    restoreStyle(state)
    if (target && target.panel !== panel) swapGeom(panel, target.panel, target)
  }
  handle.addEventListener('pointerdown', start)
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', end)
  handle.addEventListener('pointercancel', e => end(e, true))
  handle.addEventListener('lostpointercapture', onLostPointerCapture)
  grip.addEventListener('pointerdown', start)
  grip.addEventListener('pointermove', move)
  grip.addEventListener('pointerup', end)
  grip.addEventListener('pointercancel', e => end(e, true))
  grip.addEventListener('lostpointercapture', onLostPointerCapture)
}
function findSnapTarget(x, y, self) {
  let best = null, bestDist = Infinity
  grid.querySelectorAll('.panel').forEach(p => {
    if (p === self || p.classList.contains('pi-closed') || p.classList.contains('pi-tab-inactive')) return
    const r = p.getBoundingClientRect()
    const dx = Math.max(r.left - x, 0, x - r.right)
    const dy = Math.max(r.top - y, 0, y - r.bottom)
    const d = Math.hypot(dx, dy)
    if (d >= bestDist) return
    bestDist = d
    const nx = (x - (r.left + r.width / 2)) / Math.max(1, r.width / 2)
    const ny = (y - (r.top + r.height / 2)) / Math.max(1, r.height / 2)
    const horizontal = Math.abs(nx) >= Math.abs(ny)
    best = {
      panel: p,
      axis: horizontal ? 'x' : 'y',
      side: horizontal ? (nx < 0 ? 'before' : 'after') : (ny < 0 ? 'before' : 'after'),
      insert: dx > 0 || dy > 0 || Math.max(Math.abs(nx), Math.abs(ny)) >= 0.72,
    }
  })
  return bestDist < 260 ? best : null
}
function swapGeom(a, b, drop) {
  a = window.sourcePanelTabs?.slotPanel(a) ?? a
  b = window.sourcePanelTabs?.slotPanel(b) ?? b
  if (drop?.insert) {
    const insert = new CustomEvent('scene-panel-slot-insert', {
      detail: { source: a, target: b, axis: drop.axis, side: drop.side }, cancelable: true,
    })
    window.dispatchEvent(insert)
    if (insert.defaultPrevented) return true
  }
  for (const k of ['col', 'row', 'w', 'h']) {
    const t = a.dataset[k]; a.dataset[k] = b.dataset[k]; b.dataset[k] = t
  }
  // 同步 meta（刷新/展开读的是 meta）
  for (const p of [a, b]) {
    if (p.__meta) {
      p.__meta.col = +p.dataset.col; p.__meta.row = +p.dataset.row
      p.__meta.w = +p.dataset.w; p.__meta.h = +p.dataset.h
    }
  }
  const event = new CustomEvent('scene-panel-slot-swap', { detail: [a, b], cancelable: true })
  window.dispatchEvent(event)
  if (!event.defaultPrevented) { applyGeom(a); applyGeom(b) }
  return false
}

/* ============================================================
   场景加载（照搬源码 loadScenario 的清理/重挂骨架）
   ============================================================ */
function clearScene() {
  for (const cleanup of cleanups.values()) { try { cleanup?.() } catch { /* ignore */ } }
  cleanups.clear()
  // 展开栈清干净（面板要没了）
  for (const st of [...panelExpandStates]) {
    window.removeEventListener('resize', st.onResize)
    document.removeEventListener('keydown', st.onKey, true)
  }
  panelExpandStates = []
  grid.replaceChildren()
  grid.querySelectorAll('.drop-ghost').forEach(n => n.remove())
}

function commitScenario(scene) {
  if (!scene) return false
  activePanelDragCancel?.()
  currentTab = scene.id
  clearScene()
  // Advance the bridge generation before the new role/workflow records capture it.
  // Rendering first would make their ACKs stale when sceneSelected increments it.
  window.businessBridge?.sceneSelected?.(scene)
  grid.style.setProperty('--cols', scene.cols || 4)
  grid.style.setProperty('--rows', scene.rows || 4)
  scene.panels.forEach((p, i) => makePanel({ ...p, sceneId: scene.id }, i))
  // 标签激活态
  const nav = $('#scenario-tabs')
  tabListOf(nav).forEach(t => t.classList.toggle('active', t.dataset.scId === scene.id))
  applyTabCollapse(nav)
  updateSidebarScene(scene)
  if(initialSceneCommit?.id===scene.id){const pending=initialSceneCommit;initialSceneCommit=undefined;pending.resolve(true)}
  return true
}

function loadInitialScenario(id){
  return new Promise((resolve,reject)=>{
    const pending={id,resolve,reject};initialSceneCommit=pending
    Promise.resolve(loadScenario(id)).then(()=>{if(initialSceneCommit===pending){initialSceneCommit=undefined;reject({firstPaintStage:'scene'})}},()=>{if(initialSceneCommit===pending)initialSceneCommit=undefined;reject({firstPaintStage:'scene'})})
  })
}

function runSceneLoadQueue() {
  if (sceneLoadPromise) return sceneLoadPromise
  sceneLoadPromise = (async () => {
    while (sceneHandledVersion < sceneRequestVersion) {
      const attemptVersion = sceneRequestVersion
      let prepared = { ok: true }
      const bridge = window.businessBridge
      if (typeof bridge?.prepareSceneTransition === 'function') {
        try { prepared = await bridge.prepareSceneTransition() }
        catch { prepared = { ok: false } }
      }
      if (prepared?.ok !== true) {
        sceneHandledVersion = attemptVersion
        setStatus('场景切换暂不可用，请重试。', true)
        if (sceneHandledVersion < sceneRequestVersion) continue
        break
      }
      // Requests arriving during hide share that hide barrier. Commit only the
      // latest target; no intermediate scene is rendered or persisted.
      const commitVersion = sceneRequestVersion
      const scene = data.scenes.find(item => item.id === requestedSceneId)
      if (scene) commitScenario(scene)
      sceneHandledVersion = commitVersion
    }
  })().finally(() => {
    sceneLoadPromise = undefined
    if (sceneHandledVersion < sceneRequestVersion) void runSceneLoadQueue()
  })
  return sceneLoadPromise
}

function loadScenario(id) {
  const scene = data.scenes.find(s => s.id === id) || data.scenes[0]
  if (!scene) return Promise.resolve(false)
  requestedSceneId = scene.id
  sceneRequestVersion++
  return runSceneLoadQueue()
}

function updateSidebarScene(scene) {
  const current = document.getElementById('ui-sidebar-current')
  if (current) current.textContent = scene?.name || '工作台'
}

function initSidebarOverlay() {
  const toggle = document.getElementById('ui-sidebar-toggle')
  const sidebar = document.getElementById('ui-sidebar')
  const backdrop = document.getElementById('ui-sidebar-backdrop')
  const close = document.getElementById('ui-sidebar-close')
  if (!toggle || !sidebar || !backdrop || !close) return
  const nativeSidebar = window.businessBridge?.isDesktop?.() === true
  let nativeSidebarReady = false
  let nativeSidebarBusy = false
  const setOpen = open => {
    if (nativeSidebar) {
      toggle.setAttribute('aria-expanded', String(open))
      toggle.setAttribute('aria-label', open ? '关闭侧栏' : '打开侧栏')
      toggle.title = open ? '关闭原生侧栏' : '打开原生侧栏'
      document.body.classList.toggle('native-account-surface', true)
      return
    }
    sidebar.classList.toggle('is-open', open)
    sidebar.setAttribute('aria-hidden', String(!open))
    backdrop.hidden = !open
    toggle.setAttribute('aria-expanded', String(open))
    toggle.setAttribute('aria-label', open ? '关闭侧栏' : '打开侧栏')
    toggle.title = open ? '关闭侧栏' : '打开侧栏'
  }
  if (nativeSidebar) {
    document.body.classList.add('native-account-surface')
    // Desktop mode uses the Host-owned account surface only. Keep the preview
    // drawer in the DOM for browser mode, but never expose or bind it here.
    sidebar.hidden = true
    sidebar.setAttribute('aria-hidden', 'true')
    backdrop.hidden = true
    toggle.disabled = true
    toggle.setAttribute('aria-expanded', 'false')
    toggle.setAttribute('aria-label', '打开原生侧栏')
    toggle.title = '正在等待原生工作区挂载…'
    window.addEventListener('business-sidebar-state', event => {
      if (typeof event.detail === 'boolean') setOpen(event.detail)
    })
    window.addEventListener('business-account-status', event => {
      nativeSidebarReady = event.detail?.status === 'context-mounted'
      toggle.disabled = !nativeSidebarReady || nativeSidebarBusy
      if (nativeSidebarReady) toggle.title = toggle.getAttribute('aria-expanded') === 'true' ? '关闭原生侧栏' : '打开原生侧栏'
      else toggle.title = event.detail?.status === 'unavailable' || event.detail?.status === 'error'
        ? '原生工作区暂不可用' : '正在等待原生工作区挂载…'
    })
    toggle.addEventListener('click', async () => {
      if (!nativeSidebarReady || nativeSidebarBusy) return
      nativeSidebarBusy = true
      toggle.disabled = true
      try {
        const result = await window.businessBridge.toggleSidebar()
        if (result?.ok && typeof result.open === 'boolean') setOpen(result.open)
        else setStatus('原生侧栏暂时不可用。', true)
      } catch { setStatus('原生侧栏暂时不可用。', true) }
      finally {
        nativeSidebarBusy = false
        toggle.disabled = !nativeSidebarReady
      }
    })
  } else {
    toggle.addEventListener('click', () => setOpen(sidebar.getAttribute('aria-hidden') === 'true'))
    close.addEventListener('click', () => setOpen(false))
    backdrop.addEventListener('click', () => setOpen(false))
  }
  if (!nativeSidebar) {
    sidebar.querySelectorAll('[data-sidebar-action]').forEach(button => {
      button.addEventListener('click', () => {
        setOpen(false)
        const action = button.dataset.sidebarAction
        if (action === 'new-session') showLocalPreview('新建会话', '此纯前端预览不创建真实会话，也不发送消息。')
        else if (action === 'workspaces') showLocalPreview('工作区', '此预览不读取或切换真实工作区。')
        else if (action === 'automations') showLocalPreview('自动化', '此预览不读取或运行自动化任务。')
        else if (action === 'settings') showSettings()
      })
    })
    const archive = document.getElementById('ui-sidebar-archive')
    const sessionEmpty = document.getElementById('ui-sidebar-session-empty')
    archive?.addEventListener('click', () => {
      const visible = archive.getAttribute('aria-pressed') !== 'true'
      archive.setAttribute('aria-pressed', String(visible))
      archive.textContent = visible ? '隐藏归档' : '显示归档'
      if (sessionEmpty) sessionEmpty.textContent = visible ? '暂无归档会话' : '暂无会话'
    })
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && sidebar.getAttribute('aria-hidden') === 'false') setOpen(false)
    })
  }
}

function buildTabs() {
  const nav = $('#scenario-tabs')
  nav.replaceChildren()
  nav.removeAttribute('data-tabbar')
  const order = getOrder()
  const byId = new Map(data.scenes.map(s => [s.id, s]))
  const sorted = [...order.map(id => byId.get(id)).filter(Boolean),
                  ...data.scenes.filter(s => !order.includes(s.id))]
  sorted.forEach(scene => {
    const tab = make('button', 'tab' + (scene.id === currentTab ? ' active' : ''))
    tab.type = 'button'
    tab.dataset.id = scene.id
    tab.dataset.scId = scene.id
    tab.dataset.movable = '1'
    tab.append(
      el('span', 'tab-ico', createSceneIcon(scene)),
      el('span', 'tab-label', scene.name))
    const detach = el('span', 'tab-detach', createReplicaIcon('M13 4h7v7M20 4l-9 9M10 4H4v16h16v-6'))
    detach.title = '在新窗口打开此场景'
    detach.addEventListener('click', ev => {
      ev.preventDefault(); ev.stopPropagation()
      openDetachedScene(scene.id)
    })
    tab.append(detach)
    tab.addEventListener('click', () => {
      if (tab._moved) return
      persistActiveScene(scene.id)
      loadScenario(scene.id)
    })
    nav.append(tab)
  })
  initScenarioTabBar({ nav, persist: saveOrder })
  applyTabCollapse(nav)
}
function getOrder() {
  try { return JSON.parse(localStorage.getItem('sceneTabOrder') || '[]') } catch { return [] }
}
const ACTIVE_SCENE_KEY = 'ui18.activeScene:v1'
function isSoloWindow() {
  return new URLSearchParams(location.search).get('solo') === '1'
}
function getSavedActiveScene(scenes) {
  try {
    const saved = localStorage.getItem(ACTIVE_SCENE_KEY)
    return scenes.some(scene => scene.id === saved) ? saved : null
  } catch { return null }
}
function persistActiveScene(sceneId) {
  if (isSoloWindow()) return
  try { localStorage.setItem(ACTIVE_SCENE_KEY, sceneId) } catch { /* Active scene memory is optional. */ }
}
function saveOrder(ids) {
  try { localStorage.setItem('sceneTabOrder', JSON.stringify(ids)) } catch { /* ignore */ }
}
function openDetachedScene(id) {
  if (window.businessBridge?.isDesktop?.()) {
    void window.businessBridge.openScene(id).then(result => {
      if (!result?.ok) setStatus('此场景暂时无法在独立窗口打开。', true)
    })
    return
  }
  const url = `index.html?scene=${encodeURIComponent(id)}&solo=1`
  window.open(url, '_blank', 'width=1280,height=840')
}

/* ============================================================
   标题栏（照搬源码 initTitlebar / initTheme）
   ============================================================ */
let toolModalBack = null
function ensureModalHeader(titleText) {
  const title = $('#modal-title')
  const head = title.parentElement
  let group = head.classList.contains('modal-title-group') ? head : null
  if (!group) {
    group = make('div', 'modal-title-group')
    head.insertBefore(group, title)
    group.append(title)
  }
  let back = group.querySelector('.modal-tool-back')
  if (!back) {
    back = make('button', 'modal-close modal-tool-back', '‹')
    back.type = 'button'
    back.setAttribute('aria-label', '返回上一页')
    back.title = '返回上一页'
    group.insertBefore(back, title)
  }
  back.hidden = titleText === '工作台工具'
  back.onclick = () => {
    const previous = toolModalBack
    toolModalBack = null
    if (previous) previous()
    else closeModal()
  }
}
function openModal(title, bodyBuilder) {
  ensureModalHeader(title)
  $('#modal-title').textContent = title
  const body = $('#modal-body')
  body.replaceChildren()
  bodyBuilder(body)
  $('#modal-mask').style.display = 'flex'
}
function closeModal() {
  toolModalBack = null
  $('#modal-mask').style.display = 'none'
  $('#modal-body').replaceChildren()
}
function modalRows(body, rows, note) {
  for (const [badge, name, desc, right] of rows) {
    const row = el('div', 'mdl-row')
    row.append(el('div', 'mdl-badge', badge))
    row.append(el('div', null, el('div', 'mdl-name', name), el('div', 'mdl-desc', desc)))
    const r = el('div', 'mdl-right')
    for (const t of right || []) r.append(tag(t[0], t[1]))
    row.append(r)
    body.append(row)
  }
  if (note) body.append(el('div', 'modal-note', note))
}
function disconnectedModal(title, detail) {
  openModal(title, body => body.append(el('div', 'modal-note', detail), el('div', 'modal-note', '桌面宿主或业务服务未连接；此处没有示例数据。')))
}

function showSkills() {
  if (!window.businessBridge?.isDesktop?.()) return disconnectedModal('技能目录', '浏览器预览不能读取当前助手的 Skill。')
  openModal('技能目录', body => body.append(el('div', 'modal-note', '正在读取当前助手的 Skill…')))
  const body = $('#modal-body')
  const current = () => $('#modal-mask').style.display !== 'none' && $('#modal-title').textContent === '技能目录'
  void window.businessBridge.globalAction('agent-data').then(result => {
    if (!current()) return
    if (!result?.ok) { body.replaceChildren(el('div', 'modal-note', agentDataError(result.reason))); return }
    const skills = result.value.capabilities.skills
    if (!skills || !Array.isArray(skills.items)) { body.replaceChildren(el('div', 'modal-note', '当前助手未返回可确认的 Skill 条目。')); return }
    const rows = skills.items.map(item => [
      typeof item?.name === 'string' ? item.name.slice(0, 1) : '·',
      typeof item?.name === 'string' ? item.name : '未命名 Skill',
      typeof item?.description === 'string' ? item.description : '当前助手返回的 Skill。',
      [[item?.invocation?.userInvocable === true ? '可由用户调用' : '仅助手调用', 'info']],
    ])
    body.replaceChildren()
    modalRows(body, rows, `角色：${result.value.role} · Skill 状态：${skills.status || '未提供'}`)
    if (!rows.length) body.append(el('div', 'modal-note', '当前助手没有返回 Skill 条目。'))
  }).catch(() => { if (current()) body.replaceChildren(el('div', 'modal-note', '当前助手的 Skill 暂不可读。')) })
}

function showNativePluginManager() {
  if (!window.businessBridge?.isDesktop?.()) return disconnectedModal('DSH 插件管理', '浏览器预览不能打开 DSH 原生插件管理页。')
  openModal('DSH 插件管理', body => body.append(el('div', 'modal-note', '正在打开 DSH 原生插件管理页…')))
  const body = $('#modal-body')
  const current = () => $('#modal-mask').style.display !== 'none' && $('#modal-title').textContent === 'DSH 插件管理'
  void window.businessBridge.globalAction('open-plugin-manager').then(result => {
    if (!current()) return
    if (result?.ok) { closeModal(); return }
    body.replaceChildren(el('div', 'modal-note', 'DSH 原生插件管理页暂不可用；没有显示本地示例清单。'))
  }).catch(() => { if (current()) body.replaceChildren(el('div', 'modal-note', 'DSH 原生插件管理页暂不可用。')) })
}

function agentDataError(reason) {
  if (reason === 'not-mounted') return '原生工作区尚未挂载。'
  if (reason === 'forbidden') return '当前无权读取助手配置。'
  if (reason === 'unconfigured') return '当前场景没有匹配的助手配置。'
  return '当前助手配置暂不可读；未显示示例数据。'
}

function showRegisteredTools() {
  if (!window.businessBridge?.isDesktop?.()) return disconnectedModal('已注册工具', '浏览器预览不能读取桌面宿主注册的工具。')
  openModal('已注册工具', body => body.append(el('div', 'modal-note', '正在读取已注册工具…')))
  const body = $('#modal-body')
  const current = () => $('#modal-mask').style.display !== 'none' && $('#modal-title').textContent === '已注册工具'
  void window.businessBridge.globalAction('tools').then(result => {
    if (!current()) return
    if (!result?.ok || !Array.isArray(result.value?.tools)) {
      body.replaceChildren(el('div', 'modal-note', result?.reason === 'forbidden' ? '当前无权读取工具目录。' : '工具目录暂不可用。'))
      return
    }
    const rows = result.value.tools.map(tool => {
      const properties = tool.parameters.properties && typeof tool.parameters.properties === 'object'
        ? Object.keys(tool.parameters.properties) : []
      return [tool.name.slice(0, 1) || '·', tool.name,
        `${tool.description} · 参数：${properties.length ? properties.join(' · ') : '无参数字段'}`,
        tool.deferLoading ? [['延迟加载', 'info']] : []]
    })
    body.replaceChildren()
    modalRows(body, rows, '')
    if (!rows.length) body.append(el('div', 'modal-note', '当前没有已注册工具。'))
  }).catch(() => { if (current()) body.replaceChildren(el('div', 'modal-note', '工具目录暂不可用。')) })
}

function showTools() {
  toolModalBack = null
  const native = window.businessBridge?.isDesktop?.() === true
  const entries = [
    ['界面大小与动效', '调整字号、组件尺寸与界面动效。', showAppearanceSettings],
    ...(native ? [
      ['ERPNext 服务', '打开原生 ERPNext 状态组件窗口。', showERPNextService],
      ['助手能力', '读取当前助手的配置、MCP 与 Skill 状态。', showAssistantCapabilities],
      ['应用 / 编辑', '打开原生应用或编辑菜单。', showAppsEditor],
      ['DSH 插件管理', '打开 DSH 原生插件管理页。', showNativePluginManager],
      ['场景配置', '编辑现有场景或复制创建自建场景。', showSceneConfiguration],
      ['引擎程序快照', '保存、预览并在正常停机后恢复受控程序代际。', showEngineGenerations],
      ['已注册工具', '读取桌面宿主中的已注册工具目录。', showRegisteredTools],
    ] : []),
  ]
  openModal('工作台工具', body => {
    const list = el('div', 'preview-action-list')
    for (const [name, description, activate] of entries) {
      const row = el('div', 'mdl-row preview-action-row', el('div', 'mdl-badge', '•'),
        el('div', null, el('div', 'mdl-name', name), el('div', 'mdl-desc', description)))
      const button = make('button', 'preview-action-open', '打开')
      button.type = 'button'
      button.setAttribute('aria-label', `打开${name}`)
      if (name === '应用 / 编辑' && native) button.dataset.nativeAction = 'application-edit'
      button.addEventListener('click', () => {
        toolModalBack = showTools
        activate()
      })
      row.append(button)
      list.append(row)
    }
    body.append(list)
  })
}

function showERPNextService() {
  if (!window.businessBridge?.isDesktop?.()) return disconnectedModal('ERPNext 服务', '浏览器预览不能挂载原生 ERPNext 状态组件。')
  openModal('ERPNext 服务', body => body.append(el('div', 'modal-note', '正在挂载并打开原生 ERPNext 状态窗口…')))
  const body = $('#modal-body')
  const current = () => $('#modal-mask').style.display !== 'none' && $('#modal-title').textContent === 'ERPNext 服务'
  void window.businessBridge.globalAction('erpnext-status').then(result => {
    if (!current()) return
    if (!result?.ok) { body.replaceChildren(el('div', 'modal-note', 'ERPNext 原生状态组件暂不可用；没有报告服务已连接。')); return }
    body.replaceChildren(el('div', 'modal-note', `原生状态窗口：${result.value.placement === 'popped-out' ? '已打开或聚焦' : '已挂载'}。`),
      el('div', 'modal-note', `组件状态：${result.value.status || '未提供'}。此状态不代表 ERPNext 业务服务已通过健康检查。`))
  }).catch(() => { if (current()) body.replaceChildren(el('div', 'modal-note', 'ERPNext 原生状态组件暂不可用。')) })
}
function showLocalPreview(title, description) {
  openModal(title, body => {
    body.append(
      el('div', 'modal-preview-empty', el('span', 'modal-preview-icon', '◇'), el('span', null, description)),
      el('div', 'modal-note', '界面预览 · 未连接真实服务、账户或数据。'))
  })
}

function showAppsEditor() {
  const native = window.businessBridge?.isDesktop?.() === true
  openModal('应用 / 编辑', body => {
    if (!native) {
      body.append(el('div', 'modal-note', '浏览器预览没有桌面应用或编辑菜单。'))
      return
    }
    body.append(el('div', 'modal-note', '通过桌面宿主现有菜单打开应用或编辑命令。'))
    for (const [name, menu] of [['应用', 'application'], ['编辑', 'edit']]) {
      const button = make('button', 'preview-action-open', `打开${name}菜单`)
      button.type = 'button'
      button.dataset.nativeAction = menu
      button.setAttribute('aria-label', `打开${name}菜单`)
      button.addEventListener('click', async () => {
        const result = await window.businessBridge.openNativeMenu(menu, button.getBoundingClientRect())
        setStatus(result?.ok ? `已请求打开${name}菜单。` : `${name}菜单暂不可用。`, !result?.ok)
      })
      body.append(button)
    }
  })
}

function showAssistantCapabilities() {
  if (typeof window.app?.openAssistantCapabilities !== 'function') return disconnectedModal('助手能力', '浏览器预览未连接助手配置服务。')
  void window.app.openAssistantCapabilities(currentTab).catch(() => disconnectedModal('助手能力', '助手能力窗口暂不可用。'))
}

function mountAssistantCapabilities(host) {
  const list = el('nav', 'assistant-capability-list')
  list.setAttribute('aria-label', '能力分组')
  const content = el('section', 'assistant-capability-detail')
  content.setAttribute('aria-live', 'polite')
  const reload = make('button', 'capability-action', '重新读取')
  reload.type = 'button'
  host.replaceChildren(el('main', 'assistant-capability-window', el('div', 'assistant-capability-sidebar', reload, list), content))
  let generation = 0
  let selected = '0'
  const load = async () => {
    const request = ++generation
    const current = () => content.isConnected && request === generation
    list.replaceChildren()
    content.replaceChildren(el('div', 'modal-note', '正在读取当前助手配置与能力…'))
    let result
    try { result = await window.businessBridge.readAssistantCapabilities() } catch { result = undefined }
    if (!current()) return
    if (!result?.ok) { content.replaceChildren(el('div', 'modal-note', agentDataError(result?.reason))); return }
    const { role, capabilities, configuration } = result.value
    const section = (title, details) => {
      const block = el('section', 'capability-section', el('div', 'capability-heading', title))
      for (const detail of details) block.append(el('div', 'capability-empty', detail))
      return block
    }
    const mcp = capabilities.mcp || {}
    const tools = capabilities.tools || {}
    const skills = capabilities.skills || {}
    const skillConfig = configuration.skill
    const mcpConfigRows = configuration.mcpServers.flatMap(server => {
      const name = typeof server?.serverName === 'string' ? server.serverName : '未命名 MCP'
      const transport = server?.transport === 'stdio' ? 'stdio' : server?.transport === 'streamable-http' ? 'Streamable HTTP' : '未提供连接方式'
      const refs = [...Object.values(server?.env || {}), ...Object.values(server?.headers || {})]
        .filter(ref => ref && typeof ref === 'object')
        .map(ref => `${typeof ref.envName === 'string' ? ref.envName : '未命名引用'} · ${typeof ref.scheme === 'string' ? ref.scheme : '未提供方式'} · ${ref.isSet === true ? '已设置' : ref.isSet === false ? '未设置' : '状态未知'}`)
      return [`${name} · ${transport}`, ...refs.map(ref => `引用：${ref}`)]
    })
    const skillDirs = Array.isArray(skillConfig.customSkillDirs) ? skillConfig.customSkillDirs.filter(value => typeof value === 'string') : []
    const details = [
      section('当前配置', [`助手：${role}`, `能力状态：${capabilities.status}`, `当前可见工具：${Array.isArray(tools.items) ? tools.items.length : 0} 项`]),
      section('已保存配置', [`预设：${typeof configuration.preset === 'string' ? configuration.preset : '未提供'} · 修订：${configuration.revision} · ${configuration.editable === true ? '可编辑' : '只读'}`, `MCP 配置：${configuration.mcpServers.length} 项 · 禁用工具：${configuration.deniedTools.length} 项`, `Skill 默认目录：${skillConfig.includeDefaultRoots === false ? '关闭' : '包含'}`, ...(skillDirs.length ? skillDirs.map(path => `Skill 目录：${path}`) : ['没有自定义 Skill 目录'])]),
      section('MCP 配置', mcpConfigRows.length ? mcpConfigRows : ['没有 MCP 配置']),
      section('MCP 能力', [`状态：${typeof mcp.status === 'string' ? mcp.status : '未提供'}`, ...(Array.isArray(mcp.visibleTools) && mcp.visibleTools.length ? mcp.visibleTools.map(name => typeof name === 'string' ? name : '').filter(Boolean) : ['当前没有可见 MCP 工具'])]),
      section('工具能力', [`状态：${typeof tools.status === 'string' ? tools.status : '未提供'}`, `已返回：${Array.isArray(tools.items) ? tools.items.length : 0} 项 · 总数：${Number.isFinite(tools.total) ? tools.total : '未提供'}`, ...(Array.isArray(tools.items) ? tools.items.map(item => typeof item?.name === 'string' ? item.name : '').filter(Boolean) : [])]),
      section('Skill', [`状态：${typeof skills.status === 'string' ? skills.status : '未提供'}`, `已返回：${Array.isArray(skills.items) ? skills.items.length : 0} 项 · 总数：${Number.isFinite(skills.total) ? skills.total : '未提供'}`, ...(Array.isArray(skills.items) ? skills.items.map(item => typeof item?.name === 'string' ? item.name : '').filter(Boolean) : [])]),
    ]
    const labels = ['当前配置', '已保存配置', 'MCP 配置', 'MCP 能力', '工具能力', 'Skill']
    const flags = value => value === true ? '允许' : value === false ? '不允许' : '未提供'
    const leaves = [[], [],
      configuration.mcpServers.flatMap(server => typeof server?.serverName === 'string'
        ? [[server.serverName, [`连接方式：${server.transport === 'stdio' ? 'stdio' : server.transport === 'streamable-http' ? 'Streamable HTTP' : '未提供'}`]]] : []),
      (Array.isArray(mcp.visibleTools) ? mcp.visibleTools : []).flatMap(name => typeof name === 'string' ? [[name, ['当前助手可见的 MCP 工具']]] : []),
      (Array.isArray(tools.items) ? tools.items : []).flatMap(item => typeof item?.name === 'string' ? [[item.name, ['当前助手可见的工具']]] : []),
      (Array.isArray(skills.items) ? skills.items : []).flatMap(item => typeof item?.name === 'string' ? [[item.name, [
        typeof item.description === 'string' && item.description ? item.description : '未提供描述',
        `来源：${typeof item.source === 'string' ? item.source : '未提供'}`,
        `模型调用：${flags(item.invocation?.modelInvocable)} · 用户调用：${flags(item.invocation?.userInvocable)}`,
      ]]] : []),
    ]
    const items = new Map()
    const pick = key => {
      selected = key
      for (const [id, item] of items) item.button.setAttribute('aria-current', id === key ? 'true' : 'false')
      content.replaceChildren(items.get(key).detail)
    }
    const entry = (label, id, detail, child = false) => {
      const button = make('button', child ? 'capability-action assistant-capability-item' : 'capability-action', label)
      button.type = 'button'
      button.addEventListener('click', () => { if (current()) pick(id) })
      items.set(id, { button, detail })
      return button
    }
    list.replaceChildren(...labels.map((label, index) => el('div', 'assistant-capability-group',
      entry(label, String(index), details[index]), ...leaves[index].map(([name, facts], position) =>
        entry(name, `${index}:${position}:${name}`, section(name, facts), true)))))
    pick(items.has(selected) ? selected : '0')
  }
  reload.addEventListener('click', () => void load())
  void load()
}

const UI_SCALE_KEY = 'uiPreviewScale'
const UI_MOTION_KEY = 'uiPreviewMotion'
function readUiScale() {
  if (window.businessBridge?.isDesktop?.()) return window.businessBridge.getNativeScale?.() || 1
  try {
    const value = Number(localStorage.getItem(UI_SCALE_KEY))
    return [0.9, 1, 1.1].includes(value) ? value : 1
  } catch { return 1 }
}
function applyUiScale(value) {
  const scale = [0.9, 1, 1.1].includes(Number(value)) ? Number(value) : 1
  if (window.businessBridge?.isDesktop?.()) {
    void window.businessBridge.setNativeScale(scale).then(result => {
      if (!result?.ok) setStatus(result?.reason === 'unsupported-native-scale' ? '此缩放档位未获桌面宿主支持。' : '无法保存界面缩放。', true)
    })
    return
  }
  const presets = {
    0.9: ['12px', '12px', '10.5px', '36px', '45px', '36px', '30px', '4px', '4px', '26px', '18px', '243px'],
    1: ['13px', '13px', '11.5px', '38px', '48px', '40px', '34px', '5px', '5px', '28px', '20px', '270px'],
    1.1: ['14px', '14px', '12.5px', '42px', '54px', '44px', '38px', '6px', '6px', '31px', '22px', '297px'],
  }
  const [font, tabFont, titleFont, titlebar, titlebarLeading, scenebar, icon, gap, padding, panelHeader, control, sidebar] = presets[scale]
  const root = document.documentElement.style
  for (const [name, value] of Object.entries({
    '--ui-font-size': font,
    '--ui-font-tab-size': tabFont,
    '--ui-font-title-size': titleFont,
    '--ui-titlebar-height': titlebar,
    '--ui-titlebar-leading': titlebarLeading,
    '--ui-scenebar-height': scenebar,
    '--ui-icon-width': icon,
    '--ui-grid-gap': gap,
    '--ui-grid-padding': padding,
    '--ui-panel-header-height': panelHeader,
    '--ui-control-size': control,
    '--ui-sidebar-width': sidebar,
  })) root.setProperty(name, value)
  try { localStorage.setItem(UI_SCALE_KEY, String(scale)) } catch { /* preview preference is optional */ }
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')))
}
function applyUiMotion(enabled) {
  document.documentElement.classList.toggle('reduce-motion', !enabled)
  try { localStorage.setItem(UI_MOTION_KEY, enabled ? 'on' : 'off') } catch { /* preview preference is optional */ }
}
function ensureScaleOption(select, value, hostCurrent = false) {
  const key = String(value)
  let option = [...select.options].find(item => item.value === key)
  if (!option && hostCurrent) {
    option = make('option', '', `当前桌面宿主 · ${Math.round(Number(value) * 100)}%`)
    option.value = key
    option.disabled = true
    option.dataset.hostCurrentScale = 'true'
    select.append(option)
  }
  if (option) select.value = key
}

function showAppearanceSettings() {
  const native = window.businessBridge?.isDesktop?.() === true
  openModal('界面大小与动效', body => {
    const sizeLabel = el('label', 'settings-row')
    sizeLabel.append(el('span', 'settings-label', '界面大小'))
    const select = make('select', 'settings-select')
    select.setAttribute('aria-label', '界面大小')
    for (const [value, label] of [['0.9', '较小 · 90%'], ['1', '标准 · 100%'], ['1.1', '较大 · 110%']]) {
      const option = make('option', '', label)
      option.value = value
      select.append(option)
    }
    const currentScale = readUiScale()
    ensureScaleOption(select, currentScale, native && ![0.9, 1, 1.1].includes(currentScale))
    select.addEventListener('change', () => applyUiScale(select.value))
    sizeLabel.append(select)
    const motionLabel = make('label', 'settings-row settings-check')
    const motion = make('input')
    motion.type = 'checkbox'
    let motionEnabled = true
    try { motionEnabled = localStorage.getItem(UI_MOTION_KEY) !== 'off' } catch { /* default on */ }
    motion.checked = motionEnabled
    motion.setAttribute('aria-label', '启用界面动效')
    motion.addEventListener('change', () => applyUiMotion(motion.checked))
    motionLabel.append(motion, el('span', 'settings-label', '启用界面动效'))
    const reset = make('button', 'preview-action-open', '恢复标准大小')
    reset.type = 'button'
    reset.addEventListener('click', () => { select.value = '1'; applyUiScale(1) })
    body.append(sizeLabel, motionLabel, reset,
      el('div', 'modal-note', native
        ? '缩放由桌面宿主应用到窗口与原生面板；动效仅控制此界面。'
        : '设置仅保存在本地 UI 预览中，不修改系统显示设置或业务偏好。'))
  })
}

function showSettings() {
  if (!window.businessBridge?.isDesktop?.()) return showAppearanceSettings()
  void window.businessBridge.globalAction('settings').then(result => {
    if (!result?.ok) setStatus('原生设置暂不可用。', true)
    else setStatus('已向原生工作区请求打开设置。', false)
  })
}

function positionToolbarPanel(panel, anchor) {
  const rect = anchor.getBoundingClientRect()
  panel.style.top = `${Math.max(4, Math.min(rect.bottom + 4, window.innerHeight - panel.offsetHeight - 4))}px`
  panel.style.right = `${Math.max(4, Math.min(window.innerWidth - rect.right, window.innerWidth - panel.offsetWidth - 4))}px`
}

let closeMobileLink
function showMobileLink(event) {
  if (window.businessBridge?.isDesktop?.()) {
    if (closeMobileLink) { closeMobileLink(true); return }
    const button = event.currentTarget
    const anchor = button.closest('#toolbar-overflow-menu') ? $('#btn-toolbar-overflow') : button
    const body = el('div', 'titlebar-overflow-menu mobile-link-popover', el('div', 'modal-note', '正在请求手机连接信息…'))
    body.setAttribute('role', 'dialog')
    body.setAttribute('aria-label', '连接手机')
    body.tabIndex = -1
    const current = () => body.isConnected
    const position = () => positionToolbarPanel(body, anchor)
    const outside = event => { if (!body.contains(event.target) && !anchor.contains(event.target)) close(false) }
    const escape = event => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      close(true)
    }
    const close = (focus = false) => {
      body.remove()
      closeMobileLink = undefined
      button.setAttribute('aria-expanded', 'false')
      if (anchor !== button) anchor.removeEventListener('click', closeFromOverflow, true)
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape, true)
      window.removeEventListener('resize', position)
      if (focus) (anchor.getClientRects().length ? anchor : button).focus()
    }
    const closeFromOverflow = () => close()
    closeMobileLink = close
    button.setAttribute('aria-expanded', 'true')
    if (anchor !== button) anchor.addEventListener('click', closeFromOverflow, true)
    document.body.append(body)
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape, true)
    window.addEventListener('resize', position)
    position()
    queueMicrotask(() => { if (current()) body.focus() })
    void window.businessBridge.globalAction('mobile').then(result => {
      if (!current()) return
      const value = result?.value
      const matrix = value?.qrMatrix
      if (!result?.ok || typeof value?.url !== 'string' || !matrix || matrix.quietZone !== 4 || !Number.isInteger(matrix.size)
        || matrix.size < 21 || matrix.size > 177 || !Array.isArray(matrix.modules)
        || matrix.modules.length !== matrix.size
        || matrix.modules.some(row => typeof row !== 'string' || row.length !== matrix.size || !/^[01]+$/.test(row))) {
        body.replaceChildren(el('div', 'modal-note', '手机连接信息暂不可用；未生成可确认的二维码。'))
        position()
        return
      }
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('viewBox', `0 0 ${matrix.size + 8} ${matrix.size + 8}`)
      svg.setAttribute('role', 'img')
      svg.setAttribute('aria-label', '手机连接二维码')
      svg.classList.add('mobile-qr')
      const background = document.createElementNS(svg.namespaceURI, 'rect')
      background.setAttribute('width', String(matrix.size + 8)); background.setAttribute('height', String(matrix.size + 8)); background.setAttribute('fill', '#fff')
      const path = document.createElementNS(svg.namespaceURI, 'path')
      const bits = []
      matrix.modules.forEach((row, y) => { for (let x = 0; x < matrix.size; x++) if (row[x] === '1') bits.push(`M${x + 4} ${y + 4}h1v1h-1z`) })
      path.setAttribute('d', bits.join('')); path.setAttribute('fill', '#111')
      svg.append(background, path)
      const copy = make('button', 'preview-action-open', '复制连接链接')
      copy.type = 'button'
      copy.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(value.url); copy.textContent = '已复制链接' }
        catch { copy.textContent = '无法自动复制，请重试' }
      })
      body.replaceChildren(el('div', 'mobile-link-content', svg, el('div', 'modal-note', '请使用手机扫描二维码连接此工作台。'), copy))
      position()
    }).catch(() => {
      if (current()) {
        body.replaceChildren(el('div', 'modal-note', '手机连接信息暂不可用。'))
        position()
      }
    })
    return
  }
  showLocalPreview('手机连接', '手机连接与二维码区域；此 UI 预览不生成二维码、不请求连接。')
}

let webAiAuthController = null

function openWebAiWindow(provider, previewUrl) {
  if (window.businessBridge?.isDesktop?.()) {
    void window.businessBridge.openWebAi(provider).then(opened => {
      if (!opened) setStatus('网页 AI 窗口暂不可用。', true)
      else webAiAuthController?.opened(provider)
    })
    return
  }
  window.open(previewUrl, '_blank', 'noopener,noreferrer,width=1100,height=820')
}

function initWebAiAuthState() {
  const api = window.app?.aiWeb
  const providers = ['deepseek', 'doubao']
  const latestGeneration = new Map(providers.map(provider => [provider, -1]))
  const stateRevision = new Map(providers.map(provider => [provider, 0]))
  const latestReads = new Map()
  const openedProviders = new Set()
  const sampling = new Set()
  const lastSampleAt = new Map(providers.map(provider => [provider, -Infinity]))
  let active = true
  let unsubscribe

  function applyState(dto, readTicket) {
    if (!active || !dto || typeof dto !== 'object' || Array.isArray(dto)) return
    const keys = Object.keys(dto).sort()
    if (keys.length !== 4 || keys.join(',') !== 'authState,evidence,generation,provider') return
    const { provider, authState, evidence, generation } = dto
    const expected = provider === 'deepseek'
      ? { none: 'unknown', 'deepseek-sign-in-path': 'unauthenticated', 'deepseek-account-menu': 'authenticated' }
      : { none: 'unknown', 'doubao-login-button': 'unauthenticated', 'doubao-account-menu': 'authenticated' }
    if (!providers.includes(provider) || !Object.hasOwn(expected, evidence) || expected[evidence] !== authState
      || !Number.isSafeInteger(generation) || generation < 0) return
    if (readTicket && readTicket.provider !== provider) return
    if (generation < latestGeneration.get(provider)) return
    if (readTicket && stateRevision.get(provider) !== readTicket.revision
      && generation <= latestGeneration.get(provider)) return
    latestGeneration.set(provider, generation)
    stateRevision.set(provider, stateRevision.get(provider) + 1)
    const button = document.getElementById(provider === 'deepseek' ? 'btn-deepseek' : 'btn-doubao')
    if (button) {
      const providerName = provider === 'deepseek' ? 'DeepSeek' : '豆包'
      const statusLabel = authState === 'authenticated' ? '已登录'
        : authState === 'unauthenticated' ? '未登录' : '状态未确认'
      button.dataset.authState = authState
      button.title = `打开 ${providerName} 网页窗口 · ${statusLabel}`
      button.setAttribute('aria-label', `打开 ${providerName} 网页窗口，${statusLabel}`)
    }
  }

  async function refreshState(provider) {
    if (!active || !providers.includes(provider) || typeof api?.authState !== 'function') return
    const ticket = { provider, revision: stateRevision.get(provider) }
    latestReads.set(provider, ticket)
    try {
      const snapshot = await api.authState(provider)
      if (latestReads.get(provider) !== ticket) return
      applyState(snapshot, ticket)
    } catch { /* Keep the last Host-reported state. */ }
  }

  async function sample(provider, source) {
    if (!active || !openedProviders.has(provider) || sampling.has(provider)
      || typeof api?.authControlSample !== 'function') return
    const now = Date.now()
    if (source === 'focus' && now - lastSampleAt.get(provider) < 1200) return
    sampling.add(provider)
    lastSampleAt.set(provider, now)
    try {
      // This returns bounded account-menu evidence only; it never drives the auth dot.
      await api.authControlSample(provider)
    } catch { /* Sampling never decides auth; read the Host cache below. */ }
    finally {
      await refreshState(provider)
      sampling.delete(provider)
    }
  }

  if (typeof api?.subscribeAuthState === 'function') {
    try { unsubscribe = api.subscribeAuthState(applyState) } catch { /* Initial reads remain available. */ }
  }
  for (const provider of providers) void refreshState(provider)
  const onFocus = () => {
    for (const provider of openedProviders) void sample(provider, 'focus')
  }
  window.addEventListener('focus', onFocus)
  window.addEventListener('pagehide', () => {
    active = false
    window.removeEventListener('focus', onFocus)
    try { if (typeof unsubscribe === 'function') unsubscribe() } catch { /* Window teardown is authoritative. */ }
  }, { once: true })

  return Object.freeze({
    opened(provider) {
      if (!providers.includes(provider)) return
      openedProviders.add(provider)
      void sample(provider, 'open')
    },
  })
}

function initUiPreferences() {
  if (!window.businessBridge?.isDesktop?.()) applyUiScale(readUiScale())
  window.addEventListener('business-ui-scale-state', event => {
    if (!event.detail?.available) return
    const select = document.querySelector('#modal-mask[style*="display: flex"] #modal-body select[aria-label="界面大小"]')
    if (select) ensureScaleOption(select, event.detail.value, ![0.9, 1, 1.1].includes(event.detail.value))
  })
  let motionEnabled = true
  try { motionEnabled = localStorage.getItem(UI_MOTION_KEY) !== 'off' } catch { /* default on */ }
  applyUiMotion(motionEnabled)
}

// 外观切换（深色 / 浅色 / 跟随系统）
const THEME_KEY = 'guiTheme'
function currentThemeMode() {
  const nativePreference = window.businessBridge?.getThemePreference?.()
  if (['light', 'dark', 'system'].includes(nativePreference)) return nativePreference
  if (window.businessBridge?.isDesktop?.()) return 'system'
  const v = localStorage.getItem(THEME_KEY)
  return (v === 'light' || v === 'system') ? v : 'dark'
}
function applyTheme(mode) {
  const light = window.matchMedia('(prefers-color-scheme: light)').matches
  const preferredResolved = arguments[1]
  const native = window.businessBridge?.isDesktop?.() === true
  if (native && !['light', 'dark'].includes(preferredResolved)) return
  const resolved = ['light', 'dark'].includes(preferredResolved)
    ? preferredResolved : mode === 'system' ? (light ? 'light' : 'dark') : mode
  document.documentElement.dataset.theme = resolved
  const btn = document.getElementById('btn-theme')
  if (btn) {
    btn.dataset.themeIcon = mode
    btn.dataset.themeEffective = resolved
    const modes = ['light', 'dark', 'system']
    const nextMode = modes[(modes.indexOf(mode) + 1) % modes.length]
    const labels = { system: '跟随系统', dark: '固定深色（不跟随系统）', light: '固定浅色（不跟随系统）' }
    btn.title = '切换主题 · 偏好：' + labels[mode]
      + ' · 实际：' + (resolved === 'light' ? '浅色' : '深色')
      + ' · 下次：' + labels[nextMode]
    btn.setAttribute('aria-label', btn.title)
  }
}
function initTheme() {
  const btn = document.getElementById('btn-theme')
  if (!btn) return
  const native = window.businessBridge?.isDesktop?.() === true
  let themeWritePending = false
  btn.addEventListener('click', e => {
    e.stopPropagation()
    const modes = ['light', 'dark', 'system']
    const next = modes[(modes.indexOf(currentThemeMode()) + 1) % modes.length]
    if (native) {
      if (themeWritePending) return
      themeWritePending = true
      btn.disabled = true
      btn.setAttribute('aria-busy', 'true')
      setStatus('正在保存主题，请稍候。', true)
      void (async () => {
        try {
          const ok = await window.businessBridge.setThemePreference(next)
          setStatus(ok === true ? '主题已保存。' : '主题切换未完成。', ok !== true)
        } catch { setStatus('主题切换未完成。', true) }
        finally {
          themeWritePending = false
          btn.disabled = false
          btn.removeAttribute('aria-busy')
        }
      })()
      return
    }
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
  })
  const mq = window.matchMedia('(prefers-color-scheme: light)')
  const onSys = () => { if (!native && currentThemeMode() === 'system') applyTheme('system') }
  if (mq.addEventListener) mq.addEventListener('change', onSys)
  else if (mq.addListener) mq.addListener(onSys)
  window.addEventListener('business-theme-state', event => {
    const snapshot = event.detail
    if (snapshot && ['light', 'dark', 'system'].includes(snapshot.preference)) applyTheme(snapshot.preference, snapshot.colorScheme)
  })
  const preference = currentThemeMode()
  if (native) {
    btn.dataset.themeIcon = preference
    btn.removeAttribute('data-theme-effective')
    btn.title = '切换主题 · 正在读取桌面主题偏好'
    btn.setAttribute('aria-label', btn.title)
  } else applyTheme(preference)
}

function setStatus(text, _busy) {
  const statusText = $('#status-text')
  if (statusText) statusText.textContent = text
}

function initTitlebarOverflow() {
  const controls = document.getElementById('titlebar-controls')
  const actionGroup = document.getElementById('titlebar-action-controls')
  const trigger = document.getElementById('btn-toolbar-overflow')
  const menu = document.getElementById('toolbar-overflow-menu')
  const windowControls = document.getElementById('titlebar-window-controls')
  if (!controls || !actionGroup || !trigger || !menu || !windowControls) return

  const labels = new Map([
    ['btn-theme', '外观'], ['btn-mobile', '手机连接'], ['btn-settings', '设置'],
    ['btn-refresh', '刷新当前场景'],
    ['btn-tools', '工作台工具'],
  ])
  const actions = [...actionGroup.querySelectorAll(':scope > button.tb-btn')]
    .filter(button => labels.has(button.id))
    .map(button => {
      const placeholder = document.createComment(`toolbar:${button.id}`)
      button.before(placeholder)
      return {
        button, placeholder, role: button.getAttribute('role'), tabIndex: button.getAttribute('tabindex'),
        ariaLabel: button.getAttribute('aria-label'), title: button.getAttribute('title'),
        label: labels.get(button.id), labelNode: null,
      }
    })
  if (!actions.length) return

  let opened = false
  let resizeObserver
  const restoreAction = item => {
    item.labelNode?.remove()
    item.labelNode = null
    item.button.classList.remove('toolbar-overflow-menuitem')
    item.button.removeAttribute('role')
    if (item.role !== null) item.button.setAttribute('role', item.role)
    item.button.removeAttribute('tabindex')
    if (item.tabIndex !== null) item.button.setAttribute('tabindex', item.tabIndex)
    item.button.removeAttribute('aria-label')
    if (item.ariaLabel !== null) item.button.setAttribute('aria-label', item.ariaLabel)
    if (item.title !== null) item.button.setAttribute('title', item.title)
    if (item.placeholder.parentNode) item.placeholder.parentNode.insertBefore(item.button, item.placeholder.nextSibling)
  }
  const overflowed = () => actions.filter(item => item.button.parentElement === menu)
  const syncNativeOverlayState = value => document.body.classList.toggle('titlebar-overflow-open', value)
  const closeMenu = ({ focus = false } = {}) => {
    if (!opened) return
    opened = false
    menu.hidden = true
    trigger.setAttribute('aria-expanded', 'false')
    syncNativeOverlayState(false)
    if (focus) trigger.focus()
  }
  const openMenu = ({ focus = true } = {}) => {
    if (!overflowed().length) return
    opened = true
    menu.hidden = false
    trigger.setAttribute('aria-expanded', 'true')
    syncNativeOverlayState(true)
    positionMenu()
    if (focus) menu.querySelector('[role="menuitem"]')?.focus()
  }
  function positionMenu() {
    if (menu.hidden) return
    positionToolbarPanel(menu, trigger)
  }
  const setMenuItem = item => {
    const button = item.button
    if (!item.labelNode) {
      item.labelNode = document.createElement('span')
      item.labelNode.className = 'toolbar-overflow-label'
      item.labelNode.textContent = item.label
    }
    button.append(item.labelNode)
    button.classList.add('toolbar-overflow-menuitem')
    button.setAttribute('role', 'menuitem')
    button.setAttribute('tabindex', '-1')
    button.setAttribute('aria-label', item.label)
    button.title = item.label
  }
  const naturalActionWidth = () => {
    const oldFlex = actionGroup.style.flex
    const oldWidth = actionGroup.style.width
    const oldVisibility = actionGroup.style.visibility
    actionGroup.style.flex = '0 0 auto'
    actionGroup.style.width = 'max-content'
    actionGroup.style.visibility = 'hidden'
    const width = Math.ceil(actionGroup.scrollWidth || actionGroup.getBoundingClientRect().width)
    actionGroup.style.flex = oldFlex
    actionGroup.style.width = oldWidth
    actionGroup.style.visibility = oldVisibility
    return width
  }
  const elementWidth = element => Math.ceil(element.getBoundingClientRect().width || element.offsetWidth || 0)
  const fixedBrandWidth = () => {
    const drag = document.querySelector('#titlebar .titlebar-drag')
    const brand = drag?.querySelector('.brand')
    const mark = brand?.querySelector('.brand-mark')
    const webAi = drag?.querySelector('.webai-shortcuts')
    if (!drag || !brand || !mark) return 0
    const px = value => Number.parseFloat(value) || 0
    const dragStyle = getComputedStyle(drag)
    const brandStyle = getComputedStyle(brand)
    const aiStyle = webAi ? getComputedStyle(webAi) : null
    return px(dragStyle.paddingLeft) + px(dragStyle.paddingRight) + px(dragStyle.gap)
      + elementWidth(mark) + px(brandStyle.gap)
      + (webAi ? elementWidth(webAi) + px(aiStyle.marginLeft) : elementWidth(brand))
  }
  const syncOverflow = () => {
    if (opened) closeMenu()
    for (const item of [...overflowed()].reverse()) restoreAction(item)
    for (const separator of actionGroup.querySelectorAll(':scope > .tb-sep')) separator.hidden = false
    const required = naturalActionWidth()
    const titlebar = document.getElementById('titlebar')
    const viewportWidth = titlebar?.clientWidth || window.innerWidth
    const baseAvailable = Math.max(0, viewportWidth - fixedBrandWidth() - elementWidth(windowControls) - 12)
    if (required <= baseAvailable + 1) {
      trigger.hidden = true
      actionGroup.dataset.overflowing = 'false'
      for (const item of [...overflowed()].reverse()) restoreAction(item)
      for (const separator of actionGroup.querySelectorAll(':scope > .tb-sep')) separator.hidden = false
      menu.hidden = true
      trigger.setAttribute('aria-expanded', 'false')
      syncNativeOverlayState(false)
      return
    }

    trigger.hidden = false
    const available = Math.max(0, baseAvailable - elementWidth(trigger))
    actionGroup.dataset.overflowing = 'true'
    menu.hidden = true
    const separators = [...actionGroup.querySelectorAll(':scope > .tb-sep')]
    for (const separator of separators) separator.hidden = true
    for (const item of [...actions].reverse()) {
      if (actionGroup.scrollWidth <= available + 1) break
      setMenuItem(item)
      menu.prepend(item.button)
    }
    // Keep overflowed items in their original toolbar order.
    for (const item of actions) if (item.button.parentElement === menu) menu.append(item.button)
    if (!overflowed().length) {
      trigger.hidden = true
      actionGroup.dataset.overflowing = 'false'
      for (const separator of separators) separator.hidden = false
    }
  }
  const toggleMenu = () => opened ? closeMenu({ focus: true }) : openMenu()

  trigger.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); toggleMenu() })
  trigger.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown') {
      event.preventDefault(); openMenu()
    }
  })
  menu.addEventListener('keydown', event => {
    const items = [...menu.querySelectorAll('[role="menuitem"]')]
    if (!items.length) return
    const index = items.indexOf(document.activeElement)
    if (event.key === 'Escape') { event.preventDefault(); closeMenu({ focus: true }); return }
    if (event.key === 'Home') { event.preventDefault(); items[0].focus(); return }
    if (event.key === 'End') { event.preventDefault(); items.at(-1).focus(); return }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[(index + delta + items.length) % items.length].focus()
      return
    }
    if (event.key === 'Tab') {
      event.preventDefault()
      closeMenu()
      const next = event.shiftKey ? trigger : document.getElementById('btn-min')
      next?.focus()
    }
  })
  menu.addEventListener('click', event => {
    const item = event.target.closest?.('[role="menuitem"]')
    if (item) closeMenu({ focus: true })
  })
  document.addEventListener('pointerdown', event => {
    if (!opened || trigger.contains(event.target) || menu.contains(event.target) || event.target.closest?.('.theme-menu')) return
    closeMenu()
  }, true)
  window.addEventListener('resize', () => { if (opened) closeMenu(); syncOverflow() })
  if (typeof ResizeObserver === 'function') {
    resizeObserver = new ResizeObserver(() => { if (opened) closeMenu(); syncOverflow() })
    resizeObserver.observe(controls)
    const titlebar = document.getElementById('titlebar')
    if (titlebar) resizeObserver.observe(titlebar)
  }
  syncOverflow()
}

async function readNativeCaptionOverlay() {
  if (window.businessBridge?.isDesktop?.() !== true || typeof window.app?.win?.info !== 'function') return false
  try {
    const info = await window.app.win.info()
    initialPaintMain = info?.isMain === true
    return info?.nativeCaption === true
  } catch { if(initialPaintMain)throw {firstPaintStage:'caption'};return false }
}

function initTitlebar(nativeCaptionOverlay = false) {
  document.getElementById('btn-refresh').addEventListener('click', () => {
    if (currentTab) loadScenario(currentTab)
  })
  const mobile = document.getElementById('btn-mobile')
  if (mobile && window.businessBridge?.isDesktop?.()) {
    mobile.setAttribute('aria-haspopup', 'dialog')
    mobile.setAttribute('aria-expanded', 'false')
  }
  mobile?.addEventListener('click', showMobileLink)
  document.getElementById('btn-settings')?.addEventListener('click', showSettings)
  document.getElementById('btn-tools').addEventListener('click', showTools)
  document.getElementById('btn-deepseek')?.addEventListener('click', () => openWebAiWindow('deepseek', 'https://chat.deepseek.com/'))
  document.getElementById('btn-doubao')?.addEventListener('click', () => openWebAiWindow('doubao', 'https://www.doubao.com/chat/'))
  document.getElementById('modal-close').addEventListener('click', closeModal)
  document.getElementById('modal-mask').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeModal()
  })
  // 窗口控制（浏览器下为占位）
  const native = () => window.businessBridge?.isDesktop?.() === true
  const winAction = action => window.businessBridge?.windowAction?.(action)
  const syncMaximizedState = async () => {
    if (nativeCaptionOverlay) return
    if (!native()) {
      btnMax.dataset.windowState = 'preview'
      btnMax.title = '最大化（仅桌面应用可用）'
      btnMax.setAttribute('aria-label', btnMax.title)
      return
    }
    const maximized = await winAction('isMaximized')
    if (typeof maximized !== 'boolean') return
    btnMax.dataset.maximized = String(maximized)
    btnMax.dataset.windowState = maximized ? 'maximized' : 'restored'
    btnMax.title = maximized ? '还原窗口' : '最大化窗口'
    btnMax.setAttribute('aria-label', btnMax.title)
  }
  const windowControls = document.getElementById('titlebar-window-controls')
  if (windowControls) windowControls.hidden = nativeCaptionOverlay
  const btnMax = document.getElementById('btn-max')
  if (!nativeCaptionOverlay) {
    document.getElementById('btn-min').addEventListener('click', () => { if (native()) void winAction('minimize') })
    btnMax.addEventListener('click', async () => {
      if (!native()) return
      await winAction('toggleMaximize')
      await syncMaximizedState()
    })
    document.getElementById('btn-close').addEventListener('click', () => {
      if (native()) void winAction('close')
      else closeModal()
    })
    window.addEventListener('resize', () => { void syncMaximizedState() })
    void syncMaximizedState()
  } else {
    btnMax.dataset.windowState = 'native-caption'
    btnMax.title = '窗口控制由系统标题栏提供'
    btnMax.setAttribute('aria-label', btnMax.title)
  }
  initTitlebarOverflow()
}

/* ============================================================
   启动
   ============================================================ */
const normalizeScenes = raw => Array.isArray(raw) ? raw : (Array.isArray(raw?.scenes) ? raw.scenes : [])

function reportInitialPaintProgress(stage){
  return initialPaintMain && window.businessBridge?.isDesktop?.()
    ? window.app.initialPaintReady({status:'progress',stage}) : Promise.resolve()
}

async function boot() {
  if (new URLSearchParams(location.search).get('component') === 'assistant-capabilities-native') {
    document.title = '助手能力'
    document.body.classList.add('assistant-capability-surface')
    mountAssistantCapabilities(document.body)
    return
  }
  // The approved five-scene geometry is local UI state and must paint even if the
  // Host config is slow or unavailable. The bridge loads/validates business data
  // independently and replaces only the contents of business-backed panels.
  await ensureBusinessBridge()
  const nativeCaptionOverlay = await readNativeCaptionOverlay()
  document.body.classList.toggle('native-caption-overlay', nativeCaptionOverlay)
  const windowControls = document.getElementById('titlebar-window-controls')
  if (windowControls) windowControls.hidden = nativeCaptionOverlay
  if (window.__SCENES__) {
    // file:// 下 fetch 会被 CORS 拦 —— 走 scenes-data.js 内联数据
    data = { scenes: normalizeScenes(window.__SCENES__) }
  } else {
    const resp = await fetch('scenes.json')
    data = { scenes: normalizeScenes(await resp.json()) }
  }
  data.scenes = normalizeScenes(data.scenes)
  configurationTemplates = structuredClone(data.scenes)
  if (typeof window.app?.sourceConfig === 'function') {
    trustedSceneConfiguration = await window.app.sourceConfig()
    data.scenes = visibleConfiguredScenes(trustedSceneConfiguration).map(projectTrustedScene)
  }
  if (typeof window.app?.onSceneConfigurationChanged === 'function') window.app.onSceneConfigurationChanged(applyTrustedSceneConfiguration)
  // ?scene=<id> 直达；&solo=1 分离窗口（隐藏场景栏，腾高度给面板）
  const params = new URLSearchParams(location.search)
  const want = params.get('scene')
  if (want && data.scenes.some(s => s.id === want)) currentTab = want
  else currentTab = getSavedActiveScene(data.scenes) || data.scenes[0]?.id || null
  if (params.get('solo') === '1') {
    document.body.classList.add('solo')
    document.title = `织贸工作台 · ${data.scenes.find(s => s.id === currentTab)?.name || '场景'}（独立窗口）`
  }
  initTheme()
  initUiPreferences()
  webAiAuthController = initWebAiAuthState()
  initTitlebar(nativeCaptionOverlay)
  await reportInitialPaintProgress('caption')
  initSidebarOverlay()
  buildTabs()
  const sceneReady = initialPaintMain && window.businessBridge?.isDesktop?.()
    ? loadInitialScenario(currentTab).then(async value=>{await reportInitialPaintProgress('scene');return value}) : (loadScenario(currentTab),Promise.resolve())
  const bridge = window.businessBridge
  if (bridge?.isDesktop?.()) {
    setStatus('正在读取业务配置…', true)
    window.addEventListener('business-config-state', event => {
      const phase = event.detail?.phase
      if (phase === 'ready') setStatus('业务配置已载入', false)
      else if (phase === 'error') setStatus('业务配置不可用', true)
    })
    void bridge.start()
  } else {
    setStatus('界面预览 · 不连接业务服务', false)
    void bridge?.start?.()
  }
  const themeReady=bridge?.isDesktop?.() && initialPaintMain
    ? bridge.whenInitialThemeReady().then(async snapshot=>{applyTheme(snapshot.preference,snapshot.colorScheme);await reportInitialPaintProgress('theme')},()=>{throw {firstPaintStage:'theme'}})
    : Promise.resolve()
  if(bridge?.isDesktop?.() && initialPaintMain){
  await Promise.all([sceneReady,themeReady])
  // The local interactions script is parser-loaded; no guest frame/RAF/network barrier.
  if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}))
  window.dispatchEvent(new Event('resize'))
  if(!grid.classList.contains('pi-split-resize-enabled'))throw {firstPaintStage:'layout'}
  grid.getBoundingClientRect()
  await reportInitialPaintProgress('layout')
  await new Promise(resolve=>requestAnimationFrame(resolve))
  await new Promise(resolve=>requestAnimationFrame(resolve))
  await reportInitialPaintProgress('paint')
  await window.app.initialPaintReady({status:'ready'})
  }
  window.addEventListener('resize', () => {
    const nav = $('#scenario-tabs')
    if (nav.getAttribute('data-tabbar') === TABBAR_VERSION) {
      measureTabWidths(nav); applyTabCollapse(nav)
    }
  })
}
boot().catch(async error=>{
  const reason=['caption','theme','scene','layout'].includes(error?.firstPaintStage)?error.firstPaintStage:'boot'
  setStatus('工作台初始化失败。',true)
  if(initialPaintMain && typeof window.app?.initialPaintReady==='function')try{await window.app.initialPaintReady({status:'failed',reason})}catch{}
  console.error('Source shell initial paint failed: '+reason)
})
