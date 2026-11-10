const PROVIDER_ORIGINS = Object.freeze({
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
})

const REASONS = new Set([
  'no_binding', 'disposed', 'stale_context', 'negative_evidence', 'menu_not_confirmed',
  'menu_already_open', 'open_failed', 'open_not_dispatched', 'probe_failed', 'restore_failed',
  'restore_unconfirmed', 'observed', 'busy',
])

function safeContext(readContext, provider) {
  try {
    const value = readContext()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if ((typeof value.owner !== 'object' && typeof value.owner !== 'function') || value.owner === null
      || value.origin !== PROVIDER_ORIGINS[provider] || typeof value.documentId !== 'string'
      || value.documentId.length === 0 || !Number.isSafeInteger(value.generation) || value.generation < 0
      || value.alive !== true || value.focused !== true) return null
    return Object.freeze({
      owner: value.owner, origin: value.origin, documentId: value.documentId,
      generation: value.generation, alive: true, focused: true,
    })
  } catch { return null }
}

function sameContext(left, right) {
  return Boolean(left && right && left.owner === right.owner && left.origin === right.origin
    && left.documentId === right.documentId && left.generation === right.generation)
}

function contextMatches(readContext, provider, expected, attemptRevision, currentRevision, disposed) {
  if (disposed() || attemptRevision !== currentRevision()) return false
  return sameContext(expected, safeContext(readContext, provider))
}

function parseMenuObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const allowed = ['state', 'evidence', 'menuIdentity']
    if (Object.keys(value).some(key => !allowed.includes(key))) return null
    if (!['open', 'closed', 'negative', 'unknown'].includes(value.state)
      || !['positive', 'negative', 'unknown'].includes(value.evidence)) return null
    if (value.evidence === 'positive' && value.state !== 'open') return null
    if (value.state === 'negative' && value.evidence !== 'negative') return null
    if (value.state === 'open' && (typeof value.menuIdentity !== 'object' || value.menuIdentity === null)) return null
    if (value.menuIdentity !== undefined && (typeof value.menuIdentity !== 'object' || value.menuIdentity === null)) return null
    return Object.freeze({ state: value.state, evidence: value.evidence, menuIdentity: value.menuIdentity ?? null })
  } catch { return null }
}

function validBindingCapture(value, expectedContext, provider) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const keys = Object.keys(value).sort()
    if (keys.join(',') !== 'capability,context,proof') return null
    const proof = value.proof
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return null
    const proofKeys = Object.keys(proof).sort()
    if (proofKeys.join(',') !== 'exactLinkedButton,strictMenuPositive,trustedPointerDown'
      || proof.trustedPointerDown !== true || proof.strictMenuPositive !== true || proof.exactLinkedButton !== true) return null
    if (typeof value.capability !== 'object' || value.capability === null) return null
    const context = safeContext(() => value.context, provider)
    if (!sameContext(expectedContext, context)) return null
    return Object.freeze({ capability: value.capability, context })
  } catch { return null }
}

function result(provider, context, authState, evidence, operation, menuRestore, reason) {
  const safeReason = REASONS.has(reason) ? reason : 'menu_not_confirmed'
  return Object.freeze({
    provider,
    ...(context ? { generation: context.generation } : {}),
    authState,
    evidence,
    operation,
    menuRestore,
    reason: safeReason,
  })
}

function unknown(provider, context, reason, operation = 'unknown', menuRestore = 'not-needed') {
  return result(provider, context, 'unknown', 'none', operation, menuRestore, reason)
}

/**
 * Host-only coordinator for a fixed account-menu peek. Injected callbacks must be
 * trusted closures over the owned WebContents and isolated-world DOM references.
 * This module does not establish pointer trust, menu semantics, or DOM identity.
 */
export function createAccountMenuPeekController({
  provider,
  readContext,
  captureConfirmedTrigger,
  readBoundMenu,
  openBoundMenu,
  closeBoundMenu,
  subscribeLifecycle,
}) {
  if (!Object.hasOwn(PROVIDER_ORIGINS, provider)) throw new TypeError('unsupported_provider')
  for (const [name, callback] of Object.entries({ readContext, captureConfirmedTrigger, readBoundMenu, openBoundMenu, closeBoundMenu })) {
    if (typeof callback !== 'function') throw new TypeError(`missing_${name}`)
  }

  let disposed = false
  let operationRevision = 0
  let negativeRevision = 0
  let binding = null
  let busy = false
  let unsubscribe = () => {}

  const currentContext = () => safeContext(readContext, provider)
  const clearBinding = () => { binding = null }
  const invalidate = () => {
    operationRevision += 1
    clearBinding()
  }
  try {
    if (typeof subscribeLifecycle === 'function') unsubscribe = subscribeLifecycle(invalidate) ?? (() => {})
  } catch { unsubscribe = () => {} }

  const guard = (context, revision) => contextMatches(
    readContext, provider, context, revision, () => operationRevision, () => disposed,
  )

  return Object.freeze({
    /** Called only by the Host after its strict positive menu + trusted pointer + exact-link checks. */
    async bindFromConfirmedMenu() {
      if (disposed || busy) return false
      busy = true
      const before = currentContext()
      if (!before) { clearBinding(); busy = false; return false }
      const revision = operationRevision
      const negativeAtStart = negativeRevision
      try {
        const captured = await captureConfirmedTrigger()
        if (!guard(before, revision) || negativeAtStart !== negativeRevision) { clearBinding(); return false }
        const safe = validBindingCapture(captured, before, provider)
        if (!safe) { clearBinding(); return false }
        binding = safe
        return true
      } catch {
        clearBinding()
        return false
      } finally { busy = false }
    },

    /** One bounded Host operation; no renderer-supplied DOM or script input is accepted. */
    async peek() {
      if (disposed) return unknown(provider, null, 'disposed')
      if (busy) return unknown(provider, currentContext(), 'busy', 'busy')
      const currentBinding = binding
      if (!currentBinding) return unknown(provider, currentContext(), 'no_binding')
      const before = currentContext()
      if (!before || !sameContext(before, currentBinding.context)) {
        clearBinding()
        return unknown(provider, before, 'stale_context')
      }
      busy = true
      const revision = operationRevision
      const negativeAtStart = negativeRevision
      let negativeSeen = false
      let authState = 'unknown'
      let evidence = 'none'
      let operation = 'unknown'
      let menuRestore = 'not-needed'
      let reason = 'menu_not_confirmed'
      let dispatched = false
      let openedMenu = null
      let shouldRestore = false

      const stillOwned = () => guard(before, revision)
      const noteNegative = () => {
        if (!negativeSeen) negativeRevision += 1
        negativeSeen = true
        clearBinding()
        reason = 'negative_evidence'
        authState = 'unknown'
        evidence = 'none'
      }
      const readMenu = async expectedMenu => {
        try {
          const raw = await readBoundMenu(currentBinding.capability, expectedMenu)
          if (negativeRevision !== negativeAtStart) {
            negativeSeen = true
            clearBinding()
            authState = 'unknown'; evidence = 'none'; reason = 'negative_evidence'
          }
          if (!stillOwned()) return { stale: true, observation: null }
          const observation = parseMenuObservation(raw)
          return { stale: false, observation }
        } catch {
          if (negativeRevision !== negativeAtStart) {
            negativeSeen = true
            clearBinding()
            authState = 'unknown'; evidence = 'none'; reason = 'negative_evidence'
          }
          if (!stillOwned()) return { stale: true, observation: null }
          return { stale: false, observation: null }
        }
      }

      try {
        const initial = await readMenu(null)
        if (initial.stale) {
          clearBinding(); reason = 'stale_context'; menuRestore = 'unknown'
        } else {
          const start = initial.observation
          if (!start) reason = 'probe_failed'
          else if (start.evidence === 'negative' || start.state === 'negative') noteNegative()
          else if (negativeSeen) reason = 'negative_evidence'
          else if (start.state === 'open') {
            if (start.evidence === 'positive') {
              authState = 'authenticated'; evidence = 'account-menu'
              operation = 'already-open'; menuRestore = 'not-needed'; reason = 'menu_already_open'
            } else reason = 'menu_not_confirmed'
          } else if (start.state !== 'closed' || start.evidence === 'positive') reason = 'menu_not_confirmed'
          else {
            let openError = false
            const markDispatched = () => {
              if (!disposed && operationRevision === revision && stillOwned()) dispatched = true
            }
            try { await openBoundMenu(currentBinding.capability, markDispatched) }
            catch { openError = true }
            if (negativeRevision !== negativeAtStart) {
              negativeSeen = true; clearBinding(); authState = 'unknown'; evidence = 'none'; reason = 'negative_evidence'
            }
            if (!stillOwned()) {
              clearBinding(); reason = 'stale_context'; menuRestore = 'unknown'
            } else if (!dispatched) reason = openError ? 'open_failed' : 'open_not_dispatched'
            else {
              shouldRestore = true
              const afterOpen = await readMenu(null)
              if (afterOpen.stale) {
                clearBinding(); reason = 'stale_context'; menuRestore = 'unknown'
              } else {
                const opened = afterOpen.observation
                if (!opened || opened.state !== 'open' || !opened.menuIdentity) {
                  if (opened?.evidence === 'negative' || opened?.state === 'negative') noteNegative()
                  if (!negativeSeen) reason = opened ? 'menu_not_confirmed' : 'probe_failed'
                } else {
                  openedMenu = opened.menuIdentity
                  if (opened.evidence === 'negative') noteNegative()
                  else if (!negativeSeen && opened.evidence === 'positive') {
                    authState = 'authenticated'; evidence = 'account-menu'; reason = 'observed'
                  } else if (!negativeSeen) reason = openError ? 'open_failed' : 'menu_not_confirmed'
                }
              }
            }
          }
        }
      } catch {
        if (!negativeSeen) reason = 'probe_failed'
      } finally {
        if (shouldRestore && dispatched && !openedMenu && !disposed && stillOwned()) {
          const recoveryInspection = await readMenu(null)
          if (recoveryInspection.stale) {
            authState = 'unknown'; evidence = 'none'; operation = 'unknown'
            menuRestore = 'unknown'; reason = 'stale_context'
          } else {
            const observed = recoveryInspection.observation
            if (observed?.evidence === 'negative' || observed?.state === 'negative') noteNegative()
            if (observed?.state === 'open' && observed.menuIdentity) {
              openedMenu = observed.menuIdentity
            }
            if (openedMenu && !negativeSeen && observed?.evidence === 'positive') {
              authState = 'authenticated'; evidence = 'account-menu'
              if (reason === 'probe_failed' || reason === 'open_failed' || reason === 'menu_not_confirmed') reason = 'observed'
            }
          }
        }
        if (shouldRestore && openedMenu && dispatched && !disposed && currentContext()
          && sameContext(before, currentContext()) && currentContext()?.focused === true) {
          try { await closeBoundMenu(currentBinding.capability, openedMenu) } catch {}
          if (!stillOwned()) {
            authState = 'unknown'; evidence = 'none'; operation = 'unknown'
            menuRestore = 'unknown'; reason = 'stale_context'
          } else {
            let verified = null
            try {
              const raw = await readBoundMenu(currentBinding.capability, openedMenu)
              if (negativeRevision !== negativeAtStart) {
                negativeSeen = true; clearBinding(); authState = 'unknown'; evidence = 'none'; reason = 'negative_evidence'
              }
              if (stillOwned()) verified = parseMenuObservation(raw)
            } catch {}
            if (verified?.evidence === 'negative' || verified?.state === 'negative') noteNegative()
            if (!stillOwned()) {
              authState = 'unknown'; evidence = 'none'; operation = 'unknown'
              menuRestore = 'unknown'; reason = 'stale_context'
            } else if (verified?.state === 'closed' && verified.menuIdentity === openedMenu) {
              menuRestore = 'restored'
              operation = !negativeSeen && authState === 'authenticated' ? 'confirmed' : 'unknown'
              if (negativeSeen) reason = 'negative_evidence'
              else if (authState !== 'authenticated' && reason === 'observed') reason = 'menu_not_confirmed'
            } else {
              menuRestore = 'failed'
              operation = !negativeSeen && authState === 'authenticated' ? 'restore-failed' : 'unknown'
              if (!negativeSeen) reason = 'restore_failed'
            }
          }
        } else if (shouldRestore && dispatched && !stillOwned()) {
          menuRestore = 'unknown'
          authState = 'unknown'; evidence = 'none'; operation = 'unknown'; reason = 'stale_context'
        } else if (shouldRestore && dispatched) {
          menuRestore = 'unknown'
          operation = !negativeSeen && authState === 'authenticated' ? 'restore-failed' : 'unknown'
          if (negativeSeen) reason = 'negative_evidence'
          else reason = 'restore_unconfirmed'
        }
        if (!disposed && binding === currentBinding && !stillOwned()) clearBinding()
        busy = false
      }

      const finalContext = currentContext()
      if (!finalContext || !sameContext(before, finalContext) || !stillOwned()) {
        clearBinding()
        return unknown(provider, finalContext, 'stale_context', 'unknown', menuRestore === 'not-needed' ? 'unknown' : menuRestore)
      }
      if (negativeSeen || negativeRevision !== negativeAtStart) {
        clearBinding()
        return unknown(provider, before, 'negative_evidence', 'unknown', menuRestore)
      }
      return result(provider, before, authState, evidence, operation, menuRestore, reason)
    },

    /** Host lifecycle or a fixed negative observation invalidates the cached capability. */
    invalidate() { invalidate() },
    /** A known fixed negative clears the stored binding; an in-flight operation may still safely restore locally. */
    observeNegative() { negativeRevision += 1; clearBinding() },
    dispose() {
      if (disposed) return
      disposed = true
      invalidate()
      try { unsubscribe() } catch {}
      unsubscribe = () => {}
    },
  })
}
