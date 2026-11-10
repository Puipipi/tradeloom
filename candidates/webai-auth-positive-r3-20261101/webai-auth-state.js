const PROVIDERS = Object.freeze({
  deepseek: 'https://chat.deepseek.com',
  doubao: 'https://www.doubao.com',
})

const LIFECYCLE_EVENTS = new Set([
  'navigation-started', 'navigation-committed', 'in-page-navigation', 'document-ready',
  'render-process-gone', 'destroyed', 'closed',
])

const DOUBAO_LOGIN_BUTTON_VISIBLE_SCRIPT = `(() => {
  const element = document.querySelector('[data-testid="to_login_button"]');
  if (!element) return false;
  const style = getComputedStyle(element);
  const opacity = Number.parseFloat(style.opacity);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
    && Number.isFinite(opacity) && opacity > 0 && element.getClientRects().length > 0;
})()`

const DOUBAO_ACCOUNT_MENU_PROBE_SCRIPT = `(() => {
  const visible = element => {
    const style = getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && Number.isFinite(opacity) && opacity > 0 && element.getClientRects().length > 0;
  };
  const menus = Array.from(document.querySelectorAll('[role="menu"]')).filter(visible);
  let addAccountVisible = false;
  let logoutVisible = false;
  let sameMenu = false;
  let triggerPresent = false;
  let triggerVisible = false;
  let hasPopup = false;
  let linked = false;
  let accountMenuLinkedVisible = false;
  let shortcutAttributePresent = false;
  const triggers = Array.from(document.querySelectorAll('button[aria-controls]'));
  for (const menu of menus) {
    let hasAddAccount = false;
    let hasLogout = false;
    for (const item of menu.querySelectorAll('[role="menuitem"]')) {
      if (!visible(item)) continue;
      const label = typeof item.textContent === 'string' ? item.textContent.replace(/\\s+/g, ' ').trim() : '';
      if (label === '添加账号') { hasAddAccount = true; addAccountVisible = true; }
      if (label === '退出登录') { hasLogout = true; logoutVisible = true; }
    }
    if (hasAddAccount && hasLogout) sameMenu = true;
    const menuId = typeof menu.id === 'string' ? menu.id : '';
    if (menuId) {
      for (const trigger of triggers) {
        const controls = trigger.getAttribute('aria-controls') || '';
        if (!controls.split(/\\s+/).includes(menuId)) continue;
        linked = true;
        triggerPresent = true;
        const isVisible = visible(trigger);
        triggerVisible ||= isVisible;
        const popup = trigger.getAttribute('aria-haspopup');
        const hasPopupValue = popup !== null && popup !== '' && popup !== 'false';
        hasPopup ||= hasPopupValue;
        if (hasAddAccount && hasLogout && isVisible && hasPopupValue) accountMenuLinkedVisible = true;
        shortcutAttributePresent ||= Boolean(trigger.getAttribute('aria-keyshortcuts'));
      }
    }
  }
  return {
    menuVisible: menus.length > 0,
    addAccountVisible,
    logoutVisible,
    sameMenu,
    accountMenuLinkedVisible,
    triggerPresent,
    triggerVisible,
    hasPopup,
    linked,
    shortcutAttributePresent,
  };
})()`

const DEEPSEEK_ACCOUNT_MENU_PROBE_SCRIPT = `(() => {
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
    if (labels.every(label => found.has(label))) sameContainer = true;
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

const DEEPSEEK_MENU_DEVELOPMENT_PROBE_SCRIPT = `(() => {
  const labels = ['下载手机应用', '系统设置', '帮助与反馈', '退出登录'];
  const safeRoles = new Set(['button', 'dialog', 'group', 'list', 'listitem', 'menu', 'menuitem', 'navigation', 'option', 'tab', 'toolbar']);
  const blockedTags = new Set(['html', 'body', 'main', 'article']);
  const blockedRoles = new Set(['article', 'feed', 'log', 'main']);
  const empty = (status) => ({
    status,
    downloadMobileAppVisible: false,
    settingsVisible: false,
    helpAndFeedbackVisible: false,
    logoutVisible: false,
    sameRestrictedContainer: false,
    containerPath: [],
  });
  const visible = element => {
    const style = getComputedStyle(element);
    const opacity = Number.parseFloat(style.opacity);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.visibility !== 'collapse'
      && Number.isFinite(opacity) && opacity > 0 && element.getClientRects().length > 0;
  };
  const classTokens = element => {
    const result = [];
    const tokens = element.classList ? Array.from(element.classList).slice(0, 64) : [];
    for (const token of tokens) {
      if (/^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(token)) result.push(token);
      if (result.length === 8) break;
    }
    return result;
  };
  const classList = element => element.classList ? Array.from(element.classList).slice(0, 64) : [];
  const blocked = element => {
    const tag = typeof element.tagName === 'string' ? element.tagName.toLowerCase() : '';
    if (blockedTags.has(tag)) return true;
    const role = element.getAttribute('role');
    if (typeof role === 'string' && blockedRoles.has(role.toLowerCase())) return true;
    if (element.classList && element.classList.length > 64) return true;
    for (const token of classList(element)) {
      if (/^(chat|messages?|conversation|history|transcript|log|feed|thread)(?:[-_]|$)/i.test(token)) return true;
    }
    return false;
  };
  const roots = Array.from(document.querySelectorAll('nav,header,[role="navigation"],[role="menu"],[role="dialog"],[aria-expanded="true"],[aria-haspopup],[class*="dropdown" i],[class*="popover" i],[class*="popper" i],[class*="menu" i],[data-state="open"],[data-side],[data-popper-placement]'));
  if (roots.length === 0 || roots.length > 32) return empty('unknown');
  const globalPresence = Object.fromEntries(labels.map(label => [label, false]));
  let matchedRoot = null;
  let totalNodes = 0;
  let incomplete = false;
  for (const root of roots) {
    if (!visible(root) || blocked(root)) continue;
    const found = new Set();
    const stack = [root];
    let rootNodes = 0;
    while (stack.length > 0) {
      if (rootNodes >= 128 || totalNodes >= 512) { incomplete = true; break; }
      const node = stack.pop();
      if (!visible(node) || blocked(node)) continue;
      rootNodes += 1;
      totalNodes += 1;
      const childNodes = node.childNodes || [];
      if (childNodes.length > 64) { incomplete = true; break; }
      for (let childIndex = 0; childIndex < childNodes.length; childIndex += 1) {
        const child = childNodes[childIndex];
        if (child.nodeType !== 3 || typeof child.nodeValue !== 'string') continue;
        const text = child.nodeValue.replace(/\\s+/g, ' ').trim();
        if (labels.includes(text)) found.add(text);
      }
      const children = Array.from(node.children || []);
      if (children.length > 128 || stack.length + children.length > 256) { incomplete = true; break; }
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]);
    }
    if (incomplete) break;
    for (const label of found) globalPresence[label] = true;
    if (matchedRoot === null && labels.every(label => found.has(label))) matchedRoot = root;
  }
  if (incomplete) return empty('unknown');
  let containerPath = [];
  if (matchedRoot !== null) {
    let node = matchedRoot;
    while (node && containerPath.length < 3 && !blocked(node)) {
      const tag = typeof node.tagName === 'string' ? node.tagName.toLowerCase() : '';
      if (!/^[a-z][a-z0-9-]{0,23}$/.test(tag)) break;
      const roleValue = node.getAttribute('role');
      const metadata = { tag, classes: classTokens(node) };
      if (typeof roleValue === 'string' && safeRoles.has(roleValue.toLowerCase())) metadata.role = roleValue.toLowerCase();
      containerPath.push(metadata);
      node = node.parentElement;
    }
  }
  return {
    status: 'observed',
    downloadMobileAppVisible: globalPresence['下载手机应用'],
    settingsVisible: globalPresence['系统设置'],
    helpAndFeedbackVisible: globalPresence['帮助与反馈'],
    logoutVisible: globalPresence['退出登录'],
    sameRestrictedContainer: matchedRoot !== null,
    containerPath,
  };
})()`

function unknown(provider, generation) {
  return Object.freeze({ provider, authState: 'unknown', evidence: 'none', generation })
}

function unknownAccountMenu(provider, generation) {
  const triggerFields = { triggerPresent: false, triggerVisible: false, hasPopup: false, linked: false, shortcutAttributePresent: false }
  if (provider === 'deepseek') return Object.freeze({
    status: 'unknown', provider, menuVisible: false, downloadMobileAppVisible: false,
    settingsVisible: false, helpAndFeedbackVisible: false, logoutVisible: false,
    sameContainer: false, ...triggerFields, generation,
  })
  return Object.freeze({
    status: 'unknown', provider, menuVisible: false, addAccountVisible: false,
    logoutVisible: false, sameMenu: false, accountMenuLinkedVisible: false, ...triggerFields, generation,
  })
}

function isValidDeepSeekAccountMenuRaw(value) {
  const keys = [
    'menuVisible', 'downloadMobileAppVisible', 'settingsVisible', 'helpAndFeedbackVisible',
    'logoutVisible', 'sameContainer', 'triggerPresent', 'triggerVisible', 'hasPopup',
    'linked', 'shortcutAttributePresent',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== keys.length || actualKeys.some((key, index) => key !== [...keys].sort()[index])
    || keys.some(key => typeof value[key] !== 'boolean')) return false
  const labelsPresent = [value.downloadMobileAppVisible, value.settingsVisible, value.helpAndFeedbackVisible, value.logoutVisible]
  if (value.sameContainer && (!value.menuVisible || labelsPresent.some(present => !present))) return false
  if (!value.menuVisible && (labelsPresent.some(Boolean) || value.sameContainer
    || value.triggerPresent || value.triggerVisible || value.hasPopup || value.linked || value.shortcutAttributePresent)) return false
  return true
}

function isValidDoubaoAccountMenuRaw(value) {
  const keys = [
    'menuVisible', 'addAccountVisible', 'logoutVisible', 'sameMenu', 'accountMenuLinkedVisible',
    'triggerPresent', 'triggerVisible', 'hasPopup', 'linked', 'shortcutAttributePresent',
  ]
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== keys.length || actualKeys.some((key, index) => key !== [...keys].sort()[index])
    || keys.some(key => typeof value[key] !== 'boolean')) return false
  if (value.sameMenu && (!value.menuVisible || !value.addAccountVisible || !value.logoutVisible)) return false
  if (value.accountMenuLinkedVisible && (!value.sameMenu || !value.triggerPresent
    || !value.triggerVisible || !value.hasPopup || !value.linked)) return false
  if (!value.menuVisible && (value.addAccountVisible || value.logoutVisible || value.sameMenu
    || value.accountMenuLinkedVisible || value.triggerPresent || value.triggerVisible
    || value.hasPopup || value.linked || value.shortcutAttributePresent)) return false
  return true
}

function projectAccountMenu(provider, value, generation) {
  const keys = provider === 'deepseek'
    ? ['menuVisible', 'downloadMobileAppVisible', 'settingsVisible', 'helpAndFeedbackVisible', 'logoutVisible', 'sameContainer', 'triggerPresent', 'triggerVisible', 'hasPopup', 'linked', 'shortcutAttributePresent']
    : ['menuVisible', 'addAccountVisible', 'logoutVisible', 'sameMenu', 'accountMenuLinkedVisible', 'triggerPresent', 'triggerVisible', 'hasPopup', 'linked', 'shortcutAttributePresent']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownAccountMenu(provider, generation)
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== keys.length || actualKeys.some((key, index) => key !== [...keys].sort()[index])
    || keys.some(key => typeof value[key] !== 'boolean')) return unknownAccountMenu(provider, generation)
  return Object.freeze({
    status: value.menuVisible ? 'observed' : 'unknown',
    provider,
    ...Object.fromEntries(keys.map(key => [key, value[key]])),
    generation,
  })
}

function unknownDeepSeekDevelopment(generation) {
  return Object.freeze({
    status: 'unknown', provider: 'deepseek',
    downloadMobileAppVisible: false, settingsVisible: false,
    helpAndFeedbackVisible: false, logoutVisible: false,
    sameRestrictedContainer: false, containerPath: [], generation,
  })
}

function projectDeepSeekDevelopment(value, generation) {
  const boolKeys = [
    'downloadMobileAppVisible', 'settingsVisible', 'helpAndFeedbackVisible',
    'logoutVisible', 'sameRestrictedContainer',
  ]
  const keys = ['status', ...boolKeys, 'containerPath']
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownDeepSeekDevelopment(generation)
  const actualKeys = Object.keys(value).sort()
  if (actualKeys.length !== keys.length || actualKeys.some((key, index) => key !== [...keys].sort()[index])
    || !['observed', 'unknown'].includes(value.status)
    || boolKeys.some(key => typeof value[key] !== 'boolean')
    || !Array.isArray(value.containerPath) || value.containerPath.length > 3) return unknownDeepSeekDevelopment(generation)
  const safeRoles = new Set(['button', 'dialog', 'group', 'list', 'listitem', 'menu', 'menuitem', 'navigation', 'option', 'tab', 'toolbar'])
  const path = []
  for (const entry of value.containerPath) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return unknownDeepSeekDevelopment(generation)
    const entryKeys = Object.keys(entry).sort()
    if (entryKeys.some(key => !['classes', 'role', 'tag'].includes(key))
      || !entryKeys.includes('tag') || !entryKeys.includes('classes')
      || typeof entry.tag !== 'string' || !/^[a-z][a-z0-9-]{0,23}$/.test(entry.tag)
      || (entry.role !== undefined && (typeof entry.role !== 'string' || !safeRoles.has(entry.role)))
      || !Array.isArray(entry.classes) || entry.classes.length > 8
      || entry.classes.some(token => typeof token !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,47}$/.test(token))) {
      return unknownDeepSeekDevelopment(generation)
    }
    path.push(Object.freeze({ tag: entry.tag, ...(entry.role ? { role: entry.role } : {}), classes: Object.freeze([...entry.classes]) }))
  }
  const complete = boolKeys.slice(0, 4).every(key => value[key])
  if (value.status === 'unknown' && (boolKeys.some(key => value[key]) || path.length > 0)) return unknownDeepSeekDevelopment(generation)
  if (value.sameRestrictedContainer && (!complete || path.length === 0)) return unknownDeepSeekDevelopment(generation)
  if (!value.sameRestrictedContainer && path.length > 0) return unknownDeepSeekDevelopment(generation)
  return Object.freeze({
    status: value.status,
    provider: 'deepseek',
    ...Object.fromEntries(boolKeys.map(key => [key, value[key]])),
    containerPath: Object.freeze(path),
    generation,
  })
}

/** @typedef {'unknown' | 'unauthenticated' | 'authenticated'} WebAiAuthState */
/** @typedef {{provider: 'deepseek' | 'doubao', authState: WebAiAuthState, evidence: string, generation: number}} WebAiAuthStateDto */

function documentIdentity(readDocumentIdentity) {
  let value
  try { value = readDocumentIdentity() } catch { return null }
  if (!value || typeof value !== 'object' || typeof value.url !== 'string'
    || typeof value.documentId !== 'string' || !value.documentId || value.alive !== true) return null
  let parsed
  try { parsed = new URL(value.url) } catch { return null }
  return { origin: parsed.origin, pathname: parsed.pathname, documentId: value.documentId }
}

function sameDocument(left, right) {
  return left !== null && right !== null
    && left.origin === right.origin && left.pathname === right.pathname && left.documentId === right.documentId
}

/**
 * Host-only auth-state projection. The injected callbacks must close over the
 * already-owned WebContents; never expose this factory or its callbacks to a renderer.
 */
export function createWebAiAuthStateAdapter({
  provider,
  readDocumentIdentity,
  executeReadOnlyProbe,
  subscribeLifecycle,
} = {}) {
  if (!Object.hasOwn(PROVIDERS, provider)) {
    const error = new Error('invalid_provider')
    error.code = 'invalid_provider'
    throw error
  }
  if (typeof readDocumentIdentity !== 'function') throw new TypeError('readDocumentIdentity is required')

  let generation = 1
  let disposed = false
  let current = unknown(provider, generation)
  let sampledDocument = null
  let unsubscribe
  let nextSampleOrder = 0
  let latestDecisionOrder = 0

  function isOlderSample(order) {
    return order < latestDecisionOrder
  }

  function commitDecision(order) {
    if (order > latestDecisionOrder) latestDecisionOrder = order
  }

  const invalidate = ({ close = false } = {}) => {
    if (disposed) return
    generation += 1
    sampledDocument = null
    current = unknown(provider, generation)
    if (close) disposed = true
  }

  if (subscribeLifecycle !== undefined) {
    if (typeof subscribeLifecycle !== 'function') throw new TypeError('subscribeLifecycle must be a function')
    unsubscribe = subscribeLifecycle(event => {
      if (!LIFECYCLE_EVENTS.has(event)) return
      invalidate({ close: event === 'destroyed' || event === 'closed' })
    })
  }

  function reconcileDocument() {
    if (disposed) return
    const now = documentIdentity(readDocumentIdentity)
    if (sampledDocument !== null && !sameDocument(sampledDocument, now)) invalidate()
    if (now === null || now.origin !== PROVIDERS[provider]) {
      current = unknown(provider, generation)
      sampledDocument = null
    }
  }

  function hasCurrentDeepSeekPositive(document) {
    return current.provider === 'deepseek'
      && current.authState === 'authenticated'
      && current.evidence === 'deepseek-account-menu'
      && sampledDocument !== null
      && sameDocument(sampledDocument, document)
  }

  function deepSeekMenuIsPositive(menu) {
    return menu?.provider === 'deepseek'
      && menu.status === 'observed'
      && menu.sameContainer === true
      && menu.downloadMobileAppVisible === true
      && menu.settingsVisible === true
      && menu.helpAndFeedbackVisible === true
      && menu.logoutVisible === true
  }

  function publishDeepSeekPositive(document) {
    current = Object.freeze({
      provider: 'deepseek',
      authState: 'authenticated',
      evidence: 'deepseek-account-menu',
      generation,
    })
    sampledDocument = document
    return current
  }

  function hasCurrentDoubaoPositive(document) {
    return current.provider === 'doubao'
      && current.authState === 'authenticated'
      && current.evidence === 'doubao-account-menu'
      && sampledDocument !== null
      && sameDocument(sampledDocument, document)
  }

  function doubaoMenuIsPositive(menu) {
    return menu?.provider === 'doubao'
      && menu.status === 'observed'
      && menu.sameMenu === true
      && menu.addAccountVisible === true
      && menu.logoutVisible === true
      && menu.accountMenuLinkedVisible === true
  }

  function publishDoubaoPositive(document) {
    current = Object.freeze({
      provider: 'doubao',
      authState: 'authenticated',
      evidence: 'doubao-account-menu',
      generation,
    })
    sampledDocument = document
    return current
  }

  function publishUnknownForDocument(document) {
    current = unknown(provider, generation)
    sampledDocument = document
    return current
  }

  async function readDeepSeekAccountMenu(epoch, before) {
    let raw
    let failed = false
    try { raw = await executeReadOnlyProbe(DEEPSEEK_ACCOUNT_MENU_PROBE_SCRIPT) }
    catch { failed = true }
    if (epoch !== generation || disposed) return { kind: 'stale' }
    const after = documentIdentity(readDocumentIdentity)
    if (after === null) {
      invalidate()
      return { kind: 'stale' }
    }
    if (!sameDocument(before, after)) {
      invalidate()
      return { kind: 'stale' }
    }
    if (failed || !isValidDeepSeekAccountMenuRaw(raw)) return { kind: 'failed', after }
    try { return { kind: 'sampled', after, menu: projectAccountMenu('deepseek', raw, generation) } }
    catch { return { kind: 'failed', after } }
  }

  async function readDoubaoLoginNegative(epoch, before) {
    let raw
    let failed = false
    try { raw = await executeReadOnlyProbe(DOUBAO_LOGIN_BUTTON_VISIBLE_SCRIPT) }
    catch { failed = true }
    if (epoch !== generation || disposed) return { kind: 'stale' }
    const after = documentIdentity(readDocumentIdentity)
    if (after === null || !sameDocument(before, after)) {
      invalidate()
      return { kind: 'stale' }
    }
    if (failed || typeof raw !== 'boolean') return { kind: 'failed', after }
    return { kind: 'sampled', after, visible: raw }
  }

  async function readDoubaoAccountMenu(epoch, before) {
    let raw
    let failed = false
    try { raw = await executeReadOnlyProbe(DOUBAO_ACCOUNT_MENU_PROBE_SCRIPT) }
    catch { failed = true }
    if (epoch !== generation || disposed) return { kind: 'stale' }
    const after = documentIdentity(readDocumentIdentity)
    if (after === null || !sameDocument(before, after)) {
      invalidate()
      return { kind: 'stale' }
    }
    if (failed || !isValidDoubaoAccountMenuRaw(raw)) return { kind: 'failed', after }
    try { return { kind: 'sampled', after, menu: projectAccountMenu('doubao', raw, generation) } }
    catch { return { kind: 'failed', after } }
  }

  return Object.freeze({
    getState() {
      reconcileDocument()
      return current
    },

    async sample() {
      reconcileDocument()
      if (disposed) return current
      const sampleOrder = ++nextSampleOrder
      const epoch = generation
      const before = documentIdentity(readDocumentIdentity)
      if (before === null || before.origin !== PROVIDERS[provider]) return current

      let evidence = 'none'
      let authState = 'unknown'
      if (provider === 'deepseek' && before.pathname === '/sign_in') {
        if (isOlderSample(sampleOrder)) return current
        authState = 'unauthenticated'
        evidence = 'deepseek-sign-in-path'
        const after = documentIdentity(readDocumentIdentity)
        if (epoch !== generation || disposed) return current
        if (!sameDocument(before, after)) {
          invalidate()
          return current
        }
        current = Object.freeze({ provider, authState, evidence, generation })
        sampledDocument = after
        commitDecision(sampleOrder)
        return current
      } else if (provider === 'deepseek') {
        const sampled = await readDeepSeekAccountMenu(epoch, before)
        if (sampled.kind === 'stale') return current
        if (isOlderSample(sampleOrder)) return current
        if (sampled.kind === 'failed') {
          commitDecision(sampleOrder)
          return publishUnknownForDocument(sampled.after)
        }
        if (deepSeekMenuIsPositive(sampled.menu)) {
          commitDecision(sampleOrder)
          return publishDeepSeekPositive(sampled.after)
        }
        if (hasCurrentDeepSeekPositive(sampled.after)) return current
        return current
      } else if (provider === 'doubao' && typeof executeReadOnlyProbe === 'function') {
        const negative = await readDoubaoLoginNegative(epoch, before)
        if (negative.kind === 'stale') return current
        if (isOlderSample(sampleOrder)) return current
        if (negative.kind === 'failed') {
          commitDecision(sampleOrder)
          return publishUnknownForDocument(negative.after)
        }
        if (negative.visible) {
          current = Object.freeze({ provider, authState: 'unauthenticated', evidence: 'doubao-login-button', generation })
          sampledDocument = negative.after
          commitDecision(sampleOrder)
          return current
        }
        const sampled = await readDoubaoAccountMenu(epoch, negative.after)
        if (sampled.kind === 'stale') return current
        if (isOlderSample(sampleOrder)) return current
        if (sampled.kind === 'failed') {
          commitDecision(sampleOrder)
          return publishUnknownForDocument(sampled.after)
        }
        if (doubaoMenuIsPositive(sampled.menu)) {
          commitDecision(sampleOrder)
          return publishDoubaoPositive(sampled.after)
        }
        if (hasCurrentDoubaoPositive(sampled.after)) return current
        return current
      }

      const after = documentIdentity(readDocumentIdentity)
      if (epoch !== generation || disposed) return current
      if (!sameDocument(before, after)) {
        invalidate()
        return current
      }
      current = Object.freeze({ provider, authState, evidence, generation })
      sampledDocument = after
      return current
    },

    async sampleAccountMenu() {
      reconcileDocument()
      if (disposed || typeof executeReadOnlyProbe !== 'function') return unknownAccountMenu(provider, generation)
      const sampleOrder = ++nextSampleOrder
      const epoch = generation
      const before = documentIdentity(readDocumentIdentity)
      if (before === null || before.origin !== PROVIDERS[provider]) return unknownAccountMenu(provider, generation)
      if (provider === 'deepseek' && before.pathname === '/sign_in') {
        const after = documentIdentity(readDocumentIdentity)
        if (epoch === generation && !disposed && sameDocument(before, after)) {
          if (isOlderSample(sampleOrder)) return unknownAccountMenu(provider, generation)
          current = Object.freeze({ provider, authState: 'unauthenticated', evidence: 'deepseek-sign-in-path', generation })
          sampledDocument = after
          commitDecision(sampleOrder)
        }
        return unknownAccountMenu(provider, generation)
      }
      if (provider === 'deepseek') {
        const sampled = await readDeepSeekAccountMenu(epoch, before)
        if (sampled.kind === 'stale') return unknownAccountMenu(provider, generation)
        if (isOlderSample(sampleOrder)) return unknownAccountMenu(provider, generation)
        if (sampled.kind === 'failed') {
          commitDecision(sampleOrder)
          publishUnknownForDocument(sampled.after)
          return unknownAccountMenu(provider, generation)
        }
        if (deepSeekMenuIsPositive(sampled.menu)) {
          commitDecision(sampleOrder)
          publishDeepSeekPositive(sampled.after)
        } else if (!hasCurrentDeepSeekPositive(sampled.after)) {
          return sampled.menu
        }
        return sampled.menu
      }
      const negative = await readDoubaoLoginNegative(epoch, before)
      if (negative.kind === 'stale') return unknownAccountMenu(provider, generation)
      if (isOlderSample(sampleOrder)) return unknownAccountMenu(provider, generation)
      if (negative.kind === 'failed') {
        commitDecision(sampleOrder)
        publishUnknownForDocument(negative.after)
        return unknownAccountMenu(provider, generation)
      }
      if (negative.visible) {
        current = Object.freeze({ provider, authState: 'unauthenticated', evidence: 'doubao-login-button', generation })
        sampledDocument = negative.after
        commitDecision(sampleOrder)
        return unknownAccountMenu(provider, generation)
      }
      const sampled = await readDoubaoAccountMenu(epoch, negative.after)
      if (sampled.kind === 'stale') return unknownAccountMenu(provider, generation)
      if (isOlderSample(sampleOrder)) return unknownAccountMenu(provider, generation)
      if (sampled.kind === 'failed') {
        commitDecision(sampleOrder)
        publishUnknownForDocument(sampled.after)
        return unknownAccountMenu(provider, generation)
      }
      if (doubaoMenuIsPositive(sampled.menu)) {
        commitDecision(sampleOrder)
        publishDoubaoPositive(sampled.after)
      } else if (!hasCurrentDoubaoPositive(sampled.after)) {
        return sampled.menu
      }
      return sampled.menu
    },

    async sampleDeepSeekMenuDevelopment() {
      reconcileDocument()
      if (disposed || provider !== 'deepseek' || typeof executeReadOnlyProbe !== 'function') {
        return unknownDeepSeekDevelopment(generation)
      }
      const epoch = generation
      const before = documentIdentity(readDocumentIdentity)
      if (before === null || before.origin !== PROVIDERS.deepseek) return unknownDeepSeekDevelopment(generation)
      let result
      try { result = await executeReadOnlyProbe(DEEPSEEK_MENU_DEVELOPMENT_PROBE_SCRIPT) }
      catch { return unknownDeepSeekDevelopment(generation) }
      if (epoch !== generation || disposed) return unknownDeepSeekDevelopment(generation)
      const after = documentIdentity(readDocumentIdentity)
      if (!sameDocument(before, after)) {
        invalidate()
        return unknownDeepSeekDevelopment(generation)
      }
      try { return projectDeepSeekDevelopment(result, generation) }
      catch { return unknownDeepSeekDevelopment(generation) }
    },

    dispose() {
      if (!disposed) invalidate({ close: true })
      try { unsubscribe?.() } catch { /* Disposal remains fail-closed. */ }
      unsubscribe = undefined
    },
  })
}

/** Fixed provider probe; it returns only one visibility boolean, never page content. */
export function doubaoLoginButtonVisibleScript() {
  return DOUBAO_LOGIN_BUTTON_VISIBLE_SCRIPT
}

/** Fixed semantic probe; only allowlisted visibility booleans leave the isolated world. */
export function doubaoAccountMenuProbeScript() {
  return DOUBAO_ACCOUNT_MENU_PROBE_SCRIPT
}

/** Fixed candidate selector scope and labels for a DeepSeek account menu. */
export function deepseekAccountMenuProbeScript() {
  return DEEPSEEK_ACCOUNT_MENU_PROBE_SCRIPT
}

/** Fixed development-only bounded probe; not part of authState or normal menu DTO. */
export function deepseekMenuDevelopmentProbeScript() {
  return DEEPSEEK_MENU_DEVELOPMENT_PROBE_SCRIPT
}
