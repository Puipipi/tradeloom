const FIXED_PROBE_PREFIX = 'tradeloom.webai.fixed-account-entry.v1.'
const R2_CAPTURE_PREFIX = 'tradeloom.webai.account-trigger-capture.v1.'

const PROVIDERS = Object.freeze({
  deepseek: Object.freeze({ origin: 'https://chat.deepseek.com' }),
  doubao: Object.freeze({ origin: 'https://www.doubao.com' }),
})

function isElement(value, doc) {
  try { return Boolean(value && value.nodeType === 1 && value.ownerDocument === doc && value.isConnected === true) }
  catch { return false }
}

function empty(provider, phase = 'open', reason = 'unknown') {
  const base = { provider, phase, reason }
  if (provider === 'deepseek') return Object.freeze({
    ...base, menuState: phase === 'open' ? 'unknown' : 'unknown', visibleCandidateCount: 'unknown',
    capturedPathMatchesCandidate: null,
  })
  return Object.freeze(phase === 'open' ? {
    ...base, menuState: 'unknown', visibleNavigationCount: 'unknown', insideNavigation: null,
    visibleMenuButtonCandidateCountInNavigation: 'unknown', capturedButtonIsUniqueCandidate: null,
    visiblePopupMenuButtonCountInNavigation: 'unknown', capturedButtonIsUniquePopupCandidate: null,
  } : {
    ...base, menuState: 'unknown', sameCapturedButton: null, closedHasAriaControls: null,
    closedHasPopupMenu: null, closedUniqueCandidate: null,
    visiblePopupMenuButtonCountInNavigation: 'unknown', capturedButtonIsUniquePopupCandidate: null,
  })
}

/**
 * Fixed same-realm account-entry observation. It accepts only references from the
 * existing fixed R2 capture hook; it never returns or serializes DOM references.
 */
export function createFixedAccountEntryProbe(doc, provider) {
  if (!doc || (provider !== 'deepseek' && provider !== 'doubao')) return null
  const expectedOrigin = PROVIDERS[provider].origin
  try { if (doc.location?.origin !== expectedOrigin) return null } catch { return null }
  let disposed = false
  let capturedEntry = null
  let confirmedMenu = null
  const countValue = size => size === 0 ? 0 : size === 1 ? 1 : '2_plus'

  const visible = element => {
    if (!isElement(element, doc)) return false
    try {
      const style = doc.defaultView?.getComputedStyle?.(element)
      const opacity = Number.parseFloat(style?.opacity)
      return Boolean(style && style.display !== 'none' && style.visibility !== 'hidden'
        && style.visibility !== 'collapse' && Number.isFinite(opacity) && opacity > 0
        && element.getClientRects().length > 0)
    } catch { return false }
  }
  const hasClass = (element, token) => {
    try { return element.classList?.contains(token) === true } catch { return false }
  }
  const roots = () => {
    try {
      const list = doc.querySelectorAll('nav,[role="navigation"]')
      if (!Number.isSafeInteger(list?.length) || list.length < 0 || list.length > 32) return null
      const found = []
      for (let index = 0; index < list.length; index += 1) found.push(list[index])
      const unique = [...new Set(found)].filter(element => isElement(element, doc) && visible(element))
      return unique.slice(0, 32)
    } catch { return null }
  }
  const popupButtonsInNavigation = navigationRoots => {
    try {
      const buttons = new Set()
      for (const root of navigationRoots) {
        const list = root.querySelectorAll('button[aria-haspopup="menu"]')
        const length = list?.length
        if (!Number.isSafeInteger(length) || length < 0 || length > 64) return null
        for (let index = 0; index < length; index += 1) {
          const button = list[index]
          if (!isElement(button, doc) || button.tagName?.toLowerCase() !== 'button') continue
          if (visible(button)) buttons.add(button)
          if (buttons.size > 64) return null
        }
      }
      return buttons
    } catch { return null }
  }
  const linked = (button, menu) => {
    try {
      if (!('ariaControlsElements' in button)) return null
      const refs = button.ariaControlsElements
      const length = refs?.length
      if (!Number.isSafeInteger(length) || length < 0 || length > 8) return null
      let matches = 0
      for (let i = 0; i < length; i += 1) if (refs[i] === menu) matches += 1
      return matches === 1
    } catch { return null }
  }
  const getMenuRoots = () => {
    try {
      const selector = provider === 'deepseek' ? '.ds-dropdown-menu.ds-elevated' : '[role="menu"]'
      const list = doc.querySelectorAll(selector)
      if (!Number.isSafeInteger(list?.length) || list.length < 0 || list.length > 32) return null
      const values = []
      for (let index = 0; index < list.length; index += 1) values.push(list[index])
      return [...new Set(values)].filter(element => isElement(element, doc) && visible(element))
    } catch { return null }
  }
  const deepseekCandidates = () => {
    try {
      const textLeaves = doc.querySelectorAll('._9d8da05')
      const avatarLeaves = doc.querySelectorAll('.fdf01f38')
      const textCount = textLeaves?.length
      const avatarCount = avatarLeaves?.length
      if (!Number.isSafeInteger(textCount) || !Number.isSafeInteger(avatarCount)
        || textCount < 0 || avatarCount < 0 || textCount > 64 || avatarCount > 64
        || textCount + avatarCount > 128) return null
      const candidates = new Set()
      const addCandidate = (leaf, kind) => {
        if (!isElement(leaf, doc)) return
        let candidate = leaf.parentElement
        if (kind === 'avatar') {
          if (!hasClass(candidate, 'ede5bc47')) return
          candidate = candidate.parentElement
        }
        const shared = candidate?.parentElement
        const outer = shared?.parentElement
        if (hasClass(candidate, '_2afd28d') && hasClass(shared, 'dc1f7bee')
          && hasClass(shared, '_4bcc731') && hasClass(outer, '_7b40dad')
          && hasClass(outer, 'f14f3a6d') && visible(candidate)) candidates.add(candidate)
      }
      for (let index = 0; index < textCount; index += 1) addCandidate(textLeaves[index], 'text')
      for (let index = 0; index < avatarCount; index += 1) addCandidate(avatarLeaves[index], 'avatar')
      return candidates
    } catch { return null }
  }
  const originStillOwned = () => {
    try { return doc.location?.origin === expectedOrigin } catch { return false }
  }

  const probe = Object.freeze({
    confirmMenu(menu, trustedPath) {
      capturedEntry = null
      confirmedMenu = null
      if (disposed || !originStillOwned() || !isElement(menu, doc) || !visible(menu)
        || !Array.isArray(trustedPath) || trustedPath.length > 4
        || !trustedPath.every(element => isElement(element, doc))) return empty(provider)
      try {
        const allMenus = getMenuRoots()
        if (!allMenus || !allMenus.includes(menu)) return empty(provider)
        if (provider === 'deepseek' && (!hasClass(menu, 'ds-dropdown-menu') || !hasClass(menu, 'ds-elevated'))) return empty(provider)
        confirmedMenu = menu
        if (provider === 'deepseek') {
          const candidates = deepseekCandidates()
          if (!candidates) return empty(provider, 'open', 'bounded_unknown')
          const count = candidates.size === 0 ? 0 : candidates.size === 1 ? 1 : '2_plus'
          const matched = count === 1 && trustedPath.includes([...candidates][0])
          capturedEntry = matched ? [...candidates][0] : null
          confirmedMenu = menu
          return Object.freeze({
            provider, phase: 'open', reason: count === 'unknown' ? 'bounded_unknown' : 'observed',
            menuState: 'open', visibleCandidateCount: count,
            capturedPathMatchesCandidate: count === 1 ? matched : null,
          })
        }

        const navigationRoots = roots()
        if (!navigationRoots) return empty(provider)
        const navigation = new Set(navigationRoots)
        const popupCandidates = popupButtonsInNavigation(navigationRoots)
        if (!popupCandidates) return empty(provider, 'open', 'bounded_unknown')
        const candidates = new Set()
        for (const button of popupCandidates) {
          try { if (button.hasAttribute('aria-controls')) candidates.add(button) }
          catch { return empty(provider, 'open', 'bounded_unknown') }
        }
        const count = candidates.size === 0 ? 0 : candidates.size === 1 ? 1 : '2_plus'
        const inside = trustedPath.some(element => navigation.has(element) || navigationRoots.some(root => {
          try { return root.contains(element) } catch { return false }
        }))
        const uniqueButton = count === 1 ? [...candidates][0] : null
        const association = uniqueButton ? linked(uniqueButton, menu) : false
        const captured = Boolean(uniqueButton && association === true && trustedPath.includes(uniqueButton))
        capturedEntry = captured ? uniqueButton : null
        if (navigationRoots.length !== 1) capturedEntry = null
        const popupCount = countValue(popupCandidates.size)
        const uniquePopupButton = popupCount === 1 ? [...popupCandidates][0] : null
        const capturedPopupUnique = Boolean(navigationRoots.length === 1 && uniquePopupButton
          && uniquePopupButton === capturedEntry && trustedPath.includes(uniquePopupButton))
        return Object.freeze({
          provider, phase: 'open', reason: 'observed', menuState: 'open',
          visibleNavigationCount: navigationRoots.length === 0 ? 0 : navigationRoots.length === 1 ? 1 : '2_plus',
          insideNavigation: trustedPath.length ? inside : null,
          visibleMenuButtonCandidateCountInNavigation: count,
          capturedButtonIsUniqueCandidate: count === 1 && navigationRoots.length === 1
            ? (association === null ? null : captured) : null,
          visiblePopupMenuButtonCountInNavigation: popupCount,
          capturedButtonIsUniquePopupCandidate: navigationRoots.length === 1
            ? (capturedEntry ? capturedPopupUnique : null) : null,
        })
      } catch { capturedEntry = null; return empty(provider) }
    },
    inspectClosed() {
      if (provider === 'deepseek') {
        const candidate = capturedEntry
        if (disposed || !candidate || !originStillOwned()) return empty(provider, 'closed')
        const candidates = deepseekCandidates()
        if (!candidates) return empty(provider, 'closed', 'bounded_unknown')
        const stillCandidate = candidates.size === 1 && candidates.has(candidate)
        let menuClosed = false
        try { menuClosed = Boolean(confirmedMenu && confirmedMenu.ownerDocument === doc
          && (confirmedMenu.isConnected !== true || !visible(confirmedMenu))) } catch {}
        const count = candidates.size === 0 ? 0 : candidates.size === 1 ? 1 : '2_plus'
        return Object.freeze({ provider, phase: 'closed', reason: stillCandidate && menuClosed ? 'observed' : 'unknown',
          menuState: menuClosed ? 'closed' : 'unknown', visibleCandidateCount: count,
          capturedPathMatchesCandidate: count === 1 ? stillCandidate : count === 0 ? false : null })
      }
      if (disposed || !capturedEntry || !originStillOwned()) return empty(provider, 'closed')
      const button = capturedEntry
      try {
        if (!isElement(button, doc)) return empty(provider, 'closed')
        const navRoots = roots()
        if (!navRoots) return empty(provider, 'closed')
        const inNav = navRoots.some(root => { try { return root.contains(button) } catch { return false } })
        if (!inNav || navRoots.length !== 1) return Object.freeze({
          provider, phase: 'closed', reason: 'entry_changed', menuState: 'unknown', sameCapturedButton: null,
          closedHasAriaControls: null, closedHasPopupMenu: null, closedUniqueCandidate: null,
          visiblePopupMenuButtonCountInNavigation: 'unknown', capturedButtonIsUniquePopupCandidate: null,
        })
        const popupCandidates = popupButtonsInNavigation(navRoots)
        if (!popupCandidates) return empty(provider, 'closed', 'bounded_unknown')
        const buttonCandidates = new Set()
        for (const candidate of popupCandidates) {
          try { if (candidate.hasAttribute('aria-controls')) buttonCandidates.add(candidate) }
          catch { return empty(provider, 'closed', 'bounded_unknown') }
        }
        const unique = buttonCandidates.size === 1 && buttonCandidates.has(button)
        const popupCount = countValue(popupCandidates.size)
        const uniquePopup = popupCount === 1 && popupCandidates.has(button)
        const menu = confirmedMenu
        let closed = false
        try { closed = Boolean(menu && menu.ownerDocument === doc && (menu.isConnected !== true || !visible(menu))) } catch {}
        return Object.freeze({
          provider, phase: 'closed', reason: unique ? (closed ? 'observed' : 'menu_still_open') : 'entry_changed',
          menuState: closed ? 'closed' : 'unknown', sameCapturedButton: true,
          closedHasAriaControls: button.hasAttribute('aria-controls'),
          closedHasPopupMenu: button.getAttribute('aria-haspopup') === 'menu',
          closedUniqueCandidate: unique,
          visiblePopupMenuButtonCountInNavigation: popupCount,
          capturedButtonIsUniquePopupCandidate: uniquePopup,
        })
      } catch { return empty(provider, 'closed') }
    },
    dispose() { disposed = true; capturedEntry = null; confirmedMenu = null },
  })
  return probe
}

export function fixedAccountEntryProbeInstallScript(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new TypeError('unsupported_provider')
  const key = `${FIXED_PROBE_PREFIX}${provider}`
  return `(() => { const key = Symbol.for(${JSON.stringify(key)}); const old = globalThis[key]; try { old?.dispose?.(); } catch {} const PROVIDERS = ${JSON.stringify(PROVIDERS)}; const isElement = ${isElement.toString()}; const empty = ${empty.toString()}; const create = ${createFixedAccountEntryProbe.toString()}; const probe = create(document, ${JSON.stringify(provider)}); if (!probe) return false; Object.defineProperty(globalThis, key, { configurable: true, value: probe }); return true; })()`
}

/** Expression for the small R2 hook patch; call in the same positive-menu script context where `menu` is local. */
export function fixedAccountEntryProbeR2ConfirmExpression(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new TypeError('unsupported_provider')
  return `globalThis[Symbol.for(${JSON.stringify(`${R2_CAPTURE_PREFIX}${provider}`)})]?.projectFixedAccountEntry(menu) ?? null`
}

export function fixedAccountEntryProbeClosedScript(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new TypeError('unsupported_provider')
  return `(() => globalThis[Symbol.for(${JSON.stringify(`${FIXED_PROBE_PREFIX}${provider}`)})]?.inspectClosed?.() ?? null)()`
}

export function fixedAccountEntryProbeDisposeScript(provider) {
  if (!Object.hasOwn(PROVIDERS, provider)) throw new TypeError('unsupported_provider')
  return `(() => { const key = Symbol.for(${JSON.stringify(`${FIXED_PROBE_PREFIX}${provider}`)}); try { globalThis[key]?.dispose?.(); delete globalThis[key]; } catch {} return true; })()`
}
