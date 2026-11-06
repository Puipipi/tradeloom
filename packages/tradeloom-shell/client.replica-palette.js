window.__ModuleLoader__.load({
  id: '@tradeloom/dsh-business-shell',
  chunk: 'client.replica-palette.js',
  factory() {
    const tokenMap = Object.freeze({
      '--dsw-alias-bg-base': 'bg',
      '--dsw-alias-bg-layer-1': 'bg-panel',
      '--dsw-alias-bg-layer-2': 'panel-header',
      '--dsw-alias-bg-layer-3': 'card',
      '--dsw-alias-bg-overlay': 'surface-raised',
      '--dsw-alias-border-l1': 'border',
      '--dsw-alias-border-l2': 'line-2',
      '--dsw-alias-brand-primary': 'accent',
      '--dsw-alias-label-primary': 'text',
      '--dsw-alias-label-secondary': 'text-dim',
      '--dsw-alias-label-tertiary': 'text-mute',
      '--dsw-alias-label-caption': 'text-dim',
      '--dsw-alias-label-dimmed': 'text-mute',
      '--dsw-alias-label-primary-foreground': 'accent-ink',
      '--dsw-alias-state-error-primary': 'err',
      '--dsw-alias-state-idle-primary': 'text-dim',
      '--dsw-alias-state-success-primary': 'ok',
      '--dsw-alias-state-warn-primary': 'warn',
      '--dsw-specific-sidebar-fill': 'panel-header',
      '--dsw-specific-sidebar-nav-item-active': 'surface-selected',
      '--dsw-specific-sidebar-nav-item-active-accent': 'accent',
      '--dsw-specific-sidebar-nav-item-hover': 'surface-hover',
      '--dsw-specific-input-major': 'input',
      '--dsw-alias-markdown-code-block': 'surface-code',
      '--dsw-alias-markdown-code-block-banner': 'surface-subtle',
      '--dsw-alias-markdown-inline-code': 'surface-code',
      '--dsw-alias-tooltip-bg': 'panel-header',
      '--dsw-alias-button-primary-fill': 'accent',
      '--dsw-alias-button-primary-hover': 'accent',
      '--dsw-alias-button-tool-bar-fill': 'surface-subtle',
      '--dsw-alias-button-tool-bar-hover': 'surface-hover',
      '--dsw-alias-button-ghost-active-fill': 'surface-selected',
      '--dsw-alias-button-ghost-active-hover': 'surface-hover',
      '--dsw-alias-button-ghost-active-border': 'border',
      '--dsw-alias-button-elevated-fill': 'surface-raised',
      '--dsw-alias-button-floating-fill': 'surface-raised',
      '--dsw-alias-button-floating-hover': 'surface-hover',
    })
    const cssHref = '/source-shell/renderer/replica-ui/palette-tokens.css'
    const byDocument = new WeakMap()
    const byTheme = new WeakMap()
    let sourceSequence = 0

    function waitForStylesheet(doc) {
      const cssUrl = new URL(cssHref, doc.baseURI).href
      const existing = [...doc.querySelectorAll('link[data-tradeloom-replica-palette]')]
        .find(link => link.href === cssUrl)
      if (existing?.sheet) return Promise.resolve({ link: existing, owned: false })
      if (existing) return new Promise((resolve, reject) => {
        existing.addEventListener('load', () => resolve({ link: existing, owned: false }), { once: true })
        existing.addEventListener('error', () => reject(new Error('replica-palette-stylesheet-failed')), { once: true })
      })
      const link = doc.createElement('link')
      link.rel = 'stylesheet'
      link.href = cssHref
      link.dataset.tradeloomReplicaPalette = '1'
      const ready = new Promise((resolve, reject) => {
        link.addEventListener('load', () => resolve({ link, owned: true }), { once: true })
        link.addEventListener('error', () => {
          link.remove()
          reject(new Error('replica-palette-stylesheet-failed'))
        }, { once: true })
      })
      ;(doc.head ?? doc.documentElement).appendChild(link)
      return ready
    }

    async function install(ctx) {
      const doc = window.document
      const theme = ctx?.theme
      if (!doc?.documentElement || typeof theme?.overrideTokens !== 'function') return () => {}
      let state = byDocument.get(doc)
      if (!state) {
        state = { refs: 0, stylesheet: waitForStylesheet(doc), link: null, linkOwned: false }
        byDocument.set(doc, state)
      }
      let layer
      try {
        const { link, owned } = await state.stylesheet
        state.link = link
        state.linkOwned ||= owned
        layer = byTheme.get(theme)
        if (!layer) {
          const tokenPairs = Object.fromEntries(Object.entries(tokenMap).map(([nativeName, replicaName]) => [nativeName, {
            light: `var(--tl-palette-light-${replicaName})`,
            dark: `var(--tl-palette-dark-${replicaName})`,
          }]))
          layer = { refs: 0, remove: theme.overrideTokens(`tradeloom-replica-palette:${++sourceSequence}`, tokenPairs) }
          byTheme.set(theme, layer)
        }
        layer.refs += 1
        state.refs += 1
      } catch (error) {
        if (state.refs === 0) {
          if (state.linkOwned && state.link?.dataset?.tradeloomReplicaPalette === '1') state.link.remove()
          byDocument.delete(doc)
        }
        throw error
      }
      let disposed = false
      return () => {
        if (disposed) return
        disposed = true
        try {
          layer.refs = Math.max(0, layer.refs - 1)
          if (layer.refs === 0) {
            try { layer.remove?.() } finally { byTheme.delete(theme) }
          }
        } finally {
          state.refs = Math.max(0, state.refs - 1)
          if (state.refs === 0) {
            if (state.linkOwned && state.link?.dataset?.tradeloomReplicaPalette === '1') state.link.remove()
            byDocument.delete(doc)
          }
        }
      }
    }

    function readWorkbenchPalette(colorScheme) {
      if (colorScheme !== 'light' && colorScheme !== 'dark') return null
      const doc = window.document
      const style = doc?.documentElement && window.getComputedStyle?.(doc.documentElement)
      if (!style) return null
      const canvas = doc.createElement('canvas')
      canvas.width = 1
      canvas.height = 1
      const context = canvas.getContext?.('2d', { willReadFrequently: true })
      if (!context) return null
      const result = {}
      for (const key of ['canvas', 'panel', 'header', 'border', 'text', 'muted', 'accent', 'accentStrong', 'accentSoft', 'teal', 'buttonInk', 'danger', 'dangerBackground', 'dangerBorder', 'warning', 'warningBackground', 'warningBorder', 'success', 'successBackground']) {
        const value = String(style.getPropertyValue(`--tl-workbench-${colorScheme}-${key}`) ?? '').trim()
        if (!value || !window.CSS?.supports?.('color', value)) return null
        context.clearRect(0, 0, 1, 1)
        context.fillStyle = value
        context.fillRect(0, 0, 1, 1)
        const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
        if (alpha !== 255) return null
        result[key] = `#${[red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('')}`
      }
      return result
    }

    return { install, readWorkbenchPalette }
  },
})
