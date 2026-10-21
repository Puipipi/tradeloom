window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.scenes.js',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const listeners = new Set()
    const retainedByRole = new Map()
    const dockviewApis = new Map()
    const dockviewRenderers = new Map()
    const maximizeListeners = new Map()
    const narrowListeners = new Map()
    const asyncRequire = typeof require.async === 'function' ? require.async.bind(require) : null
    let dockviewRequest
    let dockSaveQueue = Promise.resolve()
    let dockRevision = 0
    let dockPersistedRevision = 0
    let snapshot = {
      config: null, configError: '', activeSceneId: 'center', roleByScene: {}, businessPath: '/home',
      layouts: {}, dockLayouts: null, dockDefaults: {}, visitedScenes: ['center'], dockSaveErrors: {},
      businessPathsByScene: {}, proposalHrefsByScene: {}, sessionBindings: {}, sessionErrors: {},
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

    function notifyMaximizeListeners(sceneId) {
      for (const listener of maximizeListeners.get(sceneId) ?? []) listener()
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

    function sceneNavigationItems(config) {
      return (Array.isArray(config?.scenes) ? config.scenes : []).map(scene => ({
        id: scene.id,
        label: scene.label,
        icon: typeof scene.icon === 'string' && scene.icon ? scene.icon : scene.label.slice(0, 1),
        route: scene.defaultBusinessRoute ?? null,
      }))
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
      const groups = chat.length > 0 && business.length > 0
        ? [makeLeaf('1', business, 60), makeLeaf('2', chat, 40)]
        : [makeLeaf('1', scene.panels, 100)]
      return {
        version: 2, closedPanelIds: [], legacyV1Snapshot: null,
        migration: { status: 'default', reason: 'client-reset-default' },
        dockview: {
          grid: { root: { type: 'branch', data: groups, size: 100 }, width: 100, height: 100, orientation: 'HORIZONTAL' },
          panels: Object.fromEntries(scene.panels.map(panel => [panel.id, {
            id: panel.id, contentComponent: panel.type, title: panel.title, renderer: 'always', params: { panelId: panel.id },
          }])),
          activeGroup: '1',
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
      if (!focusScenePanel(target.sceneId, target.panelId)) reopenScenePanel(target.sceneId, target.panelId)
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
      if (panelId && !focusScenePanel(sceneId, panelId)) reopenScenePanel(sceneId, panelId)
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

    function SceneTabs({ onSceneSelect } = {}) {
      const state = useSnapshot()
      React.useEffect(() => { void loadConfig().catch(() => {}) }, [])
      return h(React.Fragment, null,
        sceneNavigationItems(state.config).map(scene => h('button', {
          key: scene.id, type: 'button', className: 'tl-scene-tab',
          'aria-label': scene.label, title: scene.label,
          'aria-current': state.activeSceneId === scene.id ? 'page' : undefined,
          onClick: () => typeof onSceneSelect === 'function' ? onSceneSelect(scene.id) : navigateScene(scene.id),
        }, h('span', { className: 'tl-scene-tab-icon', 'aria-hidden': 'true' }, scene.icon),
        h('span', { className: 'tl-scene-tab-label' }, scene.label))),
        state.configError ? h('span', { role: 'status' }, state.configError) : null,
        h('button', { type: 'button', onClick: () => { void loadConfig(true).catch(() => {}) } }, state.configError ? '重试读取场景' : '刷新场景配置'))
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
          const result = themeApi?.setTheme?.(preference)
          if (result && typeof result.then === 'function') await result
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
      function cycleThemePreference() {
        const nextPreference = followsSystem
          ? activeColorScheme === 'dark' ? 'light' : 'dark'
          : 'system'
        void selectThemePreference(nextPreference)
      }
      return h(React.Fragment, null,
        h('style', { 'data-tradeloom-navigation-style': 'true' }, `
          .tl-model-rail {
            --tl-shell-surface: #fff; --tl-shell-soft: #f5f5f7; --tl-shell-ink: #1d1d1f;
            --tl-shell-muted: #6e6e73; --tl-shell-line: #d2d2d7; --tl-shell-accent: #0e73d8;
            --tl-shell-accent-soft: #e8f1fd; --tl-shell-button: #0e73d8; --tl-shell-button-hover: #0d6ece;
            --tl-shell-button-ink: #fff; --tl-shell-danger: #ba2121; --tl-shell-danger-bg: #fdecea; --tl-shell-danger-line: #f5c6c6;
            display: flex; flex: 1 1 auto; align-items: center; gap: 8px; min-width: 0; min-height: 52px;
            padding: 2px 4px; overflow: visible; position: relative; z-index: 30;
            color: var(--tl-shell-ink); font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px;
          }
          .tl-model-rail.is-dark {
            --tl-shell-surface: #1c1c1e; --tl-shell-soft: #2c2c2e; --tl-shell-ink: #f5f5f7;
            --tl-shell-muted: #a1a1a6; --tl-shell-line: #3a3a3c; --tl-shell-accent: #1985f0;
            --tl-shell-accent-soft: #1e3a5f; --tl-shell-button: #2f6ba8; --tl-shell-button-hover: #3a7cc0;
            --tl-shell-danger: #ff8f8f; --tl-shell-danger-bg: #3a2323; --tl-shell-danger-line: #7a3b3b;
          }
          .tl-model-current { min-width: 0; max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--tl-shell-muted); font-size: 12px; }
          .tl-model-groups { display: flex; align-items: center; gap: 5px; min-width: 0; }
          .tl-model-group { position: relative; flex: 0 0 auto; }
          .tl-model-group > summary {
            display: flex; align-items: center; justify-content: center; width: 30px; height: 30px;
            border: 1px solid var(--tl-shell-line); border-radius: 6px; background: var(--tl-shell-surface);
            color: var(--tl-shell-ink); cursor: pointer; list-style: none; font-size: 12px; font-weight: 650;
          }
          .tl-model-group > summary::-webkit-details-marker { display: none; }
          .tl-model-group > summary:focus-visible, .tl-model-options button:focus-visible,
          .tl-theme-cycle:focus-visible, .tl-scene-tab:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
          .tl-model-options {
            position: absolute; top: calc(100% + 5px); left: 0; z-index: 50; display: grid; gap: 3px;
            min-width: 180px; max-height: min(60vh,360px); overflow: auto; padding: 6px;
            border: 1px solid var(--tl-shell-line); border-radius: 7px; background: var(--tl-shell-surface);
            color: var(--tl-shell-ink); box-shadow: 0 8px 24px rgba(0,0,0,.18);
          }
          .tl-model-options button { width: 100%; border: 0; border-radius: 5px; padding: 7px 9px; text-align: left; background: transparent; color: inherit; cursor: pointer; }
          .tl-model-options button:hover, .tl-model-options button[aria-current="true"] { background: var(--tl-shell-accent-soft); }
          .tl-theme-toggle { flex: 0 0 auto; margin-left: auto; }
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
          .tl-navigation .tl-scene-tab-label { max-width: 0; overflow: hidden; opacity: 0; transition: max-width 120ms ease, opacity 120ms ease; }
          .tl-navigation .tl-scene-tab:hover, .tl-navigation .tl-scene-tab:focus-visible, .tl-navigation .tl-scene-tab[aria-current="page"] { gap: 6px; background: var(--tl-shell-accent-soft); border-color: var(--tl-shell-line); }
          .tl-navigation .tl-scene-tab:hover .tl-scene-tab-label, .tl-navigation .tl-scene-tab:focus-visible .tl-scene-tab-label, .tl-navigation .tl-scene-tab[aria-current="page"] .tl-scene-tab-label { max-width: 140px; opacity: 1; }
          @media (prefers-reduced-motion: reduce) { .tl-navigation .tl-scene-tab, .tl-navigation .tl-scene-tab-label, .tl-theme-cycle { transition: none; } }
        `),
        h('nav', { className: `tl-model-rail ${activeColorScheme === 'dark' ? 'is-dark' : 'is-light'}`, 'aria-label': '模型目录' },
          h('span', { className: 'tl-model-current', role: 'status' }, sessionId
            ? directoryState?.current ? currentModelLabel(directoryState.current, directoryState.groups)
              : activeDirectoryInfo?.status === 'pending' ? '正在连接模型目录…' : '选择模型'
            : '连接助手后选择模型'),
          h('div', { className: 'tl-model-groups' }, entries.map(group => h('details', { key: group.provider, className: 'tl-model-group' },
            h('summary', { 'aria-label': group.providerName, title: group.providerName }, group.providerName.slice(0, 1)),
            h('div', { className: 'tl-model-options' }, group.models.map(model => h('button', {
              key: `${model.provider}/${model.id}`, type: 'button',
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
              followsSystem ? h('span', { className: 'tl-theme-auto-badge', 'aria-hidden': 'true' }, 'A') : null)),
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

    function Placeholder({ panel }) { return h('div', { className: 'tl-placeholder' }, h('p', null, panel.text)) }
    function ERPNextStatus({ refreshKey = 0 } = {}) {
      const [state, setState] = React.useState({ loading: true, configured: false, connected: false, status: '', error: '' })
      React.useEffect(() => {
        let live = true
        setState(current => ({ ...current, loading: true, error: '' }))
        void fetch('/business-api/erpnext/status', { method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' } })
          .then(async response => {
            const value = await response.json()
            if (!response.ok || !value || typeof value.configured !== 'boolean' || typeof value.connected !== 'boolean'
              || !['not_configured', 'invalid_configuration', 'connected', 'unavailable'].includes(value.status)) throw new Error()
            if (live) setState({ loading: false, configured: value.configured, connected: value.connected, status: value.status, error: '' })
          })
          .catch(() => { if (live) setState({ loading: false, configured: false, connected: false, status: '', error: '暂时无法读取连接状态，请稍后重试。' }) })
        return () => { live = false }
      }, [refreshKey])
      const title = state.loading ? '正在检查 ERPNext 连接…'
        : state.error ? 'ERPNext 状态暂不可用'
          : state.status === 'not_configured' ? 'ERPNext 尚未配置'
            : state.connected ? 'ERPNext 已连接' : 'ERPNext 暂时无法连接'
      const detail = state.error || (state.status === 'not_configured'
        ? '请由管理员配置 ERPNext 连接后再使用只读数据。'
        : state.connected ? '连接检查已通过，可继续接入允许的只读数据。'
          : state.loading ? '正在读取本地连接状态。' : '请检查服务状态或连接配置。')
      return h('section', { className: 'tl-erpnext-status', 'aria-live': 'polite' }, h('h3', null, title), h('p', null, detail))
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
      const [refreshKey, setRefreshKey] = React.useState(0)
      const [maximized, setMaximized] = React.useState(() => Boolean(props.api?.isMaximized?.()))
      const [narrow, setNarrow] = React.useState(() => Boolean(context.narrow))
      const roleId = roleForScene(state.config, sceneId)
      React.useEffect(() => {
        const update = () => setMaximized(Boolean(props.api?.isMaximized?.()))
        let listeners = maximizeListeners.get(sceneId)
        if (!listeners) maximizeListeners.set(sceneId, listeners = new Set())
        listeners.add(update)
        update()
        return () => {
          listeners.delete(update)
          if (listeners.size === 0) maximizeListeners.delete(sceneId)
        }
      }, [sceneId, props.api])
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
      const actionTitle = panel.type === 'native-chat' ? assistantLabel(roleId) : panel.title
      let content = null
      if (panel.type === 'business-iframe') {
        const path = panel.id === 'business-main' ? state.businessPathsByScene?.[sceneId] ?? panel.path : panel.path
        const proposalHref = path === '/agent-center' && panel.id === 'business-main' ? state.proposalHrefsByScene?.[sceneId] ?? '' : ''
        content = h(BusinessFrame, { panel, path, proposalHref, refreshKey })
      } else if (panel.type === 'placeholder') content = h(Placeholder, { panel })
      else if (panel.type === 'erpnext-status') content = h(ERPNextStatus, { refreshKey })
      else if (panel.type === 'native-chat') content = h(NativeChatPanel, {
        sceneId, refreshKey, SessionProvider: context.SessionProvider, renderSlot: context.renderSlot,
      })
      return h('div', { className: 'tl-dock-panel', 'data-panel-id': panel.id, 'data-panel-type': panel.type },
        h('div', { className: 'tl-dock-panel-actions', role: 'toolbar', 'aria-label': `${panel.title}面板操作` },
          h('button', { type: 'button', onClick: () => setRefreshKey(value => value + 1), 'aria-label': panel.type === 'native-chat' ? '重新载入对话视图' : `刷新${panel.title}` }, panel.type === 'native-chat' ? '重新载入对话视图' : '刷新'),
          !narrow ? h('button', { type: 'button', onClick: () => {
            if (props.api?.isMaximized?.()) props.api?.exitMaximized?.()
            else props.api?.maximize?.()
          }, 'aria-label': maximized ? `还原${actionTitle}` : `展开${actionTitle}` }, maximized ? '还原' : '展开') : null,
          h('button', { type: 'button', onClick: () => props.api?.close?.(), 'aria-label': `关闭${actionTitle}` }, '关闭')),
        h('div', { className: `tl-dock-panel-body${panel.type === 'native-chat' ? ' is-native-chat' : ''}` }, content))
    }

    function stableDockComponents(sceneId) {
      if (!dockviewRenderers.has(sceneId)) {
        const types = ['business-iframe', 'placeholder', 'native-chat', 'erpnext-status']
        dockviewRenderers.set(sceneId, Object.fromEntries(types.map(type => [type, props => h(SceneDockPanel, { ...props, sceneId })])))
      }
      return dockviewRenderers.get(sceneId)
    }

    function SceneDock({ scene, active, SessionProvider, renderSlot, dockviewModule }) {
      const state = useSnapshot()
      const hostRef = React.useRef(null)
      const apiRef = React.useRef(null)
      const restoredRef = React.useRef(false)
      const narrowRef = React.useRef(false)
      const layoutEventRef = React.useRef(null)
      const maximizeEventRef = React.useRef(null)
      const [width, setWidth] = React.useState(0)
      const [activePanelId, setActivePanelId] = React.useState('')
      const [error, setError] = React.useState('')
      const roleId = roleForScene(state.config, scene.id)
      const record = state.dockLayouts?.scenes?.[scene.id]
      const api = apiRef.current
      const narrow = width > 0 && width < 900
      dockRenderContexts.set(scene.id, { SessionProvider, renderSlot, narrow })

      React.useEffect(() => {
        const chatPanel = apiRef.current?.getPanel(scene.panels.find(panel => panel.type === 'native-chat')?.id)
        if (chatPanel && roleId) chatPanel.api.setTitle(assistantLabel(roleId))
      }, [roleId, scene.id])

      React.useEffect(() => {
        const element = hostRef.current
        if (!element || typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(entries => {
          const entry = entries.find(item => item.target === element)
          if (entry) setWidth(entry.contentRect?.width ?? element.clientWidth ?? 0)
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
        maximizeEventRef.current?.dispose?.()
        dockviewApis.delete(scene.id)
      }, [scene.id])

      function persistCurrentLayout() {
        const currentApi = apiRef.current
        if (!currentApi || narrowRef.current) return Promise.resolve(false)
        const dockview = currentApi.toJSON()
        return queueDockLayoutSave(scene.id, dockview)
      }

      function onReady({ api: readyApi }) {
        apiRef.current = readyApi
        dockviewApis.set(scene.id, readyApi)
        try {
          readyApi.fromJSON(record.dockview)
          restoredRef.current = true
          const activePanel = readyApi.activePanel ?? readyApi.getPanel(scene.panels[0]?.id)
          setActivePanelId(activePanel?.id ?? scene.panels[0]?.id ?? '')
          readyApi.getPanel(scene.panels.find(panel => panel.type === 'native-chat')?.id)?.api.setTitle(assistantLabel(roleId))
          layoutEventRef.current = readyApi.onDidLayoutChange(() => {
            const selected = readyApi.activePanel?.id
            if (selected) setActivePanelId(selected)
            if (restoredRef.current && !narrowRef.current) void persistCurrentLayout()
          })
          maximizeEventRef.current = readyApi.onDidMaximizedGroupChange(() => notifyMaximizeListeners(scene.id))
          if (hostRef.current) {
            const rect = hostRef.current.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) readyApi.layout(rect.width, rect.height, true)
          }
        } catch {
          setError('工作区布局无法读取，请重置布局后重试。')
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
        for (const panel of scene.panels) {
          if (!currentApi.getPanel(panel.id)) reopenScenePanel(scene.id, panel.id)
        }
        const chatConfig = scene.panels.find(panel => panel.type === 'native-chat')
        const businessConfig = scene.panels.filter(panel => panel.type !== 'native-chat')
        const selected = currentApi.getPanel(businessConfig[0]?.id ?? chatConfig?.id) ?? currentApi.panels?.[0]
        if (selected && businessConfig.length > 0) {
          for (const panelConfig of businessConfig.slice(1)) {
            const panel = currentApi.getPanel(panelConfig.id)
            if (panel && panel.api.group !== selected.api.group) panel.api.moveTo({ group: selected.api.group, position: 'center' })
          }
        }
        if (selected && chatConfig && businessConfig.length > 0) {
          const chatPanel = currentApi.getPanel(chatConfig.id)
          if (chatPanel) chatPanel.api.moveTo({ group: selected.api.group, position: 'right' })
          const host = hostRef.current?.getBoundingClientRect()
          if (host && host.width > 0 && host.height > 0) {
            selected.api.group.api.setSize({ width: Math.round(host.width * 0.6), height: host.height })
            currentApi.getPanel(chatConfig.id)?.api.group.api.setSize({ width: Math.round(host.width * 0.4), height: host.height })
          }
        } else if (selected) {
          for (const panelConfig of scene.panels.slice(1)) {
            const panel = currentApi.getPanel(panelConfig.id)
            if (panel && panel.api.group !== selected.api.group) panel.api.moveTo({ group: selected.api.group, position: 'center' })
          }
        }
        if (selected) {
          selected.api.setActive()
          setActivePanelId(selected.id)
          if (narrowRef.current) currentApi.maximizeGroup(selected)
        }
        if (!narrow) void persistCurrentLayout()
      }

      const panels = scene.panels
      const closedPanels = panels.filter(panel => !api?.getPanel(panel.id))
      const Components = stableDockComponents(scene.id)
      const DockviewReact = dockviewModule.DockviewReact
      return h('section', { className: `tl-dock-scene${active ? ' is-active' : ''}${narrow ? ' is-narrow' : ''}`, 'aria-label': `${scene.label}工作区`, style: { display: active ? 'flex' : 'none' } },
        h('header', { className: 'tl-dock-toolbar' },
          narrow ? h('label', { className: 'tl-dock-panel-picker' }, '当前面板', h('select', {
            'aria-label': '选择当前面板', value: activePanelId,
            onChange: event => selectPanel(event.currentTarget.value),
          }, panels.map(panel => h('option', { key: panel.id, value: panel.id }, `${panel.title}${closedPanels.some(item => item.id === panel.id) ? '（已关闭）' : ''}`)))) : null,
          h('button', { type: 'button', onClick: resetLayout }, '重置布局'),
          h('div', { className: 'tl-dock-closed-panels', 'aria-label': '已关闭面板' }, closedPanels.map(panel => h('button', {
            key: panel.id, type: 'button', onClick: () => selectPanel(panel.id),
          }, `恢复${panel.title}`))),
          state.dockSaveErrors?.[scene.id] ? h('span', { role: 'alert' }, state.dockSaveErrors[scene.id], h('button', { type: 'button', onClick: () => { void persistCurrentLayout() } }, '重试保存')) : null,
          error ? h('span', { role: 'alert' }, error, h('button', { type: 'button', onClick: resetLayout }, '重置布局')) : null),
        h('div', { className: 'tl-dockview-host', ref: hostRef }, h(DockviewReact, {
          components: Components,
          onReady,
          disableDnd: narrow,
          dndStrategy: 'pointer',
          disableFloatingGroups: true,
          getTabContextMenuItems: () => [],
          className: 'tl-dockview-theme',
          proportionalLayout: true,
          theme: dockviewTheme(activeColorScheme),
        })),
        null)
    }

    function SceneWorkbench({ SessionProvider, renderSlot }) {
      const state = useSnapshot()
      const [dockviewModule, setDockviewModule] = React.useState(null)
      const [dockviewError, setDockviewError] = React.useState('')
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
      const roleId = roleForScene(state.config, scene.id)
      const visited = new Set([...(state.visitedScenes ?? []), scene.id])
      const sceneLabel = scene.label
      return h('main', { className: `tl-workbench ${activeColorScheme === 'dark' ? 'is-dark' : 'is-light'}`, 'aria-label': sceneLabel },
        h('style', null, dockviewModule.dockviewCss),
        h('style', null, `
          .tl-workbench {
            box-sizing: border-box;
            padding: 16px;
            --tl-canvas: #FFFFFF;
            --tl-surface: #FFFFFF;
            --tl-surface-soft: #F5F5F7;
            --tl-surface-hover: #E8E8ED;
            --tl-ink: #1D1D1F;
            --tl-muted: #6E6E73;
            --tl-border: #D2D2D7;
            --tl-accent: #0E73D8;
            --tl-accent-strong: #0D6ECE;
            --tl-accent-soft: #E8F1FD;
            --tl-button-bg: #0E73D8;
            --tl-button-hover: #0D6ECE;
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
          .tl-workbench.is-dark {
            --tl-canvas: #1C1C1E;
            --tl-surface: #1C1C1E;
            --tl-surface-soft: #2C2C2E;
            --tl-surface-hover: #3A3A3C;
            --tl-ink: #F5F5F7;
            --tl-muted: #A1A1A6;
            --tl-border: #3A3A3C;
            --tl-accent: #1985F0;
            --tl-accent-strong: #499EF3;
            --tl-accent-soft: #1E3A5F;
            --tl-button-bg: #2F6BA8;
            --tl-button-hover: #3A7CC0;
            --tl-button-ink: #FFFFFF;
            --tl-danger: #FF8F8F;
            --tl-danger-bg: #3A2323;
            --tl-danger-border: #7A3B3B;
          }
          .tl-workbench-heading {
            display: flex;
            align-items: center;
            gap: 8px;
            min-height: 30px;
            margin: 0 0 4px;
            padding: 0 6px;
            color: var(--tl-ink);
            font-family: inherit;
          }
          .tl-workbench-heading h2 { margin: 0; font-size: 15px; font-weight: 600; }
          .tl-workbench-heading [role="status"] { color: var(--tl-muted); font-size: 12px; }
          .tl-scene-docks { position: relative; display: flex; flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; overflow: hidden; }
          .tl-dock-scene { position: absolute; inset: 0; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
          .tl-dock-toolbar {
            display: flex; align-items: center; gap: 5px; min-height: 30px; flex: 0 0 auto;
            overflow-x: auto; white-space: nowrap; padding: 2px 4px;
            color: var(--tl-ink); font-family: inherit;
          }
          .tl-dock-toolbar button, .tl-dock-toolbar select,
          .tl-dock-panel-actions button, .tl-dock-closed-panels button,
          .tl-dock-panel-picker select {
            min-height: 26px; padding: 3px 8px; border: 1px solid var(--tl-border);
            border-radius: 5px; background: var(--tl-surface); color: var(--tl-ink);
            font: inherit; font-size: 12px;
          }
          .tl-dock-toolbar button, .tl-dock-panel-actions button, .tl-dock-closed-panels button { cursor: pointer; }
          .tl-dock-toolbar button:hover, .tl-dock-panel-actions button:hover, .tl-dock-closed-panels button:hover,
          .tl-dock-toolbar select:hover, .tl-dock-panel-picker select:hover { background: var(--tl-surface-soft); }
          .tl-dock-toolbar button:focus-visible, .tl-dock-panel-actions button:focus-visible,
          .tl-dock-closed-panels button:focus-visible, .tl-dock-toolbar select:focus-visible,
          .tl-dock-panel-picker select:focus-visible {
            outline: 2px solid var(--tl-accent); outline-offset: 1px;
          }
          .tl-dockview-host { flex: 1 1 auto; min-width: 0; min-height: 0; width: 100%; height: 100%; overflow: hidden; }
          .tl-dockview-host .tl-dockview-theme {
            height: 100%; width: 100%; color: var(--tl-ink); font-family: inherit;
            --dv-group-view-background-color: var(--tl-surface);
            --dv-tabs-and-actions-container-background-color: var(--tl-surface-soft);
            --dv-tabs-and-actions-container-height: 30px;
            --dv-tabs-and-actions-container-font-size: 12px;
            --dv-tab-font-size: 12px;
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
            --dv-tab-border-radius: 5px;
            --dv-border-radius: 5px;
          }
          .tl-dockview-host .tl-dockview-theme .dv-dockview,
          .tl-dockview-host .tl-dockview-theme .dv-groupview,
          .tl-dockview-host .tl-dockview-theme .dv-content-container { height: 100%; width: 100%; color: var(--tl-ink); }
          .tl-dockview-host .tl-dockview-theme .dv-groupview { background: var(--tl-surface); }
          .tl-dockview-host .tl-dockview-theme .dv-tabs-and-actions-container { font-family: inherit; }
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
          .tl-dock-panel {
            display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0;
            min-height: 0; overflow: hidden; background: var(--tl-surface); color: var(--tl-ink); font-family: inherit;
          }
          .tl-dock-panel-actions {
            display: flex; align-items: center; justify-content: flex-end; gap: 4px; min-height: 26px;
            padding: 2px 5px; border-bottom: 1px solid var(--tl-border); flex: 0 0 auto; background: var(--tl-surface);
          }
          .tl-dock-panel-body { flex: 1 1 auto; min-width: 0; min-height: 0; overflow: auto; background: var(--tl-surface); }
          .tl-dock-panel-body:has(>iframe) { overflow: hidden; }
          .tl-dock-panel-body.is-native-chat { display: flex; flex-direction: column; overflow: hidden; padding: 2px; }
          .tl-dock-closed-panels { display: flex; align-items: center; gap: 4px; }
          .tl-dock-panel-picker { display: inline-flex; align-items: center; gap: 4px; }
          .tl-dock-panel-picker label { color: var(--tl-muted); font-size: 12px; }
          @media (max-width: 760px) {
            .tl-workbench { padding: 12px; }
            .tl-dock-toolbar { min-height: 34px; }
            .tl-dock-panel-actions { min-height: 30px; }
          }
        `),
        h('header', { className: 'tl-workbench-heading' },
          h('h2', null, scene.label), h('span', { role: 'status' }, roleId ? `当前助手：${assistantLabel(roleId)}` : '尚未选择助手')),
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
      SceneTabs, ModelDirectoryRail, ModelDirectoryFailure, SceneWorkbench, SceneChatPanel, ERPNextStatus, retainRoleSession, releaseRoleSessions, modelDirectoryEntries, currentModelLabel, modelDirectoryDiagnostic,
      PANEL_REGISTRY: Object.freeze({ 'business-iframe': BusinessFrame, placeholder: Placeholder, 'native-chat': SceneChatPanel, 'erpnext-status': ERPNextStatus }),
      bindSession, rememberLayout, roleForScene, selectScene, updatePanelLayout,
      selectRole, navigateBusiness, navigateScene, sceneNavigationItems, assistantLabel,
      retryLoadConfig: () => loadConfig(true),
      getDockviewApi: sceneId => dockviewApis.get(sceneId),
      getSnapshot: () => snapshot,
      register(ctx, onBusinessOrigin, onRoleMetadataState) {
        layoutApi = ctx.layout
        sessionsApi = ctx.sessions
        modelDirectoriesApi = ctx.modelDirectories
        themeApi = ctx.theme
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
          businessOriginCallback = undefined
          roleDefinitionsCallback = undefined
          releaseRoleSessions()
          dockviewApis.clear()
          dockviewRenderers.clear()
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
