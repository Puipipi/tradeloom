// Frozen cooked template from the current Main strict probe (UI18 source snapshot
// documented in BOOTSTRAP.md). Keep the existing R3 role gate and projector input.
function deepseekAccountMenuProbeScript() {
  return `(() => {
  const triggerResultKey = "__UI18_ACCOUNT_TRIGGER_RESULT_KEY__";
  const visible = element => {
    const style = getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && Number.isFinite(opacity) && opacity > 0 && element.getClientRects().length > 0;
  };
  const menus = Array.from(document.querySelectorAll('[role="menu"].ds-dropdown-menu.ds-elevated')).filter(visible);
  const labels = ['下载手机应用', '系统设置', '帮助与反馈', '退出登录'];
  const presence = Object.fromEntries(labels.map(label => [label, false]));
  let sameContainer = false;
  let triggerPresent = false;
  let triggerVisible = false;
  let hasPopup = false;
  let linked = false;
  let shortcutAttributePresent = false;
  const triggers = Array.from(document.querySelectorAll('button[aria-controls]'));
  for (const menu of menus) {
    const found = new Set();
    for (const node of menu.querySelectorAll('*')) {
      if (!visible(node) || typeof node.textContent !== 'string') continue;
      const label = node.textContent.replace(/\\s+/g, ' ').trim();
      if (labels.includes(label)) found.add(label);
    }
    for (const label of found) presence[label] = true;
    if (labels.every(label => found.has(label))) {
      sameContainer = true;
      const projection = globalThis[Symbol.for("tradeloom.webai.account-trigger-capture.v1.deepseek")]?.projectConfirmedMenuTrigger(menu) ?? null;
      if (projection !== null) globalThis[Symbol.for(triggerResultKey)] = projection;
    }
    if (found.size === 0) continue;
    const menuId = typeof menu.id === 'string' ? menu.id : '';
    if (!menuId) continue;
    for (const trigger of triggers) {
      const controls = trigger.getAttribute('aria-controls') || '';
      if (!controls.split(/\\s+/).includes(menuId)) continue;
      linked = true;
      triggerPresent = true;
      triggerVisible ||= visible(trigger);
      const popup = trigger.getAttribute('aria-haspopup');
      hasPopup ||= popup !== null && popup !== '' && popup !== 'false';
      shortcutAttributePresent ||= Boolean(trigger.getAttribute('aria-keyshortcuts'));
    }
  }
  return {
    menuVisible: menus.length > 0,
    downloadMobileAppVisible: presence['下载手机应用'],
    settingsVisible: presence['系统设置'],
    helpAndFeedbackVisible: presence['帮助与反馈'],
    logoutVisible: presence['退出登录'],
    sameContainer,
    triggerPresent,
    triggerVisible,
    hasPopup,
    linked,
    shortcutAttributePresent,
  };
})()`
}

const ORIGIN = 'https://chat.deepseek.com'
const STATE_KEY = 'tradeloom.webai.deepseek-account-bootstrap.v1'
const STRICT_KEYS = ['downloadMobileAppVisible', 'settingsVisible', 'helpAndFeedbackVisible', 'logoutVisible',
  'menuVisible', 'sameContainer', 'triggerPresent', 'triggerVisible', 'hasPopup', 'linked', 'shortcutAttributePresent']
const REASONS = new Set(['observed', 'existing_positive', 'negative_evidence', 'unsupported_context', 'stale_context',
  'busy', 'disposed', 'entry_missing', 'entry_ambiguous', 'probe_failed', 'menu_not_confirmed', 'open_failed',
  'restore_failed', 'restore_unconfirmed'])
let nextOperation = 0

function stageScript(stage, operationId) {
  const strictSource = deepseekAccountMenuProbeScript()
  const r2Hook = `const projection = globalThis[Symbol.for("tradeloom.webai.account-trigger-capture.v1.deepseek")]?.projectConfirmedMenuTrigger(menu) ?? null;
      if (projection !== null) globalThis[Symbol.for(triggerResultKey)] = projection;`
  const localHook = `globalThis[Symbol.for(STATE_KEY)]?.get(operationId)?.captureConfirmedMenu(menu);`
  const strictExpression = strictSource.replace(r2Hook, localHook)
  if (strictExpression === strictSource) throw new Error('strict_hook_source_mismatch')
  return `(async () => {
    const ORIGIN = 'https://chat.deepseek.com';
    const STATE_KEY = ${JSON.stringify(STATE_KEY)};
    const operationId = ${JSON.stringify(operationId)};
    const strictProbe = () => ${strictExpression};
    const visible = element => {
      try { const style = getComputedStyle(element); const opacity = Number.parseFloat(style.opacity);
        return element && element.nodeType === 1 && element.ownerDocument === document && element.isConnected === true
          && style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
          && Number.isFinite(opacity) && opacity > 0 && element.getClientRects().length > 0; } catch { return false; }
    };
    const has = (element, token) => { try { return element?.classList?.contains(token) === true; } catch { return false; } };
    const roots = () => {
      try { const list = document.querySelectorAll('.ds-dropdown-menu.ds-elevated');
        if (!Number.isSafeInteger(list?.length) || list.length < 0 || list.length > 32) return null;
        const result = []; for (let i = 0; i < list.length; i++) if (visible(list[i])) result.push(list[i]); return result;
      } catch { return null; }
    };
    const candidates = () => {
      try {
        const text = document.querySelectorAll('._9d8da05'), avatar = document.querySelectorAll('.fdf01f38');
        if (!Number.isSafeInteger(text?.length) || !Number.isSafeInteger(avatar?.length) || text.length < 0 || avatar.length < 0
          || text.length > 64 || avatar.length > 64 || text.length + avatar.length > 128) return null;
        const found = new Set();
        const add = (leaf, isAvatar) => {
          if (!leaf || leaf.ownerDocument !== document || leaf.isConnected !== true) return;
          let item = leaf.parentElement;
          if (isAvatar) { if (!has(item, 'ede5bc47')) return; item = item.parentElement; }
          const shared = item?.parentElement, outer = shared?.parentElement;
          if (has(item, '_2afd28d') && has(shared, 'dc1f7bee') && has(shared, '_4bcc731')
            && has(outer, '_7b40dad') && has(outer, 'f14f3a6d') && visible(item)) found.add(item);
        };
        for (let i = 0; i < text.length; i++) add(text[i], false);
        for (let i = 0; i < avatar.length; i++) add(avatar[i], true);
        return found;
      } catch { return null; }
    };
    const table = () => {
      try { let value = globalThis[Symbol.for(STATE_KEY)]; if (!(value instanceof Map)) {
        value = new Map(); Object.defineProperty(globalThis, Symbol.for(STATE_KEY), { configurable: true, value }); }
        return value; } catch { return null; }
    };
    const result = (status, reason, extra = {}) => ({ stage: ${JSON.stringify(stage)}, status, reason, ...extra });
    try {
      if (document.location.origin !== ORIGIN) return result('unknown', 'unsupported_context');
      const states = table(); if (!states) return result('unknown', 'probe_failed');
      if (${JSON.stringify(stage)} === 'prepare') {
        if (document.location.pathname === '/sign_in') return result('negative', 'negative_evidence');
        const strict = strictProbe();
        if (strict?.menuVisible === true) return result('already-open', 'menu_not_confirmed', { strictObservation: strict });
        const currentRoots = roots(); if (!currentRoots) return result('unknown', 'probe_failed', { strictObservation: strict });
        if (currentRoots.length > 0) return result('menu-open-unconfirmed', 'menu_not_confirmed', { strictObservation: strict });
        const entries = candidates(); if (!entries) return result('unknown', 'probe_failed', { strictObservation: strict });
        if (entries.size === 0) return result('entry-missing', 'entry_missing', { strictObservation: strict });
        if (entries.size !== 1) return result('entry-ambiguous', 'entry_ambiguous', { strictObservation: strict });
        const state = { document, origin: document.location.origin, entry: [...entries][0], menu: null,
          strictMenu: null, opened: false, beforeRoots: currentRoots, captureConfirmedMenu: null };
        state.captureConfirmedMenu = menu => {
          try {
            const currentRoots = roots();
            if (state.document === document && state.opened && state.menu === menu && currentRoots?.length === 1
              && currentRoots[0] === menu && visible(menu)) state.strictMenu = menu;
          } catch {}
        };
        states.set(operationId, state);
        return result('prepared', 'observed', { strictObservation: strict });
      }
      const state = states.get(operationId);
      const valid = state && state.document === document && state.origin === ORIGIN && document.location.origin === ORIGIN
        && state.entry?.ownerDocument === document && state.entry.isConnected === true;
      if (!valid) { states.delete(operationId); return result('unknown', 'stale_context'); }
      if (${JSON.stringify(stage)} === 'settle') {
        await new Promise(resolve => setTimeout(resolve, 40));
        if (state.document !== document || document.location.origin !== ORIGIN || state.entry?.ownerDocument !== document)
          return result('unknown', 'stale_context');
        return result('settled', 'observed');
      }
      if (${JSON.stringify(stage)} === 'open') {
        const currentRoots = roots(); if (!currentRoots) { states.delete(operationId); return result('unknown', 'probe_failed'); }
        if (currentRoots.length > 0) { states.delete(operationId); return result('unknown', 'menu_not_confirmed'); }
        const entries = candidates();
        if (!entries || entries.size !== 1 || !entries.has(state.entry)) {
          states.delete(operationId); return result('unknown', entries?.size === 0 ? 'entry_missing' : 'entry_ambiguous');
        }
        if (typeof state.entry.click !== 'function') {
          state.opened = false; return result('not-dispatched', 'open_failed');
        }
        let clickFailed = false; state.opened = true;
        try { state.entry.click(); } catch { clickFailed = true; }
        return result('open-dispatched', clickFailed ? 'open_failed' : 'observed', { clickFailed });
      }
      if (${JSON.stringify(stage)} === 'inspect') {
        if (!state.opened) return result('unknown', 'menu_not_confirmed');
        const currentRoots = roots();
        if (!currentRoots || currentRoots.length !== 1 || state.beforeRoots.includes(currentRoots[0]))
          return result('menu-not-unique', 'menu_not_confirmed');
        state.menu = currentRoots[0];
        if (state.menu.ownerDocument !== document || state.menu.isConnected !== true || !visible(state.menu))
          return result('unknown', 'menu_not_confirmed');
        const strict = strictProbe();
        if (state.strictMenu !== state.menu) return result('menu-not-confirmed', 'menu_not_confirmed');
        return result('inspected', 'observed', { strictObservation: strict });
      }
      if (${JSON.stringify(stage)} === 'restore') {
        if (!state.opened || !state.menu || state.menu.ownerDocument !== document || !visible(state.menu))
          return result('unknown', 'menu_not_confirmed');
        const currentRoots = roots(), currentEntries = candidates();
        if (!currentRoots || currentRoots.length !== 1 || currentRoots[0] !== state.menu
          || !currentEntries || currentEntries.size !== 1 || !currentEntries.has(state.entry))
          return result('unknown', 'restore_unconfirmed');
        let clickFailed = false;
        try { if (typeof state.entry.click !== 'function') clickFailed = true; else state.entry.click(); } catch { clickFailed = true; }
        state.restoreClickFailed = clickFailed;
        return result('restore-dispatched', clickFailed ? 'restore_failed' : 'observed', { clickFailed });
      }
      if (${JSON.stringify(stage)} === 'verify') {
        if (!state.opened || !state.menu || state.menu.ownerDocument !== document) {
          states.delete(operationId); return result('unknown', 'stale_context');
        }
        const currentRoots = roots();
        const closed = (state.menu.isConnected !== true || !visible(state.menu)) && currentRoots?.length === 0;
        states.delete(operationId);
        return result(closed ? 'restored' : 'restore-unconfirmed', closed ? 'observed' : 'restore_unconfirmed',
          { clickFailed: state.restoreClickFailed === true });
      }
      if (${JSON.stringify(stage)} === 'dispose') { states.delete(operationId); return result('disposed', 'observed'); }
      return result('unknown', 'probe_failed');
    } catch { return result('unknown', 'probe_failed'); }
  })()`
}

function safeContext(readContext) {
  try {
    const value = readContext()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (!value.owner || (typeof value.owner !== 'object' && typeof value.owner !== 'function')
      || value.origin !== ORIGIN || typeof value.documentId !== 'string' || !value.documentId
      || !Number.isSafeInteger(value.frameId) || value.frameId < 0 || !Number.isSafeInteger(value.generation)
      || value.generation < 0 || value.alive !== true || value.focused !== true) return null
    return Object.freeze({ owner: value.owner, origin: value.origin, documentId: value.documentId,
      frameId: value.frameId, generation: value.generation })
  } catch { return null }
}

function safeCleanupContext(readContext) {
  try {
    const value = readContext()
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null
    if (!value.owner || (typeof value.owner !== 'object' && typeof value.owner !== 'function')
      || value.origin !== ORIGIN || typeof value.documentId !== 'string' || !value.documentId
      || !Number.isSafeInteger(value.frameId) || value.frameId < 0 || !Number.isSafeInteger(value.generation)
      || value.generation < 0 || value.alive !== true) return null
    return { owner: value.owner, origin: value.origin, documentId: value.documentId, frameId: value.frameId, generation: value.generation }
  } catch { return null }
}

function sameContext(a, b) {
  return Boolean(a && b && a.owner === b.owner && a.origin === b.origin && a.documentId === b.documentId
    && a.frameId === b.frameId && a.generation === b.generation)
}

function sameDocumentContext(a, b) {
  return Boolean(a && b && a.owner === b.owner && a.origin === b.origin && a.documentId === b.documentId
    && a.frameId === b.frameId)
}

function strictObservation(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  try {
    const keys = Object.keys(value).sort(), expected = [...STRICT_KEYS].sort()
    if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])
      || STRICT_KEYS.some(key => typeof value[key] !== 'boolean')) return null
    return Object.freeze(Object.fromEntries(STRICT_KEYS.map(key => [key, value[key]])))
  } catch { return null }
}

function result(context, observation, operation, menuRestore, entryAction, reason) {
  return Object.freeze({ provider: 'deepseek', ...(context ? { generation: context.generation } : {}),
    strictObservation: observation, operation, menuRestore, entryAction, humanTrusted: false,
    reason: REASONS.has(reason) ? reason : 'probe_failed' })
}

function unknown(context, reason, operation = 'unknown', menuRestore = 'not-needed') {
  return result(context, null, operation, menuRestore, 'none', reason)
}

export function deepseekAccountBootstrapStageScript(stage, operationId) {
  if (!['prepare', 'open', 'settle', 'inspect', 'restore', 'verify', 'dispose'].includes(stage)) throw new TypeError('invalid_stage')
  if (typeof operationId !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(operationId)) throw new TypeError('invalid_operation')
  return stageScript(stage, operationId)
}

export function createDeepseekAccountBootstrapController({ readContext, refreshAuthState, publishStrictObservation,
  executeFixedScript, subscribeLifecycle }) {
  if (typeof readContext !== 'function' || typeof refreshAuthState !== 'function'
    || typeof publishStrictObservation !== 'function' || typeof executeFixedScript !== 'function')
    throw new TypeError('missing_host_callback')
  let disposed = false, busy = false, revision = 0, negativeRevision = 0, unsubscribe = () => {}
  let operationCounter = 0
  const invalidate = () => { revision += 1 }
  try { if (typeof subscribeLifecycle === 'function') unsubscribe = subscribeLifecycle(invalidate) ?? (() => {}) } catch {}
  const current = () => safeContext(readContext)
  const guard = (expected, token) => !disposed && revision === token && sameContext(expected, current())
  const cleanupGuard = expected => Boolean(sameDocumentContext(expected, safeCleanupContext(readContext)))
  const executeStage = async (stage, id, expected, token) => {
    const validBefore = stage === 'dispose' ? cleanupGuard(expected) : guard(expected, token)
    if (!validBefore) return { stale: true, raw: null }
    let raw = null
    try { raw = await executeFixedScript(stageScript(stage, id)) } catch {}
    const validAfter = stage === 'dispose' ? cleanupGuard(expected) : guard(expected, token)
    if (!validAfter) return { stale: true, raw: null }
    if (!raw || typeof raw !== 'object' || raw.stage !== stage) return { stale: false, raw: null }
    return { stale: false, raw }
  }
  const runCore = async () => {
    if (disposed) return unknown(null, 'disposed')
    if (busy) return unknown(current(), 'busy', 'busy')
    const before = current()
    if (!before) return unknown(null, 'unsupported_context')
    const version = revision, negative = negativeRevision
    busy = true
    const id = `bootstrap_${Date.now().toString(36)}_${(++operationCounter).toString(36)}`
    let operation = 'unknown', menuRestore = 'not-needed', entryAction = 'none', reason = 'probe_failed'
    let observation = null, opened = false, openAttempted = false, openConfirmed = false
    let prepareAttempted = false, finalAuth = null, published = false
    const refresh = async () => {
      const value = await refreshAuthState()
      if (!guard(before, version)) return { stale: true, value: null }
      return { stale: false, value }
    }
    const publish = async value => {
      if (!value || !guard(before, version) || negative !== negativeRevision) return false
      try {
        await publishStrictObservation(value, Object.freeze({ owner: before.owner, origin: before.origin,
          documentId: before.documentId, frameId: before.frameId, generation: before.generation, negativeRevision: negative }))
      } catch { return false }
      return guard(before, version) && negative === negativeRevision
    }
    const stageCall = async name => {
      if (!guard(before, version)) return { stale: true, raw: null }
      return executeStage(name, id, before, version)
    }
    try {
      const priorResult = await refresh()
      if (priorResult.stale) return unknown(current(), 'stale_context', 'unknown', 'unknown')
      const prior = priorResult.value
      if (negative !== negativeRevision) return unknown(current(), 'negative_evidence')
      if (prior?.authState === 'unauthenticated' || prior?.state === 'unauthenticated') return unknown(before, 'negative_evidence')
      if (prior?.authState === 'authenticated' || prior?.state === 'authenticated')
        return unknown(before, 'existing_positive', 'unknown')

      prepareAttempted = true
      let stage = await stageCall('prepare', id, before, version)
      if (stage.stale) return unknown(current(), 'stale_context', 'unknown', 'unknown')
      if (!stage.raw) return unknown(before, 'probe_failed')
      observation = strictObservation(stage.raw.strictObservation)
      if (stage.raw.status === 'negative') return unknown(before, 'negative_evidence')
      if (stage.raw.status === 'already-open') {
        if (observation) published = await publish(observation)
        const positive = observation?.sameContainer === true && observation.menuVisible === true
          && observation.downloadMobileAppVisible === true && observation.settingsVisible === true
          && observation.helpAndFeedbackVisible === true && observation.logoutVisible === true
        operation = 'unknown'; reason = positive ? 'existing_positive' : 'menu_not_confirmed'
        return result(before, observation, operation, 'not-needed', 'none', reason)
      }
      if (stage.raw.status === 'menu-open-unconfirmed') {
        if (observation) await publish(observation)
        return result(before, observation, 'unknown', 'not-needed', 'none', 'menu_not_confirmed')
      }
      if (stage.raw.status === 'entry-missing') return result(before, observation, 'unknown', 'not-needed', 'none', 'entry_missing')
      if (stage.raw.status === 'entry-ambiguous') return result(before, observation, 'unknown', 'not-needed', 'none', 'entry_ambiguous')
      if (stage.raw.status !== 'prepared') return result(before, observation, 'unknown', 'not-needed', 'none', stage.raw.reason)

      if (negative !== negativeRevision) return unknown(current(), 'negative_evidence')
      stage = await stageCall('open', id, before, version)
      if (stage.stale) return unknown(current(), 'stale_context', 'unknown', 'unknown')
      if (stage.raw?.status === 'not-dispatched')
        return result(before, null, 'unknown', 'not-needed', 'none', 'open_failed')
      openAttempted = true
      openConfirmed = stage.raw?.status === 'open-dispatched'
      if (openConfirmed) { entryAction = 'synthetic-dom-click'; menuRestore = 'unknown' }
      else { entryAction = 'none'; menuRestore = 'unknown'; reason = stage.raw?.reason ?? 'probe_failed' }

      stage = await stageCall('settle', id, before, version)
      if (stage.stale) return unknown(current(), 'stale_context', 'unknown', 'unknown')
      if (!stage.raw || stage.raw.status !== 'settled') reason = stage.raw?.reason ?? 'probe_failed'

      stage = await stageCall('inspect', id, before, version)
      if (stage.stale) return unknown(current(), 'stale_context', 'unknown', 'unknown')
      if (stage.raw?.status === 'inspected') {
        opened = true
        observation = strictObservation(stage.raw.strictObservation)
        reason = observation ? 'observed' : 'probe_failed'
        if (observation) published = await publish(observation)
        if (observation && !published) reason = negative !== negativeRevision ? 'negative_evidence' : 'probe_failed'
      } else if (stage.raw?.status === 'menu-not-unique') {
        // A global strict observation is not attributable when this exact operation
        // did not identify one newly opened menu.
        observation = null
        reason = 'menu_not_confirmed'
      } else reason = stage.raw?.reason === 'probe_failed' ? 'probe_failed' : 'menu_not_confirmed'
      if (negative !== negativeRevision) reason = 'negative_evidence'

      // Cleanup is allowed only in the same owner/document/frame. Each mutating
      // stage is still preceded by a fresh full foreground guard.
      if (openAttempted) {
        stage = await stageCall('restore', id, before, version)
        if (!stage.stale && stage.raw?.status === 'restore-dispatched') {
          stage = await stageCall('settle', id, before, version)
          if (!stage.stale && stage.raw?.status === 'settled') {
            stage = await stageCall('verify', id, before, version)
            if (!stage.stale && stage.raw?.status === 'restored') menuRestore = 'restored'
            else { menuRestore = 'failed'; reason = 'restore_unconfirmed' }
          } else { menuRestore = 'failed'; reason = 'restore_unconfirmed' }
        } else { menuRestore = 'failed'; reason = 'restore_failed' }
      } else { menuRestore = 'failed'; reason = 'restore_unconfirmed' }

      const finalResult = await refresh()
      if (finalResult.stale) return unknown(current(), 'stale_context', 'unknown', 'unknown')
      finalAuth = finalResult.value
      const strictPositive = observation?.sameContainer === true && observation.menuVisible === true
        && observation.downloadMobileAppVisible === true && observation.settingsVisible === true
        && observation.helpAndFeedbackVisible === true && observation.logoutVisible === true
      if (negative !== negativeRevision || finalAuth?.authState === 'unauthenticated' || finalAuth?.state === 'unauthenticated')
        return unknown(before, 'negative_evidence', opened ? 'opened' : 'unknown', menuRestore)
      const adapterPositive = finalAuth?.authState === 'authenticated' || finalAuth?.state === 'authenticated'
      operation = openConfirmed && opened && strictPositive && published && adapterPositive && menuRestore === 'restored'
        ? 'opened' : 'unknown'
      if (strictPositive && published && !adapterPositive && reason === 'observed') reason = 'menu_not_confirmed'
      return result(before, observation, operation, menuRestore, entryAction,
        negative !== negativeRevision ? 'negative_evidence' : reason)
    } catch {
      return unknown(current(), disposed ? 'disposed' : negative !== negativeRevision ? 'negative_evidence' : 'probe_failed',
        opened ? 'opened' : 'unknown', opened ? menuRestore : 'not-needed')
    } finally {
      if (prepareAttempted && cleanupGuard(before)) {
        try { await executeStage('dispose', id, before, version) } catch {}
      }
      busy = false
    }
  }
  const run = async () => {
    const expected = current(), expectedRevision = revision, expectedNegative = negativeRevision
    const value = await runCore()
    if (!expected || disposed || revision !== expectedRevision || !sameContext(expected, current()))
      return unknown(current(), disposed ? 'disposed' : 'stale_context', 'unknown', 'unknown')
    if (negativeRevision !== expectedNegative)
      return unknown(expected, 'negative_evidence', value?.operation ?? 'unknown', value?.menuRestore ?? 'unknown')
    return value
  }
  return Object.freeze({
    run,
    observeNegative() { negativeRevision += 1; return unknown(current(), 'negative_evidence') },
    invalidate,
    dispose() { if (!disposed) { disposed = true; invalidate(); try { unsubscribe() } catch {} } },
  })
}
