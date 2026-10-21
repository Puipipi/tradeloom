window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  factory(require) {
    const React = require('react')
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
    let removeThemeBridge
    let agentCenterHref = '/business/agent-center'
    let removeProposalHandoff
    const agentCenterHrefListeners = new Set()

    function businessFrames() {
      return [...(window.document?.querySelectorAll?.('iframe[data-tradeloom-business-frame]') ?? [])]
    }

    function sendBusinessTheme(frame) {
      if (!frame?.contentWindow || !['light', 'dark'].includes(activeColorScheme)) return
      try {
        frame.contentWindow.postMessage({ type: 'tradeloom:theme', colorScheme: activeColorScheme }, window.location.origin)
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
      React.useEffect(() => {
        const listener = () => setState(sceneLoadState)
        sceneLoadListeners.add(listener)
        return () => sceneLoadListeners.delete(listener)
      }, [])
      return h('div', { className: `tl-shell-top is-${state.colorScheme ?? activeColorScheme}` },
        h('div', { className: 'tl-top-model-row' },
          h(AgentDirectory, { compact: true }),
          state.ModelDirectoryRail ? h(state.ModelDirectoryRail) : null),
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
          sceneWorkbench.register(ctx, setTrustedBusinessOrigin, roleMetadata => publishSceneLoadState({ roleMetadata }))
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

    function BusinessMenu(props) {
      const activePanelId = props.usePanelInfo(info => info.activePanelId)
      const [mobileOpen, setMobileOpen] = React.useState(false)
      const [mobileUrl, setMobileUrl] = React.useState('')
      const [mobileBusy, setMobileBusy] = React.useState(false)
      const [mobileError, setMobileError] = React.useState('')
      const mobileRequest = React.useRef(0)

      async function showMobileLink() {
        if (mobileBusy) return
        const requestId = ++mobileRequest.current
        setMobileBusy(true); setMobileError(''); setMobileUrl(''); setMobileOpen(true)
        try {
          const response = await fetch('/tradeloom/mobile-link', { method: 'GET', credentials: 'same-origin' })
          const result = await response.json()
          if (!response.ok || typeof result.url !== 'string') throw new Error()
          if (mobileRequest.current === requestId) setMobileUrl(result.url)
        } catch {
          if (mobileRequest.current === requestId) setMobileError('暂时无法生成手机连接链接，请确认电脑已连接局域网后重试。')
        } finally {
          if (mobileRequest.current === requestId) setMobileBusy(false)
        }
      }

      function closeMobileLink() {
        mobileRequest.current++
        setMobileOpen(false); setMobileBusy(false); setMobileUrl(''); setMobileError('')
      }

      async function copyMobileLink() {
        try {
          if (!navigator.clipboard?.writeText) throw new Error()
          await navigator.clipboard.writeText(mobileUrl)
        } catch {
          setMobileError('自动复制不可用，请点按链接并手动复制。')
        }
      }

      function navigateScene(sceneId) {
        if (!sceneApi?.navigateScene(sceneId)) layout?.selectPanel('scene-workbench')
      }

      return h('nav', {
        className: 'tl-navigation',
        'aria-label': '工作场景与业务导航',
      }, h('style', { 'data-tradeloom-nav-style': 'true' }, `
        .tl-shell-top {
          --tl-shell-surface: #fff; --tl-shell-soft: #f5f5f7; --tl-shell-ink: #1d1d1f;
          --tl-shell-muted: #6e6e73; --tl-shell-line: #d2d2d7; --tl-shell-accent: #0e73d8;
          --tl-shell-accent-strong: #0d6ece; --tl-shell-accent-soft: #e8f1fd;
          --tl-shell-danger: #ba2121; --tl-shell-danger-bg: #fdecea; --tl-shell-danger-line: #f5c6c6;
        }
        .tl-shell-top.is-dark {
          --tl-shell-surface: #1c1c1e; --tl-shell-soft: #2c2c2e; --tl-shell-ink: #f5f5f7;
          --tl-shell-muted: #a1a1a6; --tl-shell-line: #3a3a3c; --tl-shell-accent: #1985f0;
          --tl-shell-accent-strong: #499ef3; --tl-shell-accent-soft: #1e3a5f;
          --tl-shell-danger: #ff8f8f; --tl-shell-danger-bg: #3a2323; --tl-shell-danger-line: #7a3b3b;
        }
        .tl-navigation {
          display: flex; align-items: center; flex-wrap: nowrap; gap: 5px;
          min-width: 0; max-height: 42px; overflow-x: auto; overflow-y: hidden;
          white-space: nowrap; padding: 4px 10px;
          border-bottom: 1px solid var(--tl-shell-line); background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          font-family: "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 13px;
        }
        .tl-top-model-row {
          display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0;
          padding: 3px 10px; box-sizing: border-box;
        }
        .tl-navigation .tl-scene-tab { font: inherit; color: inherit; background: transparent; }
        .tl-navigation > button:not(.tl-scene-tab) {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: 30px; padding: 4px 9px;
          border: 1px solid var(--tl-shell-line); border-radius: 5px;
          background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          font: inherit; cursor: pointer;
        }
        .tl-navigation > button:not(.tl-scene-tab):hover { background: var(--tl-shell-soft); }
        .tl-navigation > button:not(.tl-scene-tab):focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
      `), props.SceneTabs
        ? h(props.SceneTabs, { onSceneSelect: navigateScene })
        : menus.map(([panelKey, label, path]) => h('button', {
        key: panelKey, type: 'button', 'data-business-path': path, onClick: () => {
          if (panelKey === 'business-agent-center') setAgentCenterHref('/business/agent-center')
          if (!sceneApi?.navigateBusiness(path)) layout?.selectPanel('scene-workbench')
        },
        'aria-current': activePanelId === panelKey ? 'page' : undefined,
        style: { flex: '0 0 auto' },
      }, label)),
      h('button', {
        key: 'mobile-link', type: 'button', onClick: () => { void showMobileLink() },
        style: { flex: '0 0 auto' },
      }, '连接手机'),
      mobileOpen ? h('section', {
        key: 'mobile-link-panel', role: 'dialog', 'aria-label': '连接手机', 'aria-modal': 'false',
        style: { position: 'fixed', zIndex: 1000, top: 56, right: 12, width: 'min(420px, calc(100vw - 24px))', padding: 16, border: '1px solid var(--tl-shell-line)', borderRadius: 12, background: 'var(--tl-shell-surface)', color: 'var(--tl-shell-ink)', boxShadow: '0 8px 24px rgba(0,0,0,.16)', whiteSpace: 'normal' },
      },
      h('button', { type: 'button', onClick: closeMobileLink, 'aria-label': '关闭手机连接面板', style: { float: 'right' } }, '关闭'),
      h('strong', null, '连接手机'),
      h('ol', { style: { paddingLeft: 20 } },
        h('li', null, '电脑保持开启。'),
        h('li', null, '手机连接同一 Wi-Fi。'),
        h('li', null, '复制授权链接，在手机浏览器打开。')),
      mobileBusy ? h('p', { role: 'status' }, '正在生成链接…') : null,
      mobileUrl ? h('div', null,
        h('input', { type: 'text', readOnly: true, value: mobileUrl, 'aria-label': '手机授权链接', onFocus: event => event.currentTarget.select(), style: { width: '100%', boxSizing: 'border-box', margin: '8px 0' } }),
        h('button', { type: 'button', onClick: () => { void copyMobileLink() } }, '复制链接')) : null,
      mobileError ? h('p', { role: 'status', style: { color: 'var(--tl-shell-danger)', fontSize: 12 } }, mobileError) : null) : null)
    }

    function AgentDirectory(props) {
      const [busy, setBusy] = React.useState('')
      const [error, setError] = React.useState('')
      const [menuOpen, setMenuOpen] = React.useState(false)
      const [capabilityOpen, setCapabilityOpen] = React.useState(false)
      const [capabilityRole, setCapabilityRole] = React.useState('')
      const [capabilityInfo, setCapabilityInfo] = React.useState({ status: 'idle', data: null, error: '' })
      const capabilityRequest = React.useRef(0)
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
      async function loadCapabilities(role) {
        if (!roles.some(item => item.id === role)) return
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
        void loadCapabilities(role)
      }
      function closeCapabilities() {
        capabilityRequest.current++
        setCapabilityOpen(false)
        setCapabilityInfo({ status: 'idle', data: null, error: '' })
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
      function renderCapabilityPanel() {
        if (!capabilityOpen) return null
        const content = [
          h('h3', { key: 'title' }, '当前助手可见能力'),
          h('label', { key: 'role-label' }, '查看助手 ', h('select', {
            value: capabilityRole,
            onChange: event => { void loadCapabilities(event.target.value) },
            'aria-label': '选择要查看能力的助手',
          }, roles.map(({ id, label }) => h('option', { key: id, value: id }, label)))),
        ]
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
          capabilityInfo.status === 'ready' ? h('button', { type: 'button', onClick: () => { void loadCapabilities(capabilityRole) } }, '重新读取') : null,
          h('button', { type: 'button', onClick: closeCapabilities }, '关闭')))
        return h('section', { className: 'tl-agent-capabilities', role: 'dialog', 'aria-label': 'MCP 与 Skill 能力', 'aria-modal': 'false' }, ...content)
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
          .tl-agent-directory button {
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
          .tl-agent-directory button:hover:not(:disabled) {
            background: var(--tl-shell-soft);
          }
          .tl-agent-directory button:focus-visible {
            outline: 2px solid var(--tl-shell-accent);
            outline-offset: 2px;
          }
          .tl-agent-directory button:disabled { cursor: wait; opacity: .7; }
          .tl-agent-menu button { width: 100%; }
          .tl-agent-capabilities { position: absolute; top: calc(100% + 5px); left: 0; z-index: 70; width: min(380px, calc(100vw - 24px)); max-height: min(70vh, 560px); overflow: auto; box-sizing: border-box; padding: 12px; border: 1px solid var(--tl-shell-line); border-radius: 8px; background: var(--tl-shell-surface); color: var(--tl-shell-ink); box-shadow: 0 8px 22px rgba(0,0,0,.16); white-space: normal; }
          .tl-agent-capabilities h3 { margin: 0 0 8px; font-size: 14px; }
          .tl-agent-capabilities p { margin: 6px 0; color: var(--tl-shell-muted); font-size: 12px; line-height: 1.45; }
          .tl-agent-capabilities select { max-width: 100%; min-height: 30px; font: inherit; color: inherit; background: var(--tl-shell-surface); border: 1px solid var(--tl-shell-line); border-radius: 5px; }
          .tl-agent-capabilities ul { padding-left: 18px; margin: 6px 0 10px; }
          .tl-agent-capabilities li { margin: 4px 0; overflow-wrap: anywhere; font-size: 12px; }
          .tl-agent-capabilities .tl-capability-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
        `),
        h('details', {
          className: 'tl-agent-selector', open: menuOpen,
          onToggle: event => setMenuOpen(Boolean(event.currentTarget.open)),
        },
        h('summary', { 'aria-label': '选择助手', onClick: event => {
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
