window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const menus = [
      ['business-home', '总览', '/home'],
      ['business-products', '商品', '/products'],
      ['business-agent-center', 'Agent 中心', '/agent-center'],
      ['business-artifacts', '资料', '/artifacts'],
      ['business-runs', '运行记录', '/runs'],
    ]
    let layout
    let uiWorkspace
    let sceneLoadState = {
      loading: false, error: '', SceneTabs: null, ModelDirectoryRail: null,
      roleMetadata: { status: 'idle', error: '', roles: null },
    }
    const sceneLoadListeners = new Set()
    let sceneLoadRequest
    let sceneContext
    let sceneApi
    let sceneWorkbenchSelected = false
    let trustedBusinessOrigin = ''
    let activeColorScheme = 'light'
    const workbenchPalette = Object.freeze({
      canvas: { light: '#f4f7fb', dark: '#0c1017' }, panel: { light: '#ffffff', dark: '#131925' },
      header: { light: '#e9eef6', dark: '#171f2c' }, border: { light: '#cbd5e2', dark: '#293345' },
      text: { light: '#202b3a', dark: '#dfe7f3' }, muted: { light: '#68778c', dark: '#8b97ab' },
      accent: { light: '#356fc4', dark: '#4d83dd' }, teal: { light: '#177d78', dark: '#37b5a9' },
    })
    let removeThemeBridge
    let agentCenterHref = '/business/agent-center'
    let removeProposalHandoff
    const agentCenterHrefListeners = new Set()
    let mobileQrRequest

    function loadMobileQr() {
      if (!mobileQrRequest) {
        mobileQrRequest = Promise.resolve(require.async('./client.mobile-qr.js'))
          .then(value => {
            const module = value?.default ?? value
            if (typeof module?.createQrMatrix !== 'function') throw new Error('mobile-qr-unavailable')
            return module
          })
          .catch(error => { mobileQrRequest = undefined; throw error })
      }
      return mobileQrRequest
    }

    function businessFrames() {
      return [...(window.document?.querySelectorAll?.('iframe[data-tradeloom-business-frame]') ?? [])]
    }

    function sendBusinessTheme(frame) {
      if (!frame?.contentWindow || !['light', 'dark'].includes(activeColorScheme)) return
      try {
        const palette = Object.fromEntries(Object.entries(workbenchPalette).map(([key, modes]) => [key, modes[activeColorScheme]]))
        frame.contentWindow.postMessage({ type: 'tradeloom:theme', colorScheme: activeColorScheme, palette }, window.location.origin)
      } catch { /* A frame may be navigating; its next load sends the current theme. */ }
    }

    function handleBusinessThemeRequest(event) {
      if (event.origin !== window.location.origin || event.data?.type !== 'tradeloom:theme:request'
        || Object.keys(event.data ?? {}).sort().join(',') !== 'type') return
      const frame = businessFrames().find(item => item.contentWindow === event.source)
      if (frame) sendBusinessTheme(frame)
    }

    function handleBusinessFrameLoad(event) {
      if (event.target?.matches?.('iframe[data-tradeloom-business-frame]')) sendBusinessTheme(event.target)
    }

    function installBusinessThemeBridge(ctx) {
      removeThemeBridge?.()
      activeColorScheme = ctx.theme?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
      publishSceneLoadState({ colorScheme: activeColorScheme })
      window.addEventListener?.('message', handleBusinessThemeRequest)
      window.document?.addEventListener?.('load', handleBusinessFrameLoad, true)
      const onThemeChange = theme => {
        const colorScheme = theme?.active?.colorScheme ?? ctx.theme?.getTheme?.()?.active?.colorScheme
        if (colorScheme !== 'light' && colorScheme !== 'dark') return
        activeColorScheme = colorScheme
        publishSceneLoadState({ colorScheme })
        for (const frame of businessFrames()) sendBusinessTheme(frame)
      }
      const removeThemeChangeListener = ctx.on?.('theme/change', onThemeChange)
      removeThemeBridge = () => {
        window.removeEventListener?.('message', handleBusinessThemeRequest)
        window.document?.removeEventListener?.('load', handleBusinessFrameLoad, true)
        removeThemeChangeListener?.()
      }
      ctx.effect?.(() => () => removeThemeBridge?.(), 'tradeloom business iframe theme bridge')
      for (const frame of businessFrames()) sendBusinessTheme(frame)
    }

    function setAgentCenterHref(href) {
      agentCenterHref = href
      for (const listener of agentCenterHrefListeners) listener(href)
    }

    function normalizeBusinessOrigin(value) {
      try {
        const url = new URL(value)
        if (url.origin !== value || !['http:', 'https:'].includes(url.protocol)
          || url.pathname !== '/' || url.search || url.hash || url.username || url.password) return ''
        return url.origin
      } catch { return '' }
    }

    function proposalRoute(href, origin) {
      try {
        const url = new URL(href)
        if (url.origin !== origin || url.pathname !== '/business/agent-center' || url.search
          || url.username || url.password) return ''
        if (!url.hash) return url.pathname
        if (!url.hash.startsWith('#proposal=')) return ''
        const pairs = [...new URLSearchParams(url.hash.slice(1))]
        if (pairs.length !== 1 || pairs[0][0] !== 'proposal') return ''
        const proposal = JSON.parse(pairs[0][1])
        const keys = Object.keys(proposal ?? {}).sort().join(',')
        if (keys !== 'batch_id,task_type,user_goal,version' || proposal.version !== 1
          || typeof proposal.batch_id !== 'string' || !proposal.batch_id.trim() || proposal.batch_id.length > 32
          || typeof proposal.user_goal !== 'string' || !proposal.user_goal.trim() || proposal.user_goal.length > 4000
          || !['prepare_product_data', 'generate_deliverables'].includes(proposal.task_type)) return ''
        return `${url.pathname}${url.hash}`
      } catch { return '' }
    }

    function setTrustedBusinessOrigin(value) {
      const origin = normalizeBusinessOrigin(value)
      if (origin === trustedBusinessOrigin) return
      removeProposalHandoff?.()
      removeProposalHandoff = undefined
      trustedBusinessOrigin = origin
      const document = window.document
      if (!origin || !document?.addEventListener) return
      const onClick = event => {
        if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        const anchor = event.target?.closest?.('a[href]')
        if (!anchor) return
        const route = proposalRoute(anchor.href, trustedBusinessOrigin)
        if (!route) return
        event.preventDefault()
        event.stopPropagation()
        setAgentCenterHref(route)
        sceneApi?.navigateBusiness('/agent-center', route)
      }
      document.addEventListener('click', onClick, true)
      removeProposalHandoff = () => document.removeEventListener('click', onClick, true)
    }

    function publishSceneLoadState(patch) {
      sceneLoadState = { ...sceneLoadState, ...patch }
      for (const listener of sceneLoadListeners) listener()
    }

    function SceneTopNavigation(props) {
      const [state, setState] = React.useState(sceneLoadState)
      const activePanelId = props.usePanelInfo?.(info => info.activePanelId)
      React.useEffect(() => {
        const listener = () => setState(sceneLoadState)
        sceneLoadListeners.add(listener)
        return () => sceneLoadListeners.delete(listener)
      }, [])
      return h('div', { className: `tl-shell-top is-${state.colorScheme ?? activeColorScheme}` },
        h('div', { className: 'tl-top-model-row' },
          h('div', { className: 'tl-shell-brand' }, h(TradeLoomMark, { className: 'tl-shell-brand-mark' }), h(TradeLoomWordmark)),
          h(AgentDirectory, { compact: true }),
          state.ModelDirectoryRail ? h(state.ModelDirectoryRail) : null,
          h(ShellToolsMenu)),
        h(BusinessMenu, { ...props, SceneTabs: state.SceneTabs }),
        state.loading ? h('p', { role: 'status', style: { margin: '0 12px 6px' } }, '正在加载工作场景…') : null,
        state.error ? h('div', { role: 'alert', style: { display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px' } },
          h('span', null, state.error),
          h('button', { type: 'button', onClick: () => loadSceneWorkbench() }, '重试工作场景')) : null)
    }

    function loadSceneWorkbench(ctx = sceneContext) {
      if (sceneLoadState.SceneTabs) return Promise.resolve(true)
      if (sceneLoadRequest) return sceneLoadRequest
      sceneContext = ctx
      publishSceneLoadState({ loading: true, error: '' })
      sceneLoadRequest = Promise.resolve()
        .then(() => require.async('./client.scenes.js'))
        .then(sceneWorkbench => {
          sceneWorkbench.register(ctx, setTrustedBusinessOrigin, roleMetadata => publishSceneLoadState({ roleMetadata }), workbenchPalette)
          sceneApi = sceneWorkbench
          if (!sceneWorkbenchSelected) {
            ctx.layout?.selectPanel('scene-workbench')
            sceneWorkbenchSelected = true
          }
          publishSceneLoadState({ SceneTabs: sceneWorkbench.SceneTabs, ModelDirectoryRail: sceneWorkbench.ModelDirectoryRail, loading: false, error: '' })
          return true
        })
        .catch(() => {
          publishSceneLoadState({ loading: false, error: '工作场景暂时无法加载。' })
          return false
        })
        .finally(() => { sceneLoadRequest = undefined })
      return sceneLoadRequest
    }

    function ShellToolsMenu() {
      const [open, setOpen] = React.useState(false)
      const [mobileOpen, setMobileOpen] = React.useState(false)
      const [mobileUrl, setMobileUrl] = React.useState('')
      const [mobileBusy, setMobileBusy] = React.useState(false)
      const [mobileError, setMobileError] = React.useState('')
      const [mobileQr, setMobileQr] = React.useState(null)
      const [mobileQrError, setMobileQrError] = React.useState('')
      const mobileRequest = React.useRef(0)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const current = sceneApi?.getSnapshot?.()
      const bindingKey = `${current?.activeSceneId ?? ''}`
      const activeBinding = React.useRef(bindingKey)
      React.useEffect(() => {
        if (!sceneApi?.subscribe) return undefined
        activeBinding.current = bindingKey
        const onSnapshot = () => {
          const latest = sceneApi.getSnapshot?.()
          const latestKey = `${latest?.activeSceneId ?? ''}`
          if (latestKey !== activeBinding.current) {
            activeBinding.current = latestKey
            setOpen(false)
          }
        }
        return sceneApi.subscribe(onSnapshot)
      }, [sceneApi])
      React.useEffect(() => {
        if (!open) return undefined
        const dismiss = event => {
          if (event.type === 'keydown') {
            if (event.key !== 'Escape') return
            event.preventDefault?.()
            setOpen(false)
            triggerRef.current?.focus?.()
            return
          }
          if (!rootRef.current?.contains?.(event.target)) setOpen(false)
        }
        document.addEventListener('keydown', dismiss)
        document.addEventListener('click', dismiss)
        return () => {
          document.removeEventListener('keydown', dismiss)
          document.removeEventListener('click', dismiss)
        }
      }, [open])

      async function showMobileLink() {
        if (mobileBusy) return
        const requestId = ++mobileRequest.current
        setMobileBusy(true); setMobileError(''); setMobileQrError(''); setMobileQr(null); setMobileUrl(''); setMobileOpen(true)
        try {
          const response = await fetch('/tradeloom/mobile-link', { method: 'GET', credentials: 'same-origin' })
          const result = await response.json()
          if (!response.ok || typeof result.url !== 'string') throw new Error()
          if (mobileRequest.current !== requestId) return
          setMobileUrl(result.url)
          try {
            const qr = await loadMobileQr()
            const matrix = qr.createQrMatrix(result.url)
            if (mobileRequest.current === requestId) setMobileQr(matrix)
          } catch {
            if (mobileRequest.current === requestId) setMobileQrError('二维码暂不可用，请复制下方授权链接到手机浏览器打开。')
          }
        } catch {
          if (mobileRequest.current === requestId) setMobileError('暂时无法生成手机连接链接，请确认电脑已连接局域网后重试。')
        } finally {
          if (mobileRequest.current === requestId) setMobileBusy(false)
        }
      }

      function closeMobileLink() {
        mobileRequest.current++
        setMobileOpen(false); setMobileBusy(false); setMobileUrl(''); setMobileQr(null); setMobileQrError(''); setMobileError('')
      }

      async function copyMobileLink() {
        try {
          if (!navigator.clipboard?.writeText) throw new Error()
          await navigator.clipboard.writeText(mobileUrl)
        } catch {
          setMobileError('自动复制不可用，请点按链接并手动复制。')
        }
      }

      function qrPath(matrix) {
        if (!matrix || !Number.isInteger(matrix.size) || matrix.size < 21 || matrix.size > 177
          || !Array.isArray(matrix.modules) || matrix.modules.length !== matrix.size) return ''
        const quietZone = 4
        const segments = []
        for (let row = 0; row < matrix.size; row++) {
          const line = matrix.modules[row]
          if (typeof line !== 'string' || line.length !== matrix.size || !/^[01]+$/.test(line)) return ''
          let col = 0
          while (col < matrix.size) {
            if (line[col] !== '1') { col++; continue }
            const start = col
            while (col < matrix.size && line[col] === '1') col++
            const x = start + quietZone
            const y = row + quietZone
            const width = col - start
            segments.push(`M${x} ${y}h${width}v1h-${width}z`)
          }
        }
        return segments.join('')
      }

      const qrD = qrPath(mobileQr)

      function action(label, onClick, disabled = false) {
        return h('button', { key: label, type: 'button', disabled, onClick: () => {
          onClick()
          setOpen(false)
        } }, label)
      }

      return h('div', { className: 'tl-shell-tools', ref: rootRef },
        h('button', { ref: triggerRef, type: 'button', className: 'tl-shell-tools-trigger', 'aria-label': '打开工具菜单', title: '工具', 'aria-controls': 'tl-shell-tools-menu', 'aria-expanded': open, onClick: () => setOpen(value => !value) }, '⋯'),
        open ? h('div', { id: 'tl-shell-tools-menu', className: 'tl-shell-tools-menu', role: 'group', 'aria-label': '工作台工具' },
          action(sceneApi?.getSnapshot?.()?.configError ? '重试读取场景' : '刷新场景配置', () => { void sceneApi?.retryLoadConfig?.() }),
          action('返回工作台', () => layout?.selectPanel('scene-workbench')),
          action('插件管理', () => layout?.selectPanel('plugins')),
          action('自动化', () => layout?.selectPanel('schedules')),
          action('切换会话侧栏', () => layout?.toggleSidebar?.()),
          action('连接手机', () => { void showMobileLink() })) : null,
        mobileOpen ? h('section', {
          role: 'dialog', 'aria-label': '连接手机', 'aria-modal': 'false',
          className: 'tl-mobile-link-panel',
        },
        h('button', { type: 'button', onClick: closeMobileLink, 'aria-label': '关闭手机连接面板' }, '关闭'),
        h('strong', null, '连接手机'),
        h('ol', null,
          h('li', null, '电脑保持开启。'),
          h('li', null, '手机连接同一 Wi-Fi。'),
          h('li', null, '扫码或复制授权链接，在手机浏览器打开。')),
        mobileBusy ? h('p', { role: 'status' }, '正在生成链接…') : null,
        qrD ? h('div', { className: 'tl-mobile-link-qr-frame' }, h('svg', {
          className: 'tl-mobile-link-qr', viewBox: `0 0 ${mobileQr.size + 8} ${mobileQr.size + 8}`,
          role: 'img', 'aria-label': '手机授权链接二维码', shapeRendering: 'crispEdges',
        }, h('rect', { x: 0, y: 0, width: mobileQr.size + 8, height: mobileQr.size + 8, fill: '#fff' }),
        h('path', { d: qrD, fill: '#000' }))) : null,
        mobileQrError ? h('p', { role: 'status' }, mobileQrError) : null,
        mobileUrl ? h('div', null,
          h('input', { type: 'text', readOnly: true, value: mobileUrl, 'aria-label': '手机授权链接', onFocus: event => event.currentTarget.select() }),
          h('button', { type: 'button', onClick: () => { void copyMobileLink() } }, '复制链接')) : null,
        mobileError ? h('p', { role: 'status' }, mobileError) : null) : null)
    }

    function BusinessMenu(props) {
      const activePanelId = props.usePanelInfo(info => info.activePanelId)

      function navigateScene(sceneId) {
        if (!sceneApi?.navigateScene(sceneId)) layout?.selectPanel('scene-workbench')
      }
      function openCurrentConversation() {
        const current = sceneApi?.getSnapshot?.()
        const role = current?.config && current.activeSceneId ? sceneApi.roleForScene(current.config, current.activeSceneId) : undefined
        const sessionId = role ? current?.sessionBindings?.[role] : undefined
        if (sessionId) uiWorkspace?.openSession(sessionId)
      }

      const sceneState = sceneApi?.getSnapshot?.()
      const currentRole = sceneState?.config && sceneState.activeSceneId
        ? sceneApi.roleForScene(sceneState.config, sceneState.activeSceneId) : undefined
      const currentSessionId = currentRole ? sceneState?.sessionBindings?.[currentRole] : undefined
      const conversationUnavailable = currentSessionId ? '' : '当前助手尚未连接，无法打开对话'

      return h('nav', {
        className: 'tl-navigation',
        'aria-label': '工作场景与业务导航',
      }, h('style', { 'data-tradeloom-nav-style': 'true' }, `
        .tl-shell-top {
          /* Collapsed-sidebar styling can hide this shell slot through inherited visibility. */
          visibility: visible;
          --tl-shell-surface: var(--dsw-alias-bg-layer-1, #ffffff); --tl-shell-soft: var(--dsw-alias-bg-layer-2, #e9eef6); --tl-shell-ink: var(--dsw-alias-label-primary, #202b3a);
          --tl-shell-muted: var(--dsw-alias-label-secondary, #68778c); --tl-shell-line: var(--dsw-alias-border-l1, #cbd5e2); --tl-shell-accent: var(--dsw-alias-brand-primary, #356fc4);
          --tl-shell-accent-strong: #285ca4; --tl-shell-accent-soft: var(--dsw-alias-bg-layer-2, #e5eefb);
          --tl-shell-danger: #ba2121; --tl-shell-danger-bg: #fdecea; --tl-shell-danger-line: #f5c6c6;
        }
        .tl-shell-top.is-dark {
          --tl-shell-surface: var(--dsw-alias-bg-layer-1, #131925); --tl-shell-soft: var(--dsw-alias-bg-layer-2, #171f2c); --tl-shell-ink: var(--dsw-alias-label-primary, #dfe7f3);
          --tl-shell-muted: var(--dsw-alias-label-secondary, #8b97ab); --tl-shell-line: var(--dsw-alias-border-l1, #293345); --tl-shell-accent: var(--dsw-alias-brand-primary, #4d83dd);
          --tl-shell-accent-strong: #6d9cec; --tl-shell-accent-soft: var(--dsw-alias-bg-layer-2, #202e47);
          --tl-shell-danger: #ff8f8f; --tl-shell-danger-bg: #3a2323; --tl-shell-danger-line: #7a3b3b;
        }
        .tl-navigation {
          box-sizing: border-box; display: flex; align-items: center; flex-wrap: nowrap; gap: 5px;
          min-width: 0; min-height: 38px; max-height: 38px; overflow-x: auto; overflow-y: hidden;
          white-space: nowrap; padding: 3px 10px;
          border-bottom: 1px solid var(--tl-shell-line); background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px;
        }
        .tl-top-model-row {
          display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; position: relative;
          padding: 1px 10px; box-sizing: border-box;
        }
        .tl-shell-brand { display:flex; align-items:center; gap:7px; flex:0 0 auto; color:var(--tl-shell-ink); }
        .tl-shell-brand-mark { width:26px; height:26px; }
        .tl-shell-brand > div { line-height:1.05 !important; }
        .tl-shell-brand strong { font-size:13px !important; }
        .tl-shell-brand span { display:none; }
        .tl-top-model-row > :first-child { flex: 0 1 auto; min-width: 0; }
        .tl-shell-tools { margin-inline-start: auto; position: relative; flex: 0 0 auto; }
        .tl-shell-tools-trigger {
          display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 32px;
          border: 1px solid var(--tl-shell-line); border-radius: 6px; background: var(--tl-shell-surface);
          color: var(--tl-shell-ink); font: 20px/1 "Segoe UI", sans-serif; cursor: pointer;
        }
        .tl-shell-tools-trigger:hover, .tl-shell-tools-menu button:hover { background: var(--tl-shell-soft); }
        .tl-shell-tools-trigger:focus-visible, .tl-shell-tools-menu button:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
        .tl-shell-tools-menu {
          position: absolute; z-index: 1000; inset-block-start: calc(100% + 4px); inset-inline-end: 0;
          display: grid; gap: 2px; min-width: 190px; padding: 6px; border: 1px solid var(--tl-shell-line);
          border-radius: 8px; background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          box-shadow: 0 8px 24px rgb(0 0 0 / 16%);
        }
        .tl-shell-tools-menu button {
          min-height: 34px; padding: 6px 9px; border: 0; border-radius: 5px; background: transparent;
          color: inherit; font: inherit; text-align: start; cursor: pointer;
        }
        .tl-mobile-link-panel {
          position: fixed; z-index: 1100; inset-block-start: 78px; inset-inline-end: 12px;
          box-sizing: border-box; display: grid; gap: 9px; width: min(420px, calc(100vw - 24px));
          max-block-size: calc(100vh - 96px); max-block-size: calc(100dvh - 96px); overflow: auto;
          padding: 12px; border: 1px solid var(--tl-shell-line); border-radius: 10px;
          background: var(--tl-shell-surface); color: var(--tl-shell-ink); box-shadow: 0 10px 32px rgb(0 0 0 / 20%);
          font: 13px/1.5 "Segoe UI", "Microsoft YaHei", sans-serif;
        }
        .tl-mobile-link-panel ol { margin: 0; padding-inline-start: 22px; color: var(--tl-shell-muted); }
        .tl-mobile-link-panel input { box-sizing: border-box; width: 100%; min-width: 0; padding: 7px 8px; border: 1px solid var(--tl-shell-line); border-radius: 6px; background: var(--tl-shell-surface); color: var(--tl-shell-ink); font: inherit; }
        .tl-mobile-link-panel button { min-height: 34px; padding: 6px 9px; border: 1px solid var(--tl-shell-line); border-radius: 6px; background: var(--tl-shell-soft); color: var(--tl-shell-ink); font: inherit; cursor: pointer; }
        .tl-mobile-link-panel button:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
        .tl-mobile-link-qr-frame { box-sizing: border-box; width: min(264px, 100%); aspect-ratio: 1; margin-inline: auto; padding: 12px; border: 1px solid #d5d5d5; border-radius: 8px; background: #fff; }
        .tl-mobile-link-qr { display: block; width: 100%; height: 100%; background: #fff; shape-rendering: crispEdges; }
        html[data-meow-smooth-furled] .tl-top-model-row { padding-inline-start: 66px; }
        .tl-navigation .tl-scene-tab { font: inherit; color: inherit; background: transparent; }
        .tl-navigation .tl-conversation-entry {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 30px; padding: 4px 9px;
          border: 1px solid var(--tl-shell-line); border-radius: 5px;
          background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          font: inherit; cursor: pointer;
        }
        .tl-navigation .tl-conversation-entry:hover { background: var(--tl-shell-soft); }
        .tl-navigation .tl-conversation-entry[aria-current="page"] { background: var(--tl-shell-accent-soft); border-color: var(--tl-shell-accent); }
        .tl-navigation .tl-conversation-entry:disabled { opacity: .65; cursor: default; }
        .tl-navigation .tl-conversation-entry:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
      `), h('button', { type: 'button', className: 'tl-conversation-entry', onClick: openCurrentConversation,
        disabled: !currentSessionId, title: currentSessionId ? '打开当前助手的原生对话' : conversationUnavailable,
        'aria-label': currentSessionId ? '打开当前对话' : conversationUnavailable,
        'aria-current': currentSessionId && activePanelId == null ? 'page' : undefined }, currentSessionId ? '对话' : '对话未连接'), props.SceneTabs
        ? h(props.SceneTabs, { onSceneSelect: navigateScene, workbenchActive: activePanelId === 'scene-workbench' })
        : menus.map(([panelKey, label, path]) => h('button', {
        key: panelKey, type: 'button', 'data-business-path': path, onClick: () => {
          if (panelKey === 'business-agent-center') setAgentCenterHref('/business/agent-center')
          if (!sceneApi?.navigateBusiness(path)) layout?.selectPanel('scene-workbench')
        },
        'aria-current': activePanelId === panelKey ? 'page' : undefined,
        style: { flex: '0 0 auto' },
      }, label)),
      null)
    }

    function capabilityPanelPlacement(anchorRect, viewport) {
      const gutter = 8
      const gap = 8
      const viewportWidth = viewport.width
      const viewportHeight = viewport.height
      const viewportLeft = viewport.left
      const viewportTop = viewport.top
      const width = Math.max(0, Math.min(720, viewportWidth - gutter * 2))
      const minLeft = viewportLeft + gutter
      const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - gutter - width)
      const anchor = anchorRect ?? { left: minLeft, top: viewportTop + gutter, bottom: viewportTop + gutter }
      const below = Math.max(0, viewportTop + viewportHeight - anchor.bottom - gutter * 2)
      const above = Math.max(0, anchor.top - viewportTop - gutter * 2)
      const placeBelow = below >= 260 || below >= above
      const availableHeight = placeBelow ? below : above
      const maxHeight = Math.min(680, availableHeight, Math.max(0, viewportHeight - gutter * 2))
      const minTop = viewportTop + gutter
      const maxTop = Math.max(minTop, viewportTop + viewportHeight - gutter - maxHeight)
      const top = placeBelow
        ? Math.min(maxTop, Math.max(minTop, anchor.bottom + gap))
        : Math.min(maxTop, Math.max(minTop, anchor.top - gap - maxHeight))
      const left = Math.min(maxLeft, Math.max(minLeft, Number(anchor.left) || minLeft))
      return { left, top, width, maxHeight }
    }

    function AgentDirectory(props) {
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [capabilityOpen, setCapabilityOpen] = React.useState(false)
      const capabilitySelectorRef = React.useRef(null)
      const capabilityCloseRef = React.useRef(null)
      const capabilityWasOpen = React.useRef(false)
      const [capabilityPanelBounds, setCapabilityPanelBounds] = React.useState(null)
      const [capabilityRole, setCapabilityRole] = React.useState('')
      const capabilityRoleRef = React.useRef(capabilityRole)
      capabilityRoleRef.current = capabilityRole
      const [capabilityInfo, setCapabilityInfo] = React.useState({ status: 'idle', data: null, error: '' })
      const capabilityRequest = React.useRef(0)
      const [capabilityTab, setCapabilityTab] = React.useState('current')
      const [configurationByRole, setConfigurationByRole] = React.useState({})
      const configurationByRoleRef = React.useRef(configurationByRole)
      configurationByRoleRef.current = configurationByRole
      const [skillDirectoryTextByRole, setSkillDirectoryTextByRole] = React.useState({})
      const configurationRequest = React.useRef({})
      const [configurationBusyRole, setConfigurationBusyRole] = React.useState('')
      const configurationSaveFlight = React.useRef(false)
      const [newSessionBusy, setNewSessionBusy] = React.useState(false)
      const newSessionFlight = React.useRef(false)
      const newSessionOperations = React.useRef({})
      const roleMetadata = sceneLoadState.roleMetadata ?? { status: 'idle', error: '', roles: null }
      const roles = roleMetadata.status === 'ready' && Array.isArray(roleMetadata.roles) ? roleMetadata.roles : []
      async function retryRoles() {
        try {
          if (sceneApi) await sceneApi.retryLoadConfig()
          else await loadSceneWorkbench()
          return true
        } catch (cause) {
          if (cause?.message === 'workbench-unavailable') return false
          throw cause
        }
      }
      async function openRole(role) {
        if (busy) return
        setBusy(role); setError('')
        try {
          if (sceneApi) {
            if (!await sceneApi.selectRole(role)) throw new Error('会话暂时无法连接')
          } else {
            const response = await fetch('/tradeloom/session', {
              method: 'POST', credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ role }),
            })
            const result = await response.json()
            if (!response.ok || typeof result.sessionId !== 'string') throw new Error(result.error || '会话暂时无法打开')
            layout?.selectPanel('scene-workbench')
          }
          setMenuOpen(false)
        } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
        finally { setBusy('') }
      }
      function editableConfiguration(result) {
        return {
          mcpServers: (Array.isArray(result.mcpServers) ? result.mcpServers : []).map(server => ({
            ...server,
            ...(server.transport === 'stdio'
              ? { env: Object.fromEntries(Object.entries(server.env ?? {}).map(([name, ref]) => [name, { envName: ref.envName, scheme: ref.scheme }])) }
              : { headers: Object.fromEntries(Object.entries(server.headers ?? {}).map(([name, ref]) => [name, { envName: ref.envName, scheme: ref.scheme }])) }),
          })),
          skill: { includeDefaultRoots: result.skill?.includeDefaultRoots !== false, customSkillDirs: [...(result.skill?.customSkillDirs ?? [])] },
          deniedTools: [...(result.deniedTools ?? [])],
        }
      }
      async function loadSavedConfiguration(role) {
        const requestId = (configurationRequest.current[role] ?? 0) + 1
        configurationRequest.current[role] = requestId
        setConfigurationByRole(previous => ({ ...previous, [role]: {
          ...(previous[role] ?? {}), status: 'loading', error: '',
        } }))
        try {
          const response = await fetch(`/tradeloom/agent-configuration?role=${encodeURIComponent(role)}`, {
            method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' },
          })
          const result = await response.json()
          if (!response.ok || result?.role !== role || typeof result.revision !== 'string'
            || !Array.isArray(result.mcpServers) || !Array.isArray(result.deniedTools) || !result.skill) throw new Error('读不到已保存配置')
          if (configurationRequest.current[role] !== requestId) return
          const fetchedDraft = editableConfiguration(result)
          const currentEntry = configurationByRoleRef.current[role]
          setSkillDirectoryTextByRole(previous => currentEntry?.dirty && Object.hasOwn(previous, role)
            ? previous
            : { ...previous, [role]: fetchedDraft.skill.customSkillDirs.join('\n') })
          setConfigurationByRole(previous => {
            const existing = previous[role]
            return { ...previous, [role]: {
              status: 'ready', saved: { preset: result.preset, revision: result.revision, editable: result.editable === true, mcpServers: result.mcpServers, skill: result.skill, deniedTools: result.deniedTools },
              draft: existing?.dirty ? existing.draft : fetchedDraft,
              dirty: existing?.dirty === true,
              message: existing?.dirty ? existing.message : '',
            } }
          })
        } catch (cause) {
          if (configurationRequest.current[role] === requestId) setConfigurationByRole(previous => ({ ...previous, [role]: {
            ...(previous[role] ?? {}), status: 'error', error: cause instanceof Error ? cause.message : '配置读取失败',
          } }))
        }
      }
      function updateConfiguration(role, transform) {
        setConfigurationByRole(previous => {
          const existing = previous[role]
          if (!existing?.draft || existing.saving) return previous
          const draft = transform(existing.draft)
          return { ...previous, [role]: { ...existing, draft, dirty: true, message: '' } }
        })
      }
      async function saveConfiguration(role) {
        const entry = configurationByRoleRef.current[role]
        if (!entry?.saved?.editable || !entry.draft || entry.saving || configurationBusyRole || configurationSaveFlight.current) return
        const submitted = JSON.parse(JSON.stringify(entry.draft))
        submitted.skill.customSkillDirs = submitted.skill.customSkillDirs.map(value => value.trim()).filter(Boolean)
        configurationSaveFlight.current = true
        setConfigurationBusyRole(role)
        setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], saving: true, message: '' } }))
        try {
          const response = await fetch(`/tradeloom/agent-configuration?role=${encodeURIComponent(role)}`, {
            method: 'PUT', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ expectedRevision: entry.saved.revision, ...submitted }),
          })
          const result = await response.json()
          if (!response.ok || result?.role !== role || result?.preset !== entry.saved.preset
            || typeof result?.revision !== 'string' || result.appliedForNewAgents !== true || result.currentSessionUnchanged !== true) {
            const message = response.status === 409 ? '配置版本已变化；草稿保留，请读取最新版本后再保存。' : '配置保存未确认；草稿已保留。'
            setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], saving: false, message } }))
            return
          }
          setSkillDirectoryTextByRole(previous => ({ ...previous, [role]: submitted.skill.customSkillDirs.join('\n') }))
          setConfigurationByRole(previous => ({ ...previous, [role]: {
            ...previous[role], saving: false, dirty: false, draft: submitted,
            saved: { ...previous[role].saved, revision: result.revision ?? previous[role].saved.revision, editable: true },
            message: '已保存为新会话默认配置；当前会话能力保持不变。保存时可能已连接或启动 MCP 服务。',
          } }))
        } catch {
          setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], saving: false, message: '连接中断；草稿保留，可用相同配置重试。' } }))
        } finally { configurationSaveFlight.current = false; setConfigurationBusyRole('') }
      }
      async function createConfiguredSession(role) {
        if (newSessionFlight.current || !sceneApi) return
        const configState = configurationByRoleRef.current[role]
        if (!configState?.saved?.editable || configState.dirty || configState.saving) {
          setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], message: '请先保存配置，再创建新对话。' } }))
          return
        }
        const currentSessionId = sceneApi.getSnapshot()?.sessionBindings?.[role] ?? null
        let operation = newSessionOperations.current[role]
        const operationStorageKey = `tradeloom:session-create:${role}`
        if (!operation) {
          try {
            const stored = JSON.parse(window.localStorage?.getItem(operationStorageKey) ?? 'null')
            if (stored?.role === role && (stored.expectedSessionId === null || typeof stored.expectedSessionId === 'string')
              && typeof stored.operationId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(stored.operationId)) operation = stored
          } catch { /* Storage can be disabled; the in-memory operation remains available for this view. */ }
        }
        if (!operation) {
          const operationId = window.crypto?.randomUUID?.()
          if (!operationId) {
            setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], message: '当前浏览器无法生成安全操作标识，请重新打开面板后重试。' } }))
            return
          }
          operation = { role, expectedSessionId: currentSessionId, operationId }
          newSessionOperations.current[role] = operation
          try { window.localStorage?.setItem(operationStorageKey, JSON.stringify(operation)) } catch { /* Keep the operation in memory if storage is unavailable. */ }
        }
        newSessionOperations.current[role] = operation
        newSessionFlight.current = true
        setNewSessionBusy(true)
        try {
          const response = await fetch('/tradeloom/session/new', {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ role, expectedSessionId: operation.expectedSessionId, operationId: operation.operationId }),
          })
          const result = await response.json()
          if (!response.ok || result?.role !== role || typeof result.sessionId !== 'string') {
            if (response.status === 409 && result?.error === 'stale-session-binding') {
              delete newSessionOperations.current[role]
              try { window.localStorage?.removeItem(operationStorageKey) } catch { /* The server has confirmed this intent was not accepted. */ }
              setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], message: '助手绑定已变化，请读取最新状态后再创建对话。' } }))
              return
            }
            const message = result?.error === 'session-create-outcome-unknown'
              ? '创建结果尚未确认；旧会话保持不变，系统已保留该操作。请勿另建操作，稍后可用同一操作核对。'
              : response.status === 409
                ? '助手绑定已变化或创建状态待核对；旧会话保持不变，请读取最新状态。'
                : '新对话创建结果尚未确认；旧会话保持不变，操作草稿已保留。'
            setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], message } }))
            return
          }
          let selectedNewSession = false
          if (capabilityRoleRef.current === role) {
            if (!await sceneApi.selectRole(role, result.sessionId)) throw new Error('已创建新会话，但工作台暂时无法切换到它。')
            setCapabilityTab('current')
            await loadCapabilities(role)
            selectedNewSession = true
          } else if (!sceneApi.bindRoleSession?.(role, result.sessionId)) {
            throw new Error('新会话已创建，但角色绑定暂时无法更新。')
          }
          delete newSessionOperations.current[role]
          try { window.localStorage?.removeItem(operationStorageKey) } catch { /* Completed operation remains replayable on the server. */ }
          setConfigurationByRole(previous => ({ ...previous, [role]: {
            ...previous[role], message: selectedNewSession
              ? '已切换到新对话；旧会话仍保留在历史记录中。'
              : '新对话已创建并绑定；你正在查看其他助手，原会话仍保留在历史记录中。',
          } }))
        } catch (cause) {
          setConfigurationByRole(previous => ({ ...previous, [role]: { ...previous[role], message: '连接中断，创建结果尚未确认；旧会话保持不变，系统已保留该操作。请勿另建操作。' } }))
        } finally {
          newSessionFlight.current = false
          setNewSessionBusy(false)
        }
      }
      async function loadCapabilities(role) {
        if (!roles.some(item => item.id === role)) return
        void loadSavedConfiguration(role)
        const requestId = ++capabilityRequest.current
        setCapabilityRole(role)
        setCapabilityInfo({ status: 'loading', data: null, error: '' })
        try {
          const response = await fetch(`/tradeloom/agent-capabilities?role=${encodeURIComponent(role)}`, {
            method: 'GET', credentials: 'same-origin', headers: { accept: 'application/json' },
          })
          const result = await response.json()
          if (!response.ok || result?.role !== role || !['ready', 'not_bound'].includes(result.status)) throw new Error()
          if (capabilityRequest.current === requestId) setCapabilityInfo({ status: 'ready', data: result, error: '' })
        } catch {
          if (capabilityRequest.current === requestId) setCapabilityInfo({ status: 'error', data: null, error: '能力信息暂时无法读取，请重试。' })
        }
      }
      function showCapabilities() {
        const current = sceneApi?.getSnapshot?.()
        const activeScene = current?.config?.scenes?.find(item => item.id === current.activeSceneId)
        const role = current?.roleByScene?.[current.activeSceneId] ?? activeScene?.roleId ?? roles[0]?.id
        setMenuOpen(false)
        setCapabilityOpen(true)
        setCapabilityTab('current')
        void loadCapabilities(role)
      }
      function updateCapabilityPanelBounds() {
        const visualViewport = window.visualViewport
        const viewportWidth = Number(visualViewport?.width) > 0 ? Number(visualViewport.width) : Math.max(0, window.innerWidth || document.documentElement?.clientWidth || 0)
        const viewportHeight = Number(visualViewport?.height) > 0 ? Number(visualViewport.height) : Math.max(0, window.innerHeight || document.documentElement?.clientHeight || 0)
        const viewport = {
          width: viewportWidth,
          height: viewportHeight,
          left: Number(visualViewport?.offsetLeft) || 0,
          top: Number(visualViewport?.offsetTop) || 0,
        }
        const anchorRect = capabilitySelectorRef.current?.getBoundingClientRect?.()
        const bounds = capabilityPanelPlacement(anchorRect, viewport)
        setCapabilityPanelBounds(bounds)
      }
      React.useLayoutEffect(() => {
        if (!capabilityOpen) return undefined
        updateCapabilityPanelBounds()
        if (!capabilityWasOpen.current) capabilityCloseRef.current?.focus?.()
        capabilityWasOpen.current = true
        const viewport = window.visualViewport
        const refreshPlacement = () => updateCapabilityPanelBounds()
        window.addEventListener?.('resize', refreshPlacement)
        window.addEventListener?.('scroll', refreshPlacement, true)
        viewport?.addEventListener?.('resize', refreshPlacement)
        viewport?.addEventListener?.('scroll', refreshPlacement)
        return () => {
          window.removeEventListener?.('resize', refreshPlacement)
          window.removeEventListener?.('scroll', refreshPlacement, true)
          viewport?.removeEventListener?.('resize', refreshPlacement)
          viewport?.removeEventListener?.('scroll', refreshPlacement)
        }
      }, [capabilityOpen])
      React.useEffect(() => {
        if (!capabilityOpen) return undefined
        const handlePanelKeyDown = event => {
          if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing) return
          closeCapabilities()
        }
        window.addEventListener?.('keydown', handlePanelKeyDown)
        return () => window.removeEventListener?.('keydown', handlePanelKeyDown)
      }, [capabilityOpen])
      function closeCapabilities() {
        capabilityRequest.current++
        setCapabilityOpen(false)
        setCapabilityInfo({ status: 'idle', data: null, error: '' })
        capabilityWasOpen.current = false
        capabilitySelectorRef.current?.focus?.()
      }
      const capabilityData = capabilityInfo.data
      const mcpLabels = {
        declared_only: '该预设声明了 MCP 客户端；这不代表当前会话已连接。',
        visible_tool: '当前助手可见 MCP 工具；这不代表服务器健康或已成功调用。',
        not_configured: '该预设未声明 MCP 客户端。',
        unavailable: 'MCP 声明状态暂不可用。',
      }
      const skillItems = capabilityData?.skills?.items
      const toolItems = capabilityData?.tools?.items
      const selectedConfiguration = configurationByRole[capabilityRole]
      function updateServer(role, index, transform) {
        updateConfiguration(role, draft => ({ ...draft, mcpServers: draft.mcpServers.map((server, item) => item === index ? transform(server) : server) }))
      }
      function renderSecretReferences(role, server, index, field, savedServer) {
        const refs = server[field] ?? {}
        const savedRefs = savedServer?.[field] ?? {}
        const rows = Object.entries(refs).map(([name, ref]) => h('div', { key: `${field}-${name}`, className: 'tl-config-secret-ref' },
          h('label', null, field === 'headers' ? '请求头名称' : '环境变量键', h('input', {
            defaultValue: name, disabled: selectedConfiguration?.saving, 'aria-label': `${field === 'headers' ? '请求头' : '环境变量键'} ${index + 1}`,
            onBlur: event => {
              const nextName = event.currentTarget.value.trim()
              if (!nextName || nextName === name) return
              updateServer(role, index, current => {
                if (Object.hasOwn(current[field] ?? {}, nextName)) return current
                const nextRefs = Object.fromEntries(Object.entries(current[field] ?? {}).filter(([key]) => key !== name))
                nextRefs[nextName] = current[field][name]
                return { ...current, [field]: nextRefs }
              })
            },
          })),
          h('label', null, '环境变量名', h('input', {
            value: ref.envName ?? '', disabled: selectedConfiguration?.saving, 'aria-label': `环境变量名 ${index + 1}`,
            onChange: event => updateServer(role, index, current => ({ ...current, [field]: { ...current[field], [name]: { envName: event.target.value, scheme: ref.scheme ?? (field === 'headers' ? 'bearer' : 'raw') } } })),
          })),
          h('label', null, '引用方式', h('select', {
            value: ref.scheme ?? (field === 'headers' ? 'bearer' : 'raw'), disabled: selectedConfiguration?.saving, 'aria-label': `引用方式 ${index + 1}`,
            onChange: event => updateServer(role, index, current => ({ ...current, [field]: { ...current[field], [name]: { envName: ref.envName, scheme: event.target.value } } })),
          }, h('option', { value: 'raw' }, '原值'), h('option', { value: 'bearer' }, 'Bearer 前缀'))),
          h('span', { className: 'tl-config-presence' }, savedRefs[name]?.present === true ? '环境变量已设置' : '环境变量状态未知或未设置'),
          h('button', { type: 'button', disabled: selectedConfiguration?.saving, onClick: () => updateServer(role, index, current => {
            const nextRefs = { ...current[field] }; delete nextRefs[name]; return { ...current, [field]: nextRefs }
          }) }, '移除引用')))
        return h('div', { className: 'tl-config-secret-list' },
          rows,
          h('button', { type: 'button', disabled: selectedConfiguration?.saving, onClick: () => updateServer(role, index, current => {
            const nextRefs = { ...(current[field] ?? {}) }
            const base = field === 'headers' ? 'Authorization' : 'MCP_TOKEN'
            let name = base; let suffix = 2
            while (Object.hasOwn(nextRefs, name)) name = `${base}_${suffix++}`
            nextRefs[name] = { envName: 'TRADELOOM_MCP_TOKEN', scheme: field === 'headers' ? 'bearer' : 'raw' }
            return { ...current, [field]: nextRefs }
          }) }, field === 'headers' ? '添加请求头引用' : '添加环境变量引用'))
      }
      function renderConfigurationEditor() {
        const entry = selectedConfiguration
        if (!entry || entry.status === 'loading') return h('p', { role: 'status' }, '正在读取已保存配置…')
        if (entry.status === 'error') return h('div', { role: 'alert' }, h('p', null, '已保存配置暂时无法读取，未显示或修改本机会话状态。'),
          h('button', { type: 'button', onClick: () => { void loadSavedConfiguration(capabilityRole) } }, '重试读取'))
        if (!entry.saved?.editable || !entry.draft) return h('div', { role: 'status' },
          h('p', null, '当前配置含有不受此编辑器管理的项目，现以只读方式显示。'),
          h('button', { type: 'button', onClick: () => { void loadSavedConfiguration(capabilityRole) } }, '重新读取'))
        const draft = entry.draft
        const savedServers = entry.saved.mcpServers ?? []
        const serverEditors = draft.mcpServers.map((server, index) => {
          const savedServer = savedServers.find(item => item.id === server.id)
          const changeField = (field, value) => updateServer(capabilityRole, index, current => ({ ...current, [field]: value }))
          const inputs = [
            h('label', { key: 'server-name' }, 'MCP 服务名称', h('input', { value: server.serverName ?? '', disabled: entry.saving,
              onChange: event => changeField('serverName', event.target.value) })),
            h('label', { key: 'transport' }, '连接方式', h('select', { value: server.transport, disabled: entry.saving,
              onChange: event => updateServer(capabilityRole, index, current => event.target.value === 'stdio'
                ? { id: current.id, transport: 'stdio', serverName: current.serverName, command: '', args: [], cwd: '', env: {}, toolCallTimeoutMs: 30000, failOnStartupError: false }
                : { id: current.id, transport: 'streamable-http', serverName: current.serverName, url: '', headers: {}, toolCallTimeoutMs: 30000, failOnStartupError: false }) },
            h('option', { value: 'stdio' }, '本机命令（stdio）'), h('option', { value: 'streamable-http' }, 'HTTP（streamable）'))),
          ]
          if (server.transport === 'stdio') {
            inputs.push(h('label', { key: 'command' }, '命令', h('input', { value: server.command ?? '', disabled: entry.saving,
              onChange: event => changeField('command', event.target.value) })))
            inputs.push(h('label', { key: 'args' }, '参数（每行一项）', h('textarea', { value: (server.args ?? []).join('\n'), disabled: entry.saving,
              onChange: event => changeField('args', event.target.value.split('\n')) })))
            inputs.push(h('label', { key: 'cwd' }, '工作目录', h('input', { value: server.cwd ?? '', disabled: entry.saving,
              onChange: event => changeField('cwd', event.target.value) })))
            inputs.push(h('div', { key: 'env' }, h('strong', null, '环境变量引用'), renderSecretReferences(capabilityRole, server, index, 'env', savedServer)))
          } else {
            inputs.push(h('label', { key: 'url' }, '服务 URL', h('input', { value: server.url ?? '', disabled: entry.saving,
              onChange: event => changeField('url', event.target.value) })))
            inputs.push(h('div', { key: 'headers' }, h('strong', null, '请求头引用'), renderSecretReferences(capabilityRole, server, index, 'headers', savedServer)))
          }
          inputs.push(h('label', { key: 'timeout' }, '工具超时（毫秒）', h('input', { type: 'number', min: 1, max: 600000, value: server.toolCallTimeoutMs ?? 30000,
            disabled: entry.saving, onChange: event => changeField('toolCallTimeoutMs', Number(event.target.value)) })))
          inputs.push(h('label', { key: 'failure' }, h('input', { type: 'checkbox', checked: server.failOnStartupError === true, disabled: entry.saving,
            onChange: event => changeField('failOnStartupError', event.target.checked) }), '连接失败时停止启动'))
          return h('details', { key: server.id, className: 'tl-config-server' },
            h('summary', null, `${server.serverName || '未命名 MCP'} · ${server.transport === 'stdio' ? 'stdio' : 'HTTP'}`),
            h('div', { className: 'tl-config-fields' }, ...inputs,
              h('button', { type: 'button', disabled: entry.saving, onClick: () => updateConfiguration(capabilityRole, current => ({ ...current, mcpServers: current.mcpServers.filter((_, item) => item !== index) })) }, '移除服务')))
        })
        const visibleTools = (toolItems ?? []).map(item => item.name).filter(name => typeof name === 'string')
        const knownDenied = [...new Set([...visibleTools, ...draft.deniedTools])]
        return h('div', { key: capabilityRole, className: 'tl-agent-config-editor' },
          h('p', null, '这里编辑的是已保存默认配置；当前运行中的会话继续使用其原有能力。保存可能立即校验并连接 MCP 服务。'),
          entry.message ? h('p', { role: 'status' }, entry.message) : null,
          h('h4', null, 'MCP 服务'),
          serverEditors.length ? serverEditors : h('p', null, '尚未配置本项目管理的 MCP 服务。'),
          h('button', { type: 'button', disabled: entry.saving, onClick: () => updateConfiguration(capabilityRole, current => {
            let index = current.mcpServers.length + 1
            let id = `tradeloom-mcp-server-${index}`
            while (current.mcpServers.some(server => server.id === id)) id = `tradeloom-mcp-server-${++index}`
            return { ...current, mcpServers: [...current.mcpServers, { id, transport: 'streamable-http', serverName: `server-${index}`, url: '', headers: {}, toolCallTimeoutMs: 30000, failOnStartupError: false }] }
          }) }, '添加 MCP 服务'),
          h('h4', null, 'Skill 目录'),
          h('label', null, h('input', { type: 'checkbox', checked: draft.skill.includeDefaultRoots, disabled: entry.saving,
            onChange: event => updateConfiguration(capabilityRole, current => ({ ...current, skill: { ...current.skill, includeDefaultRoots: event.target.checked } })) }), '包含 DSH 默认 Skill 目录'),
          h('label', null, '本项目相对目录（每行一个）', h('textarea', {
            value: skillDirectoryTextByRole[capabilityRole] ?? draft.skill.customSkillDirs.join('\n'), disabled: entry.saving,
            onChange: event => {
              const value = event.target.value
              setSkillDirectoryTextByRole(previous => ({ ...previous, [capabilityRole]: value }))
              updateConfiguration(capabilityRole, current => ({ ...current, skill: { ...current.skill, customSkillDirs: value.split(/\r?\n/) } }))
            } })),
          h('h4', null, '工具限制'),
          knownDenied.length ? h('div', { className: 'tl-config-tool-list' }, knownDenied.map(name => h('label', { key: name },
            h('input', { type: 'checkbox', checked: draft.deniedTools.includes(name), disabled: entry.saving,
              onChange: event => updateConfiguration(capabilityRole, current => ({ ...current,
                deniedTools: event.target.checked ? [...new Set([...current.deniedTools, name])] : current.deniedTools.filter(item => item !== name) })) }),
            name, visibleTools.includes(name) ? '' : ' · 已保存限制（当前不可见）')))
            : h('p', null, '当前能力列表没有可配置的工具限制。'),
          h('div', { className: 'tl-config-actions' },
            h('button', { type: 'button', disabled: entry.saving || !entry.dirty || !entry.saved.editable,
              onClick: () => { void saveConfiguration(capabilityRole) } }, entry.saving ? '保存中…' : '保存默认配置'),
            h('button', { type: 'button', disabled: entry.saving || configurationBusyRole !== '',
              onClick: () => { void loadSavedConfiguration(capabilityRole) } }, '读取最新配置'),
            h('button', { type: 'button', disabled: newSessionBusy || entry.dirty || entry.saving || !sceneApi,
              onClick: () => { void createConfiguredSession(capabilityRole) } }, newSessionBusy ? '创建中…' : '用已保存配置新建对话'))
        )
      }
      function renderCapabilityPanel() {
        if (!capabilityOpen) return null
        const content = [
          h('label', { key: 'role-label' }, '查看助手 ', h('select', {
            value: capabilityRole,
            onChange: event => { void loadCapabilities(event.target.value) },
            'aria-label': '选择要查看能力的助手',
          }, roles.map(({ id, label }) => h('option', { key: id, value: id }, label)))),
          h('div', { key: 'tabs', className: 'tl-capability-tabs', role: 'group', 'aria-label': '助手面板内容' },
            h('button', { type: 'button', 'aria-pressed': capabilityTab === 'current', onClick: () => setCapabilityTab('current') }, '当前能力'),
            h('button', { type: 'button', 'aria-pressed': capabilityTab === 'configuration', onClick: () => setCapabilityTab('configuration') }, '已保存配置')),
        ]
        if (capabilityTab === 'configuration') {
          content.push(renderConfigurationEditor())
        } else {
          if (capabilityInfo.status === 'loading') content.push(h('p', { key: 'loading', role: 'status' }, '正在读取当前助手能力…'))
          if (capabilityInfo.status === 'error') content.push(h('div', { key: 'error', role: 'alert' },
            h('p', null, capabilityInfo.error),
            h('button', { type: 'button', onClick: () => { void loadCapabilities(capabilityRole) } }, '重试')))
          if (capabilityData?.status === 'not_bound') {
            content.push(h('p', { key: 'not-bound', role: 'status' }, '该助手当前没有已绑定的原生会话，工具与 Skill 能力未知。'))
            content.push(h('h4', { key: 'mcp-title' }, 'MCP'))
            content.push(h('p', { key: 'mcp-status' }, mcpLabels[capabilityData.mcp?.status] ?? mcpLabels.unavailable))
          }
          if (capabilityData?.status === 'ready') {
            content.push(h('h4', { key: 'mcp-title' }, 'MCP'))
            content.push(h('p', { key: 'mcp-status' }, mcpLabels[capabilityData.mcp?.status] ?? mcpLabels.unavailable))
            if (capabilityData.mcp?.visibleTools?.length) content.push(h('ul', { key: 'mcp-tools', 'aria-label': '当前可见 MCP 工具' },
              capabilityData.mcp.visibleTools.map(name => h('li', { key: name }, name))))
            content.push(h('h4', { key: 'tools-title' }, '工具'))
            content.push(capabilityData.tools?.status === 'available'
              ? (toolItems?.length
                ? h('ul', { key: 'tools', 'aria-label': '当前助手可见工具' }, toolItems.map(item => h('li', { key: item.name }, item.name)))
                : h('p', { key: 'tools-empty' }, '当前助手没有已列出的工具。'))
              : h('p', { key: 'tools-unavailable' }, '工具目录暂不可用。'))
            if (capabilityData.tools?.truncated) content.push(h('p', { key: 'tools-truncated' }, `工具列表已截断，当前共 ${capabilityData.tools.total} 项。`))
            content.push(h('h4', { key: 'skills-title' }, 'Skill'))
            content.push(capabilityData.skills?.status === 'available'
              ? (skillItems?.length
                ? h('ul', { key: 'skills', 'aria-label': '当前助手范围内的 Skill' }, skillItems.map(item => h('li', { key: item.name },
                  h('strong', null, item.name), item.description ? ` — ${item.description}` : '',
                  h('small', { style: { display: 'block', color: 'var(--tl-shell-muted)' } }, `${item.source} · 模型调用${item.invocation?.modelInvocable ? '可用' : '不可用'} · 用户调用${item.invocation?.userInvocable ? '可用' : '不可用'}`))))
                : h('p', { key: 'skills-empty' }, '当前助手范围内没有已列出的 Skill。'))
              : h('p', { key: 'skills-unavailable' }, 'Skill 目录暂不可用。'))
            if (capabilityData.skills?.truncated || capabilityData.skills?.complete === false) {
              content.push(h('p', { key: 'skills-incomplete' }, `Skill 列表不完整${Number.isInteger(capabilityData.skills.total) ? `，当前共 ${capabilityData.skills.total} 项` : ''}。`))
            }
          }
          content.push(h('div', { key: 'actions', className: 'tl-capability-actions' },
            capabilityInfo.status === 'ready' ? h('button', { type: 'button', onClick: () => { void loadCapabilities(capabilityRole) } }, '重新读取') : null))
        }
        const visualViewport = window.visualViewport
        const bounds = capabilityPanelBounds ?? capabilityPanelPlacement(null, {
          width: Number(visualViewport?.width) > 0 ? Number(visualViewport.width) : window.innerWidth || 0,
          height: Number(visualViewport?.height) > 0 ? Number(visualViewport.height) : window.innerHeight || 0,
          left: Number(visualViewport?.offsetLeft) || 0,
          top: Number(visualViewport?.offsetTop) || 0,
        })
        const panel = h('section', {
          className: `tl-agent-capabilities tl-shell-top is-${activeColorScheme}`, role: 'dialog', 'aria-modal': 'false',
          'aria-labelledby': 'tl-agent-capabilities-title',
          style: { position: 'fixed', left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, maxHeight: `${bounds.maxHeight}px` },
        },
        h('header', { className: 'tl-agent-capabilities-header' },
          h('h3', { id: 'tl-agent-capabilities-title' }, '助手能力与配置'),
          h('button', { ref: capabilityCloseRef, type: 'button', 'aria-label': '关闭助手能力与配置', onClick: closeCapabilities }, '关闭')),
        h('div', { className: 'tl-agent-capabilities-body', style: { minHeight: 0, overflowY: 'auto', flex: '1 1 auto' } }, ...content))
        return ReactDOM.createPortal(panel, window.document.body)
      }
      return h('section', { className: 'tl-agent-directory', 'aria-label': '助手选择' },
        h('style', { 'data-tradeloom-agent-style': 'true' }, `
          .tl-agent-directory {
            position: relative; flex: 0 0 auto;
            color: var(--tl-shell-ink);
            font-family: "Segoe UI", "Microsoft YaHei", sans-serif;
            font-size: 13px;
          }
          .tl-agent-selector { position: relative; }
          .tl-agent-selector > summary {
            display: inline-flex; align-items: center; min-height: 30px; padding: 3px 10px;
            border: 1px solid var(--tl-shell-line); border-radius: 5px;
            background: var(--tl-shell-surface); color: inherit; font: inherit;
            cursor: pointer; list-style: none; white-space: nowrap;
          }
          .tl-agent-selector > summary::-webkit-details-marker { display: none; }
          .tl-agent-selector > summary:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
          .tl-agent-selector[open] > summary { background: var(--tl-shell-soft); }
          .tl-agent-menu {
            position: absolute; top: calc(100% + 5px); left: 0; z-index: 60;
            display: grid; gap: 3px; min-width: 170px; padding: 5px;
            border: 1px solid var(--tl-shell-line); border-radius: 6px;
            background: var(--tl-shell-surface); color: inherit;
            box-shadow: 0 8px 22px rgba(0,0,0,.16);
          }
          .tl-agent-directory button, .tl-agent-capabilities button {
            font: inherit;
            color: inherit;
            min-height: 32px;
            text-align: left;
            padding: 6px 10px;
            border: 1px solid transparent;
            border-radius: 5px;
            background: transparent;
            cursor: pointer;
            overflow: hidden;
            text-overflow: ellipsis;
            white-space: nowrap;
          }
          .tl-agent-directory button:hover:not(:disabled), .tl-agent-capabilities button:hover:not(:disabled) {
            background: var(--tl-shell-soft);
          }
          .tl-agent-directory button:focus-visible, .tl-agent-capabilities button:focus-visible {
            outline: 2px solid var(--tl-shell-accent);
            outline-offset: 2px;
          }
          .tl-agent-directory button:disabled, .tl-agent-capabilities button:disabled { cursor: wait; opacity: .7; }
          .tl-agent-menu button { width: 100%; }
          .tl-agent-capabilities { z-index: 70; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; padding: 0; border: 1px solid var(--tl-shell-line); border-radius: 8px; background: var(--tl-shell-surface); color: var(--tl-shell-ink); box-shadow: 0 8px 22px rgba(0,0,0,.16); white-space: normal; font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px; }
          .tl-agent-capabilities-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--tl-shell-line); background: var(--tl-shell-surface); }
          .tl-agent-capabilities-header h3 { min-width: 0; margin: 0; font-size: 14px; }
          .tl-agent-capabilities-body { padding: 10px 14px 14px; }
          .tl-agent-capabilities p { margin: 6px 0; color: var(--tl-shell-muted); font-size: 12px; line-height: 1.45; }
          .tl-agent-capabilities select { max-width: 100%; min-height: 30px; font: inherit; color: inherit; background: var(--tl-shell-surface); border: 1px solid var(--tl-shell-line); border-radius: 5px; }
          .tl-agent-capabilities ul { padding-left: 18px; margin: 6px 0 10px; }
          .tl-agent-capabilities li { margin: 4px 0; overflow-wrap: anywhere; font-size: 12px; }
          .tl-agent-capabilities .tl-capability-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
          .tl-agent-capabilities .tl-capability-tabs, .tl-agent-capabilities .tl-config-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
          .tl-agent-capabilities .tl-config-server { margin: 7px 0; padding: 7px 9px; border: 1px solid var(--tl-shell-line); border-radius: 6px; }
          .tl-agent-capabilities .tl-config-server summary { cursor: pointer; font-weight: 600; }
          .tl-agent-capabilities .tl-config-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: 8px; margin-top: 8px; }
          .tl-agent-capabilities label { display: grid; gap: 4px; margin: 6px 0; overflow-wrap: anywhere; }
          .tl-agent-capabilities input:not([type=checkbox]), .tl-agent-capabilities textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: 32px; padding: 6px 8px; border: 1px solid var(--tl-shell-line); border-radius: 5px; color: var(--tl-shell-ink); background: var(--tl-shell-surface); font: inherit; }
          .tl-agent-capabilities textarea { min-height: 58px; resize: vertical; }
          .tl-agent-capabilities .tl-config-secret-ref { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px; padding: 7px 0; border-top: 1px solid var(--tl-shell-line); }
          .tl-agent-capabilities .tl-config-presence { align-self: end; color: var(--tl-shell-muted); font-size: 12px; }
          .tl-agent-capabilities .tl-config-tool-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 2px 8px; }
          @media (max-width: 520px) { .tl-agent-capabilities .tl-config-secret-ref { grid-template-columns: minmax(0, 1fr); } }
        `),
        h('details', {
          className: 'tl-agent-selector', open: menuOpen,
          onToggle: event => setMenuOpen(Boolean(event.currentTarget.open)),
        },
        h('summary', { ref: capabilitySelectorRef, 'aria-label': '选择助手', onClick: event => {
          event.preventDefault()
          setMenuOpen(open => !open)
        } }, '选择助手'),
        h('div', { className: 'tl-agent-menu', role: 'group', 'aria-label': '可用助手' }, roles.length
          ? roles.map(({ id, label }) => h('button', {
            key: id, type: 'button', disabled: busy !== '' || id === busy,
            onClick: () => { void openRole(id) },
            'aria-label': label,
          }, busy === id ? `${label}…` : label))
          : h('p', { role: 'status', style: { margin: 4, color: 'var(--tl-shell-muted)', fontSize: 12 } },
            roleMetadata.status === 'error' ? roleMetadata.error : '正在读取助手列表…'),
        h('button', { type: 'button', disabled: roles.length === 0, onClick: showCapabilities }, '查看 MCP 与 Skill 能力'))),
        roleMetadata.status === 'error' ? h('div', { role: 'alert', className: 'tl-agent-load-error' },
          h('span', null, roleMetadata.error),
          h('button', { type: 'button', onClick: retryRoles }, '重试助手列表')) : null,
        error ? h('p', { role: 'status', style: { color: 'var(--tl-shell-danger, #b42318)', fontSize: 12 } }, error) : null,
        renderCapabilityPanel())
    }

    function businessPanel(label, path, panelKey) {
      return function BusinessPanel() {
        const [src, setSrc] = React.useState(() => panelKey === 'business-agent-center' ? agentCenterHref : `/business${path}`)
        React.useEffect(() => {
          if (panelKey !== 'business-agent-center') return undefined
          const listener = href => setSrc(href)
          agentCenterHrefListeners.add(listener)
          return () => agentCenterHrefListeners.delete(listener)
        }, [])
        return h('section', { 'data-business-path': path, style: { width: '100%', height: '100%', minHeight: '70vh' } },
          h('iframe', {
            'data-tradeloom-business-frame': 'true',
            title: `织贸助手 · ${label}`,
            src,
            style: { display: 'block', width: '100%', height: '100%', minHeight: '70vh', border: 0 },
          }))
      }
    }

    function TradeLoomMark(props = {}) {
      const size = Number.isFinite(props.size) ? props.size : 32
      return h('svg', {
        viewBox: '0 0 1024 1024', width: size, height: size, role: 'img',
        'aria-label': 'TradeLoom', focusable: 'false',
        ...(typeof props.className === 'string' ? { className: props.className } : {}),
        ...(props.style && typeof props.style === 'object' ? { style: props.style } : {}),
      },
      h('rect', { x: 32, y: 32, width: 960, height: 960, rx: 256, fill: '#F7FAFA', stroke: '#D9E5E5', strokeWidth: 24 }),
      h('path', { d: 'M224 384h150c82 0 82 128 164 128s82 128 164 128h98', fill: 'none', stroke: '#F7FAFA', strokeWidth: 204, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M384 224v150c0 82 128 82 128 164s128 82 128 164v98', fill: 'none', stroke: '#F7FAFA', strokeWidth: 204, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M224 384h150c82 0 82 128 164 128s82 128 164 128h98', fill: 'none', stroke: '#263D70', strokeWidth: 160, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M384 224v150c0 82 128 82 128 164s128 82 128 164v98', fill: 'none', stroke: '#0B6B67', strokeWidth: 160, strokeLinecap: 'round', strokeLinejoin: 'round' }),
      h('path', { d: 'M512 434v156', stroke: '#F7FAFA', strokeWidth: 30, strokeLinecap: 'round' }))
    }

    function TradeLoomWordmark() {
      return h('div', { style: { display: 'flex', flexDirection: 'column', lineHeight: 1.15, color: 'inherit' } },
        h('strong', { style: { fontSize: 14, fontWeight: 650, letterSpacing: '0.02em' } }, '织贸助手'),
        h('span', { style: { marginTop: 2, fontSize: 10, fontWeight: 600, letterSpacing: '0.08em', opacity: 0.72 } }, 'TradeLoom'))
    }

    return {
      inject: ['slots', 'layout', 'uiWorkspace', 'sessions', 'modelDirectories', 'remote', 'remote.session', 'theme'],
      async apply(ctx) {
        layout = ctx.layout
        uiWorkspace = ctx.uiWorkspace
        installBusinessThemeBridge(ctx)
        ctx.slots.inject('shell.top', () => ctx.slots.register({ name: 'shell.top' }, SceneTopNavigation))
        ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, TradeLoomMark))
        ctx.slots.inject('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name' }, TradeLoomWordmark))
        ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({ name: 'conversation.hero.brand.mark' }, TradeLoomMark))
        for (const [panelKey, label, path] of menus) {
          ctx.slots.inject('main', () => ctx.slots.register({
            name: 'main', key: panelKey, inject: () => ({})
          }, businessPanel(label, path, panelKey)))
        }
        await loadSceneWorkbench(ctx)
      },
    }
  },
})
