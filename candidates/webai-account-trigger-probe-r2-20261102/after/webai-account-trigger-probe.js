const PROVIDER_ORIGINS = Object.freeze({
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
})

const SAFE_TAGS = new Set(['a', 'button', 'div', 'input', 'li', 'path', 'span', 'svg'])
const SAFE_ROLES = new Set(['button', 'link', 'menu', 'menuitem', 'option', 'tab'])
const SAFE_EVIDENCE_KINDS = new Set(['ariaExactAssociation', 'pointerCandidate', 'activeOnly', 'none'])
const GLOBAL_CAPTURE_PREFIX = 'tradeloom.webai.account-trigger-capture.v1.'
const CAPTURE_DEADLINE_MS = 30_000

function neutralProjection(provider, reason = 'menuNotConfirmed') {
  return Object.freeze({
    status: 'unknown', provider, menuConfirmed: false, reason,
    relation: 'unknown', evidenceKind: 'none', matchedControlsCount: 0,
    ariaControlsElementsAvailable: null, pointerPath: Object.freeze([]), activeElement: null,
  })
}

/**
 * DOM-side fixed capture. It keeps a single trusted pointerdown candidate in memory,
 * and only projects it when the existing fixed account-menu probe passes its
 * provider-specific semantic check and calls projectConfirmedMenuTrigger(menu).
 */
export function createAccountMenuTriggerCapture(doc, provider) {
  if (!doc || !['deepseek', 'doubao'].includes(provider)) return null

  const globalKey = Symbol.for(`${GLOBAL_CAPTURE_PREFIX}${provider}`)
  let candidate = null
  let disposed = false
  let timer = null

  const removeListener = () => {
    try { doc.removeEventListener('pointerdown', onPointerDown, true) } catch {}
  }
  const dispose = () => {
    if (disposed) return
    disposed = true
    removeListener()
    try {
      if (timer !== null) {
        if (doc.defaultView?.clearTimeout) doc.defaultView.clearTimeout(timer)
        else clearTimeout(timer)
      }
    } catch {}
    timer = null
    candidate = null
    try {
      if (globalThis[globalKey] === capture) delete globalThis[globalKey]
    } catch {}
  }

  const onPointerDown = event => {
    if (disposed || candidate !== null) return
    let trusted = false
    try { trusted = event?.isTrusted === true } catch {}
    if (!trusted) return

    const path = []
    try {
      let node = event.target
      if (node && node.nodeType !== 1) node = node.parentElement
      for (let depth = 0; node && depth < 4; depth += 1) {
        if (node.nodeType !== 1 || node.ownerDocument !== doc) break
        path.push(node)
        node = node.parentElement
      }
    } catch {}
    candidate = Object.freeze({ trusted: true, path: Object.freeze(path) })
    removeListener()
  }

  const capture = Object.freeze({
    projectConfirmedMenuTrigger(menuElement) {
      if (disposed) return neutralProjection(provider, 'captureClosed')
      try {
        if (!menuElement || menuElement.nodeType !== 1 || menuElement.ownerDocument !== doc
          || menuElement.isConnected !== true || menuElement.getAttribute('role') !== 'menu') {
          return neutralProjection(provider, 'menuNotConfirmed')
        }
        if (provider === 'deepseek'
          && (!menuElement.classList?.contains('ds-dropdown-menu') || !menuElement.classList?.contains('ds-elevated'))) {
          return neutralProjection(provider, 'menuNotConfirmed')
        }

        const readCandidateClassTokens = element => {
          const result = []
          try {
            const list = element.classList
            const length = list?.length
            if (!Number.isSafeInteger(length) || length < 0) return Object.freeze(result)
            const limit = Math.min(64, length)
            for (let index = 0; index < limit; index += 1) {
              const token = typeof list.item === 'function' ? list.item(index) : list[index]
              if (typeof token !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(token)) continue
              if (!result.includes(token)) result.push(token)
              if (result.length === 8) break
            }
          } catch { return Object.freeze([]) }
          return Object.freeze(result)
        }

        const projectElement = (element, includeClassTokens = false) => {
          if (!element || element.nodeType !== 1 || element.ownerDocument !== doc) return null
          let rawTag = ''
          let rawRole = ''
          let hasControls = false
          let hasPopup = false
          let expanded = 'unknown'
          let visible = null
          let isConnected = false
          try {
            rawTag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : ''
            rawRole = element.getAttribute('role') ?? ''
            hasControls = element.hasAttribute('aria-controls')
            hasPopup = element.hasAttribute('aria-haspopup')
            const expandedValue = element.getAttribute('aria-expanded')
            expanded = expandedValue === 'true' || expandedValue === 'false' ? expandedValue : 'unknown'
            const style = doc.defaultView?.getComputedStyle?.(element)
            const opacity = Number.parseFloat(style?.opacity)
            visible = Boolean(style && style.display !== 'none' && style.visibility !== 'hidden'
              && style.visibility !== 'collapse' && Number.isFinite(opacity) && opacity > 0
              && element.getClientRects().length > 0)
            isConnected = element.isConnected === true
          } catch { return null }
          const tag = SAFE_TAGS.has(rawTag) ? rawTag : 'other'
          const role = SAFE_ROLES.has(rawRole) ? rawRole : (rawRole ? 'other' : null)
          return Object.freeze({
            tag,
            ...(role ? { role } : {}),
            isButton: tag === 'button' || role === 'button',
            visible,
            hasAriaControls: hasControls,
            hasPopup,
            expanded,
            isConnected,
            ...(includeClassTokens ? { classTokens: readCandidateClassTokens(element) } : {}),
          })
        }

        const liveCandidatePath = candidate?.trusted
          ? candidate.path.filter(element => {
            try { return element.isConnected === true && element.ownerDocument === doc } catch { return false }
          }).slice(0, 4)
          : []
        const pointerPath = liveCandidatePath.map(element => projectElement(element, true)).filter(Boolean).slice(0, 4)
        let matched = 0
        let controlsSupported = false
        let controlsUnknown = false
        for (const element of liveCandidatePath) {
          const safe = projectElement(element)
          if (!safe?.isButton) continue
          let hasProperty = false
          let refs
          try {
            hasProperty = 'ariaControlsElements' in element
            if (hasProperty) refs = element.ariaControlsElements
          } catch { controlsUnknown = true; continue }
          if (!hasProperty) continue
          controlsSupported = true
          if (refs == null) continue
          let length
          try { length = refs.length } catch { controlsUnknown = true; continue }
          if (!Number.isSafeInteger(length) || length < 0 || length > 8) {
            controlsUnknown = true
            continue
          }
          for (let index = 0; index < length; index += 1) {
            try { if (refs[index] === menuElement) matched = Math.min(2, matched + 1) }
            catch { controlsUnknown = true }
          }
        }

        let activeElement = null
        if (pointerPath.length === 0) {
          let active = null
          try { active = doc.activeElement } catch {}
          const safeActive = projectElement(active)
          if (safeActive) {
            let inside = false
            let node = active
            try {
              for (let depth = 0; node && depth < 3; depth += 1) {
                if (node === menuElement) { inside = true; break }
                node = node.parentElement
              }
            } catch {}
            activeElement = Object.freeze({
              tag: safeActive.tag,
              ...(safeActive.role ? { role: safeActive.role } : {}),
              isButton: safeActive.isButton,
              visible: safeActive.visible,
              insideConfirmedMenu: inside,
              hasAriaControls: safeActive.hasAriaControls,
            })
          }
        }

        let evidenceKind = 'none'
        let relation = 'unknown'
        if (!controlsUnknown && matched === 1) {
          evidenceKind = 'ariaExactAssociation'
          relation = 'linked'
        } else if (pointerPath.length > 0) evidenceKind = 'pointerCandidate'
        else if (activeElement) evidenceKind = 'activeOnly'

        const result = Object.freeze({
          status: 'observed', provider, menuConfirmed: true, reason: 'observed', relation,
          evidenceKind, matchedControlsCount: Math.min(2, matched),
          ariaControlsElementsAvailable: controlsSupported ? true : (controlsUnknown ? null : false),
          pointerPath: Object.freeze(pointerPath), activeElement,
        })
        dispose()
        return result
      } catch {
        dispose()
        return neutralProjection(provider, 'probeError')
      }
    },
    dispose,
  })

  try {
    const previous = globalThis[globalKey]
    previous?.dispose?.()
  } catch {}
  try {
    Object.defineProperty(globalThis, globalKey, { configurable: true, value: capture })
    doc.addEventListener('pointerdown', onPointerDown, { capture: true, passive: true })
    timer = doc.defaultView?.setTimeout
      ? doc.defaultView.setTimeout(dispose, CAPTURE_DEADLINE_MS)
      : setTimeout(dispose, CAPTURE_DEADLINE_MS)
  } catch {
    dispose()
    return null
  }
  return capture
}

export function accountMenuTriggerCaptureInstallScript(provider) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider)) throw new TypeError('unsupported_provider')
  return `(() => {
    const GLOBAL_CAPTURE_PREFIX = ${JSON.stringify(GLOBAL_CAPTURE_PREFIX)};
    const CAPTURE_DEADLINE_MS = ${CAPTURE_DEADLINE_MS};
    const SAFE_TAGS = new Set(${JSON.stringify([...SAFE_TAGS])});
    const SAFE_ROLES = new Set(${JSON.stringify([...SAFE_ROLES])});
    const neutralProjection = ${neutralProjection.toString()};
    const createAccountMenuTriggerCapture = ${createAccountMenuTriggerCapture.toString()};
    return createAccountMenuTriggerCapture(document, ${JSON.stringify(provider)}) ? { armed: true } : { armed: false };
  })()`
}

export function accountMenuTriggerCaptureCancelScript(provider) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider)) throw new TypeError('unsupported_provider')
  return `(() => {
    const key = Symbol.for(${JSON.stringify(`${GLOBAL_CAPTURE_PREFIX}${provider}`)});
    try { globalThis[key]?.dispose?.() } catch {}
    return { cancelled: true };
  })()`
}

/** Fixed expression to splice into the existing confirmed-menu branch; expects local `menu`. */
export function accountMenuTriggerCaptureConfirmedMenuExpression(provider) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider)) throw new TypeError('unsupported_provider')
  const key = `${GLOBAL_CAPTURE_PREFIX}${provider}`
  return `globalThis[Symbol.for(${JSON.stringify(key)})]?.projectConfirmedMenuTrigger(menu) ?? null`
}

function isSafeProjection(value, provider) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = [
    'status', 'provider', 'menuConfirmed', 'reason', 'relation', 'evidenceKind',
    'matchedControlsCount', 'ariaControlsElementsAvailable', 'pointerPath', 'activeElement',
  ].sort()
  const keys = Object.keys(value).sort()
  if (keys.length !== allowed.length || keys.some((key, index) => key !== allowed[index])) return false
  if (value.provider !== provider || typeof value.menuConfirmed !== 'boolean'
    || !['observed', 'unknown'].includes(value.status)
    || !['observed', 'menuNotConfirmed', 'captureClosed', 'probeError'].includes(value.reason)
    || !['linked', 'unknown'].includes(value.relation)
    || !SAFE_EVIDENCE_KINDS.has(value.evidenceKind)
    || ![0, 1, 2].includes(value.matchedControlsCount)
    || ![true, false, null].includes(value.ariaControlsElementsAvailable)
    || !Array.isArray(value.pointerPath) || value.pointerPath.length > 4) return false
  if (value.pointerPath.some(item => !isSafeElementProjection(item))) return false
  if (value.activeElement !== null && !isSafeActiveProjection(value.activeElement)) return false
  if (!value.menuConfirmed) {
    return value.status === 'unknown' && value.reason !== 'observed'
      && value.relation === 'unknown' && value.evidenceKind === 'none'
      && value.matchedControlsCount === 0 && value.pointerPath.length === 0 && value.activeElement === null
  }
  if (value.status !== 'observed' || value.reason !== 'observed') return false
  if (value.evidenceKind === 'ariaExactAssociation') return value.relation === 'linked' && value.matchedControlsCount === 1
  if (value.relation === 'linked') return false
  if (value.evidenceKind === 'pointerCandidate') return value.pointerPath.length > 0
  if (value.evidenceKind === 'activeOnly') return value.pointerPath.length === 0 && value.activeElement !== null
  return value.pointerPath.length === 0 && value.activeElement === null && value.matchedControlsCount === 0
}

function isSafeElementProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = ['tag', 'role', 'isButton', 'visible', 'hasAriaControls', 'hasPopup', 'expanded', 'isConnected', 'classTokens'].sort()
  const keys = Object.keys(value).sort()
  return keys.every(key => allowed.includes(key)) && keys.includes('tag') && keys.includes('isButton')
    && keys.includes('visible') && keys.includes('hasAriaControls') && keys.includes('hasPopup')
    && keys.includes('expanded') && keys.includes('isConnected') && keys.includes('classTokens')
    && (value.role === undefined || value.role === null || SAFE_ROLES.has(value.role) || value.role === 'other')
    && (SAFE_TAGS.has(value.tag) || value.tag === 'other')
    && typeof value.isButton === 'boolean' && [true, false, null].includes(value.visible)
    && typeof value.hasAriaControls === 'boolean' && typeof value.hasPopup === 'boolean'
    && ['true', 'false', 'unknown'].includes(value.expanded) && typeof value.isConnected === 'boolean'
    && Array.isArray(value.classTokens) && value.classTokens.length <= 8
    && value.classTokens.every(token => typeof token === 'string' && /^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(token))
}

function isSafeActiveProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const allowed = ['tag', 'role', 'isButton', 'visible', 'insideConfirmedMenu', 'hasAriaControls'].sort()
  const keys = Object.keys(value).sort()
  return keys.every(key => allowed.includes(key)) && keys.includes('tag') && keys.includes('isButton')
    && keys.includes('visible') && keys.includes('insideConfirmedMenu') && keys.includes('hasAriaControls')
    && (value.role === undefined || SAFE_ROLES.has(value.role) || value.role === 'other')
    && (SAFE_TAGS.has(value.tag) || value.tag === 'other') && typeof value.isButton === 'boolean'
    && [true, false, null].includes(value.visible) && typeof value.insideConfirmedMenu === 'boolean'
    && typeof value.hasAriaControls === 'boolean'
}

function sanitizeProjection(value) {
  const pointerPath = Object.freeze(value.pointerPath.map(item => Object.freeze({
    tag: item.tag,
    ...(item.role === undefined ? {} : { role: item.role }),
    isButton: item.isButton,
    visible: item.visible,
    hasAriaControls: item.hasAriaControls,
    hasPopup: item.hasPopup,
    expanded: item.expanded,
    isConnected: item.isConnected,
    classTokens: Object.freeze([...item.classTokens]),
  })))
  const activeElement = value.activeElement === null ? null : Object.freeze({
    tag: value.activeElement.tag,
    ...(value.activeElement.role === undefined ? {} : { role: value.activeElement.role }),
    isButton: value.activeElement.isButton,
    visible: value.activeElement.visible,
    insideConfirmedMenu: value.activeElement.insideConfirmedMenu,
    hasAriaControls: value.activeElement.hasAriaControls,
  })
  return Object.freeze({
    status: value.status, provider: value.provider, menuConfirmed: value.menuConfirmed,
    reason: value.reason, relation: value.relation, evidenceKind: value.evidenceKind,
    matchedControlsCount: value.matchedControlsCount,
    ariaControlsElementsAvailable: value.ariaControlsElementsAvailable,
    pointerPath, activeElement,
  })
}

function originOf(identity, generation) {
  if (!identity || identity.alive !== true || typeof identity.url !== 'string'
    || typeof identity.documentId !== 'string' || !Number.isSafeInteger(generation)) return null
  try { return { origin: new URL(identity.url).origin, documentId: identity.documentId, generation } }
  catch { return null }
}

function unknownResult(provider, reason) {
  return Object.freeze({
    status: 'unknown', provider, menuConfirmed: false, reason,
    relation: 'unknown', evidenceKind: 'none', matchedControlsCount: 0,
    ariaControlsElementsAvailable: null, pointerPath: Object.freeze([]), activeElement: null,
  })
}

/** Host-only wrapper. Callbacks are fixed trusted closures; none accepts script or DOM input. */
export function createWebAiAccountTriggerProbe({
  provider, readDocumentIdentity, readGeneration, isOwnedAndFocused, executeArmCapture,
  executeConfirmedMenuProbe, executeCancelCapture, subscribeLifecycle,
}) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider)) throw new TypeError('unsupported_provider')
  let disposed = false
  let epoch = 0
  let armed = null
  let busy = false
  let cancelTail = Promise.resolve()
  const empty = reason => unknownResult(provider, reason)

  const identity = () => {
    try { return originOf(readDocumentIdentity(), readGeneration()) } catch { return null }
  }
  const owned = () => {
    try { return isOwnedAndFocused() === true } catch { return false }
  }
  const cancel = () => {
    const task = cancelTail.catch(() => {}).then(async () => {
      try { await executeCancelCapture?.() } catch {}
    })
    cancelTail = task
    return task
  }
  const invalidate = () => {
    epoch += 1
    armed = null
    return cancel()
  }
  let unsubscribe = () => {}
  try {
    if (typeof subscribeLifecycle === 'function') {
      unsubscribe = subscribeLifecycle(() => invalidate()) ?? (() => {})
    }
  } catch { unsubscribe = () => {} }

  return Object.freeze({
    async arm() {
      if (disposed) return false
      const cancellation = invalidate()
      const token = epoch
      await cancellation
      if (disposed || token !== epoch) return false
      const before = identity()
      if (!before || before.origin !== PROVIDER_ORIGINS[provider] || !owned()
        || typeof executeArmCapture !== 'function' || typeof executeCancelCapture !== 'function') return false
      try {
        const result = await executeArmCapture()
        const after = identity()
        if (disposed || token !== epoch || !owned() || !after || after.origin !== before.origin
          || after.documentId !== before.documentId || after.generation !== before.generation
          || !result || result.armed !== true) {
          await invalidate()
          return false
        }
        armed = Object.freeze({ ...after, epoch: token })
        return true
      } catch {
        if (token === epoch) await invalidate()
        return false
      }
    },
    async sampleConfirmedMenu() {
      if (disposed || busy || !armed || typeof executeConfirmedMenuProbe !== 'function') return empty('unavailable')
      const token = epoch
      const before = identity()
      if (!before || !owned() || before.origin !== PROVIDER_ORIGINS[provider]
        || before.documentId !== armed.documentId || before.generation !== armed.generation
        || armed.epoch !== token) {
        await invalidate()
        return empty('stale')
      }
      busy = true
      try {
        const value = await executeConfirmedMenuProbe()
        const after = identity()
        if (disposed || token !== epoch || !owned() || !after || after.origin !== before.origin
          || after.documentId !== before.documentId || after.generation !== before.generation) {
          await invalidate()
          return empty('stale')
        }
        if (!isSafeProjection(value, provider)) return empty('invalidResult')
        return sanitizeProjection(value)
      } catch { return empty('probeFailed') }
      finally {
        busy = false
        if (token === epoch && armed?.epoch === token) {
          armed = null
          await cancel()
        }
      }
    },
    dispose() {
      if (disposed) return
      disposed = true
      invalidate()
      try { unsubscribe() } catch {}
      unsubscribe = () => {}
    },
  })
}

export function projectNoConfirmedMenu(provider) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider)) throw new TypeError('unsupported_provider')
  return neutralProjection(provider)
}
