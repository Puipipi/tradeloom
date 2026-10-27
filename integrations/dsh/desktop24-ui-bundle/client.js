window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement
    const workspaceModalLocks = new WeakMap()
    function workspaceModalState() {
      const overlayHost = window.document.querySelector('[data-shell-overlay]')
      const frame = overlayHost?.parentElement
      return { frame, state: frame ? workspaceModalLocks.get(frame) : undefined }
    }
    function activeTopbarPopover() {
      return window.document.querySelector('[data-tl-topbar-popover-open]')
    }
    function requestTopbarPopoverDismissal() {
      window.document.dispatchEvent(new window.CustomEvent('tl-shell-dismiss-topbar-popover'))
    }
    function WorkspaceModalLayer({ children, onClose }) {
      const [bounds, setBounds] = React.useState(null)
      const layerRef = React.useRef(null)
      const ownerRef = React.useRef({})
      const ownerFrameRef = React.useRef(null)
      const closeRef = React.useRef(onClose)
      closeRef.current = onClose
      React.useLayoutEffect(() => {
        const overlayHost = window.document.querySelector('[data-shell-overlay]')
        const frame = overlayHost?.parentElement
        if (!frame) return undefined
        ownerFrameRef.current = frame
        let lock = workspaceModalLocks.get(frame)
        if (!lock) {
          const branches = [...frame.children].filter(node => node !== overlayHost && !node.matches('[data-shell-top],[data-shell-bottom],[data-shell-titlebar],[data-shell-leading]'))
          lock = { owners: [], previous: branches.map(node => ({ node, had: node.hasAttribute('inert'), value: node.getAttribute('inert') })) }
          workspaceModalLocks.set(frame, lock)
          for (const item of lock.previous) item.node.setAttribute('inert', '')
        }
        lock.owners.push(ownerRef.current)
        const measure = () => {
          const top = [...frame.children].find(node => node.matches('[data-shell-top]'))?.getBoundingClientRect()
          const bottom = [...frame.children].find(node => node.matches('[data-shell-bottom]'))?.getBoundingClientRect()
          const rect = frame.getBoundingClientRect()
          const y1 = top?.bottom ?? rect.top
          const y2 = bottom?.top ?? rect.bottom
          setBounds({ left: rect.left, top: y1, width: rect.width, height: Math.max(0, y2 - y1) })
        }
        measure()
        window.addEventListener('resize', measure)
        window.addEventListener('scroll', measure, true)
        window.visualViewport?.addEventListener('resize', measure)
        const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(measure) : null
        observer?.observe(frame)
        const topNode = [...frame.children].find(node => node.matches('[data-shell-top]'))
        const bottomNode = [...frame.children].find(node => node.matches('[data-shell-bottom]'))
        if (topNode) observer?.observe(topNode)
        if (bottomNode) observer?.observe(bottomNode)
        return () => {
          observer?.disconnect(); window.removeEventListener('resize', measure); window.removeEventListener('scroll', measure, true)
          window.visualViewport?.removeEventListener('resize', measure)
          const ownerIndex = lock.owners.lastIndexOf(ownerRef.current)
          if (ownerIndex >= 0) lock.owners.splice(ownerIndex, 1)
          if (!lock.owners.length) {
            for (const item of lock.previous) { if (item.had) item.node.setAttribute('inert', item.value ?? ''); else item.node.removeAttribute('inert') }
            workspaceModalLocks.delete(frame)
          }
        }
      }, [])
      React.useEffect(() => {
        const layer = layerRef.current
        const panel = layer?.querySelector('[role="dialog"]')
        if (panel && !panel.hasAttribute('tabindex')) panel.tabIndex = -1
        const focusable = () => [...(panel?.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])') ?? [])]
          .filter(node => {
            if (node.closest('[hidden],[inert]') || node.getAttribute('aria-hidden') === 'true' || node.matches(':disabled')) return false
            const closedDetails = node.closest('details:not([open])')
            if (closedDetails && !node.matches('summary') && !node.closest('summary')) return false
            const style = window.getComputedStyle?.(node)
            return Boolean(node.getClientRects?.().length) && style?.visibility !== 'hidden' && style?.display !== 'none'
          })
        focusable()[0]?.focus?.()
        if (!focusable().length) panel?.focus?.()
        const keydown = event => {
          if (event.defaultPrevented) return
          const { frame: currentFrame, state } = workspaceModalState()
          if (currentFrame !== ownerFrameRef.current || state?.owners.at(-1) !== ownerRef.current) return
          const popover = activeTopbarPopover()
          if (popover && event.key === 'Escape') {
            event.preventDefault()
            event.stopImmediatePropagation?.()
            requestTopbarPopoverDismissal()
            return
          }
          if (popover && event.key === 'Tab') {
            const items = [...popover.querySelectorAll('button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),summary,[tabindex]:not([tabindex="-1"])')]
              .filter(node => {
                if (node.closest('[hidden],[inert]') || node.getAttribute('aria-hidden') === 'true' || node.matches(':disabled')) return false
                const closedDetails = node.closest('details:not([open])')
                if (closedDetails && !node.matches('summary') && !node.closest('summary')) return false
                const style = window.getComputedStyle?.(node)
                return Boolean(node.getClientRects?.().length) && style?.visibility !== 'hidden' && style?.display !== 'none'
              })
            if (!items.length) {
              event.preventDefault()
              if (!popover.hasAttribute('tabindex')) popover.tabIndex = -1
              popover.focus?.()
              return
            }
            const first = items[0], last = items.at(-1)
            if (!popover.contains(document.activeElement)) {
              event.preventDefault()
              ;(event.shiftKey ? last : first).focus()
              return
            }
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
            return
          }
          if (event.key === 'Escape') { event.preventDefault(); closeRef.current(); return }
          if (event.key !== 'Tab') return
          const items = focusable()
          if (!items.length) { event.preventDefault(); panel?.focus?.(); return }
          const first = items[0], last = items.at(-1)
          if (event.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { event.preventDefault(); first.focus() }
        }
        document.addEventListener('keydown', keydown)
        return () => document.removeEventListener('keydown', keydown)
      }, [])
      const rect = bounds ?? { left: 0, top: 0, width: window.innerWidth || 0, height: window.innerHeight || 0 }
      return ReactDOM.createPortal(h('div', { ref: layerRef, className: 'tl-workspace-modal-backdrop', onMouseDown: event => {
        if (event.target !== event.currentTarget) return
        if (activeTopbarPopover()) {
          event.preventDefault()
          requestTopbarPopoverDismissal()
          return
        }
        event.preventDefault()
        closeRef.current()
      }, style: { position: 'fixed', zIndex: 2000, left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px`, display: 'grid', placeItems: 'center', background: 'rgb(0 0 0 / 42%)', backdropFilter: 'blur(3px)' } }, children), window.document.body)
    }
    const menus = [
      ['business-home', '总览', '/home'],
      ['business-products', '商品', '/products'],
      ['business-agent-center', '工作流', '/agent-center'],
      ['business-artifacts', '资料', '/artifacts'],
      ['business-runs', '运行记录', '/runs'],
    ]
    let layout
    let uiWorkspace
    let shellSlots
    let shellPluginInventory
    let shellLocale
    let sceneLoadState = {
      loading: false, error: '', SceneTabs: null, AIWebRail: null,
      roleMetadata: { status: 'idle', error: '', roles: null },
    }
    const sceneLoadListeners = new Set()
    let sceneLoadRequest
    let sceneContext
    let sceneApi
    let sceneWorkbenchSelected = false
    let trustedBusinessOrigin = ''
    let activeColorScheme = 'light'
    const themeAliasNames = Object.freeze({
      canvas: '--dsw-alias-bg-base', panel: '--dsw-alias-bg-layer-1', header: '--dsw-alias-bg-layer-2',
      border: '--dsw-alias-border-l1', text: '--dsw-alias-label-primary', muted: '--dsw-alias-label-secondary',
      accent: '--dsw-alias-brand-primary',
    })
    const workbenchPalette = Object.freeze({
      canvas: { light: '#f4f6f8', dark: '#0c0e14' }, panel: { light: '#ffffff', dark: '#12151e' },
      header: { light: '#eef0f2', dark: '#1b2130' }, border: { light: '#d5d9de', dark: '#282e3c' },
      text: { light: '#202326', dark: '#e6e8ef' }, muted: { light: '#687078', dark: '#939baa' },
      accent: { light: '#3979a8', dark: '#6b9bf5' }, accentStrong: { light: '#2d638d', dark: '#88afff' },
      accentSoft: { light: '#e8f1f6', dark: '#202b40' }, teal: { light: '#177d78', dark: '#74cec6' },
      buttonInk: { light: '#ffffff', dark: '#10131b' },
      danger: { light: '#ba2121', dark: '#ed7373' }, dangerBackground: { light: '#fdecea', dark: '#392729' },
      dangerBorder: { light: '#f5c6c6', dark: '#623c42' }, warning: { light: '#76501b', dark: '#d6ad5b' },
      warningBackground: { light: '#fffaf2', dark: '#302a20' }, warningBorder: { light: '#eed8b7', dark: '#5a4b32' },
      success: { light: '#0f635a', dark: '#39d5a1' }, successBackground: { light: '#e1f2ef', dark: '#1e3735' },
    })
    const workbenchScrollbarStyles = `
      html[data-tradeloom-ui] { --tl-scrollbar-size:5px; }
      html[data-tradeloom-ui] body, html[data-tradeloom-ui] body * {
        scrollbar-width:auto; scrollbar-color:auto;
      }
      html[data-tradeloom-ui] body::-webkit-scrollbar, html[data-tradeloom-ui] body *::-webkit-scrollbar { width:var(--tl-scrollbar-size); height:var(--tl-scrollbar-size); }
      html[data-tradeloom-ui] body::-webkit-scrollbar-thumb, html[data-tradeloom-ui] body *::-webkit-scrollbar-thumb { border:0; border-radius:999px; background:color-mix(in srgb,var(--tl-theme-muted) 55%,transparent); }
      html[data-tradeloom-ui] body::-webkit-scrollbar-thumb:hover, html[data-tradeloom-ui] body *::-webkit-scrollbar-thumb:hover { background:var(--tl-theme-muted); }
      html[data-tradeloom-ui] body::-webkit-scrollbar-track, html[data-tradeloom-ui] body *::-webkit-scrollbar-track,
      html[data-tradeloom-ui] body::-webkit-scrollbar-corner, html[data-tradeloom-ui] body *::-webkit-scrollbar-corner { background:transparent; }
      html[data-tradeloom-ui] :is([data-conversation-scroll],[role="tree"],[role="listbox"],.tl-agent-capabilities-body,.tl-session-usage-list,.tl-model-options,.tl-layout-menu-popover) { min-width:0; scrollbar-gutter:stable; }
    `
    const DEFAULT_WORKBENCH_FONT_BODY = 14
    const workbenchUiTokens = { fontFamily: '"Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif', fontBody: DEFAULT_WORKBENCH_FONT_BODY, fontCompact: DEFAULT_WORKBENCH_FONT_BODY - 2, lineHeight: 1.45,
      topRowHeight: 48, navHeight: 38, modelControl: 31, sceneTabHeight: 28, dockTabHeight: 28, controlHeight: 28, toolbarHeight: 30, iconSize: 15, cornerRadius: 8,
    }
    let activeResolvedPalette = null
    let removeThemeBridge
    let shellThemeService
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
      const local = [...(window.document?.querySelectorAll?.('iframe[data-tradeloom-business-frame]') ?? [])]
      return [...local, ...(sceneApi?.getPopoutBusinessFrames?.() ?? [])]
    }

    function handleBusinessPopoutFramesChange() {
      for (const frame of businessFrames()) sendBusinessTheme(frame)
    }

    function normalizeThemeColor(value, background = '') {
      const color = String(value ?? '').trim()
      let match = /^#([\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.exec(color)
      if (match) {
        let hex = match[1]
        if (hex.length === 3 || hex.length === 4) hex = [...hex].map(char => char + char).join('')
        const alpha = hex.length === 8 ? parseInt(hex.slice(6), 16) / 255 : 1
        if (alpha < 1) return compositeColor(`#${hex.slice(0, 6).toLowerCase()}`, alpha, background)
        return `#${hex.slice(0, 6).toLowerCase()}`
      }
      match = /^rgba?\((.*)\)$/i.exec(color)
      if (!match) return ''
      const parts = match[1].replace(/,/g, ' ').replace('/', ' ').trim().split(/\s+/)
      if (parts.length < 3 || parts.length > 4) return ''
      const channels = parts.slice(0, 3).map(part => {
        const value = Number.parseFloat(part)
        if (!Number.isFinite(value)) return NaN
        return part.endsWith('%') ? value * 255 / 100 : value
      })
      if (channels.some(part => !Number.isFinite(part) || part < 0 || part > 255)) return ''
      const alphaPart = parts[3]
      const alpha = alphaPart === undefined ? 1 : alphaPart.endsWith('%')
        ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart)
      if (!Number.isFinite(alpha) || alpha < 0 || alpha > 1) return ''
      if (alpha === 1) {
        const rounded = channels.map(Math.round)
        if (rounded.some(channel => !Number.isInteger(channel) || channel < 0 || channel > 255)) return ''
        return `#${rounded.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
      }
      return compositeColor(channels, alpha, background)
    }

    function compositeColor(foreground, alpha, background) {
      const backgroundMatch = /^#([\da-f]{6})$/i.exec(background ?? '')
      if (!backgroundMatch) return ''
      const foregroundChannels = Array.isArray(foreground)
        ? foreground : foreground.slice(1).match(/.{2}/g).map(part => parseInt(part, 16))
      const backgroundChannels = backgroundMatch[1].match(/.{2}/g).map(part => parseInt(part, 16))
      return `#${foregroundChannels.map((part, index) => Math.round(part * alpha + backgroundChannels[index] * (1 - alpha)).toString(16).padStart(2, '0')).join('')}`
    }

    function resolveWorkbenchPalette() {
      const probe = window.document?.querySelector?.('.tl-shell-top') ?? window.document?.body ?? window.document?.documentElement
      const computed = probe && window.getComputedStyle?.(probe)
      const resolved = Object.fromEntries(Object.entries(workbenchPalette).map(([key, modes]) => [key, modes[activeColorScheme]]))
      if (!computed) {
        resolved.accentStrong = resolved.accent
        resolved.accentSoft = compositeColor(resolved.accent, 0.12, resolved.panel) || workbenchPalette.accentSoft[activeColorScheme]
        resolved.teal = workbenchPalette.teal[activeColorScheme]
        return resolved
      }
      for (const [key, alias] of Object.entries(themeAliasNames)) {
        const background = resolved.panel ?? resolved.canvas
        const aliasValue = String(computed.getPropertyValue(alias) ?? '').trim()
        let value = normalizeThemeColor(aliasValue, background)
        if (aliasValue && !value && probe?.appendChild && window.document?.createElement) {
          const swatch = window.document.createElement('span')
          swatch.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none'
          swatch.style.color = `var(${alias})`
          probe.appendChild(swatch)
          value = normalizeThemeColor(window.getComputedStyle(swatch).color, background)
          swatch.remove?.()
        }
        if (!/^#[\da-f]{6}$/i.test(value)) value = ''
        resolved[key] = value || workbenchPalette[key][activeColorScheme]
      }
      resolved.accentStrong = resolved.accent
      resolved.accentSoft = compositeColor(resolved.accent, 0.12, resolved.panel) || workbenchPalette.accentSoft[activeColorScheme]
      resolved.teal = workbenchPalette.teal[activeColorScheme]
      for (const [key, modes] of Object.entries(workbenchPalette)) {
        if (Object.hasOwn(themeAliasNames, key) || ['accentStrong', 'accentSoft', 'teal'].includes(key)) continue
        resolved[key] = modes[activeColorScheme]
      }
      return resolved
    }

    function applyThemeTokensToDocument(palette = activeResolvedPalette) {
      const rootStyle = window.document?.documentElement?.style
      if (!palette || typeof rootStyle?.setProperty !== 'function') return
      window.document.documentElement?.setAttribute?.('data-tradeloom-ui', 'true')
      const paletteVariables = {
        canvas: 'canvas', panel: 'panel', header: 'header', border: 'border', buttonInk: 'button-ink',
        text: 'text', muted: 'muted', accent: 'accent', accentStrong: 'accent-strong', accentSoft: 'accent-soft',
        danger: 'danger', dangerBackground: 'danger-bg', dangerBorder: 'danger-border', warning: 'warning',
        warningBackground: 'warning-bg', warningBorder: 'warning-border', success: 'success',
        successBackground: 'success-bg', teal: 'teal',
      }
      for (const [key, suffix] of Object.entries(paletteVariables)) rootStyle.setProperty(`--tl-theme-${suffix}`, palette[key])
      rootStyle.setProperty('--tl-shell-surface', palette.panel)
      rootStyle.setProperty('--tl-shell-soft', palette.header)
      rootStyle.setProperty('--tl-shell-ink', palette.text)
      rootStyle.setProperty('--tl-shell-muted', palette.muted)
      rootStyle.setProperty('--tl-shell-line', palette.border)
      rootStyle.setProperty('--tl-shell-accent', palette.accent)
      rootStyle.setProperty('--tl-shell-accent-strong', palette.accentStrong)
      rootStyle.setProperty('--tl-shell-accent-soft', palette.accentSoft)
      rootStyle.setProperty('--tl-shell-danger', palette.danger)
      const uiVariables = {
        '--tl-font-family': workbenchUiTokens.fontFamily, '--tl-font-body': `${workbenchUiTokens.fontBody}px`,
        '--tl-font-compact': `${workbenchUiTokens.fontCompact}px`, '--tl-line-height': String(workbenchUiTokens.lineHeight),
        '--tl-ui-scale': String(workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY),
        '--tl-space-1': `${Math.round(4 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-2': `${Math.round(6 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-3': `${Math.round(8 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-4': `${Math.round(10 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-5': `${Math.round(12 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-row-height': `${workbenchUiTokens.topRowHeight}px`, '--tl-nav-height': `${workbenchUiTokens.navHeight}px`,
        '--tl-control-height': `${workbenchUiTokens.controlHeight}px`, '--tl-model-size': `${workbenchUiTokens.modelControl}px`,
        '--tl-scene-tab-height': `${workbenchUiTokens.sceneTabHeight}px`, '--tl-dock-tab-height': `${workbenchUiTokens.dockTabHeight}px`,
        '--tl-toolbar-height': `${workbenchUiTokens.toolbarHeight}px`, '--tl-icon-size': `${workbenchUiTokens.iconSize}px`,
        '--tl-corner-radius': `${workbenchUiTokens.cornerRadius}px`,
      }
      for (const [name, value] of Object.entries(uiVariables)) rootStyle.setProperty(name, value)
    }

    function refreshThemeSnapshot(colorScheme = activeColorScheme) {
      activeColorScheme = colorScheme
      syncWorkbenchFontSize(shellThemeService?.getTheme?.())
      activeResolvedPalette = resolveWorkbenchPalette()
      applyThemeTokensToDocument()
      publishSceneLoadState({ colorScheme, fontBody: workbenchUiTokens.fontBody })
      for (const frame of businessFrames()) sendBusinessTheme(frame)
    }

    function syncWorkbenchFontSize(themeSnapshot) {
      const configured = themeSnapshot?.fontSizes?.text
      const fontBody = Number.isInteger(configured) && configured >= 10 && configured <= 22
        ? configured : DEFAULT_WORKBENCH_FONT_BODY
      const scale = fontBody / DEFAULT_WORKBENCH_FONT_BODY
      const scaled = (base, min, max) => Math.min(max, Math.max(min, Math.round(base * scale)))
      workbenchUiTokens.fontBody = fontBody
      workbenchUiTokens.fontCompact = Math.max(10, fontBody - 2)
      workbenchUiTokens.topRowHeight = scaled(48, 16, 96)
      workbenchUiTokens.navHeight = scaled(38, 16, 96)
      workbenchUiTokens.modelControl = scaled(31, 16, 96)
      workbenchUiTokens.sceneTabHeight = scaled(28, 16, 96)
      workbenchUiTokens.dockTabHeight = scaled(28, 16, 96)
      workbenchUiTokens.controlHeight = scaled(28, 16, 96)
      workbenchUiTokens.toolbarHeight = scaled(30, 16, 96)
      workbenchUiTokens.iconSize = scaled(15, 8, 32)
      workbenchUiTokens.cornerRadius = scaled(8, 0, 16)
    }

    function sendBusinessTheme(frame) {
      if (!frame?.contentWindow || !['light', 'dark'].includes(activeColorScheme)) return
      try {
        const palette = activeResolvedPalette = resolveWorkbenchPalette()
        if (!palette) return
        applyThemeTokensToDocument(palette)
        frame.contentWindow.postMessage({ type: 'tradeloom:theme', colorScheme: activeColorScheme, palette, ui: workbenchUiTokens }, window.location.origin)
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
      shellThemeService = ctx.theme
      activeColorScheme = ctx.theme?.getTheme?.()?.active?.colorScheme === 'dark' ? 'dark' : 'light'
      syncWorkbenchFontSize(ctx.theme?.getTheme?.())
      activeResolvedPalette = resolveWorkbenchPalette()
      applyThemeTokensToDocument()
      publishSceneLoadState({ colorScheme: activeColorScheme, fontBody: workbenchUiTokens.fontBody })
      window.addEventListener?.('message', handleBusinessThemeRequest)
      window.addEventListener?.('tradeloom:business-popout-frames-change', handleBusinessPopoutFramesChange)
      window.document?.addEventListener?.('load', handleBusinessFrameLoad, true)
      const onThemeChange = theme => {
        const snapshot = theme ?? ctx.theme?.getTheme?.()
        const colorScheme = snapshot?.active?.colorScheme ?? ctx.theme?.getTheme?.()?.active?.colorScheme
        if (colorScheme !== 'light' && colorScheme !== 'dark') return
        // Popout listeners resolve this palette during the same event. Publish
        // the resolved scheme before they read it, without moving DOM writes.
        activeColorScheme = colorScheme
        // The scene chunk subscribes to the same event and publishes a snapshot
        // synchronously. Update the shared UI tokens first so its immediate
        // render cannot capture the previous density. Palette work remains on
        // the next frame to avoid changing the color-token update cadence.
        syncWorkbenchFontSize(snapshot)
        if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => refreshThemeSnapshot(colorScheme))
        else Promise.resolve().then(() => refreshThemeSnapshot(colorScheme))
      }
      const removeThemeChangeListener = ctx.on?.('theme/change', onThemeChange)
      removeThemeBridge = () => {
        window.removeEventListener?.('message', handleBusinessThemeRequest)
        window.removeEventListener?.('tradeloom:business-popout-frames-change', handleBusinessPopoutFramesChange)
        window.document?.removeEventListener?.('load', handleBusinessFrameLoad, true)
        removeThemeChangeListener?.()
      }
      ctx.effect?.(() => () => removeThemeBridge?.(), 'tradeloom business iframe theme bridge')
      for (const frame of businessFrames()) sendBusinessTheme(frame)
      if (typeof window.requestAnimationFrame === 'function') window.requestAnimationFrame(() => refreshThemeSnapshot(activeColorScheme))
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
        if (url.origin !== origin || url.search || url.username || url.password) return ''
        const task = /^\/business\/workflow-tasks\/([^/]+)$/.exec(url.pathname)
        if (task) {
          // Django's <str:workflow_id> accepts one nonempty segment, not only UUIDs.
          const taskId = decodeURIComponent(task[1])
          if (!taskId || taskId.includes('/') || taskId.includes('\\')) return ''
          if (url.hash && !['#workflow-plan', '#workflow-overview'].includes(url.hash)
            && !/^#review-[A-Za-z0-9_-]+$/.test(url.hash)) return ''
          return `${url.pathname}${url.hash}`
        }
        if (url.pathname !== '/business/agent-center') return ''
        if (['#workflow-create-form', '#workflow-list-heading'].includes(url.hash)) return `${url.pathname}${url.hash}`
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

    function NativeWindowsMenuSlot() {
      const slotRef = React.useRef(null)
      React.useEffect(() => {
        const slot = slotRef.current
        const body = window.document?.body
        const Observer = window.MutationObserver
        if (!slot || !body || typeof Observer !== 'function') return undefined
        let host
        let originalParent
        let originalNextSibling
        const styleProperties = ['position', 'top', 'left', 'right', 'height', 'width', 'flex', 'z-index']
        let originalStyle
        const placeMenu = () => {
          const menuHost = window.document.querySelector('[data-windows-menu]')
          if (!menuHost || menuHost.parentElement === slot) return
          if (!host) {
            host = menuHost
            originalParent = host.parentNode
            originalNextSibling = host.nextSibling
            originalStyle = Object.fromEntries(styleProperties.map(name => [name, [host.style.getPropertyValue(name), host.style.getPropertyPriority(name)]]))
          }
          slot.append(host)
          for (const [name, value] of Object.entries({
            position: 'relative', top: 'auto', left: 'auto', right: 'auto', height: '100%', width: 'max-content', flex: '0 0 auto', 'z-index': '40',
          })) host.style.setProperty(name, value, 'important')
        }
        placeMenu()
        const observer = new Observer(placeMenu)
        observer.observe(body, { childList: true, subtree: true })
        return () => {
          observer.disconnect()
          if (host && originalParent?.isConnected) {
            if (originalNextSibling?.parentNode === originalParent) originalParent.insertBefore(host, originalNextSibling)
            else originalParent.append(host)
          }
          if (host && originalStyle) {
            for (const [name, [value, priority]] of Object.entries(originalStyle)) {
              if (value) host.style.setProperty(name, value, priority)
              else host.style.removeProperty(name)
            }
          }
        }
      }, [])
      return h('div', { ref: slotRef, className: 'tl-native-menu-slot' })
    }

    function SceneTopNavigation(props) {
      const [state, setState] = React.useState(sceneLoadState)
      const activePanelId = props.usePanelInfo?.(info => info.activePanelId)
      const resolvedPalette = activeResolvedPalette ?? resolveWorkbenchPalette()
      if (resolvedPalette) activeResolvedPalette = resolvedPalette
      React.useEffect(() => {
        const listener = () => setState(sceneLoadState)
        sceneLoadListeners.add(listener)
        const unsubscribeSnapshot = state.SceneTabs && typeof sceneApi?.subscribe === 'function'
          ? sceneApi.subscribe(() => setState(current => {
            const previous = current ?? sceneLoadState
            return { ...previous, snapshotRevision: (previous.snapshotRevision ?? 0) + 1 }
          }))
          : undefined
        return () => { sceneLoadListeners.delete(listener); unsubscribeSnapshot?.() }
      }, [state.SceneTabs])
      return h('div', { className: `tl-shell-top is-${state.colorScheme ?? activeColorScheme}`, style: {
        '--tl-font-family': workbenchUiTokens.fontFamily, '--tl-font-body': `${workbenchUiTokens.fontBody}px`,
        '--tl-font-compact': `${workbenchUiTokens.fontCompact}px`, '--tl-line-height': String(workbenchUiTokens.lineHeight),
        '--tl-ui-scale': String(workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY),
        '--tl-space-1': `${Math.round(4 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-2': `${Math.round(6 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-3': `${Math.round(8 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-4': `${Math.round(10 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-space-5': `${Math.round(12 * workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY)}px`,
        '--tl-row-height': `${workbenchUiTokens.topRowHeight}px`, '--tl-nav-height': `${workbenchUiTokens.navHeight}px`,
        '--tl-control-height': `${workbenchUiTokens.controlHeight}px`, '--tl-model-size': `${workbenchUiTokens.modelControl}px`,
        '--tl-scene-tab-height': `${workbenchUiTokens.sceneTabHeight}px`, '--tl-dock-tab-height': `${workbenchUiTokens.dockTabHeight}px`,
        '--tl-toolbar-height': `${workbenchUiTokens.toolbarHeight}px`, '--tl-icon-size': `${workbenchUiTokens.iconSize}px`,
        '--tl-corner-radius': `${workbenchUiTokens.cornerRadius}px`,
        '--tl-theme-canvas': resolvedPalette?.canvas, '--tl-theme-panel': resolvedPalette?.panel,
        '--tl-theme-header': resolvedPalette?.header, '--tl-theme-border': resolvedPalette?.border,
        '--tl-theme-button-ink': resolvedPalette?.buttonInk,
        '--tl-theme-text': resolvedPalette?.text, '--tl-theme-muted': resolvedPalette?.muted,
        '--tl-theme-accent': resolvedPalette?.accent, '--tl-theme-accent-strong': resolvedPalette?.accentStrong,
        '--tl-theme-accent-soft': resolvedPalette?.accentSoft, '--tl-theme-danger': resolvedPalette?.danger,
        '--tl-theme-danger-bg': resolvedPalette?.dangerBackground, '--tl-theme-danger-border': resolvedPalette?.dangerBorder,
        '--tl-theme-warning': resolvedPalette?.warning, '--tl-theme-warning-bg': resolvedPalette?.warningBackground,
        '--tl-theme-warning-border': resolvedPalette?.warningBorder, '--tl-theme-success': resolvedPalette?.success,
        '--tl-theme-success-bg': resolvedPalette?.successBackground,
      } },
        h('style', { 'data-tradeloom-scrollbars': 'true' }, workbenchScrollbarStyles),
        h('div', { className: 'tl-top-model-row' },
          h('div', { className: 'tl-shell-brand' }, h(TradeLoomMark, { className: 'tl-shell-brand-mark' }), h(TradeLoomWordmark)),
          h(NativeWindowsMenuSlot),
          h(AgentDirectory, { compact: true }),
          state.AIWebRail ? h(state.AIWebRail) : null,
          h(ShellToolsMenu)),
        h(BusinessMenu, { ...props, SceneTabs: state.SceneTabs }),
        state.loading ? h('p', { role: 'status', style: { margin: '0 12px 6px' } }, '正在加载工作场景…') : null,
        state.error ? h('div', { role: 'alert', style: { display: 'flex', alignItems: 'center', gap: 'var(--tl-space-2)', padding: 'var(--tl-space-1) var(--tl-space-3)' } },
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
          sceneWorkbench.register(ctx, setTrustedBusinessOrigin, roleMetadata => publishSceneLoadState({ roleMetadata }), resolveWorkbenchPalette, workbenchUiTokens)
          sceneApi = sceneWorkbench
          if (!sceneWorkbenchSelected) {
            ctx.layout?.selectPanel('scene-workbench')
            sceneWorkbenchSelected = true
          }
          publishSceneLoadState({ SceneTabs: sceneWorkbench.SceneTabs, AIWebRail: sceneWorkbench.AIWebRail, loading: false, error: '' })
          return true
        })
        .catch(() => {
          publishSceneLoadState({ loading: false, error: '工作场景暂时无法加载。' })
          return false
        })
        .finally(() => { sceneLoadRequest = undefined })
      return sceneLoadRequest
    }

    function PluginInventoryOverview({ onClose }) {
      const [revision, setRevision] = React.useState(0)
      const [inventory, setInventory] = React.useState({ status: 'loading' })
      React.useEffect(() => {
        let current = true
        setInventory({ status: 'loading' })
        if (typeof shellPluginInventory?.list !== 'function') {
          setInventory({ status: 'unavailable' })
          return undefined
        }
        Promise.resolve().then(() => shellPluginInventory.list()).then(result => {
          if (!current) return
          if (!result?.ok || !Array.isArray(result.value?.entries)) {
            setInventory({ status: 'error' })
            return
          }
          setInventory({ status: 'ready', snapshot: result.value })
        }).catch(() => { if (current) setInventory({ status: 'error' }) })
        return () => { current = false }
      }, [revision])
      const text = value => {
        if (typeof value === 'string') return value
        if (value && typeof value === 'object') return shellLocale?.resolveText?.(value) || value.zh || value.en || ''
        return ''
      }
      const phases = { pending: '等待加载', loading: '加载中', active: '已加载', failed: '加载失败', unloading: '卸载中' }
      const row = (entry, index) => h('article', { key: `${entry.entryId ?? entry.moduleName}:${index}`, className: 'tl-plugin-inventory-row' },
        h('div', { className: 'tl-plugin-inventory-name' },
          h('strong', null, text(entry.meta?.title) || entry.moduleName || '名称未知'),
          h('span', { className: 'tl-plugin-inventory-version' }, '版本未知')),
        text(entry.meta?.description) ? h('details', { className: 'tl-plugin-inventory-description' },
          h('summary', { 'aria-label': `展开或收起${text(entry.meta?.title) || entry.moduleName || '插件'}的说明` },
            h('span', { className: 'tl-plugin-description-preview' }, text(entry.meta.description)),
            h('span', { className: 'tl-plugin-description-more' }, '展开说明'),
            h('span', { className: 'tl-plugin-description-less' }, '收起说明')),
          h('p', null, text(entry.meta.description))) : h('p', { className: 'tl-plugin-inventory-description' }, '描述未知'),
        h('code', { title: entry.moduleName }, entry.moduleName || '模块未知'),
        h('div', { className: 'tl-plugin-inventory-state' },
          h('span', { 'data-enabled': String(entry.enabled) }, entry.enabled === true ? '已启用' : entry.enabled === false ? '已停用' : entry.enabled === 'conditional' ? '按条件启用' : '启用状态未知'),
          h('span', { 'data-phase': entry.fiberPhase ?? 'unobserved' }, entry.fiberPhase == null ? '运行状态未观测' : phases[entry.fiberPhase] || `未知状态（${entry.fiberPhase}）`)))
      const snapshot = inventory.snapshot
      return h('section', { id: 'tl-plugin-inventory-panel', className: `tl-plugin-inventory-panel tl-shell-top is-${activeColorScheme}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': '插件概览' },
        h('style', { 'data-tradeloom-plugin-inventory-style': true }, `
          .tl-plugin-inventory-panel { position:relative; display:flex; flex-direction:column; box-sizing:border-box; width:min(calc(560px * var(--tl-ui-scale,1)),calc(100% - var(--tl-space-5) * 2)); max-height:calc(100% - var(--tl-space-5) * 2); padding:var(--tl-space-3); gap:var(--tl-space-2); overflow:hidden; border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); background:var(--tl-shell-surface); color:var(--tl-shell-ink); box-shadow:0 8px 24px rgb(0 0 0 / 20%); font:var(--tl-font-compact)/1.45 var(--tl-font-family); }
          .tl-plugin-inventory-panel header,.tl-plugin-inventory-panel footer { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:var(--tl-space-2); flex:none; }
          .tl-plugin-inventory-panel button { font:inherit; color:inherit; background:var(--tl-shell-soft); border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); padding:var(--tl-space-1) var(--tl-space-2); min-height:var(--tl-control-height); cursor:pointer; }
          .tl-plugin-inventory-panel button:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:-2px; }
          .tl-plugin-inventory-note { margin:0; color:var(--tl-shell-muted); overflow-wrap:anywhere; }
          .tl-plugin-inventory-list { min-height:0; overflow:auto; scrollbar-gutter:stable; display:grid; gap:var(--tl-space-2); }
          .tl-plugin-inventory-row { min-width:0; display:grid; gap:var(--tl-space-1); padding:var(--tl-space-2); border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); overflow-wrap:anywhere; }
          .tl-plugin-inventory-name,.tl-plugin-inventory-state { display:flex; flex-wrap:wrap; align-items:baseline; gap:var(--tl-space-2); }
          .tl-plugin-inventory-name strong { flex:1; min-width:0; }
          .tl-plugin-inventory-version,.tl-plugin-inventory-row code { color:var(--tl-shell-muted); font:inherit; }
          .tl-plugin-inventory-description { margin:0; }
          .tl-plugin-inventory-description summary { cursor:pointer; list-style:none; }
          .tl-plugin-inventory-description summary::-webkit-details-marker { display:none; }
          .tl-plugin-inventory-description summary:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:2px; }
          .tl-plugin-description-preview { display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden; }
          .tl-plugin-description-more,.tl-plugin-description-less { color:var(--tl-shell-accent); }
          .tl-plugin-description-less,.tl-plugin-inventory-description[open] .tl-plugin-description-preview,.tl-plugin-inventory-description[open] .tl-plugin-description-more { display:none; }
          .tl-plugin-inventory-description[open] .tl-plugin-description-less { display:inline; }
          .tl-plugin-inventory-description p { margin:var(--tl-space-1) 0 0; }
          .tl-plugin-inventory-state { color:var(--tl-shell-muted); }
          .tl-plugin-inventory-state [data-enabled="true"] { color:var(--tl-theme-success,var(--tl-shell-ink)); }
          .tl-plugin-inventory-state [data-phase="failed"] { color:var(--tl-theme-danger,var(--tl-shell-ink)); }
          .tl-plugin-inventory-presets { min-width:0; }
          .tl-plugin-inventory-presets summary { cursor:pointer; padding:var(--tl-space-1) 0; overflow-wrap:anywhere; }
        `),
        h('header', null, h('strong', null, '插件概览'), h('button', { type: 'button', onClick: onClose, 'aria-label': '关闭插件概览' }, '×')),
        h('p', { className: 'tl-plugin-inventory-note' }, '当前配置条目与预设组合；不代表全部下载包或 MCP 连接。版本信息尚未提供。'),
        h('div', { className: 'tl-plugin-inventory-list', 'aria-busy': inventory.status === 'loading' },
          inventory.status === 'loading' ? h('p', { role: 'status' }, '正在读取插件清单…') : null,
          inventory.status === 'error' ? h('p', { role: 'alert' }, '插件清单读取失败，请重试。') : null,
          inventory.status === 'unavailable' ? h('p', { role: 'status' }, '插件清单服务暂不可用。') : null,
          snapshot ? h(React.Fragment, null,
            h('p', { className: 'tl-plugin-inventory-note' }, `当前配置 · ${snapshot.entries.length} 条`),
            snapshot.entries.length ? snapshot.entries.map(row) : h('p', null, '当前配置没有插件条目。'),
            (snapshot.agentPresets ?? []).map(preset => h('details', { key: preset.id, className: 'tl-plugin-inventory-presets' },
              h('summary', null, `${preset.name || preset.id}${preset.isDefault ? ' · 默认预设' : ''} · ${preset.rows?.length ?? 0} 条`),
              preset.broken ? h('p', { role: 'status' }, '预设组合暂不可读取。') : (preset.rows ?? []).map(row)))) : null),
        h('footer', null, h('button', { type: 'button', disabled: inventory.status === 'loading', onClick: () => setRevision(value => value + 1) }, '刷新清单'),
          h('button', { type: 'button', onClick: () => { onClose(); layout?.selectPanel('plugins') } }, '完整插件管理')))
    }

    function ShellToolsMenu() {
      const [, refreshNativeEntries] = React.useState(0)
      React.useEffect(() => shellSlots?.subscribe?.('sidebar.settings', () => refreshNativeEntries(value => value + 1)), [])
      const settingsEntry = shellSlots?.entries?.('sidebar.settings')?.find(entry => typeof entry.store?.create === 'function')
      const openNativeSettings = () => {
        const store = settingsEntry?.store.create()
        if (store?.getSnapshot?.().open) store.actions.close()
        else store?.actions.open()
      }
      const themeSnapshot = shellThemeService?.getTheme?.()
      const themePreferences = ['system', ...(themeSnapshot?.themes ?? []).map(theme => theme.id)]
      const cycleTheme = () => {
        const current = shellThemeService.getTheme().preference ?? 'system'
        const next = themePreferences[(themePreferences.indexOf(current) + 1) % themePreferences.length]
        shellThemeService.setTheme(next)
      }
      const [open, setOpen] = React.useState(false)
      const [usageOpen, setUsageOpen] = React.useState(false)
      const [usageRevision, setUsageRevision] = React.useState(0)
      const [usageCatalogRevision, setUsageCatalogRevision] = React.useState(0)
      const [usageGroupOpen, setUsageGroupOpen] = React.useState({})
      const [fontSizeOpen, setFontSizeOpen] = React.useState(false)
      const [fontSizeError, setFontSizeError] = React.useState('')
      const [motionOpen, setMotionOpen] = React.useState(false)
      const [motionPreference, setMotionPreference] = React.useState(() => {
        try {
          const value = window.localStorage?.getItem('tradeloom.workbench.motion')
          return ['system', 'on', 'off'].includes(value) ? value : 'system'
        } catch { return 'system' }
      })
      const [mobileOpen, setMobileOpen] = React.useState(false)
      const [mobileUrl, setMobileUrl] = React.useState('')
      const [mobileBusy, setMobileBusy] = React.useState(false)
      const [mobileError, setMobileError] = React.useState('')
      const [mobileQr, setMobileQr] = React.useState(null)
      const [mobileQrError, setMobileQrError] = React.useState('')
      const mobileRequest = React.useRef(0)
      const rootRef = React.useRef(null)
      const triggerRef = React.useRef(null)
      const usageTriggerRef = React.useRef(null)
      const fontSizeTriggerRef = React.useRef(null)
      const motionTriggerRef = React.useRef(null)
      const [pluginsOpen, setPluginsOpen] = React.useState(false)
      React.useLayoutEffect(() => {
        if (!open && !usageOpen && !fontSizeOpen && !motionOpen && !pluginsOpen) return undefined
        const panelSelector = '.tl-shell-tools-menu,.tl-session-usage-panel,.tl-font-size-panel,.tl-motion-preference-panel'
        const positionPanels = () => {
          const root = rootRef.current
          const anchor = (usageOpen ? usageTriggerRef.current : triggerRef.current)?.getBoundingClientRect()
          if (!root || !anchor) return
          const popupTop = anchor.bottom + 4
          const availableBelowAnchor = Math.max(0, window.innerHeight - popupTop - 8)
          for (const panel of root.querySelectorAll(panelSelector)) {
            if (!panel.hasAttribute('data-tl-topbar-popover-open')) {
              panel.setAttribute('popover', 'manual')
              panel.setAttribute('data-tl-topbar-popover', '')
              if (typeof panel.showPopover !== 'function') continue
              panel.showPopover()
              panel.setAttribute('data-tl-topbar-popover-open', '')
            }
            Object.assign(panel.style, { position: 'fixed', inset: 'auto', insetInlineEnd: 'auto', insetBlockStart: 'auto', margin: '0',
              maxWidth: `${Math.max(0, window.innerWidth - 16)}px` })
            if (panel.matches('.tl-session-usage-panel')) {
              panel.style.setProperty('--tl-viewport-max-height', `${availableBelowAnchor}px`)
            } else {
              panel.style.maxHeight = `${availableBelowAnchor}px`
            }
            const rect = panel.getBoundingClientRect()
            panel.style.left = `${Math.max(8, Math.min(window.innerWidth - rect.width - 8, anchor.right - rect.width))}px`
            panel.style.top = `${popupTop}px`
          }
        }
        positionPanels()
        const observer = typeof window.ResizeObserver === 'function' ? new window.ResizeObserver(positionPanels) : undefined
        for (const panel of rootRef.current?.querySelectorAll(panelSelector) ?? []) observer?.observe(panel)
        window.addEventListener('resize', positionPanels)
        return () => { observer?.disconnect(); window.removeEventListener('resize', positionPanels) }
      }, [open, usageOpen, fontSizeOpen, motionOpen, pluginsOpen, workbenchUiTokens.fontBody])
      const current = sceneApi?.getSnapshot?.()
      const bindingKey = `${current?.activeSceneId ?? ''}`
      const boundUsageKey = JSON.stringify(Object.entries(current?.sessionBindings ?? {}).filter(([, id]) => typeof id === 'string' && id).sort(([left], [right]) => left.localeCompare(right)))
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
            setUsageOpen(false)
            setFontSizeOpen(false)
            setMotionOpen(false)
            setPluginsOpen(false)
          }
        }
        return sceneApi.subscribe(onSnapshot)
      }, [sceneApi])
      React.useEffect(() => {
        if (!open && !usageOpen && !fontSizeOpen && !motionOpen && !pluginsOpen) return undefined
        const closeTopbarPopover = restoreFocus => {
          if (open) { setOpen(false); if (restoreFocus) triggerRef.current?.focus?.() }
          else if (usageOpen) { setUsageOpen(false); if (restoreFocus) usageTriggerRef.current?.focus?.() }
          else if (fontSizeOpen) { setFontSizeOpen(false); if (restoreFocus) triggerRef.current?.focus?.() }
          else if (motionOpen) { setMotionOpen(false); if (restoreFocus) triggerRef.current?.focus?.() }
        }
        const handleTopbarPopoverDismissal = () => closeTopbarPopover(true)
        const dismiss = event => {
          if (event.type === 'keydown') {
            if (event.defaultPrevented) return
            if (event.key !== 'Escape') return
            if (activeTopbarPopover()) {
              event.preventDefault?.()
              requestTopbarPopoverDismissal()
              return
            }
            if (workspaceModalState().state?.owners.length) return
            event.preventDefault?.()
            return
          }
          const root = rootRef.current
          const eventPath = typeof event.composedPath === 'function' ? event.composedPath() : undefined
          const inModalPortal = Array.isArray(eventPath) && eventPath.some(node => node?.classList?.contains('tl-workspace-modal-backdrop'))
          if (inModalPortal) {
            if (activeTopbarPopover()) closeTopbarPopover(false)
            return
          }
          const insideRoot = root && (Array.isArray(eventPath)
            ? eventPath.includes(root)
            : root.contains?.(event.target))
          if (!insideRoot) {
            closeTopbarPopover(false)
          }
        }
        document.addEventListener('tl-shell-dismiss-topbar-popover', handleTopbarPopoverDismissal)
        document.addEventListener('keydown', dismiss)
        document.addEventListener('click', dismiss)
        return () => {
          document.removeEventListener('tl-shell-dismiss-topbar-popover', handleTopbarPopoverDismissal)
          document.removeEventListener('keydown', dismiss)
          document.removeEventListener('click', dismiss)
        }
      }, [open, usageOpen, fontSizeOpen, motionOpen, pluginsOpen])

      React.useEffect(() => {
        const root = window.document?.documentElement
        if (!root) return
        root.dataset.tlWorkbenchMotion = motionPreference
      }, [motionPreference])

      function updateMotionPreference(value) {
        if (!['system', 'on', 'off'].includes(value)) return
        try { window.localStorage?.setItem('tradeloom.workbench.motion', value) } catch { /* Keep the choice for this renderer session. */ }
        const root = window.document?.documentElement
        if (root) root.dataset.tlWorkbenchMotion = value
        try { window.dispatchEvent?.(new window.CustomEvent('tradeloom:workbench-motion-preference-change', { detail: { value } })) } catch { /* Popout documents also receive the preference on attach. */ }
        setMotionPreference(value)
      }

      React.useEffect(() => {
        if (!usageOpen) return undefined
        const sessions = sceneContext?.sessions
        if (!sessions?.list?.subscribe) return undefined
        return sessions.list.subscribe(() => {
            setUsageRevision(value => value + 1)
            setUsageCatalogRevision(value => value + 1)
        })
      }, [usageOpen, sceneContext?.sessions?.list])

      React.useEffect(() => {
        if (!usageOpen) return undefined
        const unsubscribe = []
        const sessions = sceneContext?.sessions
        if (!sessions?.scope || !sessions?.sessionOf) return undefined
        const sessionIds = [...new Set(Object.values(sceneApi?.getSnapshot?.()?.sessionBindings ?? {})
          .filter(sessionId => typeof sessionId === 'string' && sessionId))]
        for (const sessionId of sessionIds) {
          const scoped = sessions.scope(sessionId)
          const session = scoped ? sessions.sessionOf(scoped) : undefined
          const face = session?.projections?.faceOf?.('contextPressure')
          if (face?.subscribe) unsubscribe.push(face.subscribe(() => setUsageRevision(value => value + 1)))
        }
        return () => { for (const stop of unsubscribe) stop() }
      }, [usageOpen, boundUsageKey, sceneApi, sceneContext?.sessions?.list, usageCatalogRevision])

      function sessionUsageRows() {
        const state = sceneApi?.getSnapshot?.()
        const roles = state?.config?.roles ?? []
        const roleById = new Map(roles.map(role => [role.id, role]))
        const sessions = sceneContext?.sessions
        const catalog = sessions?.list?.getSnapshot?.()
        const catalogIds = Array.isArray(catalog?.ids)
          ? [...new Set(catalog.ids.filter(sessionId => typeof sessionId === 'string' && sessionId))] : []
        const listedIds = new Set(catalogIds)
        const roleIdsBySession = new Map()
        for (const [roleId, sessionId] of Object.entries(state?.sessionBindings ?? {})) {
          if (typeof sessionId !== 'string' || !sessionId || !roleById.has(roleId)) continue
          const roleIds = roleIdsBySession.get(sessionId) ?? []
          roleIds.push(roleId)
          roleIdsBySession.set(sessionId, roleIds)
        }
        const pendingBindings = [...roleIdsBySession.entries()]
          .filter(([sessionId]) => !listedIds.has(sessionId))
          .map(([, roleIds]) => roleIds.map(roleId => roleById.get(roleId)?.assistantLabel || roleById.get(roleId)?.label || roleId))
          .flat()
        const rows = catalogIds.map(sessionId => {
          const summary = catalog?.byId?.[sessionId]
          const roleIds = roleIdsBySession.get(sessionId) ?? []
          let pressure = catalog?.projectionsBySession?.[sessionId]?.values?.contextPressure
            ?? summary?.projectionValues?.contextPressure
          let loaded = false
          if (roleIds.length && sessions?.scope && sessions?.sessionOf) {
            const scoped = sessions.scope(sessionId)
            const session = scoped ? sessions.sessionOf(scoped) : undefined
            const face = session?.projections?.faceOf?.('contextPressure')
            if (scoped) loaded = true
            const livePressure = face?.getSnapshot?.()
            if (livePressure && typeof livePressure === 'object') pressure = livePressure
          }
          const group = roleIds.length ? 'scene' : summary?.origin === 'subagent' || summary?.parentId ? 'assistant' : 'other'
          return {
            sessionId,
            title: typeof summary?.displayTitle === 'string' && summary.displayTitle.trim()
              ? summary.displayTitle : typeof summary?.title === 'string' && summary.title.trim() ? summary.title : '未命名会话',
            roleLabels: roleIds.map(roleId => roleById.get(roleId)?.assistantLabel || roleById.get(roleId)?.label || roleId),
            group,
            loaded,
            pressure: pressure && typeof pressure === 'object' ? pressure : undefined,
          }
        })
        const groups = [
          { key: 'scene', label: '场景会话', description: '已绑定到工作场景的会话', defaultOpen: false },
          { key: 'assistant', label: '助手会话', description: '会话目录标记为子助手的记录', defaultOpen: true },
          { key: 'other', label: '其他会话', description: '其他已列入目录的会话', defaultOpen: true },
        ].map(group => ({ ...group, rows: rows.filter(row => row.group === group.key) }))
        return {
          catalogPhase: catalog?.phase ?? 'unavailable',
          directoryCount: rows.length,
          pendingBindings,
          groups,
          rows,
        }
      }

      function formatUsage(value) {
        if (!Number.isFinite(value) || value < 0) return '未知'
        if (value >= 10000) {
          const compact = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(value / 10000)
          return `${compact}万`
        }
        return new Intl.NumberFormat().format(value)
      }

      function formatExactUsage(value) {
        return Number.isFinite(value) && value >= 0 ? new Intl.NumberFormat().format(value) : '未知'
      }

      function setTextFontSize(value) {
        const fontSize = Number(value)
        if (!Number.isInteger(fontSize) || fontSize < 10 || fontSize > 22) return
        if (typeof shellThemeService?.setFontSize !== 'function') {
          setFontSizeError('当前环境不支持保存界面大小。')
          return
        }
        try {
          shellThemeService.setFontSize('text', fontSize)
          setFontSizeError('')
        } catch {
          setFontSizeError('界面大小保存失败，请重试。')
        }
      }

      const usage = usageOpen ? sessionUsageRows() : null
      const fontBody = workbenchUiTokens.fontBody
      const interfaceScalePercent = Math.round(fontBody / DEFAULT_WORKBENCH_FONT_BODY * 100)
      const canSetFontSize = typeof shellThemeService?.setFontSize === 'function'

      async function showMobileLink() {
        if (mobileOpen) { closeMobileLink(); return }
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

      const usagePanelElement = usageOpen ? (() => {
        const groupNodes = usage.groups.filter(group => group.rows.length).map(group => h('details', {
          key: group.key, open: usageGroupOpen[group.key] ?? group.defaultOpen, className: 'tl-session-usage-group',
          onToggle: event => {
            const isOpen = Boolean(event.currentTarget.open)
            setUsageGroupOpen(previous => ({ ...previous, [group.key]: isOpen }))
          },
        },
        h('summary', { className: 'tl-session-usage-summary' },
          h('span', { className: 'tl-session-usage-caret', 'aria-hidden': 'true' }, '›'),
          h('span', { 'aria-hidden': 'true', className: 'tl-session-usage-group-icon' }, group.key === 'scene' ? '▦' : group.key === 'assistant' ? '◇' : '○'),
          h('span', { className: 'tl-session-usage-group-heading' },
            h('span', { title: group.description }, group.label)),
          h('span', { className: 'tl-session-usage-count' }, `${group.rows.length} 条`)),
        group.rows.map(row => {
          const pressure = row.pressure && typeof row.pressure === 'object' ? row.pressure : undefined
          const used = pressure?.projectedTokens ?? pressure?.pressureTokens
          const capacity = pressure?.contextWindow
          const hasUsed = Number.isFinite(used) && used >= 0
          const hasCapacity = Number.isFinite(capacity) && capacity > 0
          const percent = hasUsed && hasCapacity ? Math.round(used / capacity * 100) : null
          const hasRecentUsage = hasUsed || hasCapacity
          const tone = percent === null ? 'muted' : percent < 100 ? 'success' : percent <= 200 ? 'warning' : 'danger'
          const toneColor = tone === 'muted' ? 'var(--tl-shell-muted)' : `var(--tl-theme-${tone})`
          const subtitle = row.roleLabels.length ? row.roleLabels.join(' / ') : ''
          const ratio = percent === null ? '未知' : `${percent}%`
          const exactValues = hasRecentUsage
            ? `最近上下文估算 ${formatExactUsage(used)} / ${formatExactUsage(capacity)} tokens` : '暂无用量记录，上下文估算未知'
          const exceeded = percent !== null && percent >= 100
          return h('article', {
            key: row.sessionId, role: 'listitem', 'data-session-id': row.sessionId, 'data-usage-tone': tone,
            className: 'tl-session-usage-record',
          },
          h('div', { className: 'tl-session-usage-row' },
            h('span', { 'aria-hidden': 'true', className: 'tl-session-usage-dot', style: { background: toneColor } }),
            h('strong', { className: 'tl-session-usage-title', title: row.title }, row.title),
            h('span', { className: 'tl-session-usage-percent', title: `上下文估算占比：${ratio}；${exactValues}`, 'aria-label': `上下文估算占比 ${ratio}；${exactValues}`, style: { color: toneColor } },
              exceeded && h('span', { className: 'tl-session-usage-warning', role: 'img', 'aria-label': '上下文估算达到或超出窗口' }, '⚠'), ratio)),
          subtitle && h('div', { className: 'tl-session-usage-role' }, subtitle),
          h('div', { className: 'tl-session-usage-detail', title: exactValues },
            h('span', null, '已用 ', h('b', { 'data-usage-value': 'used' }, formatUsage(used))),
            h('span', null, '容量 ', h('b', { 'data-usage-value': 'capacity' }, formatUsage(capacity)))),
          h('div', {
            className: `tl-session-usage-meter${percent === null ? ' is-unknown' : ''}`,
            role: percent === null ? 'img' : 'progressbar', 'aria-label': percent === null ? '上下文估算占比未知' : '上下文估算占比',
            'aria-valuemin': percent === null ? undefined : 0, 'aria-valuemax': percent === null ? undefined : 100,
            'aria-valuenow': percent === null ? undefined : Math.min(100, percent),
            'aria-valuetext': percent === null ? undefined : `${ratio}；${exactValues}${exceeded ? '；达到或超出窗口' : ''}`,
          }, percent !== null && h('span', { style: { width: `${Math.min(100, percent)}%`, background: toneColor } })))
        })))
        return h('section', {
          id: 'tl-session-usage-panel', className: 'tl-session-usage-panel', role: 'dialog', 'aria-label': '会话用量',
          'data-revision': usageRevision,
          style: { position: 'absolute', zIndex: 1001, insetBlockStart: 'calc(100% + var(--tl-space-1))', insetInlineEnd: 0, display: 'flex', flexDirection: 'column', width: 'min(calc(440px * var(--tl-ui-scale, 1)), calc(100vw - var(--tl-space-5) * 2))', maxHeight: 'min(calc(520px * var(--tl-ui-scale, 1)), calc(100vh - var(--tl-space-5) * 8), var(--tl-viewport-max-height, 100vh))', overflow: 'hidden', padding: 'var(--tl-space-3)', border: '1px solid var(--tl-shell-line)', borderRadius: 'var(--tl-corner-radius)', background: 'var(--tl-shell-surface)', color: 'var(--tl-shell-ink)', boxShadow: '0 8px 24px rgb(0 0 0 / 20%)', font: 'var(--tl-font-body)/1.3 var(--tl-font-family)' },
        },
        h('header', { className: 'tl-session-usage-header' },
          h('strong', null, '会话上下文'),
          h('span', { style: { color: 'var(--tl-shell-muted)', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' } }, `共 ${usage.directoryCount} 条`),
          h('button', { type: 'button', className: 'tl-session-usage-close', 'aria-label': '关闭会话用量', onClick: () => { setUsageOpen(false); usageTriggerRef.current?.focus?.() } }, '×')),
        usage.catalogPhase === 'pending' ? h('p', { className: 'tl-session-usage-state', role: 'status' }, '正在读取已有会话目录。') : null,
        usage.catalogPhase === 'unavailable' ? h('p', { className: 'tl-session-usage-state', role: 'status' }, '当前会话目录不可用。') : null,
        usage.pendingBindings.length ? h('p', { className: 'tl-session-usage-state', role: 'note' },
          `${usage.pendingBindings.length} 个角色绑定尚未由目录确认，未计入目录记录。`) : null,
        h('div', { className: 'tl-session-usage-list', role: 'list' },
          groupNodes,
          usage.directoryCount === 0 && usage.catalogPhase === 'ready'
            ? h('p', { className: 'tl-session-usage-empty' }, '会话目录中暂无记录。') : null),
        h('details', { className: 'tl-session-usage-footer' },
          h('summary', null, '轮数 / 压缩 / 成本：未知', h('span', null, ' 口径')),
          h('p', null, '上下文数值来自原生 contextPressure 最近投影，不是累计用量或费用。未提供的数据明确显示未知；真实 0 保留为 0。进度条仅在占比可计算时显示，超过窗口保留实际百分比。轮数、压缩和成本的数据合同尚未接入。')))
      })() : null

      return h('div', { className: 'tl-shell-tools', ref: rootRef },
        h('button', { type: 'button', className: 'tl-shell-quick-action', title: '显示或收起原生会话侧栏', 'aria-label': '切换会话侧栏', onClick: () => layout?.toggleSidebar?.() },
          h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true }, h('rect', { x: 3, y: 4, width: 14, height: 12, rx: 2 }), h('path', { d: 'M8 4v12' }))),
        h('button', { type: 'button', className: 'tl-shell-quick-action', title: '连接手机', 'aria-label': '连接手机', onClick: () => { void showMobileLink() } },
          h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true }, h('rect', { x: 6, y: 2, width: 8, height: 16, rx: 2 }), h('path', { d: 'M9 15h2' }))),
        h('button', { type: 'button', className: 'tl-shell-quick-action', title: '设置 · 外观、快捷键、版本与开发者工具', 'aria-label': '打开原生设置', disabled: !settingsEntry, onClick: openNativeSettings },
          h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true }, h('path', { d: 'M8 3h4l.5 2 2 1 2-.5 2 3.5-1.5 1.5v2l1.5 1.5-2 3.5-2-.5-2 1-.5 2H8l-.5-2-2-1-2 .5-2-3.5L3 12v-2L1.5 8.5l2-3.5 2 .5 2-1Z', transform: 'translate(1 -1) scale(.9)' }), h('circle', { cx: 10, cy: 10, r: 3 }))),
        h('button', { type: 'button', className: 'tl-shell-quick-action', title: `切换主题 · 当前${themeSnapshot?.preference === 'system' ? '跟随系统' : activeColorScheme === 'dark' ? '深色' : '浅色'}`, 'aria-label': '切换界面主题', disabled: typeof shellThemeService?.setTheme !== 'function' || themePreferences.length < 2, onClick: cycleTheme },
          h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true }, h('path', { d: 'M16.5 12.2A7 7 0 0 1 7.8 3.5a7 7 0 1 0 8.7 8.7Z' }))),
        h('button', { ref: usageTriggerRef, type: 'button', className: 'tl-shell-quick-action tl-session-usage-trigger', 'aria-label': '显示会话用量', title: '会话用量', 'aria-controls': 'tl-session-usage-panel', 'aria-expanded': usageOpen, onClick: () => { setOpen(false); setFontSizeOpen(false); setMotionOpen(false); setUsageOpen(value => !value) } },
          h('svg', { viewBox: '0 0 20 20', 'aria-hidden': true }, h('circle', { cx: 10, cy: 10, r: 7 }), h('path', { d: 'M10 4.5V10l4 2.5' }))),
        h('button', { ref: triggerRef, type: 'button', className: 'tl-shell-tools-trigger', 'aria-label': '打开工具菜单', title: '工具', 'aria-controls': pluginsOpen ? 'tl-plugin-inventory-panel' : 'tl-shell-tools-menu', 'aria-expanded': open || pluginsOpen, onClick: () => { setUsageOpen(false); setFontSizeOpen(false); setMotionOpen(false); if (pluginsOpen) { setPluginsOpen(false); setOpen(false) } else setOpen(value => !value) } }, '⋯'),
        open ? h('div', { id: 'tl-shell-tools-menu', className: 'tl-shell-tools-menu', role: 'group', 'aria-label': '工作台工具' },
          h('span', { className: 'tl-shell-menu-heading' }, '工作台'),
          action(sceneApi?.getSnapshot?.()?.configError ? '重试读取场景' : '刷新场景配置', () => { void sceneApi?.retryLoadConfig?.() }),
          action('返回工作台', () => layout?.selectPanel('scene-workbench')),
          h('span', { className: 'tl-shell-menu-heading' }, '原生功能'),
          action('插件管理', () => { setUsageOpen(false); setFontSizeOpen(false); setMotionOpen(false); setPluginsOpen(value => !value) }),
          action('自动化', () => layout?.selectPanel('schedules')),
          action('切换会话侧栏', () => layout?.toggleSidebar?.()),
          action('连接手机', () => { void showMobileLink() }),
          h('span', { className: 'tl-shell-menu-heading' }, '显示与会话'),
          h('button', { key: '界面大小', ref: fontSizeTriggerRef, type: 'button', onClick: () => { setUsageOpen(false); setOpen(false); setFontSizeError(''); setFontSizeOpen(true) }, 'aria-expanded': fontSizeOpen }, '界面大小'),
          h('button', { key: '工作台动效', ref: motionTriggerRef, type: 'button', onClick: () => { setUsageOpen(false); setFontSizeOpen(false); setOpen(false); setMotionOpen(value => !value) }, 'aria-expanded': motionOpen }, '工作台动效'),
          h('button', { key: '会话用量', type: 'button', onClick: () => { setFontSizeOpen(false); setOpen(false); setUsageOpen(value => !value) }, 'aria-expanded': usageOpen }, '会话用量')) : null,
        usagePanelElement,
        pluginsOpen ? h(WorkspaceModalLayer, { onClose: () => { setPluginsOpen(false); triggerRef.current?.focus?.() } }, h(PluginInventoryOverview, { onClose: () => { setPluginsOpen(false); triggerRef.current?.focus?.() } })) : null,
        motionOpen ? h('section', {
          className: 'tl-motion-preference-panel', role: 'dialog', 'aria-label': '工作台动效',
          style: { position: 'absolute', zIndex: 1002, insetBlockStart: 'calc(100% + var(--tl-space-1))', insetInlineEnd: 0, display: 'grid', gap: 'var(--tl-space-2)', width: 'min(calc(250px * var(--tl-ui-scale, 1)), calc(100vw - var(--tl-space-5) * 2))', padding: 'var(--tl-space-3)', border: '1px solid var(--tl-shell-line)', borderRadius: 'var(--tl-corner-radius)', background: 'var(--tl-shell-surface)', color: 'var(--tl-shell-ink)', boxShadow: '0 8px 24px rgb(0 0 0 / 20%)', font: 'var(--tl-font-compact)/1.45 var(--tl-font-family)' },
        },
        h('strong', null, '工作台动效'),
        h('fieldset', { style: { display: 'grid', gap: 'var(--tl-space-1)', minWidth: 0, margin: 0, padding: 0, border: 0 } },
          h('legend', { style: { marginBottom: 'var(--tl-space-1)', color: 'var(--tl-shell-muted)' } }, '面板几何动效'),
          [['system', '跟随系统'], ['on', '开启'], ['off', '关闭']].map(([value, label]) => h('label', {
            key: value, style: { display: 'flex', alignItems: 'center', gap: 'var(--tl-space-2)', minHeight: 'var(--tl-control-height)', padding: '0 var(--tl-space-2)', borderRadius: 'var(--tl-corner-radius)', background: motionPreference === value ? 'var(--tl-shell-soft)' : 'transparent', cursor: 'pointer' },
          }, h('input', { type: 'radio', name: 'tl-workbench-motion', value, checked: motionPreference === value, onChange: () => updateMotionPreference(value) }), label))),
        h('p', { style: { margin: 0, color: 'var(--tl-shell-muted)' } }, '“跟随系统”会遵循系统的减少动态效果设置。')) : null,
        fontSizeOpen ? h('section', {
          className: 'tl-font-size-panel', role: 'dialog', 'aria-label': '界面大小',
          style: { position: 'absolute', zIndex: 1001, insetBlockStart: 'calc(100% + var(--tl-space-1))', insetInlineEnd: 0, display: 'grid', gap: 'var(--tl-space-3)', width: 'min(calc(320px * var(--tl-ui-scale, 1)), calc(100vw - var(--tl-space-5) * 2))', padding: 'var(--tl-space-3)', border: '1px solid var(--tl-shell-line)', borderRadius: 'var(--tl-corner-radius)', background: 'var(--tl-shell-surface)', color: 'var(--tl-shell-ink)', boxShadow: '0 8px 24px rgb(0 0 0 / 20%)', font: 'var(--tl-font-compact)/1.45 var(--tl-font-family)' },
        },
        h('header', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--tl-space-3)' } },
          h('strong', null, '界面大小'),
          h('span', { style: { color: 'var(--tl-shell-muted)', fontVariantNumeric: 'tabular-nums' } }, `${interfaceScalePercent}% · 正文${fontBody}px`)),
          h('label', { htmlFor: 'tl-shell-font-size', style: { display: 'grid', gap: 'var(--tl-space-2)' } },
          h('span', null, '字号、按钮与间距同步'),
          h('input', { id: 'tl-shell-font-size', type: 'range', min: 10, max: 22, step: 1, value: fontBody,
            disabled: !canSetFontSize, 'aria-label': '界面大小',
            'aria-valuetext': `${interfaceScalePercent}%，正文${fontBody}像素`, onChange: event => setTextFontSize(event.currentTarget.value) })),
        h('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--tl-space-3)' } },
          h('span', { style: { color: 'var(--tl-shell-muted)', fontSize: 'var(--tl-font-compact)' } }, `${Math.round(10 / 14 * 100)}% · 10 px`, '　', `${Math.round(22 / 14 * 100)}% · 22 px`),
          h('button', { type: 'button', className: 'tl-font-size-reset', disabled: !canSetFontSize, onClick: () => setTextFontSize(DEFAULT_WORKBENCH_FONT_BODY) }, '恢复参考大小')),
        fontSizeError ? h('p', { role: 'status', style: { margin: 0, color: 'var(--tl-shell-danger)' } }, fontSizeError)
          : !canSetFontSize ? h('p', { role: 'note', style: { margin: 0, color: 'var(--tl-shell-muted)' } }, '当前环境不支持保存界面大小。') : null) : null,
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
          --tl-shell-surface: var(--tl-theme-panel); --tl-shell-soft: var(--tl-theme-header); --tl-shell-ink: var(--tl-theme-text);
          --tl-shell-muted: var(--tl-theme-muted); --tl-shell-line: var(--tl-theme-border); --tl-shell-accent: var(--tl-theme-accent);
          --tl-shell-accent-strong: var(--tl-theme-accent-strong); --tl-shell-accent-soft: var(--tl-theme-accent-soft);
          --tl-shell-danger: var(--tl-theme-danger); --tl-shell-danger-bg: var(--tl-theme-danger-bg); --tl-shell-danger-line: var(--tl-theme-danger-border);
          --tl-shell-overlay-z: 1100;
          background: var(--tl-theme-canvas); color: var(--tl-shell-ink);
        }
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row {
          position: fixed; z-index: 1101; inset-block-start: 0; inset-inline-start: 40px; inset-inline-end: 140px;
          width: auto; min-height: var(--dsh-windows-titlebar-height, 32px); height: var(--dsh-windows-titlebar-height, 32px);
          max-height: var(--dsh-windows-titlebar-height, 32px); padding: 0 8px; overflow: visible;
          background: transparent; -webkit-app-region: drag;
        }
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row button,
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row a,
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row input,
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row select,
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row textarea,
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row summary,
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row [role="button"],
        html[data-windows-titlebar] .tl-shell-top .tl-top-model-row [data-windows-menu] { -webkit-app-region: no-drag; }
        html[data-windows-titlebar] .tl-top-model-row .tl-shell-quick-action,
        html[data-windows-titlebar] .tl-top-model-row .tl-shell-tools-trigger {
          width: 26px; height: 26px; padding: 4px;
        }
        html[data-windows-titlebar] .tl-top-model-row .tl-shell-quick-action svg { width:16px; height:16px; }
        html[data-windows-titlebar] .tl-top-model-row .tl-shell-brand-mark { width:22px; height:22px; }
        html[data-windows-titlebar] .tl-top-model-row .tl-agent-selector > summary {
          min-height:26px; height:26px; padding-block:0; font-size:min(var(--tl-font-compact), 16px);
        }
        html[data-windows-titlebar] .tl-top-model-row .tl-model-rail { min-height:0; height:28px; max-height:28px; padding-block:0; }
        html[data-windows-titlebar] .tl-top-model-row .tl-model-group { min-width:28px; max-width:28px; }
        html[data-windows-titlebar] .tl-top-model-row .tl-model-group > summary,
        html[data-windows-titlebar] .tl-top-model-row .tl-model-picker-trigger {
          width:28px; min-width:28px; height:28px; max-height:28px; font-size:min(var(--tl-font-body),16px);
        }
        @media (max-width:900px) {
          html[data-windows-titlebar] .tl-top-model-row .tl-shell-quick-action[aria-label="切换会话侧栏"],
          html[data-windows-titlebar] .tl-top-model-row .tl-shell-quick-action[aria-label="连接手机"] { display:none; }
          html[data-windows-titlebar] .tl-top-model-row .tl-shell-brand { display:none; }
        }
        .tl-navigation {
          box-sizing: border-box; display: flex; align-items: center; flex-wrap: nowrap; gap: var(--tl-space-1);
          min-width: 0; min-height: var(--tl-nav-height); max-height: var(--tl-nav-height); overflow-x: auto; overflow-y: hidden;
          white-space: nowrap; padding: var(--tl-space-1) var(--tl-space-3);
          border-bottom: 1px solid var(--tl-shell-line); background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          font-family: var(--tl-font-family); font-size: var(--tl-font-compact);
        }
        .tl-top-model-row {
          display: flex; align-items: center; gap: var(--tl-space-2); width: 100%; min-width: 0; min-height: var(--tl-row-height); position: relative;
          padding: 0 var(--tl-space-3); box-sizing: border-box;
        }
        .tl-native-menu-slot { display:flex; flex:0 0 auto; align-items:center; height:100%; }
        .tl-shell-brand { display:flex; align-items:center; gap:var(--tl-space-2); flex:0 0 auto; color:var(--tl-shell-ink); }
        .tl-shell-brand-mark { flex:0 0 auto; width:calc(22px * var(--tl-ui-scale, 1)); height:calc(22px * var(--tl-ui-scale, 1)); }
        .tl-shell-brand > div { min-width:0; line-height:1.05 !important; white-space:nowrap; overflow:hidden; }
        .tl-shell-brand strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .tl-shell-brand strong { font-size:var(--tl-font-body) !important; }
        .tl-shell-brand span { display:none; }
        .tl-top-model-row > :first-child { flex: 0 1 auto; min-width: 0; }
        @media (max-width:600px) { .tl-shell-brand > div { display:none !important; } .tl-top-model-row > :first-child { flex:0 0 auto; } .tl-shell-top .tl-shell-quick-action, .tl-shell-top .tl-shell-tools-trigger { width:max(28px, calc(var(--tl-control-height) * .8)); } .tl-top-model-row { gap:var(--tl-space-1); } }
        .tl-shell-top .tl-model-rail .tl-theme-toggle { display:none; }
        .tl-shell-tools { display:flex; align-items:center; gap:var(--tl-space-1); margin-inline-start: auto; position: relative; flex: 0 0 auto; }
        .tl-shell-quick-action { display:inline-flex; align-items:center; justify-content:center; width:var(--tl-control-height); height:var(--tl-control-height); padding:var(--tl-space-1); border:1px solid transparent; border-radius:var(--tl-corner-radius); color:var(--tl-shell-muted); background:transparent; cursor:pointer; }
        .tl-shell-quick-action svg { width:var(--tl-icon-size); height:var(--tl-icon-size); fill:none; stroke:currentColor; stroke-width:1.5; }
        .tl-shell-quick-action:disabled { opacity:.4; cursor:default; }
        .tl-shell-quick-action:hover:not(:disabled) { color:var(--tl-shell-ink); background:var(--tl-shell-soft); border-color:var(--tl-shell-line); }
        .tl-shell-quick-action:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:1px; }
        .tl-shell-menu-heading { padding:var(--tl-space-2) var(--tl-space-3) var(--tl-space-1); color:var(--tl-shell-muted); font-size:var(--tl-font-compact); font-weight:600; }
        .tl-shell-menu-heading:not(:first-child) { margin-top:var(--tl-space-1); border-top:1px solid var(--tl-shell-line); }
        .tl-shell-tools-trigger {
          display: inline-flex; align-items: center; justify-content: center; width: var(--tl-control-height); height: var(--tl-control-height);
          border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); background: var(--tl-shell-surface);
          color: var(--tl-shell-ink); font: var(--tl-font-body)/1 var(--tl-font-family); cursor: pointer;
        }
        .tl-shell-tools-trigger:hover, .tl-shell-tools-menu button:hover { background: var(--tl-shell-soft); }
        .tl-shell-tools-trigger:focus-visible, .tl-shell-tools-menu button:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
        .tl-shell-tools-menu {
          box-sizing:border-box; max-width:calc(100vw - var(--tl-space-5) * 2);
          max-height:calc(100dvh - var(--tl-row-height) - var(--tl-space-4) * 2); overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable;
          position: absolute; z-index: 1000; inset-block-start: calc(100% + var(--tl-space-1)); inset-inline-end: 0;
          display: grid; gap: var(--tl-space-1); min-width: calc(190px * var(--tl-ui-scale, 1)); padding: var(--tl-space-2); border: 1px solid var(--tl-shell-line);
          border-radius: var(--tl-corner-radius); background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          box-shadow: 0 8px 24px rgb(0 0 0 / 16%);
        }
        .tl-shell-tools-menu button {
          min-height: var(--tl-control-height); padding: var(--tl-space-2) var(--tl-space-3); border: 0; border-radius: var(--tl-corner-radius); background: transparent;
          color: inherit; font: inherit; text-align: start; cursor: pointer;
        }
        .tl-font-size-reset { box-sizing:border-box; min-height:var(--tl-control-height); padding:var(--tl-space-1) var(--tl-space-2); border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); background:var(--tl-shell-soft); color:var(--tl-shell-ink); font:inherit; cursor:pointer; }
        .tl-font-size-reset:not(:disabled):hover { background:var(--tl-shell-accent-soft); border-color:var(--tl-shell-accent); }
        .tl-font-size-reset:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:2px; }
        .tl-font-size-reset:disabled { opacity:.4; cursor:default; }
        .tl-motion-preference-panel,.tl-font-size-panel { box-sizing:border-box; max-height:calc(100dvh - var(--tl-row-height) - var(--tl-space-4) * 2); overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
        .tl-session-usage-panel {
          box-sizing: border-box; min-width: 0;
        }
        .tl-session-usage-header { flex:0 0 auto; display:flex; align-items:center; gap:var(--tl-space-2); padding-bottom:var(--tl-space-2); border-bottom:1px solid var(--tl-shell-line); }
        .tl-session-usage-header strong { margin-inline-end:auto; }
        .tl-session-usage-close { flex:none; border:0; background:transparent; color:var(--tl-shell-muted); padding:.1em .35em; font:inherit; cursor:pointer; border-radius:var(--tl-corner-radius); }
        .tl-session-usage-close:hover { background:var(--tl-shell-soft); color:var(--tl-shell-ink); }
        .tl-session-usage-close:focus-visible, .tl-session-usage-footer summary:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:1px; }
        .tl-session-usage-state { flex:0 0 auto; margin:var(--tl-space-2) 0 0; color:var(--tl-shell-muted); overflow-wrap:anywhere; }
        .tl-session-usage-list { min-height:0; flex:1 1 auto; overflow:auto; overscroll-behavior:contain; padding-inline-end:var(--tl-space-1); scrollbar-gutter:stable; }
        .tl-session-usage-list::-webkit-scrollbar { width:5px; height:5px; }
        .tl-session-usage-list::-webkit-scrollbar-thumb { border-radius:5px; background:var(--tl-shell-muted); }
        .tl-session-usage-group { margin:0; }
        .tl-session-usage-group > summary { display:flex; align-items:center; gap:var(--tl-space-1); min-height:1.7em; padding:var(--tl-space-1); cursor:pointer; font-weight:600; list-style:none; border-radius:var(--tl-corner-radius); }
        .tl-session-usage-group > summary:hover, .tl-session-usage-group > summary:focus-visible, .tl-session-usage-group[open] > summary { background:var(--tl-shell-soft); }
        .tl-session-usage-group > summary:focus-visible { outline:2px solid var(--tl-shell-accent); outline-offset:1px; }
        .tl-session-usage-group > summary::-webkit-details-marker { display:none; }
        .tl-session-usage-caret { display:inline-block; flex:none; transition:transform .12s ease; }
        .tl-session-usage-group[open] > summary .tl-session-usage-caret { transform:rotate(90deg); }
        .tl-session-usage-group-icon { color:var(--tl-shell-muted); }
        .tl-session-usage-group-heading { min-width:0; line-height:1.25; }
        .tl-session-usage-count { margin-inline-start:auto; white-space:nowrap; color:var(--tl-shell-muted); font-weight:400; font-variant-numeric:tabular-nums; }
        .tl-session-usage-record { padding:var(--tl-space-2) var(--tl-space-1); border-bottom:1px solid var(--tl-shell-line); }
        .tl-session-usage-row { display:flex; align-items:baseline; gap:var(--tl-space-2); min-width:0; }
        .tl-session-usage-dot { flex:none; width:.3em; height:.3em; border-radius:50%; align-self:center; }
        .tl-session-usage-title { min-width:0; flex:1; overflow-wrap:anywhere; line-height:1.25; font-weight:600; }
        .tl-session-usage-percent { flex:none; min-width:4.5em; text-align:end; white-space:nowrap; font-weight:600; font-variant-numeric:tabular-nums; }
        .tl-session-usage-warning { margin-inline-end:.25em; }
        .tl-session-usage-role { margin-top:.1em; color:var(--tl-shell-muted); overflow-wrap:anywhere; }
        .tl-session-usage-detail { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:var(--tl-space-2); margin-top:.15em; color:var(--tl-shell-muted); font-variant-numeric:tabular-nums; }
        .tl-session-usage-detail > span { min-width:0; overflow-wrap:anywhere; }
        .tl-session-usage-detail > span:last-child { text-align:end; }
        .tl-session-usage-detail b { color:var(--tl-shell-ink); font-weight:500; }
        .tl-session-usage-meter { margin-top:.25em; height:.25em; min-height:4px; overflow:hidden; border-radius:2px; background:var(--tl-shell-soft); border:1px solid var(--tl-shell-line); }
        .tl-session-usage-meter > span { display:block; height:100%; }
        .tl-session-usage-meter.is-unknown { background:repeating-linear-gradient(135deg,var(--tl-shell-soft),var(--tl-shell-soft) 4px,var(--tl-shell-line) 4px,var(--tl-shell-line) 5px); }
        .tl-session-usage-footer { flex:0 0 auto; margin:var(--tl-space-2) 0 0; padding-top:var(--tl-space-1); border-top:1px solid var(--tl-shell-line); color:var(--tl-shell-muted); }
        .tl-session-usage-footer summary { cursor:pointer; overflow-wrap:anywhere; }
        .tl-session-usage-footer summary span { color:var(--tl-shell-accent); }
        .tl-session-usage-footer p { margin:var(--tl-space-1) 0 0; max-height:7em; overflow:auto; overflow-wrap:anywhere; }
        .tl-mobile-link-panel {
          position: fixed; z-index: 1100; inset-block-start: calc(var(--tl-row-height) + var(--tl-nav-height) + var(--tl-space-3)); inset-inline-end: var(--tl-space-3);
          box-sizing: border-box; display: grid; gap: var(--tl-space-3); width: min(calc(420px * var(--tl-ui-scale, 1)), calc(100vw - var(--tl-space-5) * 2));
          max-block-size: calc(100vh - var(--tl-space-5) * 8); max-block-size: calc(100dvh - var(--tl-space-5) * 8); overflow: auto;
          padding: var(--tl-space-3); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius);
          background: var(--tl-shell-surface); color: var(--tl-shell-ink); box-shadow: 0 10px 32px rgb(0 0 0 / 20%);
          font: var(--tl-font-compact)/1.5 var(--tl-font-family);
        }
        .tl-mobile-link-panel ol { margin: 0; padding-inline-start: calc(22px * var(--tl-ui-scale, 1)); color: var(--tl-shell-muted); }
        .tl-mobile-link-panel input { box-sizing: border-box; width: 100%; min-width: 0; min-height: var(--tl-control-height); padding: var(--tl-space-2) var(--tl-space-3); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); background: var(--tl-shell-surface); color: var(--tl-shell-ink); font: inherit; }
        .tl-mobile-link-panel button { min-height: var(--tl-control-height); padding: var(--tl-space-2) var(--tl-space-3); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); background: var(--tl-shell-soft); color: var(--tl-shell-ink); font: inherit; cursor: pointer; }
        .tl-mobile-link-panel button:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
        .tl-mobile-link-qr-frame { box-sizing: border-box; width: min(calc(264px * var(--tl-ui-scale, 1)), 100%); aspect-ratio: 1; margin-inline: auto; padding: var(--tl-space-3); border: 1px solid #d5d5d5; border-radius: var(--tl-corner-radius); background: #fff; }
        .tl-mobile-link-qr { display: block; width: 100%; height: 100%; background: #fff; shape-rendering: crispEdges; }
        html[data-meow-smooth-furled] .tl-top-model-row { padding-inline-start: 8px; }
        .tl-navigation .tl-scene-tab { font: inherit; color: inherit; background: transparent; }
        .tl-navigation .tl-conversation-entry {
          display: inline-flex; align-items: center; justify-content: center;
          min-height: calc(var(--tl-control-height) - var(--tl-space-1)); padding: var(--tl-space-1) var(--tl-space-3);
          border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius);
          background: var(--tl-shell-surface); color: var(--tl-shell-ink);
          font: inherit; cursor: pointer;
        }
        .tl-navigation .tl-conversation-entry:hover { background: var(--tl-shell-soft); }
        .tl-navigation .tl-conversation-entry[aria-current="page"] { background: var(--tl-shell-accent-soft); border-color: var(--tl-shell-accent); }
        .tl-navigation .tl-conversation-entry:disabled { opacity: .65; cursor: default; }
        .tl-navigation .tl-conversation-entry:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
        .tl-shell-top .tl-navigation .tl-conversation-entry:focus-visible,
        .tl-shell-top .tl-navigation .tl-scene-tab:focus-visible,
        .tl-shell-top .tl-navigation .tl-scene-layout-trigger:focus-visible { outline-offset: -2px; }
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
      const scale = workbenchUiTokens.fontBody / DEFAULT_WORKBENCH_FONT_BODY
      const gutter = Math.round(8 * scale)
      const gap = Math.round(8 * scale)
      const viewportWidth = viewport.width
      const viewportHeight = viewport.height
      const viewportLeft = viewport.left
      const viewportTop = viewport.top
      const width = Math.max(0, Math.min(Math.round(720 * scale), viewportWidth - gutter * 2))
      const minLeft = viewportLeft + gutter
      const maxLeft = Math.max(minLeft, viewportLeft + viewportWidth - gutter - width)
      const anchor = anchorRect ?? { left: minLeft, top: viewportTop + gutter, bottom: viewportTop + gutter }
      const below = Math.max(0, viewportTop + viewportHeight - anchor.bottom - gutter * 2)
      const above = Math.max(0, anchor.top - viewportTop - gutter * 2)
      const placeBelow = below >= Math.round(260 * scale) || below >= above
      const availableHeight = placeBelow ? below : above
      const maxHeight = Math.min(Math.round(680 * scale), availableHeight, Math.max(0, viewportHeight - gutter * 2))
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
      const [capabilityExpanded, setCapabilityExpanded] = React.useState({ mcp: true, tools: false })
      const [selectedCapabilitySkill, setSelectedCapabilitySkill] = React.useState('')
      const [capabilitySkillView, setCapabilitySkillView] = React.useState('list')
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
        setSelectedCapabilitySkill('')
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
          if (workspaceModalState().state?.owners.length) return
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
      const capabilityRoleLabel = roles.find(item => item.id === capabilityRole)?.label ?? capabilityRole
      const mcpLabels = {
        declared_only: '该预设声明了 MCP 客户端；这不代表当前会话已连接。',
        visible_tool: '当前助手可见 MCP 工具；这不代表服务器健康或已成功调用。',
        not_configured: '该预设未声明 MCP 客户端。',
        unavailable: 'MCP 声明状态暂不可用。',
      }
      const skillItems = capabilityData?.skills?.items
      const toolItems = capabilityData?.tools?.items
      function capabilityCountSummary() {
        if (capabilityInfo.status !== 'ready') return ''
        if (capabilityData?.status !== 'ready') return ''
        const counts = []
        if (capabilityData.skills?.status === 'available') {
          const count = Number.isInteger(capabilityData.skills.total) ? capabilityData.skills.total : (skillItems?.length ?? 0)
          if (Number.isInteger(capabilityData.skills.total) || Array.isArray(skillItems)) counts.push(`Skill ${count}`)
        }
        if (capabilityData.tools?.status === 'available') {
          const count = Number.isInteger(capabilityData.tools.total) ? capabilityData.tools.total : (toolItems?.length ?? 0)
          if (Number.isInteger(capabilityData.tools.total) || Array.isArray(toolItems)) counts.push(`工具 ${count}`)
        }
        if (Array.isArray(capabilityData.mcp?.visibleTools)) counts.push(`MCP 已返回 ${capabilityData.mcp.visibleTools.length}${capabilityData.mcp.visibleToolsTruncated ? ' · 已截断' : ''}`)
        return counts.join(' · ')
      }
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
          if (capabilityInfo.status === 'loading') content.push(h('p', { key: 'loading', className: 'tl-capability-notice', role: 'status' }, '正在读取当前助手能力…'))
          if (capabilityInfo.status === 'error') content.push(h('div', { key: 'error', className: 'tl-capability-notice is-error', role: 'alert' },
            h('p', null, capabilityInfo.error),
            h('button', { type: 'button', onClick: () => { void loadCapabilities(capabilityRole) } }, '重试')))
          if (capabilityData?.status === 'not_bound') {
            content.push(h('p', { key: 'not-bound', className: 'tl-capability-notice', role: 'status' }, '该助手当前没有已绑定的原生会话，工具与 Skill 能力未知。'))
            content.push(h('h4', { key: 'mcp-title' }, 'MCP'))
            content.push(h('p', { key: 'mcp-status' }, mcpLabels[capabilityData.mcp?.status] ?? mcpLabels.unavailable))
          }
          if (capabilityData?.status === 'ready') {
            const mcpVisibleTools = capabilityData.mcp?.visibleTools
            const mcpCount = Array.isArray(mcpVisibleTools) ? `已返回 ${mcpVisibleTools.length} 项` : '数量未知'
            const mcpContent = Array.isArray(mcpVisibleTools) && mcpVisibleTools.length
              ? h('ul', { className: 'tl-capability-tool-list', 'aria-label': '当前可见 MCP 工具' },
                mcpVisibleTools.map(name => h('li', { key: name }, h('code', null, name))))
              : h('p', { className: 'tl-capability-empty' }, Array.isArray(mcpVisibleTools)
                ? '当前返回列表没有 MCP 工具。' : 'MCP 可见工具数量未知。')
            content.push(h('details', { key: 'mcp-group', className: 'tl-capability-group tl-capability-disclosure', open: capabilityExpanded.mcp,
              onToggle: event => { const open = event.currentTarget.open; setCapabilityExpanded(current => current.mcp === open ? current : { ...current, mcp: open }) } },
              h('summary', null, h('span', { id: 'tl-capability-mcp-title', className: 'tl-capability-group-title' }, 'MCP 可见工具'),
                h('span', { className: 'tl-capability-count' }, mcpCount)),
              h('div', { className: 'tl-capability-group-content' },
                h('p', { className: 'tl-capability-group-status' }, mcpLabels[capabilityData.mcp?.status] ?? mcpLabels.unavailable),
                h('p', { className: 'tl-capability-group-status' }, '服务归属与连接状态：未知（尚未提供观测）。'),
                capabilityData.mcp?.visibleToolsTruncated
                  ? h('p', { className: 'tl-capability-notice', role: 'status' }, `MCP 列表已截断；${mcpCount}，完整数量未知。`) : null,
                mcpContent)))

            const toolCount = Number.isInteger(capabilityData.tools?.total) ? capabilityData.tools.total : (Array.isArray(toolItems) ? toolItems.length : null)
            const toolContent = capabilityData.tools?.status === 'available'
              ? (toolItems?.length
                ? h('ul', { className: 'tl-capability-tool-list', 'aria-label': '当前助手可见工具' },
                  toolItems.map(item => h('li', { key: item.name }, h('code', null, item.name))))
                : h('p', { className: 'tl-capability-empty' }, Array.isArray(toolItems) ? '当前助手没有已列出的工具。' : '工具列表未知。'))
              : h('p', { className: 'tl-capability-empty' }, '工具目录暂不可用。')
            content.push(h('details', { key: 'tools-group', className: 'tl-capability-group tl-capability-disclosure', open: capabilityExpanded.tools,
              onToggle: event => { const open = event.currentTarget.open; setCapabilityExpanded(current => current.tools === open ? current : { ...current, tools: open }) } },
              h('summary', null, h('span', { id: 'tl-capability-tools-title', className: 'tl-capability-group-title' }, '全部可见工具'),
                h('span', { className: 'tl-capability-count' }, toolCount !== null && capabilityData.tools?.status === 'available' ? `${toolCount} 项` : '数量未知')),
              h('div', { className: 'tl-capability-group-content' },
                h('p', { className: 'tl-capability-group-status' }, '含上方 MCP 工具；此处为当前助手可见目录。'),
                capabilityData.tools?.truncated ? h('p', { className: 'tl-capability-notice', role: 'status' }, `工具列表已截断，当前共 ${capabilityData.tools.total} 项。`) : null,
                toolContent)))

            const skillCount = Number.isInteger(capabilityData.skills?.total) ? capabilityData.skills.total : (Array.isArray(skillItems) ? skillItems.length : null)
            const skillCards = skillItems?.length
              ? h('div', { className: 'tl-capability-skill-grid', 'data-display-mode': capabilitySkillView, role: 'list', 'aria-label': '当前助手范围内的 Skill' },
                skillItems.map(item => {
                  const selected = selectedCapabilitySkill === item.name
                  return h('article', { key: item.name, role: 'listitem', className: 'tl-capability-skill-item' },
                    h('button', {
                      type: 'button', className: 'tl-capability-skill-card',
                      'aria-pressed': selected, 'aria-expanded': selected, onClick: () => setSelectedCapabilitySkill(selected ? '' : item.name),
                    },
                    h('span', { className: 'tl-capability-skill-title' }, h('strong', null, item.name),
                      h('span', { className: 'tl-capability-skill-kind' }, 'Skill')),
                    item.description ? h('span', { className: 'tl-capability-skill-description' }, item.description) : null,
                    h('span', { className: 'tl-capability-skill-meta' },
                      item.source ? h('span', { className: 'tl-capability-skill-source' }, `来源 · ${item.source}`) : null,
                      h('span', { className: `tl-capability-skill-state${item.invocation?.modelInvocable === true ? ' is-available' : ''}` }, `模型调用 ${item.invocation?.modelInvocable === true ? '可用' : item.invocation?.modelInvocable === false ? '不可用' : '未知'}`),
                      h('span', { className: `tl-capability-skill-state${item.invocation?.userInvocable === true ? ' is-available' : ''}` }, `用户调用 ${item.invocation?.userInvocable === true ? '可用' : item.invocation?.userInvocable === false ? '不可用' : '未知'}`))))
                }))
              : h('p', { className: 'tl-capability-empty' }, Array.isArray(skillItems) ? '当前助手范围内没有已列出的 Skill。' : 'Skill 列表未知。')
            const skillContent = capabilityData.skills?.status === 'available'
              ? skillCards
              : h('p', { className: 'tl-capability-empty' }, 'Skill 目录暂不可用。')
            content.push(h('section', { key: 'skills-group', className: 'tl-capability-group tl-capability-skill-group', 'aria-labelledby': 'tl-capability-skills-title' },
              h('div', { className: 'tl-capability-group-heading' },
                h('h4', { id: 'tl-capability-skills-title' }, 'Skill'),
                h('div', { className: 'tl-capability-view-switch', role: 'group', 'aria-label': 'Skill显示方式' },
                  ...[['list', '列表'], ['grid', '卡片']].map(([view, label]) => h('button', { key: view, type: 'button', 'aria-pressed': capabilitySkillView === view, onClick: () => setCapabilitySkillView(view) }, label))),
                capabilityData.skills?.status === 'available' ? h('span', { className: 'tl-capability-count' }, skillCount === null ? '数量未知' : String(skillCount)) : null),
              skillContent))
            if (capabilityData.skills?.truncated || capabilityData.skills?.complete === false) {
              content.push(h('p', { key: 'skills-incomplete' }, `Skill 列表不完整${Number.isInteger(capabilityData.skills.total) ? `，当前共 ${capabilityData.skills.total} 项` : ''}。`))
            }
          }
        }
        const visualViewport = window.visualViewport
        const bounds = capabilityPanelBounds ?? capabilityPanelPlacement(null, {
          width: Number(visualViewport?.width) > 0 ? Number(visualViewport.width) : window.innerWidth || 0,
          height: Number(visualViewport?.height) > 0 ? Number(visualViewport.height) : window.innerHeight || 0,
          left: Number(visualViewport?.offsetLeft) || 0,
          top: Number(visualViewport?.offsetTop) || 0,
        })
        const panel = h('section', {
          className: `tl-agent-capabilities tl-shell-top is-${activeColorScheme}`, role: 'dialog', 'aria-modal': 'true',
          'aria-labelledby': 'tl-agent-capabilities-title',
          style: { position: 'relative', left: 'auto', top: 'auto', width: 'min(calc(720px * var(--tl-ui-scale, 1)), calc(100% - var(--tl-space-5) * 2))', maxHeight: 'calc(100% - var(--tl-space-5) * 2)' },
        },
        h('header', { className: 'tl-agent-capabilities-header' },
          h('div', { className: 'tl-agent-capabilities-heading' },
            h('h3', { id: 'tl-agent-capabilities-title' }, `助手能力 · ${capabilityRoleLabel || '当前助手'}`),
            capabilityTab === 'current' && capabilityCountSummary()
              ? h('span', { className: 'tl-agent-capabilities-counts', 'aria-label': '能力目录数量' }, capabilityCountSummary()) : null),
          h('div', { className: 'tl-agent-capabilities-header-actions' },
            capabilityTab === 'current' && capabilityInfo.status === 'ready'
              ? h('button', { type: 'button', onClick: () => { void loadCapabilities(capabilityRole) }, title: '重新读取当前助手能力' }, '重新读取') : null,
            h('button', { ref: capabilityCloseRef, type: 'button', 'aria-label': '关闭助手能力与配置', onClick: closeCapabilities, title: '关闭' }, '×'))),
        h('div', { className: 'tl-agent-capabilities-body', style: { minHeight: 0, overflowY: 'auto', flex: '1 1 auto' } }, ...content))
        return h(WorkspaceModalLayer, { onClose: closeCapabilities }, panel)
      }
      return h('section', { className: 'tl-agent-directory', 'aria-label': '助手选择' },
        h('style', { 'data-tradeloom-agent-style': 'true' }, `
          .tl-agent-directory {
            position: relative; flex: 0 0 auto;
            color: var(--tl-shell-ink);
            font-family: var(--tl-font-family);
            font-size: var(--tl-font-compact);
          }
          .tl-agent-selector { position: relative; }
          .tl-agent-selector > summary {
            display: inline-flex; align-items: center; min-height: var(--tl-control-height); padding: var(--tl-space-1) var(--tl-space-3);
            border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius);
            background: var(--tl-shell-surface); color: inherit; font: inherit;
            cursor: pointer; list-style: none; white-space: nowrap;
          }
          .tl-agent-selector > summary::-webkit-details-marker { display: none; }
          .tl-agent-selector > summary:focus-visible { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
          .tl-agent-selector[open] > summary { background: var(--tl-shell-soft); }
          .tl-agent-menu {
            position: absolute; top: calc(100% + var(--tl-space-1)); left: 0; z-index: 60;
            display: grid; gap: var(--tl-space-1); min-width: calc(170px * var(--tl-ui-scale, 1)); padding: var(--tl-space-2);
            border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius);
            background: var(--tl-shell-surface); color: inherit;
            box-shadow: 0 8px 22px rgba(0,0,0,.16);
          }
          .tl-agent-directory button, .tl-agent-capabilities button {
            font: inherit;
            color: inherit;
            min-height: var(--tl-control-height);
            text-align: left;
            padding: var(--tl-space-2) var(--tl-space-3);
            border: 1px solid transparent;
            border-radius: var(--tl-corner-radius);
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
          /* Body portal layer: above Dockview's z-index:99 sash, shared with fixed shell overlays. */
          .tl-agent-capabilities { z-index: var(--tl-shell-overlay-z, 1100); display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; padding: 0; border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); background: var(--tl-shell-surface); color: var(--tl-shell-ink); box-shadow: 0 8px 22px rgba(0,0,0,.16); white-space: normal; font-family: var(--tl-font-family); font-size: var(--tl-font-compact); }
          .tl-agent-capabilities-header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; gap: var(--tl-space-3); min-height: calc(42px * var(--tl-ui-scale, 1)); padding: var(--tl-space-2) var(--tl-space-3) var(--tl-space-2) var(--tl-space-4); border-bottom: 1px solid var(--tl-shell-line); background: linear-gradient(115deg, var(--tl-theme-header), var(--tl-theme-panel)); }
          .tl-agent-capabilities-heading { display: grid; min-width: 0; gap: var(--tl-space-1); }
          .tl-agent-capabilities-header h3 { min-width: 0; margin: 0; font-size: var(--tl-font-body); font-weight: 650; line-height: 1.25; }
          .tl-agent-capabilities-counts { color: var(--tl-shell-muted); font-size: var(--tl-font-compact); font-variant-numeric: tabular-nums; }
          .tl-agent-capabilities-header-actions { display: flex; flex: 0 0 auto; align-items: center; gap: var(--tl-space-1); }
          .tl-agent-capabilities-header-actions button { min-height: var(--tl-control-height); padding: var(--tl-space-1) var(--tl-space-2); border-color: var(--tl-shell-line); background: color-mix(in srgb, var(--tl-theme-panel) 70%, transparent); font-size: var(--tl-font-compact); }
          .tl-agent-capabilities-header-actions button:last-child { min-width: var(--tl-control-height); padding: var(--tl-space-1); text-align: center; font-size: var(--tl-font-body); line-height: 1; }
          .tl-agent-capabilities-body { padding: var(--tl-space-4) var(--tl-space-5) var(--tl-space-5); }
          .tl-agent-capabilities p { margin: var(--tl-space-2) 0; color: var(--tl-shell-muted); font-size: var(--tl-font-compact); line-height: var(--tl-line-height); }
          .tl-agent-capabilities select { max-width: 100%; min-height: var(--tl-control-height); font: inherit; color: inherit; background: var(--tl-shell-surface); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); }
          .tl-agent-capabilities ul { padding: 0; margin: var(--tl-space-2) 0 var(--tl-space-1); list-style: none; }
          .tl-agent-capabilities li { margin: 0; overflow-wrap: anywhere; font-size: var(--tl-font-compact); }
          .tl-capability-group { min-width: 0; margin: var(--tl-space-4) 0 calc(var(--tl-space-5) + var(--tl-space-2)); }
          .tl-capability-group-heading { display: flex; align-items: center; gap: var(--tl-space-3); margin-bottom: var(--tl-space-1); }
          .tl-capability-group-heading h4 { margin: 0; font-size: var(--tl-font-compact); font-weight: 650; }
          .tl-capability-count { display: inline-flex; align-items: center; justify-content: center; min-width: calc(20px * var(--tl-ui-scale, 1)); height: calc(20px * var(--tl-ui-scale, 1)); padding: 0 var(--tl-space-1); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); color: var(--tl-shell-muted); font-size: var(--tl-font-compact); font-variant-numeric: tabular-nums; }
          .tl-capability-group-status { margin: var(--tl-space-1) 0 var(--tl-space-2) !important; }
          .tl-capability-disclosure { margin: var(--tl-space-3) 0; border: 0; border-top: 1px solid var(--tl-shell-line); border-radius: 0; }
          .tl-capability-disclosure:focus-within { outline: 2px solid var(--tl-shell-accent); outline-offset: 2px; }
          .tl-capability-disclosure > summary { display: flex; align-items: baseline; gap: var(--tl-space-2); padding: var(--tl-space-2) var(--tl-space-3); cursor: pointer; list-style: none; }
          .tl-capability-disclosure > summary::-webkit-details-marker { display: none; }
          .tl-capability-disclosure > summary::before { content: '›'; flex: 0 0 auto; }
          .tl-capability-disclosure[open] > summary::before { content: '⌄'; }
          .tl-capability-group-title { flex: 1 1 auto; min-width: 0; font-weight: 650; overflow-wrap: anywhere; }
          .tl-capability-disclosure .tl-capability-count { flex: 0 1 auto; height: auto; min-width: 0; text-align: end; }
          .tl-capability-group-content { padding: 0 var(--tl-space-3) var(--tl-space-2); }
          .tl-capability-notice { padding: var(--tl-space-2) 0; overflow-wrap: anywhere; }
          .tl-capability-notice.is-error { padding-inline-start: var(--tl-space-3); border-inline-start: 3px solid var(--tl-shell-accent); }
          .tl-capability-tool-list { display: flex; flex-direction: column; gap: 0; }
          .tl-capability-tool-list li { min-width: 0; }
          .tl-capability-tool-list code { display: block; max-width: 100%; padding: var(--tl-space-1) 0; border-bottom: 1px solid var(--tl-shell-line); color: var(--tl-shell-ink); white-space: normal; overflow-wrap: anywhere; font: var(--tl-font-compact)/1.4 ui-monospace, SFMono-Regular, Consolas, monospace; }
          .tl-capability-skill-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(calc(260px * var(--tl-ui-scale, 1)), 100%), 1fr)); gap: var(--tl-space-3); }
          .tl-agent-capabilities .tl-capability-skill-card { position:relative; box-sizing:border-box; display:flex; width:100%; min-width:0; min-height:calc(84px * var(--tl-ui-scale,1)); flex-direction:column; align-items:stretch; gap:var(--tl-space-1); padding:var(--tl-space-2) var(--tl-space-3); border:1px solid var(--tl-shell-line); border-left:calc(3px * var(--tl-ui-scale,1)) solid var(--tl-theme-teal); border-radius:var(--tl-corner-radius); background:var(--tl-theme-canvas); white-space:normal; text-align:start; cursor:pointer; }
          .tl-agent-capabilities .tl-capability-skill-card:hover { border-color:var(--tl-shell-accent); border-left-color:var(--tl-theme-teal); background:var(--tl-theme-panel); }
          .tl-agent-capabilities .tl-capability-skill-card[aria-pressed="true"] { border-color:var(--tl-shell-accent); border-left-color:var(--tl-theme-teal); background:color-mix(in srgb,var(--tl-shell-accent-soft) 32%,var(--tl-theme-canvas)); box-shadow:0 0 8px color-mix(in srgb,var(--tl-shell-accent) 18%,transparent); }
          .tl-capability-skill-title { display: flex; min-width: 0; align-items: center; gap: var(--tl-space-2); }
          .tl-capability-skill-title strong { overflow: hidden; color: var(--tl-shell-ink); text-overflow: ellipsis; font-size: var(--tl-font-compact); }
          .tl-capability-skill-kind { flex: 0 0 auto; padding: var(--tl-space-1) var(--tl-space-2); border-radius: var(--tl-corner-radius); background: var(--tl-shell-accent-soft); color: var(--tl-shell-accent-strong); font-size: var(--tl-font-compact); font-weight: 600; }
          .tl-capability-skill-description { display:-webkit-box; overflow:hidden; color:var(--tl-shell-ink); font-size:var(--tl-font-compact); font-weight:400; line-height:1.45; overflow-wrap:anywhere; -webkit-box-orient:vertical; -webkit-line-clamp:2; }
          .tl-capability-skill-card[aria-expanded="true"] .tl-capability-skill-description { display:block; -webkit-line-clamp:unset; }
          .tl-capability-skill-meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--tl-space-1); margin-top: auto; }
          .tl-capability-skill-meta span { padding: var(--tl-space-1) var(--tl-space-2); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); color: var(--tl-shell-muted); font-size: var(--tl-font-compact); font-weight: 500; }
          .tl-capability-skill-meta .is-available { border-color: color-mix(in srgb, var(--tl-theme-success) 42%, var(--tl-shell-line)); color: var(--tl-theme-success); }
          .tl-capability-skill-grid[data-display-mode="list"] { grid-template-columns:minmax(0,1fr); }
          .tl-capability-skill-grid[data-display-mode="list"] .tl-capability-skill-card { min-height:0; }
          .tl-capability-view-switch { display:inline-flex; margin-inline-start:auto; border:1px solid var(--tl-shell-line); border-radius:var(--tl-corner-radius); padding:1px; }
          .tl-agent-capabilities .tl-capability-view-switch button { min-height:calc(var(--tl-control-height) * .8); padding:var(--tl-space-1) var(--tl-space-2); }
          .tl-capability-view-switch button[aria-pressed="true"] { color:var(--tl-shell-accent); background:var(--tl-shell-accent-soft); }
          .tl-capability-empty { padding: var(--tl-space-2) 0; }
          @media (max-width: 520px) { .tl-capability-skill-grid { grid-template-columns: minmax(0, 1fr); } }
          .tl-agent-capabilities .tl-capability-actions { display: flex; justify-content: flex-end; gap: var(--tl-space-2); margin-top: var(--tl-space-3); }
          .tl-agent-capabilities .tl-capability-tabs, .tl-agent-capabilities .tl-config-actions { display: flex; flex-wrap: wrap; gap: var(--tl-space-2); margin: var(--tl-space-3) 0; }
          .tl-agent-capabilities .tl-config-server { margin: var(--tl-space-3) 0; padding: var(--tl-space-3); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); }
          .tl-agent-capabilities .tl-config-server summary { cursor: pointer; font-weight: 600; }
          .tl-agent-capabilities .tl-config-fields { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--tl-space-3); margin-top: var(--tl-space-3); }
          .tl-agent-capabilities label { display: grid; gap: var(--tl-space-1); margin: var(--tl-space-2) 0; overflow-wrap: anywhere; }
          .tl-agent-capabilities input:not([type=checkbox]), .tl-agent-capabilities textarea { box-sizing: border-box; width: 100%; min-width: 0; min-height: var(--tl-control-height); padding: var(--tl-space-2) var(--tl-space-3); border: 1px solid var(--tl-shell-line); border-radius: var(--tl-corner-radius); color: var(--tl-shell-ink); background: var(--tl-shell-surface); font: inherit; }
          .tl-agent-capabilities textarea { min-height: calc(58px * var(--tl-ui-scale, 1)); resize: vertical; }
          .tl-agent-capabilities .tl-config-secret-ref { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--tl-space-2); padding: var(--tl-space-3) 0; border-top: 1px solid var(--tl-shell-line); }
          .tl-agent-capabilities .tl-config-presence { align-self: end; color: var(--tl-shell-muted); font-size: var(--tl-font-compact); }
          .tl-agent-capabilities .tl-config-tool-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(calc(180px * var(--tl-ui-scale, 1)), 100%), 1fr)); gap: var(--tl-space-1) var(--tl-space-3); }
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
          : h('p', { role: 'status', style: { margin: 'var(--tl-space-2)', color: 'var(--tl-shell-muted)', fontSize: 'var(--tl-font-compact)' } },
            roleMetadata.status === 'error' ? roleMetadata.error : '正在读取助手列表…'),
        h('button', { type: 'button', disabled: roles.length === 0, onClick: showCapabilities }, '查看 MCP 与 Skill 能力'))),
        roleMetadata.status === 'error' ? h('div', { role: 'alert', className: 'tl-agent-load-error' },
          h('span', null, roleMetadata.error),
          h('button', { type: 'button', onClick: retryRoles }, '重试助手列表')) : null,
        error ? h('p', { role: 'status', style: { color: 'var(--tl-shell-danger)', fontSize: 'var(--tl-font-compact)' } }, error) : null,
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
      inject: ['slots', 'layout', 'uiWorkspace', 'sessions', 'modelDirectories', 'remote', 'remote.session', 'remote.pluginInventory', 'locale', 'theme'],
      async apply(ctx) {
        layout = ctx.layout
        uiWorkspace = ctx.uiWorkspace
        shellSlots = ctx.slots
        shellPluginInventory = ctx.remote?.pluginInventory
        shellLocale = ctx.locale
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
