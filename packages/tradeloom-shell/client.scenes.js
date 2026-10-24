window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.scenes.js',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const listeners = new Set()
    const retainedByRole = new Map()
    const dockviewApis = new Map()
    const pendingScenePanelFocus = new Map()
    const dockviewRenderers = new Map()
    const narrowListeners = new Map()
    const asyncRequire = typeof require.async === 'function' ? require.async.bind(require) : null
    let dockviewRequest
    let dockSaveQueue = Promise.resolve()
    let dockRevision = 0
    let dockPersistedRevision = 0
    let snapshot = {
      config: null, configError: '', activeSceneId: 'center', roleByScene: {}, businessPath: '/home',
      layouts: {}, dockLayouts: null, dockDefaults: {}, visitedScenes: ['center'], dockSaveErrors: {},
      businessPathsByScene: {}, proposalHrefsByScene: {}, sessionBindings: {}, sessionErrors: {}, panelRefreshKeys: {},
    }
    let layoutApi
    let sessionsApi
    let modelDirectoriesApi
    let themeApi
    let activeColorScheme = 'light'
    let businessOriginCallback
    let roleDefinitionsCallback
    let configRequest
    let sceneStateRequest
    const sessionRequests = new Map()

    function publish(patch) {
      snapshot = { ...snapshot, ...patch }
      for (const listener of listeners) listener()
    }

    function validRoleMetadata(roles) {
      if (!Array.isArray(roles) || roles.length === 0 || roles.length > 32) return false
      const seen = new Set()
      return roles.every(role => {
        if (!role || typeof role !== 'object' || Array.isArray(role)
          || Object.keys(role).sort().join(',') !== 'assistantLabel,id,label'
          || typeof role.id !== 'string' || !/^[a-z0-9-]{1,48}$/.test(role.id) || seen.has(role.id)
          || typeof role.label !== 'string' || !role.label.trim() || role.label.length > 100
          || typeof role.assistantLabel !== 'string' || !role.assistantLabel.trim() || role.assistantLabel.length > 100) return false
        seen.add(role.id)
        return true
      })
    }

    function isRoleId(config, roleId) {
      return typeof roleId === 'string' && Array.isArray(config?.roles)
        && config.roles.some(role => role?.id === roleId)
    }

    function normalizePanelStyle(layout, expanded = false) {
      if (expanded) return { gridColumn: '1 / -1', gridRow: '1 / -1', zIndex: 2 }
      return { gridColumn: `${layout.col} / span ${layout.w}`, gridRow: `${layout.row} / span ${layout.h}` }
    }

    function rememberLayout(layouts, sceneId, layout) {
      return { ...layouts, [sceneId]: { ...(layouts[sceneId] ?? {}), ...layout } }
    }

    function selectScene(current, sceneId) {
      const scene = current?.config?.scenes?.find(item => item.id === sceneId)
      if (!scene) return current
      const mainPath = scene.panels.find(panel => panel.id === 'business-main' && panel.type === 'business-iframe')?.path
      const businessPath = current.businessPathsByScene?.[sceneId] ?? scene.defaultBusinessRoute ?? mainPath ?? current.businessPath
      return {
        ...current, activeSceneId: sceneId, businessPath,
        visitedScenes: [...new Set([...(current.visitedScenes ?? []), sceneId])],
      }
    }

    function requestDockview() {
      if (!asyncRequire) return Promise.reject(new Error('dockview-loader-unavailable'))
      if (!dockviewRequest) {
        dockviewRequest = asyncRequire('./client.dockview.js').then(value => {
          const module = value?.default ?? value
          if (!module || typeof module.DockviewReact !== 'object' && typeof module.DockviewReact !== 'function'
            || typeof module.dockviewCss !== 'string') throw new Error('dockview-asset-unavailable')
          return module
        }).catch(error => { dockviewRequest = undefined; throw error })
      }
      return dockviewRequest
    }

    function dockRecordFor(sceneId, dockview) {
      const scene = snapshot.config?.scenes.find(item => item.id === sceneId)
      if (!scene || !dockview || typeof dockview !== 'object') return undefined
      const previous = snapshot.dockLayouts?.scenes?.[sceneId]
      const openPanels = dockview.panels && typeof dockview.panels === 'object' ? dockview.panels : {}
      const panels = { ...openPanels }
      for (const panel of scene.panels) {
        if (panel.type === 'native-chat' && panels[panel.id]) panels[panel.id] = { ...panels[panel.id], title: panel.title }
      }
      return {
        version: 2,
        dockview: { ...dockview, panels },
        closedPanelIds: scene.panels.filter(panel => !Object.prototype.hasOwnProperty.call(openPanels, panel.id)).map(panel => panel.id),
        legacyV1Snapshot: previous?.legacyV1Snapshot ?? null,
        migration: previous?.migration ?? { status: 'default', reason: 'client-layout-change' },
      }
    }

    function queueDockLayoutSave(sceneId, dockview) {
      const record = dockRecordFor(sceneId, dockview)
      if (!record) return Promise.resolve(false)
      const nextScenes = { ...(snapshot.dockLayouts?.scenes ?? {}), [sceneId]: record }
      publish({ dockLayouts: { version: 2, scenes: nextScenes }, dockSaveErrors: { ...snapshot.dockSaveErrors, [sceneId]: '' } })
      dockRevision++
      const requested = dockRevision
      dockSaveQueue = dockSaveQueue.catch(() => {}).then(async () => {
        while (dockPersistedRevision < requested) {
          const revision = dockRevision
          const response = await fetch('/tradeloom/dock-layouts', {
            method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify(snapshot.dockLayouts),
          })
          if (!response.ok) throw new Error('dock-layout-save-failed')
          dockPersistedRevision = revision
          publish({ dockSaveErrors: Object.fromEntries(Object.keys(snapshot.dockSaveErrors).map(id => [id, ''])) })
        }
        return true
      }).catch(() => {
        publish({ dockSaveErrors: { ...snapshot.dockSaveErrors, [sceneId]: '布局保存失败，请重试。' } })
        return false
      })
      return dockSaveQueue
    }

    function focusScenePanel(sceneId, panelId) {
      const api = dockviewApis.get(sceneId)
      const panel = api?.getPanel(panelId)
      if (panel) panel.api.setActive()
      return Boolean(panel)
    }

    function refreshScenePanel(sceneId, panelId) {
      const sceneKeys = snapshot.panelRefreshKeys?.[sceneId] ?? {}
      const panelRefreshKeys = {
        ...snapshot.panelRefreshKeys,
        [sceneId]: { ...sceneKeys, [panelId]: (sceneKeys[panelId] ?? 0) + 1 },
      }
      publish({ panelRefreshKeys })
      return panelRefreshKeys[sceneId][panelId]
    }

    function reopenScenePanel(sceneId, panelId) {
      const api = dockviewApis.get(sceneId)
      const scene = snapshot.config?.scenes.find(item => item.id === sceneId)
      const panel = scene?.panels.find(item => item.id === panelId)
      if (!api || !panel) return false
      const existing = api.getPanel(panelId)
      if (existing) { existing.api.setActive(); return true }
      const reference = api.getPanel('business-main') ?? api.getPanels?.()[0]
      api.addPanel({
        id: panel.id, component: panel.type,
        title: panel.type === 'native-chat' ? assistantLabel(roleForScene(snapshot.config, sceneId)) : panel.title,
        renderer: 'always',
        params: { panelId: panel.id },
        ...(reference ? { position: { referencePanel: reference.id, direction: 'within' } } : {}),
      })
      api.getPanel(panelId)?.api.setActive()
      return true
    }

    function requestScenePanelFocus(sceneId, panelId) {
      if (focusScenePanel(sceneId, panelId) || reopenScenePanel(sceneId, panelId)) {
        pendingScenePanelFocus.delete(sceneId)
        return true
      }
      pendingScenePanelFocus.set(sceneId, panelId)
      return false
    }

    function sceneNavigationItems(config) {
      return (Array.isArray(config?.scenes) ? config.scenes : []).map(scene => ({
        id: scene.id,
        label: scene.label,
        icon: typeof scene.icon === 'string' && scene.icon ? scene.icon : scene.label.slice(0, 1),
        route: scene.defaultBusinessRoute ?? null,
      }))
    }

    function sceneIcon(sceneId) {
      const common = { viewBox: '0 0 20 20', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' }
      const shape = {
        center: [h('rect', { x: 2.5, y: 2.5, width: 6, height: 6, rx: 1 }), h('rect', { x: 11.5, y: 2.5, width: 6, height: 6, rx: 1 }), h('rect', { x: 2.5, y: 11.5, width: 6, height: 6, rx: 1 }), h('rect', { x: 11.5, y: 11.5, width: 6, height: 6, rx: 1 })],
        products: [h('path', { d: 'm10 2.5 7 4v7l-7 4-7-4v-7l7-4Z' }), h('path', { d: 'm3 6.5 7 4 7-4M10 10.5v7' })],
        'agent-center': [h('rect', { x: 4, y: 3.5, width: 12, height: 14, rx: 1.5 }), h('path', { d: 'M7 3.5v-1h6v1M7 8h6M7 11h6M7 14h4' })],
        deliverables: [h('path', { d: 'M3 4.5h14v3H3zM4 7.5v9h12v-9M8 11h4m-2-2v5m-2-2 2 2 2-2' })],
        runs: [h('circle', { cx: 10, cy: 10, r: 7.5 }), h('path', { d: 'M10 5.5v5l3.5 2' })],
        'user-profile': [h('circle', { cx: 10, cy: 6.5, r: 3 }), h('path', { d: 'M3.5 17c.7-3.1 3.1-4.8 6.5-4.8s5.8 1.7 6.5 4.8' })],
        erpnext: [h('rect', { x: 3, y: 2.5, width: 14, height: 15, rx: 1.5 }), h('path', { d: 'M6 6h8M6 9h8M6 12h3M11.5 12H14M6 15h3M11.5 15H14' })],
        // 工作流：三个节点用连线串起来
        workflow: [h('rect', { x: 1.5, y: 3, width: 5, height: 4, rx: 1 }), h('rect', { x: 13.5, y: 3, width: 5, height: 4, rx: 1 }), h('rect', { x: 7.5, y: 13, width: 5, height: 4, rx: 1 }), h('path', { d: 'M6.5 5h7M4 7v3.5c0 2 1.5 4.5 3.5 4.5M16 7v3.5c0 2-1.5 4.5-3.5 4.5' })],
      }[sceneId]
      return h('svg', common, ...(shape ?? [h('circle', { cx: 10, cy: 10, r: 6 })]))
    }

    function updatePanelLayout(layout, panelId, action) {
      const panels = layout.panels ?? {}
      if (action === 'expand') return { ...layout, expandedPanel: layout.expandedPanel === panelId ? '' : panelId }
      if (action === 'hide' || action === 'restore') {
        const current = panels[panelId] ?? { visible: true }
        return { ...layout, panels: { ...panels, [panelId]: { ...current, visible: action === 'restore' } } }
      }
      if (action === 'refresh') return { ...layout, refreshCounts: { ...(layout.refreshCounts ?? {}), [panelId]: (layout.refreshCounts?.[panelId] ?? 0) + 1 } }
      return layout
    }

    function roleForScene(config, sceneId) {
      const roleId = snapshot.roleByScene[sceneId] ?? config?.scenes?.find(scene => scene.id === sceneId)?.roleId
      return isRoleId(config, roleId) ? roleId : undefined
    }

    function bindSession(bindings, roleId, sessionId, config = snapshot.config) {
      if (!isRoleId(config, roleId) || typeof sessionId !== 'string' || sessionId.length === 0) return bindings
      return { ...bindings, [roleId]: sessionId }
    }

    function modelDirectoryEntries(groups) {
      return (Array.isArray(groups) ? groups : []).map(group => ({
        provider: group.id,
        providerName: group.name,
        models: (Array.isArray(group.models) ? group.models : []).map(model => ({
          provider: group.id, providerName: group.name, id: model.id, name: model.name,
        })),
      }))
    }

    function providerBadgeLabel(providerName) {
      const name = typeof providerName === 'string' ? providerName.trim() : ''
      return name.match(/[A-Za-z0-9]/)?.[0]?.toUpperCase() ?? Array.from(name)[0] ?? '模'
    }

    function currentModelLabel(current, groups) {
      if (!current) return '选择模型'
      const provider = (Array.isArray(groups) ? groups : []).find(group => (group.provider ?? group.id) === current.provider)
      const model = provider?.models?.find(item => item.id === current.model)
      return provider && model ? `${provider.providerName ?? provider.name} · ${model.name}` : '已选择模型'
    }

    function persistState(next = snapshot) {
      if (!next.config) return Promise.resolve(false)
      const value = {
        version: 1,
        activeSceneId: next.activeSceneId,
        roleByScene: next.roleByScene,
        businessPath: next.businessPath,
        layouts: Object.fromEntries(next.config.scenes.map(scene => [scene.id, {
          expandedPanel: next.layouts[scene.id]?.expandedPanel ?? '',
          panels: Object.fromEntries(scene.panels.map(panel => {
            const saved = next.layouts[scene.id]?.panels?.[panel.id] ?? {}
            return [panel.id, { col: saved.col ?? panel.col, row: saved.row ?? panel.row, w: saved.w ?? panel.w, h: saved.h ?? panel.h, visible: saved.visible !== false }]
          })),
        }])) ,
      }
      return fetch('/tradeloom/scene-layouts', {
        method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value),
      }).then(response => response.ok).catch(() => false)
    }

    function defaultDockRecord(scene) {
      const chat = scene.panels.filter(panel => panel.type === 'native-chat')
      const business = scene.panels.filter(panel => panel.type !== 'native-chat')
      const makeLeaf = (id, panels, size) => ({
        type: 'leaf', data: { views: panels.map(panel => panel.id), activeView: panels[0]?.id, id }, size,
      })
      let root
      let orientation = 'HORIZONTAL'
      let activeGroup = '1'
      if (chat.length > 0 && business.length > 0 && scene.layoutProfile?.kind === 'collaboration_grid'
        && ['business-main', 'auxiliary', 'reference', 'native-chat'].every(id => scene.panels.some(panel => panel.id === id))) {
        const byId = new Map(scene.panels.map(panel => [panel.id, panel]))
        const leaf = (groupId, panelId, size) => makeLeaf(groupId, [byId.get(panelId)], size)
        const row = (id, size, leftId, leftSize, rightId, rightSize) => ({
          type: 'branch', size,
          data: [leaf(`${id}a`, leftId, leftSize), leaf(`${id}b`, rightId, rightSize)],
        })
        root = { type: 'branch', size: 100, data: [
          row('top', 58, 'business-main', 75, 'auxiliary', 25),
          row('bottom', 42, 'reference', 25, 'native-chat', 75),
        ] }
        orientation = 'VERTICAL'
        activeGroup = 'topa'
      } else if (chat.length > 0 && business.length > 0) {
        const split = scene.layoutProfile?.kind === 'assistant_lead' ? [32, 68] : [72, 28]
        root = { type: 'branch', data: [makeLeaf('1', business, split[0]), makeLeaf('2', chat, split[1])], size: 100 }
        if (scene.layoutProfile?.kind === 'assistant_lead') activeGroup = '2'
      } else root = { type: 'branch', data: [makeLeaf('1', scene.panels, 100)], size: 100 }
      return {
        version: 2, closedPanelIds: [], legacyV1Snapshot: null,
        migration: { status: 'default', reason: 'client-reset-default' },
        dockview: {
          grid: { root, width: 100, height: 100, orientation },
          panels: Object.fromEntries(scene.panels.map(panel => [panel.id, {
            id: panel.id, contentComponent: panel.type, title: panel.title, renderer: 'always', params: { panelId: panel.id },
          }])),
          activeGroup,
        },
      }
    }

    async function loadConfig(force = false) {
      if (force) {
        configRequest = undefined
        sceneStateRequest = undefined
        publish({ config: null, configError: '' })
      }
      if (snapshot.config) return snapshot.config
      if (!configRequest) {
        configRequest = Promise.all([
          fetch('/tradeloom/scenes', { method: 'GET', credentials: 'same-origin' }).then(async response => {
            const config = await response.json()
            if (!response.ok || config?.version !== 1 || !Array.isArray(config.scenes) || config.scenes.length === 0
            || !validRoleMetadata(config.roles)
              || !config.scenes.every(scene => typeof scene.id === 'string' && typeof scene.label === 'string'
                && isRoleId(config, scene.roleId) && Array.isArray(scene.panels))) throw new Error()
            return config
          }),
          fetch('/tradeloom/scene-layouts', { method: 'GET', credentials: 'same-origin' }).then(async response => {
            const state = await response.json()
            if (!response.ok || state?.version !== 1 || typeof state.activeSceneId !== 'string'
              || !state.roleByScene || typeof state.roleByScene !== 'object' || !state.layouts || typeof state.layouts !== 'object') throw new Error()
            return state
          }),
          fetch('/tradeloom/dock-layouts', { method: 'GET', credentials: 'same-origin' }).then(async response => {
            const state = await response.json()
            if (!response.ok || state?.version !== 2 || !state.scenes || typeof state.scenes !== 'object') throw new Error()
            return state
          }),
        ]).then(([config, saved, savedDockLayouts]) => {
          if (!config.scenes.some(scene => scene.id === saved.activeSceneId)) throw new Error()
          const sceneIds = new Set(config.scenes.map(scene => scene.id))
          if (Object.keys(saved.roleByScene).some(id => !sceneIds.has(id) || !isRoleId(config, saved.roleByScene[id]))) throw new Error()
          if (Object.keys(saved.layouts).some(id => !sceneIds.has(id))) throw new Error()
          if (Object.keys(savedDockLayouts.scenes).some(id => !sceneIds.has(id))) throw new Error()
          if (config.scenes.some(scene => {
            const record = savedDockLayouts.scenes[scene.id]
            return !record || record.version !== 2 || !record.dockview || !Array.isArray(record.closedPanelIds)
          })) throw new Error()
          const normalizedLayouts = Object.fromEntries(config.scenes.map(scene => {
            const savedLayout = saved.layouts[scene.id] ?? {}
            const savedPanels = savedLayout.panels ?? {}
            const panels = Object.fromEntries(scene.panels.map(panel => {
              const current = savedPanels[panel.id] ?? {}
              const insideGrid = [current.col ?? panel.col, current.row ?? panel.row, current.w ?? panel.w, current.h ?? panel.h]
                .every(value => Number.isInteger(value) && value >= 1 && value <= 4)
              const col = insideGrid ? (current.col ?? panel.col) : panel.col
              const row = insideGrid ? (current.row ?? panel.row) : panel.row
              const w = insideGrid ? (current.w ?? panel.w) : panel.w
              const height = insideGrid ? (current.h ?? panel.h) : panel.h
              return [panel.id, { col, row, w, h: height, visible: current.visible !== false }]
            }))
            return [scene.id, { expandedPanel: scene.panels.some(panel => panel.id === savedLayout.expandedPanel) ? savedLayout.expandedPanel : '', panels, refreshCounts: {} }]
          }))
          const businessPathsByScene = Object.fromEntries(config.scenes.map(scene => [
            scene.id,
            saved.activeSceneId === scene.id ? saved.businessPath ?? scene.defaultBusinessRoute
              : scene.defaultBusinessRoute ?? scene.panels.find(panel => panel.id === 'business-main')?.path ?? null,
          ]))
          const next = {
            config, configError: '', activeSceneId: saved.activeSceneId,
            roleByScene: Object.fromEntries(config.scenes.map(scene => [scene.id, saved.roleByScene[scene.id] ?? scene.roleId])),
            businessPath: saved.businessPath ?? config.scenes.find(scene => scene.id === saved.activeSceneId)?.defaultBusinessRoute ?? '/home',
            layouts: normalizedLayouts, dockLayouts: savedDockLayouts,
            dockDefaults: Object.fromEntries(config.scenes.map(scene => [scene.id, defaultDockRecord(scene)])),
            visitedScenes: [...new Set([...(snapshot.visitedScenes ?? []), saved.activeSceneId])],
            businessPathsByScene, proposalHrefsByScene: {}, dockSaveErrors: {},
            sessionBindings: snapshot.sessionBindings, sessionErrors: {},
          }
          publish(next)
          businessOriginCallback?.(config.businessOrigin)
          roleDefinitionsCallback?.({ status: 'ready', error: '', roles: config.roles.map(({ id, label, assistantLabel }) => ({ id, label, assistantLabel })) })
          return config
        }).catch(() => {
          configRequest = undefined
          publish({ configError: '工作场景暂时无法读取，请重试。' })
          roleDefinitionsCallback?.({ status: 'error', error: '助手列表暂不可用，请重试。', roles: null })
          throw new Error('workbench-unavailable')
        })
        roleDefinitionsCallback?.({ status: 'loading', error: '', roles: null })
      }
      return await configRequest
    }

    async function ensureRoleSession(roleId) {
      if (!isRoleId(snapshot.config, roleId)) return undefined
      const bound = snapshot.sessionBindings[roleId]
      if (bound) return bound
      if (sessionRequests.has(roleId)) return await sessionRequests.get(roleId)
      const request = fetch('/tradeloom/session', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ role: roleId }),
      }).then(async response => {
        const result = await response.json()
        if (!response.ok || result.role !== roleId || typeof result.sessionId !== 'string' || !result.sessionId) throw new Error('会话暂时无法连接')
        publish({ sessionBindings: bindSession(snapshot.sessionBindings, roleId, result.sessionId), sessionErrors: { ...snapshot.sessionErrors, [roleId]: '' } })
        void persistState()
        return result.sessionId
      }).catch(error => {
        publish({ sessionErrors: { ...snapshot.sessionErrors, [roleId]: error instanceof Error ? error.message : '连接失败' } })
        return undefined
      }).finally(() => sessionRequests.delete(roleId))
      sessionRequests.set(roleId, request)
      return await request
    }

    function selectRole(roleId, knownSessionId) {
      if (!isRoleId(snapshot.config, roleId)) return Promise.resolve(false)
      const bindings = typeof knownSessionId === 'string' && knownSessionId
        ? bindSession(snapshot.sessionBindings, roleId, knownSessionId)
        : snapshot.sessionBindings
      const next = {
        ...snapshot,
        roleByScene: { ...snapshot.roleByScene, [snapshot.activeSceneId]: roleId },
        sessionBindings: bindings,
      }
      publish(next)
      layoutApi?.selectPanel('scene-workbench')
      const chatPanelId = snapshot.config?.scenes.find(item => item.id === snapshot.activeSceneId)?.panels.find(panel => panel.type === 'native-chat')?.id
      if (chatPanelId) { if (!focusScenePanel(snapshot.activeSceneId, chatPanelId)) reopenScenePanel(snapshot.activeSceneId, chatPanelId) }
      void persistState(next)
      return (knownSessionId ? Promise.resolve(knownSessionId) : ensureRoleSession(roleId)).then(sessionId => Boolean(sessionId))
    }

    function bindRoleSession(roleId, sessionId) {
      const bindings = bindSession(snapshot.sessionBindings, roleId, sessionId)
      if (bindings === snapshot.sessionBindings) return false
      const next = { ...snapshot, sessionBindings: bindings }
      publish(next)
      void persistState(next)
      return true
    }

    function navigateBusiness(path, proposalHref) {
      const target = snapshot.config?.businessRoutes?.[path]
      if (!target) return false
      const next = {
        ...snapshot, activeSceneId: target.sceneId, businessPath: path,
        businessPathsByScene: { ...snapshot.businessPathsByScene, [target.sceneId]: path },
        proposalHrefsByScene: { ...snapshot.proposalHrefsByScene, [target.sceneId]: proposalHref ?? '' },
        visitedScenes: [...new Set([...(snapshot.visitedScenes ?? []), target.sceneId])],
      }
      publish(next)
      layoutApi?.selectPanel('scene-workbench')
      requestScenePanelFocus(target.sceneId, target.panelId)
      void persistState(next)
      return true
    }

    function navigateScene(sceneId) {
      const scene = snapshot.config?.scenes?.find(item => item.id === sceneId)
      if (!scene) return false
      if (scene.defaultBusinessRoute) return navigateBusiness(scene.defaultBusinessRoute)
      const next = selectScene(snapshot, sceneId)
      publish(next)
      layoutApi?.selectPanel('scene-workbench')
      const panelId = scene.panels.find(panel => panel.type === 'erpnext-status')?.id ?? scene.panels[0]?.id
      if (panelId) requestScenePanelFocus(sceneId, panelId)
      void persistState(next)
      return true
    }

    function useSnapshot() {
      const [current, setCurrent] = React.useState(snapshot)
      React.useEffect(() => {
        const listener = () => setCurrent(snapshot)
        listeners.add(listener)
        return () => listeners.delete(listener)
      }, [])
      return current
    }

    function SceneTabs({ onSceneSelect, workbenchActive } = {}) {
      const state = useSnapshot()
      const activeSceneId = state.activeSceneId
      const [, setActionRevision] = React.useState(0)
      const [layoutMenuOpen, setLayoutMenuOpen] = React.useState(false)
      const layoutContext = dockRenderContexts.get(activeSceneId) ?? {}
      React.useEffect(() => { void loadConfig().catch(() => {}) }, [])
      React.useEffect(() => subscribeDockActions(activeSceneId, () => setActionRevision(value => value + 1)), [activeSceneId])
      const layoutMenuId = 'tl-scene-layout-menu'
      function positionLayoutMenu(event) {
        if (typeof document === 'undefined' || typeof window === 'undefined') return
        const popover = document.getElementById(layoutMenuId)
        if (!popover) return
        const rect = event.currentTarget.getBoundingClientRect()
        const width = Math.min(240, window.innerWidth - 16)
        popover.style.position = 'fixed'
        popover.style.inset = 'auto'
        popover.style.margin = '0'
        popover.style.left = `${Math.max(8, Math.min(window.innerWidth - width - 8, rect.left))}px`
        popover.style.top = `${Math.max(8, Math.min(window.innerHeight - 180, rect.bottom + 4))}px`
      }
      function runLayoutAction(action) {
        return () => {
          if (typeof document === 'undefined') { action?.(); return }
          const popover = document.getElementById(layoutMenuId)
          if (popover?.matches?.(':popover-open')) popover.hidePopover?.()
          setLayoutMenuOpen(false)
          action?.()
        }
      }
      return h(React.Fragment, null,
        sceneNavigationItems(state.config).map(scene => h('button', {
          key: scene.id, type: 'button', className: 'tl-scene-tab',
          'aria-label': scene.label, title: scene.label,
          'aria-current': workbenchActive && state.activeSceneId === scene.id ? 'page' : undefined,
          onClick: () => typeof onSceneSelect === 'function' ? onSceneSelect(scene.id) : navigateScene(scene.id),
        }, h('span', { className: 'tl-scene-tab-icon' }, sceneIcon(scene.id)),
        h('span', { className: 'tl-scene-tab-label' }, scene.label))),
        workbenchActive ? h(React.Fragment, null,
          h('button', { type: 'button', className: 'tl-scene-layout-trigger', 'aria-label': '工作区布局', title: '工作区布局',
            disabled: typeof layoutContext.resetLayout !== 'function', 'aria-haspopup': 'true', 'aria-expanded': layoutMenuOpen,
            popovertarget: layoutMenuId, popovertargetaction: 'toggle',
            onClick: positionLayoutMenu }, '布局'),
          h('div', { id: layoutMenuId, className: 'tl-layout-menu-popover', popover: 'auto', role: 'group', 'aria-label': '工作区布局',
            onToggle: event => setLayoutMenuOpen(event.newState === 'open') },
            h('span', { className: 'tl-layout-menu-title' }, '工作区布局'),
            h('button', { type: 'button', onClick: runLayoutAction(layoutContext.resetLayout) }, '应用推荐布局'),
            ...(layoutContext.closedPanels ?? []).map(closed => h('button', { key: closed.id, type: 'button',
              onClick: runLayoutAction(() => layoutContext.selectPanel?.(closed.id)) }, `恢复${closed.title}`)),
            layoutContext.saveError ? h('button', { type: 'button', onClick: runLayoutAction(layoutContext.retrySave) }, '重试保存布局') : null,
            layoutContext.error ? h('button', { type: 'button', onClick: runLayoutAction(layoutContext.resetLayout) }, '重试推荐布局') : null)) : null,
        state.configError ? h('span', { role: 'status' }, state.configError) : null)
    }

    function modelDirectoryDiagnostic(stage, error, missingService = '') {
      const phaseLabels = {
        setup: '准备目录服务',
        retain: '连接助手会话',
        ready: '等待会话就绪',
        directoryFor: '创建模型目录',
        subscribe: '订阅模型目录',
        load: '读取模型目录',
      }
      const serviceNames = new Set(['sessions', 'modelDirectories'])
      const injectableServiceNames = new Set(['sessions', 'modelDirectories', 'remote', 'remote.session'])
      let reason = 'unavailable'
      if (serviceNames.has(missingService)) reason = `missingInjected:${missingService}`
      else {
        const message = error && typeof error.message === 'string' ? error.message : ''
        if (/^ui-model-selection: session "[^"]+" resolved no scope$/.test(message)) reason = 'missingScope'
        else if (/^ui-model-selection: session "[^"]+" resolved no binding$/.test(message)) reason = 'missingBinding'
        else if (message === "Cannot read properties of undefined (reading 'directoryFor')"
          || message === 'directoryFor is not a function') reason = 'missingInjected:modelDirectories'
        else {
          const missingInjection = message.match(/^cannot get property ["']([^"']+)["'] without inject$/i)?.[1]
          if (injectableServiceNames.has(missingInjection)) reason = `missingInjected:${missingInjection}`
        }
      }
      const phase = Object.prototype.hasOwnProperty.call(phaseLabels, stage) ? stage : 'load'
      return {
        phase,
        reason,
        error: '模型目录暂时无法加载，请重新打开工作台或检查模型配置。',
      }
    }

    function ModelDirectoryFailure({ diagnostic }) {
      return h('span', {
        role: 'status',
        'data-model-directory-phase': diagnostic.phase,
        'data-model-directory-error': diagnostic.reason,
      }, diagnostic.error)
    }

    function ModelDirectoryRail() {
      const state = useSnapshot()
      const scene = state.config?.scenes.find(item => item.id === state.activeSceneId)
      const roleId = scene ? roleForScene(state.config, scene.id) : undefined
      const sessionId = roleId ? state.sessionBindings[roleId] : undefined
      const directoryKey = roleId && sessionId ? JSON.stringify([roleId, sessionId]) : ''
      const [directoryInfo, setDirectoryInfo] = React.useState({ key: '', status: 'idle', snapshot: null, error: '' })
      const [themeError, setThemeError] = React.useState('')
      const activeDirectoryInfo = directoryInfo.key === directoryKey ? directoryInfo : null
      const directoryState = activeDirectoryInfo?.snapshot
      const directoryError = activeDirectoryInfo?.error ?? ''
      function updateSelectionState(directory, error = '') {
        setDirectoryInfo(current => {
          if (!directoryKey || current.key !== directoryKey) return current
          return {
            ...current,
            status: error ? 'error' : 'ready',
            snapshot: directory ? directory.store.getSnapshot() : current.snapshot,
            error,
          }
        })
      }
      React.useEffect(() => {
        let live = true
        let unsubscribe
        if (!roleId || !sessionId) {
          return () => { live = false }
        }
        const missingService = !sessionsApi ? 'sessions' : !modelDirectoriesApi ? 'modelDirectories' : ''
        if (missingService) {
          const diagnostic = modelDirectoryDiagnostic('setup', null, missingService)
          setDirectoryInfo({ key: directoryKey, status: 'error', snapshot: null, ...diagnostic })
          return () => { live = false }
        }
        setDirectoryInfo({ key: directoryKey, status: 'pending', snapshot: null, error: '' })
        void (async () => {
          let stage = 'retain'
          try {
            const reference = retainRoleSession(sessionsApi, roleId, sessionId)
            if (!reference) throw new Error('session-reference-unavailable')
            stage = 'ready'
            await reference.ready
            if (!live) return
            stage = 'directoryFor'
            const directory = modelDirectoriesApi.directoryFor(sessionId)
            const update = () => {
              if (live) setDirectoryInfo({ key: directoryKey, status: 'ready', snapshot: directory.store.getSnapshot(), error: '', phase: '', reason: '' })
            }
            stage = 'subscribe'
            unsubscribe = directory.store.subscribe(update)
            update()
            stage = 'load'
            await directory.load()
            update()
          } catch (error) {
            if (live) setDirectoryInfo({
              key: directoryKey, status: 'error', snapshot: null,
              ...modelDirectoryDiagnostic(stage, error),
            })
          }
        })()
        return () => { live = false; unsubscribe?.() }
      }, [roleId, sessionId])
      const entries = modelDirectoryEntries(directoryState?.groups)
      async function selectThemePreference(preference) {
        setThemeError('')
        try {
          themeApi?.setTheme?.(preference)
        } catch {
          setThemeError('主题设置失败，请重试。')
        }
      }
      const themePreference = themeApi?.getTheme?.()?.preference
      const followsSystem = themePreference === 'system'
      const currentAppearance = followsSystem
        ? `跟随系统（${activeColorScheme === 'dark' ? '深色' : '浅色'}）`
        : activeColorScheme === 'dark' ? '深色' : '浅色'
      const nextAppearance = followsSystem
        ? activeColorScheme === 'dark' ? '浅色' : '深色'
        : '跟随系统'
      const appearanceLabel = `当前外观：${currentAppearance}，切换到${nextAppearance}`
      const currentModel = sessionId
        ? directoryState?.current ? currentModelLabel(directoryState.current, directoryState.groups)
          : activeDirectoryInfo?.status === 'pending' ? '正在连接模型目录…' : '选择模型'
        : '连接助手后选择模型'
      function cycleThemePreference() {
        const nextPreference = followsSystem
          ? activeColorScheme === 'dark' ? 'light' : 'dark'
          : 'system'
        void selectThemePreference(nextPreference)
      }
      return h(React.Fragment, null,
        h('style', { 'data-tradeloom-navigation-style': 'true' }, `
          .tl-model-rail {
            --tl-shell-surface: var(--dsw-alias-bg-layer-1, #fff); --tl-shell-soft: var(--dsw-alias-bg-layer-2, #e9eef6); --tl-shell-ink: var(--dsw-alias-label-primary, #202b3a);
            --tl-shell-muted: var(--dsw-alias-label-secondary, #68778c); --tl-shell-line: var(--dsw-alias-border-l1, #cbd5e2); --tl-shell-accent: var(--dsw-alias-brand-primary, #356fc4);
            --tl-shell-accent-soft: var(--dsw-alias-bg-layer-2, #e5eefb); --tl-shell-button: var(--dsw-alias-brand-primary, #356fc4); --tl-shell-button-hover: #285ca4;
            --tl-shell-button-ink: #fff; --tl-shell-danger: #ba2121; --tl-shell-danger-bg: #fdecea; --tl-shell-danger-line: #f5c6c6;
            display: flex; flex: 1 1 0; align-items: center; gap: 6px; min-width: 0; min-height: 34px;
            padding: 2px 4px; overflow: visible; position: relative; z-index: 30;
            color: var(--tl-shell-ink); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px;
          }
          .tl-model-current { position:absolute; width:1px; height:1px; padding:0; margin:-1px; overflow:hidden; clip:rect(0,0,0,0); white-space:nowrap; border:0; }
          .tl-model-groups { display: flex; flex: 0 0 auto; align-items: center; gap: 4px; min-width: 0; overflow: visible; }
          .tl-model-group { position: relative; flex: 0 0 auto; min-width: 32px; max-width: 32px; }
          .tl-model-group > summary {
            display:grid; place-items:center; box-sizing:border-box; width:32px; min-width:32px; height:32px; padding:0;
            border:1px solid var(--tl-shell-line); border-radius:8px; background:var(--tl-shell-surface);
            color:var(--tl-shell-ink); cursor:pointer; list-style:none; white-space:nowrap; text-align:center; line-height:1; font-size:13px; font-weight:700;
          }
          .tl-model-group > summary::-webkit-details-marker { display: none; }
          .tl-model-group > summary:focus-visible, .tl-model-options button:focus-visible,
          .tl-theme-cycle:focus-visible, .tl-scene-tab:focus-visible, .tl-scene-layout-trigger:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
          .tl-model-options {
            position: absolute; top: calc(100% + 5px); left: 0; z-index: 50; display: grid; gap: 3px;
            min-width: 180px; max-height: min(60vh,360px); overflow: auto; padding: 6px;
            border: 1px solid var(--tl-shell-line); border-radius: 7px; background: var(--tl-shell-surface);
            color: var(--tl-shell-ink); box-shadow: 0 8px 24px rgba(0,0,0,.18);
          }
          .tl-model-options > strong { display:block; padding:6px 9px; border-bottom:1px solid var(--tl-shell-line); font-size:12px; }
          .tl-model-options button { width: 100%; border: 0; border-radius: 5px; padding: 7px 9px; text-align: left; background: transparent; color: inherit; cursor: pointer; }
          .tl-model-options button:hover, .tl-model-options button[aria-current="true"] { background: var(--tl-shell-accent-soft); }
          .tl-theme-toggle { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; margin-left: auto; }
          .tl-theme-cycle {
            position: relative; display: grid; place-items: center; width: 30px; height: 30px; padding: 3px;
            border: 1px solid var(--tl-shell-line); border-radius: 6px; background: var(--tl-shell-surface);
            color: var(--tl-shell-ink); cursor: pointer; transition: background-color 120ms ease, border-color 120ms ease;
          }
          .tl-theme-cycle:hover { background: var(--tl-shell-soft); border-color: var(--tl-shell-accent); }
          .tl-theme-cycle svg { display: block; width: 18px; height: 18px; }
          .tl-theme-auto-badge {
            position: absolute; right: -2px; bottom: -2px; display: grid; place-items: center;
            width: 10px; height: 10px; border: 1px solid var(--tl-shell-line); border-radius: 50%;
            background: var(--tl-shell-soft); color: var(--tl-shell-muted); font-size: 7px; font-weight: 700; line-height: 1;
          }
          .tl-theme-error { margin: 0 10px 3px; color: var(--tl-shell-danger); font-size: 12px; }
          .tl-navigation .tl-scene-tab { display: inline-flex; align-items: center; justify-content: flex-start; gap: 0; min-width: 34px; height: 32px; padding: 0 8px; overflow: hidden; border: 1px solid transparent; border-radius: 6px; white-space: nowrap; transition: min-width 120ms ease, background-color 120ms ease, border-color 120ms ease; }
          .tl-navigation .tl-scene-tab-icon { display: inline-flex; align-items: center; justify-content: center; flex: 0 0 18px; font-size: 13px; }
          .tl-navigation .tl-scene-tab-icon svg { display: block; width: 16px; height: 16px; }
          .tl-navigation .tl-scene-tab-label { max-width: 0; overflow: hidden; opacity: 0; transition: max-width 120ms ease, opacity 120ms ease; }
          .tl-navigation .tl-scene-tab:hover, .tl-navigation .tl-scene-tab:focus-visible, .tl-navigation .tl-scene-tab[aria-current="page"] { gap: 6px; background: var(--tl-shell-accent-soft); border-color: var(--tl-shell-line); }
          .tl-navigation .tl-scene-tab:hover .tl-scene-tab-label, .tl-navigation .tl-scene-tab:focus-visible .tl-scene-tab-label, .tl-navigation .tl-scene-tab[aria-current="page"] .tl-scene-tab-label { max-width: 140px; opacity: 1; }
          .tl-navigation .tl-scene-layout-trigger { flex:0 0 auto; min-width:34px; min-height:30px; padding:4px 9px; border:1px solid var(--tl-shell-line); border-radius:6px; background:var(--tl-shell-surface); color:var(--tl-shell-ink); font:inherit; cursor:pointer; }
          .tl-navigation .tl-scene-layout-trigger:hover:not(:disabled) { background:var(--tl-shell-soft); }
          .tl-navigation .tl-scene-layout-trigger:disabled { opacity:.55; cursor:default; }
          .tl-layout-menu-popover { position:fixed; inset:auto; margin:0; z-index:10000; display:grid; gap:3px; min-width:190px; max-width:min(240px,calc(100vw - 16px)); max-height:min(60vh,360px); overflow:auto; padding:6px; border:1px solid var(--tl-shell-line); border-radius:8px; background:var(--tl-shell-surface); color:var(--tl-shell-ink); box-shadow:0 8px 24px rgb(0 0 0 / 18%); }
          .tl-layout-menu-popover:not(:popover-open) { display:none; }
          .tl-layout-menu-popover button { min-height:34px; padding:6px 9px; border:0; border-radius:5px; background:transparent; color:inherit; font:inherit; text-align:start; cursor:pointer; }
          .tl-layout-menu-popover button:hover { background:var(--tl-shell-soft); }
          .tl-layout-menu-popover button:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:1px; }
          @media (prefers-reduced-motion: reduce) { .tl-navigation .tl-scene-tab, .tl-navigation .tl-scene-tab-label, .tl-theme-cycle { transition: none; } }
        `),
        h('nav', { className: `tl-model-rail ${activeColorScheme === 'dark' ? 'is-dark' : 'is-light'}`, 'aria-label': '模型目录' },
          h('span', { className: 'tl-model-current', role: 'status', 'aria-live': 'polite', title: currentModel }, currentModel),
          h('div', { className: 'tl-model-groups' }, entries.map(group => h('details', { key: group.provider, className: 'tl-model-group' },
            h('summary', { 'aria-label': `${group.providerName}模型列表`, title: group.providerName }, providerBadgeLabel(group.providerName)),
            h('div', { className: 'tl-model-options' }, h('strong', null, group.providerName), ...group.models.map(model => h('button', {
              key: `${model.provider}/${model.id}`, type: 'button',
              'aria-label': `选择${model.providerName}的${model.name}`, title: `${model.providerName} · ${model.name}`,
              'aria-current': directoryState?.current?.provider === model.provider && directoryState?.current?.model === model.id ? 'true' : undefined,
              onClick: async () => {
                if (!sessionId) return
                let directory
                try {
                  directory = modelDirectoriesApi.directoryFor(sessionId)
                  const result = await directory.select({ provider: model.provider, model: model.id })
                  updateSelectionState(directory, result.ok ? '' : '模型暂时无法切换')
                } catch { updateSelectionState(directory, '模型暂时无法切换') }
              },
            }, model.name)))))),
          h('div', { className: 'tl-theme-toggle' },
            h('button', { type: 'button', className: 'tl-theme-cycle', 'aria-label': appearanceLabel, title: appearanceLabel, onClick: cycleThemePreference },
              activeColorScheme === 'dark'
                ? h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' },
                  h('path', { d: 'M20.3 15.4A8.5 8.5 0 0 1 8.6 3.7 8.6 8.6 0 1 0 20.3 15.4Z' }))
                : h('svg', { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', 'aria-hidden': 'true' },
                  h('circle', { cx: 12, cy: 12, r: 4 }),
                  h('path', { d: 'M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42' })),
              followsSystem ? h('span', { className: 'tl-theme-auto-badge', 'aria-hidden': 'true' }, 'A') : null),
          ),
          directoryError ? h(ModelDirectoryFailure, { diagnostic: activeDirectoryInfo }) : null),
        themeError ? h('p', { className: 'tl-theme-error', role: 'alert' }, themeError) : null)
    }

    function PanelFrame({ panel, expanded, layout, onExpand, onRefresh, refreshLabel, onHide, children }) {
      return h('section', {
        className: 'tl-panel', 'aria-label': panel.title,
        style: { ...normalizePanelStyle(layout, expanded), minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', border: '1px solid var(--border-color, #d9e5e5)', borderRadius: 10, overflow: 'hidden', background: 'var(--background-color, Canvas)' },
      },
      h('header', { className: 'tl-panel-header' },
        h('strong', { style: { flex: 1 } }, panel.title),
        h('button', { type: 'button', onClick: onRefresh, 'aria-label': refreshLabel }, refreshLabel),
        h('button', { type: 'button', onClick: onExpand, 'aria-label': expanded ? `还原${panel.title}` : `展开${panel.title}` }, expanded ? '还原' : '展开'),
        h('button', { type: 'button', onClick: onHide, 'aria-label': `关闭${panel.title}` }, '关闭')),
      h('div', { className: 'tl-panel-body', style: {
        flex: 1, minWidth: 0, minHeight: 0, padding: panel.type === 'business-iframe' ? 0 : 10,
        ...(panel.type === 'native-chat' ? { display: 'flex', flexDirection: 'column' } : {}),
      } }, children))
    }

    function BusinessFrame({ panel, path, proposalHref, refreshKey }) {
      const src = path === '/agent-center' && proposalHref ? proposalHref : `/business${path}`
      return h('iframe', { key: `${refreshKey}:${src}`, 'data-tradeloom-business-frame': 'true', title: `织贸助手 · ${panel.title}`, src,
        style: { display: 'block', width: '100%', height: '100%', minHeight: 180, border: 0 } })
    }

    const ERP_DOCTYPES = Object.freeze(['Item', 'Customer', 'Supplier', 'Warehouse', 'Bin', 'Sales Order', 'Purchase Order'])
    const ERP_DOCTYPE_LABELS = Object.freeze({
      Item: '商品', Customer: '客户', Supplier: '供应商', Warehouse: '仓库', Bin: '库存数量',
      'Sales Order': '销售订单', 'Purchase Order': '采购订单',
    })
    const ERP_LIST_FIELDS = Object.freeze({
      Item: ['item_code', 'item_name', 'item_group', 'stock_uom', 'disabled'],
      Customer: ['customer_name', 'customer_type', 'customer_group', 'territory', 'disabled'],
      Supplier: ['supplier_name', 'supplier_type', 'supplier_group', 'country', 'disabled'],
      Warehouse: ['warehouse_name', 'company', 'parent_warehouse', 'disabled'],
      Bin: ['item_code', 'warehouse', 'actual_qty', 'reserved_qty', 'projected_qty', 'stock_uom'],
      'Sales Order': ['name', 'customer_name', 'company', 'transaction_date', 'status', 'grand_total', 'currency'],
      'Purchase Order': ['name', 'supplier_name', 'company', 'transaction_date', 'status', 'grand_total', 'currency'],
    })
    const ERP_FIELD_LABELS = Object.freeze({
      name: '编号', modified: '最后修改', item_code: '商品编码', item_name: '商品名称', item_group: '商品组',
      stock_uom: '库存单位', disabled: '已停用', description: '说明', brand: '品牌', image: '图片路径',
      is_stock_item: '库存商品', has_variants: '含变体', customer_name: '客户名称', alias: '别名',
      customer_type: '客户类型', customer_group: '客户组', territory: '区域', tax_id: '税号',
      default_currency: '默认币种', website: '网站', email_id: '电子邮箱', mobile_no: '手机',
      supplier_name: '供应商名称', supplier_type: '供应商类型', supplier_group: '供应商组', country: '国家/地区',
      warehouse_name: '仓库名称', is_group: '分组仓库', company: '公司', parent_warehouse: '上级仓库',
      warehouse_type: '仓库类型', phone_no: '电话', city: '城市', state: '省/州', warehouse: '仓库',
      actual_qty: '实际数量', reserved_qty: '已预留数量', ordered_qty: '已订购数量', indented_qty: '申请数量',
      planned_qty: '计划数量', projected_qty: '预计数量', customer: '客户编号', supplier: '供应商编号',
      transaction_date: '交易日期', delivery_date: '交货日期', schedule_date: '计划日期', status: '状态',
      delivery_status: '交付状态', billing_status: '开票状态', total_qty: '总数量', grand_total: '总金额',
      currency: '币种', docstatus: '单据状态', items: '商品明细', barcodes: '条码', qty: '数量', uom: '单位',
      rate: '单价', amount: '金额', barcode: '条码', barcode_type: '条码类型',
    })

    function safeErpNextSiteUrl(value) {
      if (typeof value !== 'string' || !value || value.length > 2048) return ''
      try {
        const parsed = new URL(value)
        const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
        const loopback = hostname === 'localhost' || hostname === '::1' || /^127(?:\.\d{1,3}){3}$/.test(hostname)
        if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !loopback)
          || parsed.username || parsed.password || parsed.search || parsed.hash) return ''
        return parsed.href.replace(/\/$/, '')
      } catch { return '' }
    }

    function erpDisplayValue(value) {
      if (value === null || value === undefined || value === '') return '—'
      if (value === true) return '是'
      if (value === false) return '否'
      if (typeof value === 'string' || typeof value === 'number') return String(value)
      return '—'
    }

    function ERPNextRecords({ refreshKey = 0 }) {
      const [state, setState] = React.useState({
        doctype: 'Item', offset: 0, loading: true, listError: '', records: [], nextOffset: null,
        listRetry: 0, selectedName: '', detail: null, detailLoading: false, detailError: '', detailRetry: 0,
      })
      React.useEffect(() => {
        let live = true
        setState(current => ({ ...current, loading: true, listError: '', records: [], nextOffset: null, selectedName: '', detail: null, detailError: '' }))
        const query = new URLSearchParams({ doctype: state.doctype, limit: '20', offset: String(state.offset) })
        void fetch(`/business-api/erpnext/records?${query}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || value.doctype !== state.doctype || !Array.isArray(value.records)
              || value.records.length > 20 || !(value.next_offset === null || (Number.isInteger(value.next_offset) && value.next_offset >= 0))
              || value.records.some(record => !record || record.doctype !== state.doctype || !record.data
                || typeof record.data.name !== 'string' || !record.external_ref || record.external_ref.system !== 'erpnext'
                || record.external_ref.doctype !== state.doctype || record.external_ref.name !== record.data.name)) throw new Error()
            return value
          })
          .then(value => { if (live) setState(current => ({ ...current, loading: false, records: value.records, nextOffset: value.next_offset })) })
          .catch(() => { if (live) setState(current => ({ ...current, loading: false, listError: '暂时无法读取 ERPNext 列表，请重试。' })) })
        return () => { live = false }
      }, [state.doctype, state.offset, state.listRetry, refreshKey])
      React.useEffect(() => {
        let live = true
        if (!state.selectedName) return () => { live = false }
        setState(current => ({ ...current, detailLoading: true, detailError: '', detail: null }))
        const query = new URLSearchParams({ doctype: state.doctype, name: state.selectedName })
        void fetch(`/business-api/erpnext/record?${query}`, { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || value.doctype !== state.doctype || !value.data
              || value.data.name !== state.selectedName || !value.external_ref || value.external_ref.system !== 'erpnext'
              || value.external_ref.doctype !== state.doctype || value.external_ref.name !== state.selectedName) throw new Error()
            return value
          })
          .then(value => { if (live) setState(current => ({ ...current, detailLoading: false, detail: value })) })
          .catch(() => { if (live) setState(current => ({ ...current, detailLoading: false, detailError: '暂时无法读取记录详情，请重试。' })) })
        return () => { live = false }
      }, [state.doctype, state.selectedName, state.detailRetry, refreshKey])

      const columns = ERP_LIST_FIELDS[state.doctype]
      const detailData = state.detail?.data
      const childFields = new Set(['items', 'barcodes'])
      return h('div', { className: 'tl-erpnext-browser' },
        h('div', { className: 'tl-erpnext-controls' },
          h('label', null, '数据类型', h('select', {
            value: state.doctype,
            onChange: event => setState(current => ({ ...current, doctype: event.target.value, offset: 0, selectedName: '', detail: null })),
            'aria-label': '选择 ERPNext 数据类型',
          }, ERP_DOCTYPES.map(doctype => h('option', { key: doctype, value: doctype }, ERP_DOCTYPE_LABELS[doctype])))),
          h('button', { type: 'button', onClick: () => setState(current => ({ ...current, listRetry: current.listRetry + 1 })) }, '刷新列表')),
        state.loading ? h('p', { role: 'status' }, `正在读取${ERP_DOCTYPE_LABELS[state.doctype]}…`)
          : state.listError ? h('p', { role: 'alert' }, state.listError,
            h('button', { type: 'button', onClick: () => setState(current => ({ ...current, listRetry: current.listRetry + 1 })) }, '重试'))
            : state.records.length === 0 ? h('p', { role: 'status' }, '当前没有可显示的记录。')
              : h('div', { className: 'tl-erpnext-table-wrap' }, h('table', null,
                h('thead', null, h('tr', null,
                  ...columns.map(field => h('th', { key: field, scope: 'col' }, ERP_FIELD_LABELS[field] ?? field)),
                  h('th', { scope: 'col' }, '操作'))),
                h('tbody', null, state.records.map(record => h('tr', { key: record.data.name },
                  ...columns.map(field => h('td', { key: field }, erpDisplayValue(record.data[field]))),
                  h('td', null, h('button', { type: 'button', onClick: () => setState(current => ({ ...current, selectedName: record.data.name, detail: null, detailError: '' })) }, '详情'))))))),
        !state.loading && !state.listError && state.records.length > 0 ? h('div', { className: 'tl-erpnext-pagination' },
          state.offset > 0 ? h('button', { type: 'button', onClick: () => setState(current => ({ ...current, offset: Math.max(0, current.offset - 20), selectedName: '', detail: null })) }, '上一页') : null,
          h('span', null, `从第 ${state.offset + 1} 项开始`),
          state.nextOffset !== null ? h('button', { type: 'button', onClick: () => setState(current => ({ ...current, offset: current.nextOffset, selectedName: '', detail: null })) }, '下一页') : null) : null,
        state.selectedName ? h('section', { className: 'tl-erpnext-detail', 'aria-live': 'polite' },
          h('div', { className: 'tl-erpnext-detail-heading' }, h('h4', null, '记录详情'),
            h('button', { type: 'button', onClick: () => setState(current => ({ ...current, selectedName: '', detail: null, detailError: '' })) }, '关闭详情')),
          state.detailLoading ? h('p', { role: 'status' }, '正在读取详情…')
            : state.detailError ? h('p', { role: 'alert' }, state.detailError,
              h('button', { type: 'button', onClick: () => setState(current => ({ ...current, detailRetry: current.detailRetry + 1 })) }, '重试'))
              : detailData ? h(React.Fragment, null,
                h('dl', null, ...Object.entries(detailData).filter(([key, value]) => !childFields.has(key) && (value === null || ['string', 'number', 'boolean'].includes(typeof value)))
                  .map(([key, value]) => h(React.Fragment, { key }, h('dt', null, ERP_FIELD_LABELS[key] ?? key), h('dd', null, erpDisplayValue(value))))),
                ...[...childFields].filter(key => Array.isArray(detailData[key]) && detailData[key].length > 0)
                  .map(key => h('div', { key, className: 'tl-erpnext-child-table' },
                    h('h5', null, ERP_FIELD_LABELS[key]),
                    h('pre', null, JSON.stringify(detailData[key], null, 2)))),
                h('p', { className: 'tl-erpnext-source' }, `来源：ERPNext · ${state.detail.external_ref.instance_id} · ${state.detail.external_ref.doctype}/${state.detail.external_ref.name} · 修改时间 ${erpDisplayValue(state.detail.external_ref.modified)}`)) : null) : null)
    }

    function Placeholder({ panel }) { return h('div', { className: 'tl-placeholder' }, h('p', null, panel.text)) }

    // 工作流画布按需加载；模型下拉复用中心会话的模型目录。
    let workflowRequest
    function requestWorkflowChunk() {
      if (!asyncRequire) return Promise.reject(new Error('workflow-loader-unavailable'))
      workflowRequest ??= asyncRequire('./client.workflow.js').then(value => {
        const module = value?.default ?? value
        if (typeof module?.WorkflowCanvas !== 'function') throw new Error('workflow-asset-unavailable')
        return module
      }).catch(error => { workflowRequest = undefined; throw error })
      return workflowRequest
    }

    function useRoleModelGroups(roleId) {
      const state = useSnapshot()
      const sessionId = state.sessionBindings?.[roleId]
      const [groups, setGroups] = React.useState([])
      React.useEffect(() => {
        let live = true
        let unsubscribe
        if (!sessionId || !sessionsApi || !modelDirectoriesApi) return () => { live = false }
        void (async () => {
          try {
            const reference = retainRoleSession(sessionsApi, roleId, sessionId)
            if (!reference) return
            await reference.ready
            if (!live) return
            const directory = modelDirectoriesApi.directoryFor(sessionId)
            const update = () => { if (live) setGroups(modelDirectoryEntries(directory.store.getSnapshot()?.groups)) }
            unsubscribe = directory.store.subscribe(update)
            await directory.load()
            update()
          } catch { /* 模型目录不可用时只保留「跟随默认模型」 */ }
        })()
        return () => { live = false; unsubscribe?.() }
      }, [roleId, sessionId])
      return groups
    }

    function WorkflowPanel() {
      const [module, setModule] = React.useState(null)
      const [error, setError] = React.useState('')
      const modelGroups = useRoleModelGroups('center')
      React.useEffect(() => {
        let live = true
        requestWorkflowChunk().then(value => { if (live) setModule(value) }, () => { if (live) setError('工作流画布加载失败，请刷新重试。') })
        return () => { live = false }
      }, [])
      if (error) return h('p', { className: 'tl-placeholder', role: 'alert' }, error)
      if (!module) return h('p', { className: 'tl-placeholder', role: 'status' }, '加载工作流画布…')
      return h(module.WorkflowCanvas, { modelGroups })
    }
    function ERPNextStatus({ refreshKey = 0 } = {}) {
      const [state, setState] = React.useState({ loading: true, configured: false, connected: false, status: '', error: '', siteUrl: '', retry: 0 })
      React.useEffect(() => {
        let live = true
        setState(current => ({ ...current, loading: true, error: '' }))
        void fetch('/business-api/erpnext/status', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || typeof value.configured !== 'boolean' || typeof value.connected !== 'boolean'
              || !['not_configured', 'invalid_configuration', 'connected', 'unavailable'].includes(value.status)) throw new Error()
            if (live) setState(current => ({ ...current, loading: false, configured: value.configured, connected: value.connected, status: value.status, error: '', siteUrl: safeErpNextSiteUrl(value.site_url) }))
          })
          .catch(() => { if (live) setState(current => ({ ...current, loading: false, configured: false, connected: false, status: '', error: '暂时无法读取连接状态，请稍后重试。', siteUrl: '' })) })
        return () => { live = false }
      }, [refreshKey, state.retry])
      const title = state.loading ? '正在检查 ERPNext 连接…'
        : state.error ? 'ERPNext 状态暂不可用'
          : state.status === 'not_configured' ? 'ERPNext 尚未配置'
            : state.connected ? 'ERPNext 已连接' : 'ERPNext 暂时无法连接'
      const detail = state.error || (state.status === 'not_configured'
        ? '请由管理员配置 ERPNext 连接后再使用只读数据。'
        : state.connected ? '连接检查已通过。以下为 ERPNext 只读记录。'
          : state.loading ? '正在读取本地连接状态。' : '请检查服务状态或连接配置。')
      return h('section', { className: 'tl-erpnext-status', 'aria-live': 'polite' },
        h('div', { className: 'tl-erpnext-status-heading' }, h('h3', null, title),
          h('button', { type: 'button', onClick: () => setState(current => ({ ...current, retry: current.retry + 1 })), disabled: state.loading }, '检查连接')),
        h('p', null, detail),
        state.siteUrl ? h('a', { href: state.siteUrl, target: '_blank', rel: 'noopener noreferrer' }, '打开 ERPNext') : null,
        state.error ? h('button', { type: 'button', onClick: () => setState(current => ({ ...current, retry: current.retry + 1 })) }, '重试') : null,
        state.connected ? h(ERPNextRecords, { key: refreshKey, refreshKey }) : null,
        h(ERPNextQuotationDraft, { enabled: state.connected }))
    }

    const EMPTY_QUOTATION_ITEM = Object.freeze({ item_code: '', qty: '', rate: '', uom: '' })
    const QUOTATION_TEXT_LIMITS = Object.freeze({
      company: 140, party_name: 140, transaction_date: 10, valid_till: 10, currency: 3,
      item_code: 140, qty: 32, rate: 32, uom: 140,
    })
    const DRAFT_OPERATION_ID = /^[0-9a-f]{32}$/
    const DRAFT_MODIFIED = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/

    function safeQuotationReadback(value) {
      const ref = value?.external_ref
      const data = value?.data
      if (value?.doctype !== 'Quotation' || !data || typeof data !== 'object' || Array.isArray(data)
        || typeof data.name !== 'string' || !data.name || data.docstatus !== 0
        || typeof data.modified !== 'string' || !DRAFT_MODIFIED.test(data.modified)
        || !ref || ref.system !== 'erpnext' || ref.doctype !== 'Quotation' || ref.name !== data.name
        || typeof ref.instance_id !== 'string' || !ref.instance_id || ref.modified !== data.modified) return null
      return {
        doctype: 'Quotation', data: { name: data.name, modified: data.modified, docstatus: 0 },
        external_ref: { system: 'erpnext', instance_id: ref.instance_id, doctype: 'Quotation', name: ref.name, modified: ref.modified },
      }
    }

    function quotationOperation(value) {
      if (!value || typeof value !== 'object' || !DRAFT_OPERATION_ID.test(value.operation_id ?? '')
        || value.doctype !== 'Quotation' || !['create', 'update'].includes(value.action)
        || !['reserved', 'outcome_unknown', 'succeeded', 'conflict'].includes(value.status)) return null
      const receipt = value.receipt ? safeQuotationReadback(value.receipt) : null
      const remoteCurrent = value.remote_current ? safeQuotationReadback(value.remote_current) : null
      if ((value.receipt && !receipt) || (value.remote_current && !remoteCurrent)) return null
      const operation = {
        operation_id: value.operation_id,
        action: value.action,
        status: value.status,
        remote_name: typeof value.remote_name === 'string' ? value.remote_name : '',
        remote_modified: typeof value.remote_modified === 'string' ? value.remote_modified : '',
        receipt,
        remote_current: remoteCurrent,
      }
      if (operation.status === 'succeeded' && operation.receipt) return operation
      if (operation.status !== 'succeeded') return operation
      return null
    }

    function quotationPayload(fields) {
      const payload = {
        company: fields.company.trim(),
        party_name: fields.party_name.trim(),
        transaction_date: fields.transaction_date,
        currency: fields.currency.trim().toUpperCase(),
        items: fields.items.map(item => ({
          item_code: item.item_code.trim(), qty: item.qty.trim(), rate: item.rate.trim(), uom: item.uom.trim(),
        })),
      }
      if (fields.valid_till) payload.valid_till = fields.valid_till
      if (!payload.company || payload.company.length > QUOTATION_TEXT_LIMITS.company
        || !payload.party_name || payload.party_name.length > QUOTATION_TEXT_LIMITS.party_name
        || payload.transaction_date.length > QUOTATION_TEXT_LIMITS.transaction_date
        || !/^\d{4}-\d{2}-\d{2}$/.test(payload.transaction_date)
        || (fields.valid_till && !/^\d{4}-\d{2}-\d{2}$/.test(fields.valid_till))
        || (payload.valid_till && payload.valid_till.length > QUOTATION_TEXT_LIMITS.valid_till)
        || payload.currency.length > QUOTATION_TEXT_LIMITS.currency || !/^[A-Z]{3}$/.test(payload.currency)
        || payload.items.length < 1 || payload.items.length > 100
        || payload.items.some(item => !item.item_code || item.item_code.length > QUOTATION_TEXT_LIMITS.item_code
          || !item.uom || item.uom.length > QUOTATION_TEXT_LIMITS.uom
          || item.qty.length > QUOTATION_TEXT_LIMITS.qty || item.rate.length > QUOTATION_TEXT_LIMITS.rate
          || !/^\d+(?:\.\d+)?$/.test(item.qty)
          || !/^\d+(?:\.\d+)?$/.test(item.rate) || Number(item.qty) <= 0)) return null
      return payload
    }

    function ERPNextQuotationDraft({ enabled = false } = {}) {
      const [state, setState] = React.useState(() => ({
        fields: { company: '', party_name: '', transaction_date: '', valid_till: '', currency: '', items: [{ ...EMPTY_QUOTATION_ITEM }] },
        operation: null, baseOperation: null, pendingRequest: null, current: null, needsReadback: false, loading: false, error: '', notice: '',
      }))

      function updateFields(change) {
        setState(current => ({ ...current, fields: { ...current.fields, ...change }, error: '', notice: '' }))
      }

      async function csrfHeaders() {
        await fetch('/business-api/', { method: 'GET', credentials: 'same-origin', headers: { accept: 'text/html' } })
        const cookie = typeof document === 'object' ? document.cookie : ''
        const match = /(?:^|;\s*)csrftoken=([^;]+)/.exec(cookie)
        if (!match) throw new Error('csrf_unavailable')
        return { accept: 'application/json', 'content-type': 'application/json', 'X-CSRFToken': decodeURIComponent(match[1]) }
      }

      async function sendWrite(request) {
        setState(current => ({ ...current, loading: true, error: '', notice: '', pendingRequest: request }))
        try {
          const headers = await csrfHeaders()
          const response = await fetch(request.path, {
            method: request.method, credentials: 'same-origin', headers, body: request.body,
          })
          let value
          try { value = await response.json() } catch { throw new Error('invalid_response') }
          const operation = quotationOperation(value)
          if (!operation || (response.status === 409 && operation.status !== 'conflict')
            || (response.status !== 409 && !response.ok && response.status !== 202)
            || (response.status === 202 && operation.status !== 'outcome_unknown' && operation.status !== 'reserved')) {
            const uncertain = response.status >= 500 || !operation && (response.ok || response.status === 202)
            setState(current => ({ ...current, loading: false, pendingRequest: uncertain ? request : null,
              error: uncertain ? '暂未收到可核对的操作回执。请使用原请求键恢复，不要另建请求。' : '报价操作未完成，请检查输入后明确发起新操作。' }))
            return
          }
          const currentRecord = operation.status === 'succeeded' ? operation.remote_current ?? operation.receipt
            : operation.status === 'conflict' ? operation.remote_current : null
          setState(current => ({ ...current, loading: false, operation,
            baseOperation: operation.status === 'succeeded' ? operation : current.baseOperation,
            current: currentRecord ?? current.current,
            pendingRequest: null, needsReadback: operation.status === 'conflict',
            notice: operation.status === 'succeeded' ? '已确认保存草稿。'
              : operation.status === 'conflict' ? '版本冲突；请先读取当前版本，再决定是否创建新的修改操作。'
                : '结果待核对；请读取操作状态，不要重复创建或使用新请求键。',
            error: '' }))
        } catch {
          setState(current => ({ ...current, loading: false, pendingRequest: request,
            error: '暂未收到操作回执。请使用原请求键恢复，不要另建请求。' }))
        }
      }

      async function readOperation(operationId, isRecovery = false) {
        setState(current => ({ ...current, loading: true, error: '', notice: '' }))
        try {
          const response = await fetch(`/business-api/erpnext/quotation-drafts/${encodeURIComponent(operationId)}`,
            { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          const value = await response.json()
          const operation = quotationOperation(value)
          if (!response.ok || !operation) throw new Error('invalid_response')
          const latestRemote = operation.remote_current ?? (operation.status === 'succeeded' ? operation.receipt : null)
          setState(current => ({ ...current, loading: false, operation,
            baseOperation: operation.status === 'succeeded' ? operation : current.baseOperation,
            current: latestRemote ?? current.current,
            pendingRequest: null,
            needsReadback: operation.status === 'conflict' && !latestRemote,
            notice: operation.status === 'succeeded' ? '已确认保存草稿。'
              : operation.status === 'conflict' ? '已读取冲突时的当前版本；如需修改，请明确创建一条新操作。'
                : '结果待核对；此操作仅查询状态，没有重新写入。', error: '' }))
        } catch {
          setState(current => ({ ...current, loading: false, error: '暂时无法读取操作状态，请稍后重试。' }))
        }
      }

      function createDraft() {
        const payload = quotationPayload(state.fields)
        if (!enabled) { setState(current => ({ ...current, error: 'ERPNext 当前不可写入；已有操作仍可只读核对。' })); return }
        if (!payload) { setState(current => ({ ...current, error: '请填写有效的公司、客户、日期、币种和报价行。' })); return }
        const idempotencyKey = globalThis.crypto?.randomUUID?.()
        if (!idempotencyKey) { setState(current => ({ ...current, error: '当前环境无法生成安全请求键。' })); return }
        if (state.operation && ['outcome_unknown', 'reserved', 'conflict'].includes(state.operation.status)) {
          setState(current => ({ ...current, error: '请先读取当前操作状态，再开始新的操作。' })); return
        }
        const body = JSON.stringify({ idempotency_key: idempotencyKey, payload })
        return sendWrite({ method: 'POST', path: '/business-api/erpnext/quotation-drafts', body })
      }

      function updateDraft() {
        const payload = quotationPayload(state.fields)
        const target = state.baseOperation
        const ref = state.current?.external_ref
        const idempotencyKey = globalThis.crypto?.randomUUID?.()
        if (!enabled || !payload || !target || target.status !== 'succeeded'
          || state.pendingRequest
          || ['outcome_unknown', 'reserved'].includes(state.operation?.status)
          || (state.operation?.status === 'conflict' && state.needsReadback)
          || !ref || ref.system !== 'erpnext'
          || ref.doctype !== 'Quotation' || ref.name !== target.remote_name || !DRAFT_MODIFIED.test(ref.modified ?? '')
          || state.needsReadback || !idempotencyKey) {
          setState(current => ({ ...current, error: '请先读取一条已成功草稿的当前版本，并确认报价内容有效。' })); return
        }
        const body = JSON.stringify({ idempotency_key: idempotencyKey, expected_modified: ref.modified, payload })
        return sendWrite({ method: 'PUT', path: `/business-api/erpnext/quotation-drafts/${encodeURIComponent(target.operation_id)}`, body })
      }

      function addItem() {
        if (state.fields.items.length >= 100) return
        updateFields({ items: [...state.fields.items, { ...EMPTY_QUOTATION_ITEM }] })
      }

      const textField = (label, key, type = 'text', required = true) => h('label', { className: 'tl-erpnext-draft-field', key },
        h('span', null, label), h('input', { type, required, value: state.fields[key], 'aria-label': label,
          maxLength: QUOTATION_TEXT_LIMITS[key],
          onChange: event => updateFields({ [key]: event.target.value }) }))
      return h('section', { className: 'tl-erpnext-draft', 'aria-labelledby': 'tl-erpnext-draft-title' },
        h('div', { className: 'tl-erpnext-detail-heading' }, h('h4', { id: 'tl-erpnext-draft-title' }, '报价草稿'),
          h('span', { className: 'tl-erpnext-source' }, '仅保存 ERPNext Quotation 草稿；不会提交或开具单据。')),
        h('div', { className: 'tl-erpnext-draft-fields' },
          textField('公司', 'company'), textField('客户', 'party_name'), textField('交易日期', 'transaction_date', 'date'),
          textField('有效日期', 'valid_till', 'date', false), textField('币种', 'currency')),
        h('div', { className: 'tl-erpnext-draft-items' },
          h('div', { className: 'tl-erpnext-detail-heading' }, h('h5', null, '报价行'),
            h('button', { type: 'button', onClick: addItem, disabled: state.fields.items.length >= 100 }, '添加商品行')),
          ...state.fields.items.map((item, index) => h('div', { className: 'tl-erpnext-draft-item', key: index },
            ...[
              ['商品编码', 'item_code', 'text'], ['数量', 'qty', 'text'], ['单价', 'rate', 'text'], ['单位', 'uom', 'text'],
            ].map(([label, key, type]) => h('label', { className: 'tl-erpnext-draft-field', key },
              h('span', null, `${label} ${index + 1}`), h('input', { type, inputMode: key === 'qty' || key === 'rate' ? 'decimal' : undefined,
                value: item[key], maxLength: QUOTATION_TEXT_LIMITS[key], 'aria-label': `${label} ${index + 1}`,
                onChange: event => updateFields({ items: state.fields.items.map((row, rowIndex) => rowIndex === index
                  ? { ...row, [key]: event.target.value } : row) }) }))),
            state.fields.items.length > 1 ? h('button', { type: 'button', onClick: () => updateFields({ items: state.fields.items.filter((_, rowIndex) => rowIndex !== index) }) }, '移除商品行') : null))),
        h('div', { className: 'tl-erpnext-draft-actions' },
          h('button', { type: 'button', onClick: createDraft, disabled: !enabled || state.loading || Boolean(state.pendingRequest)
            || ['outcome_unknown', 'reserved'].includes(state.operation?.status)
            || (state.operation?.status === 'conflict' && state.needsReadback) }, '创建报价草稿'),
          state.baseOperation?.status === 'succeeded' ? h('button', { type: 'button', onClick: updateDraft, disabled: !enabled || state.loading || state.pendingRequest || state.needsReadback
            || ['outcome_unknown', 'reserved'].includes(state.operation?.status) }, '保存为新修改操作') : null,
          state.pendingRequest ? h('button', { type: 'button', onClick: () => sendWrite(state.pendingRequest), disabled: state.loading }, '用原请求键恢复回执') : null,
          state.operation && ['outcome_unknown', 'reserved', 'conflict'].includes(state.operation.status)
            ? h('button', { type: 'button', onClick: () => readOperation(state.operation.operation_id), disabled: state.loading }, '读取操作状态') : null,
          state.operation?.status === 'conflict' ? h('button', { type: 'button', onClick: () => readOperation(state.operation.operation_id), disabled: state.loading }, '刷新冲突版本') : null),
        state.loading ? h('p', { role: 'status' }, '正在处理…') : null,
        state.error ? h('p', { role: 'alert' }, state.error) : null,
        state.notice ? h('p', { role: state.operation?.status === 'succeeded' ? 'status' : 'alert' }, state.notice) : null,
        state.current ? h('p', { className: 'tl-erpnext-source' }, `ERPNext 报价：${state.current.data?.name ?? state.operation?.remote_name ?? '—'} · 修改时间 ${state.current.external_ref?.modified ?? '—'}`) : null)
    }

    function FixedChatView(props) { return h(React.Fragment, null, props.renderSlot('conversation.session', { view: 'chat' })) }

    function SceneChatPanel({ renderFactorySlot }) {
      return renderFactorySlot('conversation.content', { variant: 'embedded', phase: 'active', hero: false }, {
        slots: { views: FixedChatView },
      })
    }

    function retainRoleSession(sessions, roleId, sessionId) {
      if (typeof roleId !== 'string' || !roleId || typeof sessionId !== 'string' || !sessionId) return undefined
      const retained = retainedByRole.get(roleId)
      if (retained?.sessionId === sessionId) return retained.reference
      retained?.reference.release()
      const reference = sessions.retain(sessionId, { source: 'mainView' })
      retainedByRole.set(roleId, { sessionId, reference })
      return reference
    }

    function releaseRoleSessions() {
      for (const { reference } of retainedByRole.values()) reference.release()
      retainedByRole.clear()
    }

    const dockRenderContexts = new Map()
    const dockGroupRenderers = new Map()
    const dockActionListeners = new Map()

    function subscribeDockActions(sceneId, listener) {
      let listenersForScene = dockActionListeners.get(sceneId)
      if (!listenersForScene) dockActionListeners.set(sceneId, listenersForScene = new Set())
      listenersForScene.add(listener)
      return () => {
        listenersForScene.delete(listener)
        if (!listenersForScene.size) dockActionListeners.delete(sceneId)
      }
    }

    function notifyDockActions(sceneId) {
      for (const listener of dockActionListeners.get(sceneId) ?? []) listener()
    }

    function DockGroupActions({ sceneId, ...groupProps }) {
      const [, setRevision] = React.useState(0)
      React.useEffect(() => subscribeDockActions(sceneId, () => setRevision(value => value + 1)), [sceneId])
      const context = dockRenderContexts.get(sceneId) ?? {}
      const panelId = groupProps.activePanel?.id
      const panel = context.panels?.find(item => item.id === panelId)
      if (!panel) return null
      const label = panel.type === 'native-chat' ? context.assistantLabel : panel.title
      const runWithoutActivatingGroup = action => event => {
        event?.stopPropagation?.()
        action?.()
      }
      const stopGroupActivation = event => event?.stopPropagation?.()
      return h('div', { className: 'tl-dock-group-actions', role: 'toolbar', 'aria-label': `${label}面板操作` },
        h('button', { type: 'button', title: `刷新${label}`, 'aria-label': `刷新${label}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.refresh?.(panel.id)) }, '刷新'),
        !context.narrow ? h('button', {
          type: 'button', title: context.isPanelMaximized?.(panel.id) ? `还原${label}` : `展开${label}`,
          'aria-label': context.isPanelMaximized?.(panel.id) ? `还原${label}` : `展开${label}`,
          onPointerDown: stopGroupActivation, onMouseDown: stopGroupActivation,
          onClick: runWithoutActivatingGroup(() => context.toggleMaximize?.(panel.id)),
        }, context.isPanelMaximized?.(panel.id) ? '还原' : '展开') : null)
    }

    function notifyNarrowListeners(sceneId, narrow) {
      for (const listener of narrowListeners.get(sceneId) ?? []) listener(narrow)
    }

    function NativeChatPanel({ sceneId, refreshKey, SessionProvider, renderSlot }) {
      const state = useSnapshot()
      const roleId = roleForScene(state.config, sceneId)
      const sessionId = roleId ? state.sessionBindings[roleId] : undefined
      const [readyReference, setReadyReference] = React.useState(null)
      const [error, setError] = React.useState('')
      React.useEffect(() => {
        let live = true
        if (!roleId) return () => { live = false }
        if (!sessionId) {
          void ensureRoleSession(roleId).then(value => {
            if (live && !value) setError(snapshot.sessionErrors[roleId] || '连接失败，请重试。')
          })
          return () => { live = false }
        }
        let reference
        try {
          reference = retainRoleSession(sessionsApi, roleId, sessionId)
          if (!reference) throw new Error('session-reference-unavailable')
          void reference.ready.then(() => { if (live) { setError(''); setReadyReference({ id: sessionId, reference }) } })
            .catch(() => { if (live) setError('会话暂时无法连接，请重试。') })
        } catch { setError('会话暂时无法连接，请重试。') }
        return () => { live = false; setReadyReference(current => current?.id === sessionId ? null : current) }
      }, [roleId, sessionId])
      if (sessionId && readyReference?.id === sessionId) {
        return h(SessionProvider, { session: readyReference.reference }, h(React.Fragment, { key: `${sessionId}:${refreshKey}` }, renderSlot('scene.workbench.chat', {})))
      }
      return h('div', { className: 'tl-chat-status', role: error ? 'alert' : 'status' },
        error || (sessionId ? '正在连接助手…' : '正在准备助手…'),
        error ? h('button', { type: 'button', onClick: () => { setError(''); void ensureRoleSession(roleId) } }, '重试连接') : null)
    }

    function SceneDockPanel(props) {
      const sceneId = props.sceneId
      const state = useSnapshot()
      const scene = state.config?.scenes.find(item => item.id === sceneId)
      const panelId = props.params?.panelId ?? props.api?.id ?? props.id
      const panel = scene?.panels.find(item => item.id === panelId)
      const context = dockRenderContexts.get(sceneId) ?? {}
      const [narrow, setNarrow] = React.useState(() => Boolean(context.narrow))
      const refreshKey = state.panelRefreshKeys?.[sceneId]?.[panelId] ?? 0
      const roleId = roleForScene(state.config, sceneId)
      React.useEffect(() => {
        const update = value => setNarrow(Boolean(value))
        let listeners = narrowListeners.get(sceneId)
        if (!listeners) narrowListeners.set(sceneId, listeners = new Set())
        listeners.add(update)
        update(Boolean(dockRenderContexts.get(sceneId)?.narrow))
        return () => {
          listeners.delete(update)
          if (listeners.size === 0) narrowListeners.delete(sceneId)
        }
      }, [sceneId])
      if (!panel) return null
      let content = null
      if (panel.type === 'business-iframe') {
        const path = panel.id === 'business-main' ? state.businessPathsByScene?.[sceneId] ?? panel.path : panel.path
        const proposalHref = path === '/agent-center' && panel.id === 'business-main' ? state.proposalHrefsByScene?.[sceneId] ?? '' : ''
        content = h(BusinessFrame, { panel, path, proposalHref, refreshKey })
      } else if (panel.type === 'placeholder') content = h(Placeholder, { panel })
      else if (panel.type === 'erpnext-status') content = h(ERPNextStatus, { refreshKey })
      else if (panel.type === 'workflow-canvas') content = h(WorkflowPanel)
      else if (panel.type === 'native-chat') content = h(NativeChatPanel, {
        sceneId, refreshKey, SessionProvider: context.SessionProvider, renderSlot: context.renderSlot,
      })
      return h('div', { className: 'tl-dock-panel', 'data-panel-id': panel.id, 'data-panel-type': panel.type },
        h('div', { className: `tl-dock-panel-body${panel.type === 'native-chat' ? ' is-native-chat' : ''}` }, content))
    }

    function stableDockComponents(sceneId) {
      if (!dockviewRenderers.has(sceneId)) {
        const types = ['business-iframe', 'placeholder', 'native-chat', 'erpnext-status', 'workflow-canvas']
        dockviewRenderers.set(sceneId, Object.fromEntries(types.map(type => [type, props => h(SceneDockPanel, { ...props, sceneId })])))
      }
      return dockviewRenderers.get(sceneId)
    }

    function stableDockGroupActions(sceneId) {
      if (!dockGroupRenderers.has(sceneId)) dockGroupRenderers.set(sceneId, props => h(DockGroupActions, { ...props, sceneId }))
      return dockGroupRenderers.get(sceneId)
    }

    function SceneDock({ scene, active, SessionProvider, renderSlot, dockviewModule }) {
      const state = useSnapshot()
      const hostRef = React.useRef(null)
      const apiRef = React.useRef(null)
      const restoredRef = React.useRef(false)
      const narrowRef = React.useRef(false)
      const layoutEventRef = React.useRef(null)
      const activePanelEventRef = React.useRef(null)
      const maximizeEventRef = React.useRef(null)
      const [width, setWidth] = React.useState(0)
      const [height, setHeight] = React.useState(0)
      const [activePanelId, setActivePanelId] = React.useState('')
      const [maximized, setMaximized] = React.useState(false)
      const [closedPanelIds, setClosedPanelIds] = React.useState([])
      const [error, setError] = React.useState('')
      const roleId = roleForScene(state.config, scene.id)
      const record = state.dockLayouts?.scenes?.[scene.id]
      const api = apiRef.current
      const minimumCanvasWidth = scene.layoutProfile?.minimumWidth ?? 1143
      const minimumCanvasHeight = scene.layoutProfile?.minimumHeight ?? 250
      const narrow = width > 0 && height > 0 && (width < minimumCanvasWidth || height < minimumCanvasHeight)
      dockRenderContexts.set(scene.id, {
        SessionProvider, renderSlot, narrow, panels: scene.panels, assistantLabel: assistantLabel(roleId),
        closedPanels: scene.panels.filter(panel => closedPanelIds.includes(panel.id)),
        saveError: state.dockSaveErrors?.[scene.id], error,
        refresh: panelId => refreshScenePanel(scene.id, panelId),
        resetLayout: () => resetLayout(), selectPanel: panelId => selectPanel(panelId),
        retrySave: () => { void persistCurrentLayout() },
        isPanelMaximized: panelId => {
          const currentApi = apiRef.current
          const panel = currentApi?.getPanel(panelId)
          return Boolean(panel && panel.api.isMaximized())
        },
        toggleMaximize: panelId => {
          const currentApi = apiRef.current
          const panel = currentApi?.getPanel(panelId)
          if (!panel) return
          if (panel.api.isMaximized()) { panel.api.exitMaximized(); return }
          if (currentApi.hasMaximizedGroup()) currentApi.exitMaximizedGroup()
          panel.api.maximize()
        },
      })

      const closedPanelSignature = closedPanelIds.join('|')
      React.useEffect(() => { notifyDockActions(scene.id) }, [scene.id, narrow, maximized, closedPanelSignature, state.dockSaveErrors?.[scene.id], error, roleId])

      React.useEffect(() => {
        const chatPanel = apiRef.current?.getPanel(scene.panels.find(panel => panel.type === 'native-chat')?.id)
        if (chatPanel && roleId) chatPanel.api.setTitle(assistantLabel(roleId))
      }, [roleId, scene.id])

      React.useEffect(() => {
        const element = hostRef.current
        if (!element || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(entries => {
          const entry = entries.find(item => item.target === element)
          if (entry) {
            setWidth(entry.contentRect?.width ?? element.clientWidth ?? 0)
            setHeight(entry.contentRect?.height ?? element.clientHeight ?? 0)
          }
        })
        observer.observe(element)
        return () => observer.disconnect()
      }, [])

      React.useEffect(() => {
        if (!active || !apiRef.current) return undefined
        const frame = requestAnimationFrame(() => {
          const rect = hostRef.current?.getBoundingClientRect()
          if (rect && rect.width > 0 && rect.height > 0) apiRef.current.layout(rect.width, rect.height, true)
        })
        return () => cancelAnimationFrame(frame)
      }, [active])

      React.useEffect(() => {
        const currentApi = apiRef.current
        if (!currentApi || !restoredRef.current) return
        notifyNarrowListeners(scene.id, narrow)
        if (narrow && !narrowRef.current) {
          narrowRef.current = true
          const panel = currentApi.getPanel(activePanelId) ?? currentApi.getPanel(currentApi.activePanel?.id) ?? currentApi.getPanel(scene.panels[0]?.id)
          if (panel) { panel.api.setActive(); currentApi.maximizeGroup(panel) }
        } else if (!narrow && narrowRef.current) {
          narrowRef.current = false
          if (currentApi.hasMaximizedGroup()) currentApi.exitMaximizedGroup()
        }
      }, [narrow, activePanelId, scene.id])

      React.useEffect(() => () => {
        layoutEventRef.current?.dispose?.()
        activePanelEventRef.current?.dispose?.()
        maximizeEventRef.current?.dispose?.()
        dockviewApis.delete(scene.id)
      }, [scene.id])

      function persistCurrentLayout() {
        const currentApi = apiRef.current
        if (!currentApi || narrowRef.current) return Promise.resolve(false)
        const dockview = currentApi.toJSON()
        return queueDockLayoutSave(scene.id, dockview)
      }

      function syncClosedPanels(currentApi) {
        const next = scene.panels.filter(panel => !currentApi?.getPanel(panel.id)).map(panel => panel.id)
        setClosedPanelIds(previous => previous.length === next.length && previous.every((id, index) => id === next[index]) ? previous : next)
      }

      function onReady({ api: readyApi }) {
        apiRef.current = readyApi
        dockviewApis.set(scene.id, readyApi)
        try {
          readyApi.fromJSON(record.dockview)
          restoredRef.current = true
          const requestedPanelId = pendingScenePanelFocus.get(scene.id)
          if (requestedPanelId) {
            pendingScenePanelFocus.delete(scene.id)
            if (!focusScenePanel(scene.id, requestedPanelId)) reopenScenePanel(scene.id, requestedPanelId)
          }
          syncClosedPanels(readyApi)
          const activePanel = readyApi.activePanel ?? readyApi.getPanel(scene.panels[0]?.id)
          setActivePanelId(activePanel?.id ?? scene.panels[0]?.id ?? '')
          readyApi.getPanel(scene.panels.find(panel => panel.type === 'native-chat')?.id)?.api.setTitle(assistantLabel(roleId))
          layoutEventRef.current = readyApi.onDidLayoutChange(() => {
            const selected = readyApi.activePanel?.id
            if (selected) setActivePanelId(selected)
            syncClosedPanels(readyApi)
            notifyDockActions(scene.id)
            if (restoredRef.current && !narrowRef.current) void persistCurrentLayout()
          })
          activePanelEventRef.current = readyApi.onDidActivePanelChange(event => {
            const selected = event?.panel?.id ?? readyApi.activePanel?.id
            if (selected) setActivePanelId(selected)
            notifyDockActions(scene.id)
          })
          setMaximized(Boolean(readyApi.hasMaximizedGroup?.()))
          maximizeEventRef.current = readyApi.onDidMaximizedGroupChange(() => {
            setMaximized(Boolean(readyApi.hasMaximizedGroup?.()))
            notifyDockActions(scene.id)
          })
          if (hostRef.current) {
            const rect = hostRef.current.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              readyApi.layout(rect.width, rect.height, true)
              setWidth(rect.width)
              setHeight(rect.height)
            }
          }
        } catch {
          setError('工作区布局无法读取，请应用推荐布局后重试。')
        }
      }

      function selectPanel(panelId) {
        const currentApi = apiRef.current
        if (!currentApi) return
        if (!currentApi.getPanel(panelId)) reopenScenePanel(scene.id, panelId)
        const panel = currentApi.getPanel(panelId)
        if (!panel) return
        panel.api.setActive()
        setActivePanelId(panelId)
        if (narrowRef.current) currentApi.maximizeGroup(panel)
      }

      function resetLayout() {
        const currentApi = apiRef.current
        const defaultRecord = snapshot.dockDefaults?.[scene.id]
        if (!currentApi || !defaultRecord) return
        if (currentApi.hasMaximizedGroup()) currentApi.exitMaximizedGroup()
        narrowRef.current = narrow
        try { currentApi.fromJSON(defaultRecord.dockview) }
        catch { setError('推荐布局无法应用，请重试。'); return }
        syncClosedPanels(currentApi)
        setError('')
        const selected = currentApi.activePanel ?? currentApi.getPanel(scene.panels[0]?.id)
        if (selected) {
          selected.api.setActive()
          setActivePanelId(selected.id)
          if (narrowRef.current) currentApi.maximizeGroup(selected)
        }
        if (!narrow) void persistCurrentLayout()
      }

      const panels = scene.panels
      const closedPanels = panels.filter(panel => !api?.getPanel(panel.id))
      const toolbarError = state.dockSaveErrors?.[scene.id] || error
      const Components = stableDockComponents(scene.id)
      const DockviewReact = dockviewModule.DockviewReact
      return h('section', { className: `tl-dock-scene${active ? ' is-active' : ''}${narrow ? ' is-narrow' : ''}`, 'aria-label': `${scene.label}工作区`, style: { display: active ? 'flex' : 'none' } },
        narrow || toolbarError ? h('header', { className: 'tl-dock-toolbar' },
          narrow ? h('label', { className: 'tl-dock-panel-picker' }, '当前面板', h('select', {
            'aria-label': '选择当前面板', value: activePanelId,
            onChange: event => selectPanel(event.currentTarget.value),
          }, panels.map(panel => h('option', { key: panel.id, value: panel.id }, `${panel.title}${closedPanels.some(item => item.id === panel.id) ? '（已关闭）' : ''}`)))) : null,
          toolbarError ? h('span', { role: 'alert', className: 'tl-dock-layout-error' }, toolbarError) : null) : null,
        h('div', { className: 'tl-dockview-host', ref: hostRef }, h(DockviewReact, {
          components: Components,
          rightHeaderActionsComponent: stableDockGroupActions(scene.id),
          onReady,
          disableDnd: narrow,
          dndStrategy: 'pointer',
          disableFloatingGroups: true,
          getTabContextMenuItems: () => [],
          className: 'tl-dockview-theme dockview-spaced',
          proportionalLayout: true,
          theme: dockviewTheme(activeColorScheme),
        })),
        null)
    }

    function SceneWorkbench({ SessionProvider, renderSlot }) {
      const state = useSnapshot()
      const [mainPanelId, setMainPanelId] = React.useState(() => layoutApi?.panelInfo?.getSnapshot?.()?.activePanelId ?? null)
      const [dockviewModule, setDockviewModule] = React.useState(null)
      const [dockviewError, setDockviewError] = React.useState('')
      React.useEffect(() => {
        const panelInfo = layoutApi?.panelInfo
        if (!panelInfo?.subscribe) return undefined
        setMainPanelId(panelInfo.getSnapshot?.()?.activePanelId ?? null)
        return panelInfo.subscribe(() => setMainPanelId(panelInfo.getSnapshot?.()?.activePanelId ?? null))
      }, [])
      React.useEffect(() => {
        void loadConfig().catch(() => {})
        let live = true
        void requestDockview().then(module => { if (live) setDockviewModule(module) })
          .catch(() => { if (live) setDockviewError('工作区组件暂时无法加载，请重试。') })
        return () => { live = false }
      }, [])
      if (!state.config || !state.dockLayouts) return h('main', { className: 'tl-workbench-loading', 'aria-label': '工作场景' },
        h('p', { role: state.configError ? 'alert' : 'status' }, state.configError || '正在读取工作场景…'),
        h('button', { type: 'button', onClick: () => { void loadConfig(true).catch(() => {}) } }, '重试读取场景'))
      if (!dockviewModule) return h('main', { className: 'tl-workbench-loading', 'aria-label': '工作场景' },
        h('p', { role: dockviewError ? 'alert' : 'status' }, dockviewError || '正在准备工作区组件…'),
        dockviewError ? h('button', { type: 'button', onClick: () => { setDockviewError(''); void requestDockview().then(setDockviewModule).catch(() => setDockviewError('工作区组件暂时无法加载，请重试。')) } }, '重试加载') : null)
      const scene = state.config.scenes.find(item => item.id === state.activeSceneId)
      const visited = new Set([...(state.visitedScenes ?? []), scene.id])
      const sceneLabel = scene.label
      return h('main', { className: `tl-workbench ${activeColorScheme === 'dark' ? 'is-dark' : 'is-light'}`, 'aria-label': sceneLabel },
        h('style', null, dockviewModule.dockviewCss),
        h('style', null, `
          .tl-workbench {
            box-sizing: border-box;
            padding: 10px;
            --tl-space-1: 4px;
            --tl-space-2: 8px;
            --tl-space-3: 12px;
            --tl-space-4: 16px;
            --tl-panel-inset: var(--tl-space-3);
            --tl-toolbar-inset: var(--tl-space-3);
            --tl-canvas: var(--dsw-alias-bg-base, #f4f7fb);
            --tl-surface: var(--dsw-alias-bg-layer-1, #ffffff);
            --tl-surface-soft: var(--dsw-alias-bg-layer-2, #e9eef6);
            --tl-surface-hover: var(--dsw-alias-bg-layer-2, #e9eef6);
            --tl-ink: var(--dsw-alias-label-primary, #202b3a);
            --tl-muted: var(--dsw-alias-label-secondary, #68778c);
            --tl-border: var(--dsw-alias-border-l1, #cbd5e2);
            --tl-accent: var(--dsw-alias-brand-primary, #356fc4);
            --tl-accent-strong: #285ca4;
            --tl-accent-soft: var(--dsw-alias-bg-layer-2, #e5eefb);
            --tl-button-bg: var(--dsw-alias-brand-primary, #356fc4);
            --tl-button-hover: #285ca4;
            --tl-button-ink: #FFFFFF;
            --tl-danger: #BA2121;
            --tl-danger-bg: #FDECEA;
            --tl-danger-border: #F5C6C6;
            display: flex;
            flex-direction: column;
            width: 100%;
            height: 100%;
            min-width: 0;
            min-height: 0;
            overflow: hidden;
            color: var(--tl-ink);
            font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
            font-size: 13px;
          }
          .tl-scene-docks { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; overflow: hidden; }
          .tl-dock-scene { position: absolute; inset: 0; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
          .tl-dock-toolbar {
            display: flex; align-items: center; gap: 5px; min-height: 28px; flex: 0 0 auto;
            overflow-x: auto; white-space: nowrap; padding: 2px 4px;
            color: var(--tl-ink); font-family: inherit;
          }
          .tl-dock-toolbar button, .tl-dock-toolbar select, .tl-dock-panel-picker select {
            box-sizing: border-box; min-height: 32px; padding: 5px 10px; border: 1px solid var(--tl-border);
            border-radius: 7px; background: var(--tl-surface); color: var(--tl-ink);
            font: inherit; font-size: 13px; line-height: 1.25;
          }
          .tl-dock-toolbar button { cursor: pointer; }
          .tl-dock-toolbar button:hover,
          .tl-dock-toolbar select:hover, .tl-dock-panel-picker select:hover { background: var(--tl-surface-soft); }
          .tl-dock-toolbar button:focus-visible, .tl-dock-toolbar select:focus-visible,
          .tl-dock-panel-picker select:focus-visible {
            outline: 2px solid var(--tl-accent); outline-offset: 1px;
          }
          .tl-dockview-host { flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; height: 100%; overflow: hidden; }
          .tl-dockview-host .tl-dockview-theme {
            height: 100%; width: 100%; color: var(--tl-ink); font-family: inherit;
            --dv-group-view-background-color: var(--tl-surface);
            --dv-tabs-and-actions-container-background-color: var(--tl-surface-soft);
            --dv-spacing-padding: 10px;
            --dv-floating-group-border: 1px solid var(--tl-border);
            --dv-tabs-and-actions-container-height: 36px;
            --dv-tabs-and-actions-container-font-size: 13px;
            --dv-tab-font-size: 13px;
            --dv-activegroup-visiblepanel-tab-background-color: var(--tl-surface);
            --dv-activegroup-hiddenpanel-tab-background-color: var(--tl-surface-soft);
            --dv-inactivegroup-visiblepanel-tab-background-color: var(--tl-surface);
            --dv-inactivegroup-hiddenpanel-tab-background-color: var(--tl-surface-soft);
            --dv-activegroup-visiblepanel-tab-color: var(--tl-ink);
            --dv-activegroup-hiddenpanel-tab-color: var(--tl-muted);
            --dv-inactivegroup-visiblepanel-tab-color: var(--tl-muted);
            --dv-inactivegroup-hiddenpanel-tab-color: var(--tl-muted);
            --dv-tab-divider-color: var(--tl-border);
            --dv-separator-border: var(--tl-border);
            --dv-sash-color: var(--tl-border);
            --dv-active-sash-color: var(--tl-accent);
            --dv-icon-hover-background-color: var(--tl-surface-soft);
            --dv-tab-border-radius: 7px;
            --dv-border-radius: 9px;
          }
          .tl-dockview-host .tl-dockview-theme .dv-dockview,
          .tl-dockview-host .tl-dockview-theme .dv-groupview,
          .tl-dockview-host .tl-dockview-theme .dv-content-container { height: 100%; width: 100%; color: var(--tl-ink); }
          .tl-dockview-host .tl-dockview-theme .dv-groupview { background: var(--tl-surface); }
          .tl-dockview-host .tl-dockview-theme .dv-tabs-and-actions-container {
            box-sizing: border-box; padding-inline: var(--tl-space-2); font-family: inherit;
          }
          .tl-dockview-host .tl-dockview-theme .dv-tab { border-radius: 5px; }
          .tl-dockview-host .tl-dockview-theme .dv-right-actions-container button,
          .tl-dockview-host .tl-dockview-theme .dv-left-actions-container button {
            border-radius: 4px; color: var(--tl-muted);
          }
          .tl-dockview-host .tl-dockview-theme .dv-right-actions-container button:hover,
          .tl-dockview-host .tl-dockview-theme .dv-left-actions-container button:hover {
            background: var(--tl-surface-soft); color: var(--tl-ink);
          }
          .tl-dock-scene.is-narrow .dv-tabs-and-actions-container { pointer-events: none; }
          .tl-dock-scene.is-narrow .tl-dock-group-actions { pointer-events: auto; }
          .tl-dock-panel {
            display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0;
            min-height: 0; overflow: hidden; background: var(--tl-surface); color: var(--tl-ink); font-family: inherit;
          }
          .tl-dock-group-actions { display:inline-flex; align-items:center; gap:4px; padding-inline:4px; font-size:13px; }
          .tl-dock-group-actions button { min-height:28px; padding:4px 8px; border:1px solid var(--tl-border); border-radius:6px; background:var(--tl-surface); color:var(--tl-ink); font:inherit; cursor:pointer; }
          .tl-dock-group-actions button:hover { background:var(--tl-surface-hover); border-color:var(--tl-accent); }
          .tl-dock-group-actions button:focus-visible { outline:2px solid var(--tl-accent); outline-offset:1px; }
          .tl-dock-layout-error { color:var(--tl-muted); font-size:12px; }
          .tl-dock-panel-body {
            box-sizing: border-box; flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto;
            padding: var(--tl-panel-inset); background: var(--tl-surface);
          }
          .tl-dock-panel-body:has(>iframe) { overflow: hidden; }
          .tl-dock-panel-body:has(>iframe) { padding: 0; }
          .tl-dock-panel-body.is-native-chat { display: flex; flex-direction: column; overflow: hidden; padding: 2px; }
          .tl-dock-panel-body.is-native-chat [data-content-phase="active"] [data-conversation-scroll] > [data-slot="conversation.session"]:not(:has([data-slot="conversation.view"])) + [data-composer-seat] { margin-block-start:auto; }
          .tl-erpnext-status { display: flex; flex-direction: column; gap: 8px; min-width: 0; color: var(--tl-ink); }
          .tl-erpnext-status-heading, .tl-erpnext-controls, .tl-erpnext-pagination, .tl-erpnext-detail-heading {
            display: flex; align-items: center; flex-wrap: wrap; gap: 8px;
          }
          .tl-erpnext-status-heading h3, .tl-erpnext-detail-heading h4 { flex: 1 1 auto; margin: 0; font-size: 14px; }
          .tl-erpnext-status p, .tl-erpnext-source { margin: 0; color: var(--tl-muted); font-size: 12px; }
          .tl-erpnext-status a { align-self: flex-start; color: var(--tl-accent); }
          .tl-erpnext-browser { display: flex; flex-direction: column; gap: 8px; min-width: 0; min-height: 0; }
          .tl-erpnext-controls label { display: inline-flex; align-items: center; gap: 6px; color: var(--tl-muted); }
          .tl-erpnext-controls button, .tl-erpnext-controls select, .tl-erpnext-browser button,
          .tl-erpnext-status-heading button, .tl-erpnext-status > button, .tl-erpnext-detail-heading button {
            min-height: 28px; padding: 4px 9px; border: 1px solid var(--tl-border); border-radius: 5px;
            background: var(--tl-surface); color: var(--tl-ink); font: inherit; font-size: 12px; cursor: pointer;
          }
          .tl-erpnext-browser button:hover, .tl-erpnext-status button:hover { background: var(--tl-surface-hover); }
          .tl-erpnext-browser button:focus-visible, .tl-erpnext-status button:focus-visible,
          .tl-erpnext-controls select:focus-visible { outline: 2px solid var(--tl-accent); outline-offset: 1px; }
          .tl-erpnext-table-wrap { max-width: 100%; overflow: auto; border: 1px solid var(--tl-border); border-radius: 5px; }
          .tl-erpnext-table-wrap table { border-collapse: collapse; width: 100%; min-width: 640px; background: var(--tl-surface); }
          .tl-erpnext-table-wrap th, .tl-erpnext-table-wrap td { padding: 6px 8px; border-bottom: 1px solid var(--tl-border); text-align: left; white-space: nowrap; }
          .tl-erpnext-table-wrap th { position: sticky; top: 0; background: var(--tl-surface-soft); color: var(--tl-muted); font-weight: 600; }
          .tl-erpnext-pagination { justify-content: flex-end; color: var(--tl-muted); font-size: 12px; }
          .tl-erpnext-detail { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding-top: 8px; border-top: 1px solid var(--tl-border); }
          .tl-erpnext-detail dl { display: grid; grid-template-columns: minmax(100px, 0.35fr) minmax(0, 1fr); gap: 4px 10px; margin: 0; }
          .tl-erpnext-detail dt { color: var(--tl-muted); }
          .tl-erpnext-detail dd { min-width: 0; margin: 0; overflow-wrap: anywhere; }
          .tl-erpnext-child-table h5 { margin: 4px 0; font-size: 12px; }
          .tl-erpnext-child-table pre { max-width: 100%; overflow: auto; padding: 8px; border: 1px solid var(--tl-border); border-radius: 5px; background: var(--tl-surface-soft); color: var(--tl-ink); }
          .tl-erpnext-draft { display: flex; flex-direction: column; gap: 8px; min-width: 0; padding-top: 8px; border-top: 1px solid var(--tl-border); }
          .tl-erpnext-draft-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
          .tl-erpnext-draft-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; color: var(--tl-muted); font-size: 12px; }
          .tl-erpnext-draft-field input { box-sizing: border-box; width: 100%; min-height: 30px; padding: 5px 7px; border: 1px solid var(--tl-border); border-radius: 5px; background: var(--tl-surface); color: var(--tl-ink); font: inherit; font-size: 13px; }
          .tl-erpnext-draft-field input:focus-visible { outline: 2px solid var(--tl-accent); outline-offset: 1px; }
          .tl-erpnext-draft-items { display: flex; flex-direction: column; gap: 6px; }
          .tl-erpnext-draft-item { display: grid; grid-template-columns: repeat(4, minmax(90px, 1fr)) auto; align-items: end; gap: 6px; }
          .tl-erpnext-draft-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
          .tl-erpnext-draft-actions button { min-height: 28px; padding: 4px 9px; border: 1px solid var(--tl-border); border-radius: 5px; background: var(--tl-surface); color: var(--tl-ink); font: inherit; font-size: 12px; cursor: pointer; }
          .tl-erpnext-draft-actions button:hover { background: var(--tl-surface-hover); }
          .tl-erpnext-draft-actions button:focus-visible { outline: 2px solid var(--tl-accent); outline-offset: 1px; }
          @media (max-width: 760px) { .tl-erpnext-draft-item { grid-template-columns: repeat(2, minmax(100px, 1fr)); } }
          .tl-dock-panel-picker { display: inline-flex; align-items: center; gap: 6px; color: var(--tl-muted); font-size: 13px; }
          @media (max-width: 760px) {
            .tl-workbench { padding: 12px; }
            .tl-workbench { --tl-panel-inset: 10px; --tl-toolbar-inset: 10px; }
            .tl-dock-toolbar { min-height: 30px; }
          }
        `),
        h('div', { className: 'tl-scene-docks' }, state.config.scenes.filter(item => visited.has(item.id)).map(item => h(SceneDock, {
          key: item.id, scene: item, active: item.id === scene.id, SessionProvider, renderSlot, dockviewModule,
        }))))
    }

    function assistantLabel(roleId, config = snapshot.config) {
      return config?.roles?.find(role => role.id === roleId)?.assistantLabel ?? '工作助手'
    }

    function dockviewTheme(colorScheme) {
      const dark = colorScheme === 'dark'
      return {
        name: dark ? 'abyss' : 'light',
        className: dark ? 'dockview-theme-abyss' : 'dockview-theme-light',
        colorScheme: dark ? 'dark' : 'light',
        tabGroupIndicator: 'none',
      }
    }

    return {
      SceneTabs, ModelDirectoryRail, ModelDirectoryFailure, SceneWorkbench, SceneChatPanel, ERPNextStatus, ERPNextQuotationDraft, retainRoleSession, releaseRoleSessions, modelDirectoryEntries, providerBadgeLabel, currentModelLabel, modelDirectoryDiagnostic,
      PANEL_REGISTRY: Object.freeze({ 'business-iframe': BusinessFrame, placeholder: Placeholder, 'native-chat': SceneChatPanel, 'erpnext-status': ERPNextStatus, 'workflow-canvas': WorkflowPanel }),
      bindSession, rememberLayout, roleForScene, selectScene, updatePanelLayout,
      selectRole, bindRoleSession, navigateBusiness, navigateScene, sceneNavigationItems, assistantLabel,
      subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener) },
      retryLoadConfig: () => loadConfig(true),
      getDockviewApi: sceneId => dockviewApis.get(sceneId),
      getSnapshot: () => snapshot,
      register(ctx, onBusinessOrigin, onRoleMetadataState, palette = {}) {
        layoutApi = ctx.layout
        sessionsApi = ctx.sessions
        modelDirectoriesApi = ctx.modelDirectories
        themeApi = ctx.theme
        const themeTokens = Object.fromEntries([
          ['--dsw-alias-bg-base', 'canvas'], ['--dsw-alias-bg-layer-1', 'panel'],
          ['--dsw-alias-bg-layer-2', 'header'], ['--dsw-alias-border-l1', 'border'],
          ['--dsw-alias-label-primary', 'text'], ['--dsw-alias-label-secondary', 'muted'],
          ['--dsw-alias-brand-primary', 'accent'],
        ].map(([token, key]) => [token, { light: palette[key]?.light ?? '', dark: palette[key]?.dark ?? '' }]))
        const releaseThemeTokens = ctx.theme?.overrideTokens?.('@tradeloom/dsh-business-shell', themeTokens)
        activeColorScheme = ctx.theme?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
        const updateColorScheme = theme => {
          const colorScheme = theme?.active?.colorScheme ?? ctx.theme?.getTheme?.()?.active?.colorScheme
          activeColorScheme = colorScheme === 'dark' ? 'dark' : 'light'
          publish({ themeRevision: (snapshot.themeRevision ?? 0) + 1 })
        }
        // Cordis owns ctx.on() listeners on this plugin fiber and disposes them automatically.
        ctx.on?.('theme/change', updateColorScheme)
        businessOriginCallback = onBusinessOrigin
        roleDefinitionsCallback = onRoleMetadataState
        if (snapshot.config?.roles) roleDefinitionsCallback?.({
          status: 'ready', error: '',
          roles: snapshot.config.roles.map(({ id, label, assistantLabel }) => ({ id, label, assistantLabel })),
        })
        else roleDefinitionsCallback?.({ status: 'loading', error: '', roles: null })
        ctx.effect?.(() => () => {
          releaseThemeTokens?.()
          businessOriginCallback = undefined
          roleDefinitionsCallback = undefined
          releaseRoleSessions()
          dockviewApis.clear()
          pendingScenePanelFocus.clear()
          dockviewRenderers.clear()
          dockGroupRenderers.clear()
          dockRenderContexts.clear()
          narrowListeners.clear()
        }, 'tradeloom scene workbench role sessions')
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main', key: 'scene-workbench',
          children: { 'scene.workbench.chat': { kind: 'single', scope: 'session' } },
        }, SceneWorkbench))
        ctx.slots.inject('scene.workbench.chat', () => ctx.slots.register({ name: 'scene.workbench.chat' }, SceneChatPanel))
      },
    }
  },
})
