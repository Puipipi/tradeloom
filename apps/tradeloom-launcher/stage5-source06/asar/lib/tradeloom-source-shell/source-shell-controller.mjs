import { cpus, totalmem, freemem } from 'node:os'
import { appendFile, mkdir, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { createSurfaceOwner } from './surface-owner.mjs'
const SOURCE_URL = 'dsh-app://app/source-shell/renderer/source-entry.html'
const ACCOUNT_URL = 'dsh-app://app/source-shell/renderer/account-window.html'
const SCENE_COMPONENT_URL = 'dsh-app://app/'
function validPanelGeometryRecord(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'action,actionId,elapsedMs,outcome,panels,samples,truncated') return false
  if (!['maximize','restore','resize','extend','collapse'].includes(value.action)
    || !Number.isSafeInteger(value.actionId) || value.actionId < 1 || value.actionId > 24
    || !['completed','cancelled','detached','limit','invalid','superseded'].includes(value.outcome)
    || typeof value.truncated !== 'boolean' || (value.outcome === 'limit' && !value.truncated)
    || (value.outcome === 'completed' && value.truncated)
    || !Number.isFinite(value.elapsedMs) || value.elapsedMs < 0 || value.elapsedMs > 86400000
    || (value.elapsedMs > 1500 && !value.truncated)
    || !Array.isArray(value.panels) || value.panels.length < 1 || value.panels.length > 8
    || new Set(value.panels).size !== value.panels.length
    || !value.panels.every(p => typeof p === 'string' && /^panel-([1-9]\d{0,2})$/u.test(p) && Number(p.slice(6)) <= 192)
    || !Array.isArray(value.samples) || value.samples.length > 120
    || (value.samples.length === 0 && value.outcome !== 'invalid')) return false
  let previous = -1
  for (const sample of value.samples) {
    if (!sample || Object.keys(sample).sort().join(',') !== 'rects,t'
      || !Number.isFinite(sample.t) || sample.t < previous || sample.t < 0 || sample.t > 1500 || sample.t > value.elapsedMs
      || !Array.isArray(sample.rects) || sample.rects.length !== value.panels.length
      || !sample.rects.every(r => Array.isArray(r) && r.length === 4 && r.every(n => Number.isFinite(n) && Math.abs(n) <= 1000000) && r[2] >= 0 && r[3] >= 0)) return false
    previous = sample.t
  }
  return true
}
export function createSourceShellController({ BrowserWindow, WebContentsView, ipcMain, appPreload, sourcePreload, ownedPartition, getConfig, saveConfig, confirmConfigurationChange, engineGenerationAction, onNativeDescriptorChanged = () => {}, resolveBinding, sceneRotationPreview = async () => { throw Error('scene rotation unavailable') }, sceneRotationConfirm = async () => { throw Error('scene rotation unavailable') }, sceneRotationStatus = async () => { throw Error('scene rotation unavailable') }, sceneRotationResume = async () => { throw Error('scene rotation unavailable') }, sceneRotationCancel = async () => { throw Error('scene rotation unavailable') }, sceneRotationAbandon = async () => { throw Error('scene rotation unavailable') }, installProtocol, primaryWindow, getNativeCaptionFallback, resolveNativeTheme, subscribeNativeTheme, hasNativeModal = () => false, updateOwnership = () => {}, createRegistry = createSurfaceOwner, loadUiScale = async () => 1, saveUiScale = async () => { throw Error('UI scale persistence unavailable') }, loadSceneOrder = async () => ({saved:false,ids:[]}), saveSceneOrder = async () => { throw Error('scene order persistence unavailable') }, inventoryTimeoutMs = 5000, systemInfo = { cpus, totalmem, freemem }, diskStat = statfs, getKnownFolders, openKnownFolder, attachAccountShortcuts, resetAccountShortcuts, observeFailure = () => {}, observePhase = () => {}, writeUi18Diagnostic = appendFile }) {
  if (!appPreload || !sourcePreload || !ownedPartition || typeof getConfig !== 'function' || typeof resolveBinding !== 'function' || typeof installProtocol !== 'function' || typeof resolveNativeTheme !== 'function' || typeof subscribeNativeTheme !== 'function') throw new Error('missing trusted desktop configuration')
  let initialSourcePaint;
  let configurationQueue = Promise.resolve(), configurationEpoch = 0
  const draftFlushes = new Map()
  const panelIdentity = (value, sceneValue) => value && JSON.stringify([value.type, value.roleId ?? sceneValue.roleId])
  const captureRoleBinding = (binding, sceneId, panelId) => {
    const currentScene = scene(sceneId), currentPanel = currentScene.panels.find(value => value.id === panelId)
    const roleId = currentPanel?.roleId ?? currentScene.roleId
    if (!currentPanel || !['native-chat', 'native-workspace'].includes(currentPanel.type)
      || binding?.sceneId !== sceneId || binding.panelId !== panelId || binding.bindingStatus !== 'bound'
      || typeof roleId !== 'string' || !roleId || binding.roleId !== roleId
      || typeof binding.sessionId !== 'string' || !binding.sessionId
      || typeof binding.bindingRevision !== 'string' || !/^(0|[1-9][0-9]{0,63})$/.test(binding.bindingRevision)) throw Error('trusted role binding mismatch')
    return Object.freeze({ roleId, sessionId: binding.sessionId, bindingRevision: binding.bindingRevision })
  }
  const changedRoleViews = next => [...views.values()].filter(item => {
    const oldScene = config.scenes.find(value => value.id === item.sceneId)
    const nextScene = next.scenes.find(value => value.id === item.sceneId)
    return panelIdentity(oldScene?.panels.find(value => value.id === item.panelId), oldScene)
      !== panelIdentity(nextScene?.panels.find(value => value.id === item.panelId), nextScene)
  })
  async function flushRoleDraft(item) {
    const expected = descriptor(item), requestId = randomUUID()
    if (item.status !== 'context-mounted' || item.view.webContents.isDestroyed()) throw Error('scene draft owner not ready')
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { draftFlushes.delete(requestId); reject(Error('scene draft save not confirmed')) }, inventoryTimeoutMs)
      draftFlushes.set(requestId, { item, expected, resolve: saved => { clearTimeout(timer); draftFlushes.delete(requestId); saved ? resolve() : reject(Error('scene draft save failed')) } })
      try { item.view.webContents.send('source-shell:draft-flush-request', { requestId, descriptor: expected }) }
      catch (error) { clearTimeout(timer); draftFlushes.delete(requestId); reject(error) }
    })
  }
  async function applyConfiguration(next, assertCapturedOwner) {
    if (!next || !Array.isArray(next.scenes) || typeof next.configurationRevision !== 'string') throw Error('invalid trusted scene configuration')
    const affected = changedRoleViews(next)
    for (const item of affected) {
      if (rolePopouts.has(key(item.sceneId, item.panelId)) || hasNativeModal(item.parent)) throw Error('return affected popout and close its modal before applying')
      await flushRoleDraft(item)
      assertCapturedOwner()
    }
    // Read back the exact saved revision after persistence and before revoking
    // any surface. An older save may not rebind a newer configuration.
    const current = await getConfig(); assertCapturedOwner()
    if (current.configurationRevision !== next.configurationRevision) throw Error('scene configuration superseded before application')
    for (const item of affected) if (views.get(key(item.sceneId, item.panelId)) !== item || item.view.webContents.isDestroyed()) throw Error('scene configuration surface changed')
    configurationEpoch++
    config = current
    for (const item of affected) {
      notifyGuest(item)
      revoke(item)
      if (!item.view.webContents.isDestroyed()) item.view.webContents.close()
    }
    for (const window of windows.values()) if (!window.isDestroyed()) window.webContents.send('source-shell:configuration-changed', config)
    return { saved: true, applied: true, configurationRevision: config.configurationRevision }
  }
  let accountOverlay;
  let controller, main, accountPopout, accountPopoutCreating, registry, config, account, accountGlobalPanel, sceneComponent, erpNextStatusComponent, accountSidebar, accountSidebarOpen=false, accountSidebarWidthDip=340, accountSidebarRequest=0, accountSidebarCreating, accountCreating, closed = false, generation = 0, uiScale=1, orderSaved=false, orderMigrationAllowed=true, orderQueue=Promise.resolve(), sourceThemeSnapshot, sourceThemeMaterials, releaseNativeTheme, sourceThemePublisher, pendingSourceThemePreference, themeRequest, themeSequence=0
  const windows = new Map(), nativeCaptionWindows = new WeakSet(), views = new Map(), rolePopouts = new Map(), rolePopoutCreating = new Map(), closingRolePopouts = new Set(), componentPopouts = new Map(), componentPopoutCreating = new Map(), closingComponentPopouts = new Set(), channels = [], focusedGuests = new Map(), inventoryRequests = new Map(), modelRequests = new Map(), settingsRequests = new Map(), mobileLinkRequests = new Map()
  let inventorySequence=0
  let accountOverlayRequest, accountOverlayState = {requestId:0,generation:0,eligible:false}
  const ui18DiagnosticRoot = 'C:\\Users\\23825\\AppData\\Local\\Temp\\tradeloom-launch-diag-20261031\\ui18-controller-runtime-diagnostic-20261101'
  const ui18DiagnosticPath = join(ui18DiagnosticRoot, 'ui18-theme-settings-diagnostic.jsonl')
  let ui18DiagnosticQueue = Promise.resolve()
  const ui18Diagnostic = (operation, stage, fields = {}) => {
    if (!['diagnostic', 'settings', 'theme'].includes(operation)) return
    const stages = {
      diagnostic: ['initialized'],
      settings: ['request-rejected', 'request-sent', 'claim-accepted', 'claim-rejected', 'state-accepted', 'state-rejected', 'result-accepted', 'result-rejected', 'timeout'],
      theme: ['preference-queued', 'preference-dispatched', 'publish-rejected', 'publish-accepted', 'broadcast-complete'],
    }
    if (!stages[operation].includes(stage)) return
    const record = { schemaVersion: 1, at: new Date().toISOString(), processId: process.pid, operation, stage }
    if (typeof fields.failure === 'string' && ['owner-not-mounted', 'source-owner-rejected', 'send-failed', 'request-missing', 'sender-mismatch', 'wrong-kind', 'generation-mismatch', 'state-rejected', 'listener-error', 'service-missing', 'open-threw', 'open-state-missing', 'state-report-rejected', 'opened-false', 'no-claim', 'no-result', 'owner-resolver-failed', 'scope-rejected', 'account-missing', 'navigation-rejected', 'snapshot-invalid'].includes(fields.failure)) record.failure = fields.failure
    if (typeof fields.ownerPresent === 'boolean') record.ownerPresent = fields.ownerPresent
    if (fields.ownerKind === 'account' || fields.ownerKind === 'none') record.ownerKind = fields.ownerKind
    if (['loading', 'document-loaded', 'context-mounted', 'error', 'unknown'].includes(fields.accountStatus)) record.accountStatus = fields.accountStatus
    if (['shell', 'other', 'unknown'].includes(fields.businessNavigation)) record.businessNavigation = fields.businessNavigation
    if (Number.isSafeInteger(fields.generation) && fields.generation >= 0) record.generation = fields.generation
    if (Number.isSafeInteger(fields.sendCount) && fields.sendCount >= 0) record.sendCount = fields.sendCount
    if (typeof fields.mainTargetIncluded === 'boolean') record.mainTargetIncluded = fields.mainTargetIncluded
    if (typeof fields.claimed === 'boolean') record.claimed = fields.claimed
    if (typeof fields.opened === 'boolean') record.opened = fields.opened
    ui18DiagnosticQueue = ui18DiagnosticQueue.catch(() => {}).then(async () => {
      await mkdir(ui18DiagnosticRoot, { recursive: true })
      await writeUi18Diagnostic(ui18DiagnosticPath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', flag: 'a' })
    }).catch(() => {
      try { observeFailure('ui18-diagnostic-write', { code: 'UNCLASSIFIED' }) } catch {}
    })
  }
  const ui18AccountFields = () => {
    const nav = account ? descriptor(account).businessNavigation : undefined
    return {
      ownerPresent: Boolean(account),
      ownerKind: account ? 'account' : 'none',
      accountStatus: ['loading', 'document-loaded', 'context-mounted', 'error'].includes(account?.status) ? account.status : 'unknown',
      businessNavigation: nav === 'shell' ? 'shell' : account ? 'other' : 'unknown',
      generation: Number.isSafeInteger(account?.generation) && account.generation >= 0 ? account.generation : undefined,
    }
  }
  const failMobileLinks = item => { for(const [id,request] of mobileLinkRequests){if(item && request.item!==item)continue;clearTimeout(request.timer);mobileLinkRequests.delete(id);request.reject(Error('mobile link unavailable'))} }
  const failInventory = () => { finishThemeRequest(false); for(const request of inventoryRequests.values()){clearTimeout(request.timer);request.reject(Error('plugin inventory unavailable'))}inventoryRequests.clear(); for(const request of modelRequests.values()){clearTimeout(request.timer);request.reject(Error("model catalog unavailable"))}modelRequests.clear(); for(const request of settingsRequests.values()){clearTimeout(request.timer);request.reject(Error("settings unavailable"))}settingsRequests.clear();failMobileLinks() }
  const key = (s, p) => JSON.stringify([s, p])
  const wrap = w => ({ id: w.id, get frame() { return w.webContents.mainFrame }, get bounds() { return w.getContentBounds() }, window: w })
  const assertWindow = event => {
    const w = [...windows.values(), ...(accountPopout ? [accountPopout] : []), ...rolePopouts.values()].find(x => x.webContents === event.sender && x.webContents.mainFrame === event.senderFrame)
    const id = [...windows].find(([,value]) => value === w)?.[0]
    const expected = w===accountPopout ? ACCOUNT_URL : [...rolePopouts.values()].includes(w) ? 'about:blank' : id && id !== 'main' ? SOURCE_URL + '?solo=1&scene=' + encodeURIComponent(id) : SOURCE_URL
    if (!w || event.senderFrame.url !== expected) throw new Error('source shell: rejected sender')
    return w
  }
  const assertThemeWindow = event => {
    const window=assertWindow(event)
    if(window.isDestroyed() || ![...windows.values()].includes(window))throw Error('wrong source theme owner')
    return window
  }
  const scene = id => { const value = config.scenes.find(s => s.id === id); if (!value) throw new Error('unknown scene'); return value }
  const normalizeOrder = ids => {const result=[];for(const raw of Array.isArray(ids)?ids:[]){if(typeof raw!=='string')continue;const id=raw.trim();if(!id || result.includes(id))continue;result.push(id);if(result.length===200)break}return result}
  const orderedScenes = ids => {const saved=normalizeOrder(ids),byId=new Map(config.scenes.map(s=>[s.id,s]));const ordered=saved.map(id=>byId.get(id)).filter(Boolean).concat(config.scenes.filter(s=>!saved.includes(s.id)));return ordered.filter(s=>s.first).concat(ordered.filter(s=>!s.first))}
  const orderState = () => ({saved:orderSaved,ids:config.scenes.map(s=>s.id)})
  const owner = (w,s,p) => { const seat=registry.get(s,p); if (!seat || seat.window.window!==w) throw new Error('wrong scene owner'); return seat }
  const validScale = value => [0.85,0.9,0.95,1,1.1,1.25].includes(value)
  const themePreference = value => value === 'light' || value === 'dark' || value === 'system'
  const finishThemeRequest = ok => {
    const request=themeRequest;if(!request)return
    themeRequest=undefined;pendingSourceThemePreference=undefined;clearTimeout(request.timer)
    request.event.sender.removeListener('destroyed',request.callerDestroyed)
    request.resolve(ok===true)
  }
  const dispatchThemeRequest = () => {
    const request=themeRequest;if(!request||request.dispatched)return false
    try {
      assertThemeWindow(request.event)
      if(!account || sourceThemePublisher?.item!==account || sourceThemePublisher.generation!==account.generation
        || account.view.webContents.isDestroyed() || sourceThemePublisher.frame!==account.view.webContents.mainFrame
        || controller.resolveGuest(account.view.webContents,sourceThemePublisher.frame)?.scope!=='account'
        || descriptor(account).businessNavigation!=='shell')return false
      request.item=account;request.contents=account.view.webContents;request.frame=sourceThemePublisher.frame
      request.metadata={requestId:request.id,generation:account.generation};request.dispatched=true;pendingSourceThemePreference=undefined
      request.contents.send('source-shell:theme-preference-event',request.preference,request.metadata)
      ui18Diagnostic('theme','preference-dispatched',ui18AccountFields());return true
    } catch { finishThemeRequest(false);return false }
  }
  const paletteKeys = ['canvas','panel','header','border','text','muted','accent','accentStrong','accentSoft','teal','buttonInk','danger','dangerBackground','dangerBorder','warning','warningBackground','warningBorder','success','successBackground']
  const uiKeys = ['fontFamily','fontBody','fontCompact','lineHeight','topRowHeight','navHeight','modelControl','sceneTabHeight','dockTabHeight','controlHeight','toolbarHeight','iconSize','cornerRadius']
  const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  const safeCssValue = value => typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(value)
  const safeThemeSnapshot = value => {
    if (!exactKeys(value, ['preference','colorScheme','palette','ui']) || !themePreference(value.preference)
      || !['light','dark'].includes(value.colorScheme) || !exactKeys(value.palette, paletteKeys) || !exactKeys(value.ui, uiKeys)) throw Error('invalid source theme snapshot')
    const palette = Object.fromEntries(paletteKeys.map(key => { if (!safeCssValue(value.palette[key])) throw Error('invalid source theme palette'); return [key,value.palette[key]] }))
    const ui = Object.fromEntries(uiKeys.map(key => { const item=value.ui[key]; if(key==='fontFamily'){if(typeof item!=='string'||item.length>128)throw Error('invalid source theme UI token')}else if(!Number.isFinite(item)||item<=0||item>512)throw Error('invalid source theme UI token');return [key,item] }))
    return Object.freeze({preference:value.preference,colorScheme:value.colorScheme,palette:Object.freeze(palette),ui:Object.freeze(ui)})
  }
  const safeThemeMaterials = value => {
    if (!exactKeys(value, ['preference','colorScheme','palette','palettes','ui']) || !exactKeys(value.palettes, ['light','dark'])) throw Error('invalid source theme materials')
    const { palettes, ...active } = value
    const current = safeThemeSnapshot(active)
    const light = safeThemeSnapshot({ ...active, colorScheme:'light', palette:palettes.light }).palette
    const dark = safeThemeSnapshot({ ...active, colorScheme:'dark', palette:palettes.dark }).palette
    return Object.freeze({ preference:current.preference, palettes:Object.freeze({light,dark}), ui:current.ui })
  }
  const canonicalThemeSnapshot = () => {
    if (!sourceThemeMaterials) return undefined
    const preference = sourceThemeMaterials.preference
    const resolved = resolveNativeTheme(preference)
    const colorScheme = preference === 'system' ? resolved : preference
    return safeThemeSnapshot({preference, colorScheme, palette:sourceThemeMaterials.palettes[colorScheme], ui:sourceThemeMaterials.ui})
  }
  const publishCanonicalTheme = () => {
    if (closed || !sourceThemeMaterials) return
    const snapshot = canonicalThemeSnapshot()
    const sourceWindows = new Set([...windows.values(), ...rolePopouts.values(), ...componentPopouts.values(), ...(accountPopout ? [accountPopout] : [])])
    let sendCount = 0
    const mainTargetIncluded = sourceWindows.has(main)
    for (const sourceWindow of sourceWindows) {
      if (sourceWindow.isDestroyed() || sourceWindow.webContents.isDestroyed()) continue
      if (process.platform === 'win32' && nativeCaptionWindows.has(sourceWindow) && typeof sourceWindow.setTitleBarOverlay === 'function') {
        try { sourceWindow.setTitleBarOverlay({ color: snapshot.palette.header, symbolColor: snapshot.palette.text }) } catch { /* Keep the validated snapshot flowing if an OS caption update is unavailable. */ }
      }
      try { sourceWindow.webContents.send('source-shell:theme-event', snapshot); sendCount++ } catch { /* A closing source window cannot block theme publication elsewhere. */ }
    }
    const nativeGuests = new Set([account?.view, accountSidebar?.view, sceneComponent?.view, erpNextStatusComponent?.view, ...[...views.values()].map(item => item.view)].filter(Boolean))
    for (const view of nativeGuests) {
      if (view.webContents.isDestroyed()) continue
      try { view.webContents.send('source-shell:theme-event', snapshot) } catch { /* Closing owned guests cannot block other targets. */ }
    }
    ui18Diagnostic('theme', 'publish-accepted', { ...ui18AccountFields(), sendCount, mainTargetIncluded })
    ui18Diagnostic('theme', 'broadcast-complete', { ...ui18AccountFields(), sendCount, mainTargetIncluded })
    sourceThemeSnapshot = snapshot
    return snapshot
  }
  const scaledRect = (w,rect) => { const z=w.webContents.getZoomFactor(); return Object.fromEntries(['x','y','width','height'].map(k=>[k,rect[k]*z])) }
  const applyBounds = item => { if(accountOverlay?.item===item)return applyAccountOverlayBounds(item);if(!item.rect)return;const w=item.parent,seat=item.kind==='account'||item.kind==='scene-component'?undefined:registry.get(item.sceneId,item.panelId),rect=seat?.rehomed?item.rect:scaledRect(w,item.rect);let result;if(item.kind==='account'||item.kind==='scene-component'){if(!['x','y','width','height'].every(k=>Number.isFinite(rect[k]))||rect.width<0||rect.height<0)throw Error('invalid account bounds');const b=w.getContentBounds(),x=Math.max(0,Math.min(b.width,Math.floor(rect.x))),y=Math.max(0,Math.min(b.height,Math.floor(rect.y)));result={x,y,width:Math.max(0,Math.min(b.width-x,Math.floor(rect.width))),height:Math.max(0,Math.min(b.height-y,Math.floor(rect.height)))};item.view.setBounds(result)}else{owner(w,item.sceneId,item.panelId);result=registry.bounds({sender:seat.window,frame:w.webContents.mainFrame},item.sceneId,item.panelId,rect);item.view.setBounds(result)}if(accountSidebarOpen&&accountSidebar&&accountSidebar.parent===w&&!accountGlobalPanel&&w.contentView.children?.at(-1)!==accountSidebar.view)w.contentView.addChildView(accountSidebar.view);raiseAccountOverlay(w);return result }
  const applyScale = value => {
    for(const w of windows.values())w.webContents.setZoomFactor(value)
    if(accountPopout)accountPopout.webContents.setZoomFactor(value)
    for(const w of rolePopouts.values())w.webContents.setZoomFactor(value)
    for(const w of componentPopouts.values())w.webContents.setZoomFactor(value)
    if(account)account.view.webContents.setZoomFactor(value)
    if(accountSidebar)accountSidebar.view.webContents.setZoomFactor(value)
    if(sceneComponent)sceneComponent.view.webContents.setZoomFactor(value)
    if(erpNextStatusComponent)erpNextStatusComponent.view.webContents.setZoomFactor(value)
    for(const item of views.values())item.view.webContents.setZoomFactor(value)
    for(const item of [sceneComponent,erpNextStatusComponent]){
      const child=item&&componentPopouts.get(item.componentKey)
      if(child && item.parent===child && !child.isDestroyed()){
        const bounds=child.getContentBounds(),zoom=child.webContents.getZoomFactor()||1
        item.rect={x:0,y:0,width:bounds.width/zoom,height:bounds.height/zoom}
      }
    }
    for(const item of [...views.values(),...(account?[account]:[]),...(sceneComponent?[sceneComponent]:[]),...(erpNextStatusComponent?[erpNextStatusComponent]:[])])applyBounds(item)
    if(accountSidebar)applyAccountSidebarBounds(accountSidebar)
  }
  const descriptor = item => item.kind === 'account' ? {kind:'account',generation:item.generation,businessNavigation:'shell'} : item.kind==='account-sidebar' ? {kind:'account-sidebar',generation:item.generation,accountGeneration:item.accountGeneration} : item.kind==='scene-component' ? {kind:'scene-component',componentKey:item.componentKey,sceneId:item.sceneId,panelId:item.panelId,generation:item.generation,...(account?{accountGeneration:account.generation}:{})} : {kind:'role',sceneId:item.sceneId,panelId:item.panelId,roleId:item.roleId,sessionId:item.sessionId,bindingRevision:item.bindingRevision,surface:item.surface,generation:item.generation,...(account?{accountGeneration:account.generation}:{})}
  const notifyRoleLayout = item => { const contents=item.view.webContents;if(contents.isDestroyed())return;const next=descriptor(item);if(next.kind==='role')onNativeDescriptorChanged(contents,next);try { contents.send('dsh-desktop:native-surface-changed',next) } catch {} }
  const notifyGuest = item => { item.generation=++generation; item.status=item.loaded?'document-loaded':'loading';const next=descriptor(item);if(next.kind==='role')onNativeDescriptorChanged(item.view.webContents,next); try { item.view.webContents.send('dsh-desktop:native-surface-changed',next) } catch(error) { item.status='context-update-failed'; console.error('source shell: guest notification failed',error) } }
  const observedOperations = Object.freeze({
    create:'role-create',status:'role-status',bounds:'role-bounds',visible:'role-visibility',
    workflowCanvasMount:'workflow-create',workflowCanvasStatus:'workflow-status',workflowCanvasBounds:'workflow-bounds',workflowCanvasVisible:'workflow-visibility',
    erpNextStatusMount:'erpnext-create',erpNextStatusStatus:'erpnext-status',erpNextStatusBounds:'erpnext-bounds',erpNextStatusVisible:'erpnext-visibility',
    accountSidebarToggle:'sidebar-open',accountSidebarSet:'sidebar-open',accountSidebarStatus:'sidebar-status',accountSidebarWidth:'sidebar-width',accountSidebarSetWidth:'sidebar-width',themePreference:'theme-preference',
    sceneRotationPreview:'scene-rotation-preview',sceneRotationConfirm:'scene-rotation-confirm',sceneRotationStatus:'scene-rotation-status',sceneRotationResume:'scene-rotation-resume',sceneRotationCancel:'scene-rotation-cancel',sceneRotationAbandon:'scene-rotation-abandon',
  })
  const bind = (name, fn) => {
    const channel = `source-shell:${name}`, operation=observedOperations[name]
    const report = error => { if(operation) try { observeFailure(operation,error) } catch {} }
    ipcMain.handle(channel, (...args) => {
      try {
        const result=fn(...args)
        return result && typeof result.then==='function' ? result.catch(error=>{report(error);throw error}) : result
      } catch(error) { report(error); throw error }
    })
    channels.push(channel)
  }
  const observeCreatePhase = phase => { try { observePhase(phase) } catch {} }
  const roleGuestPhases = new Set(['palette-start','palette-end','palette-error','register-start','register-end','register-error','refresh-start','refresh-end','refresh-error','not-live','catalog-not-ready','catalog-missing-bound','retain-unknown-session','retain-error','invalid-reference','retain-ready-start','retain-ready-end','retain-ready-error','slot-available','slot-unavailable','mounted-start','mounted-end','mounted-error','generation-wait-start','generation-wait-end','loader-wait-start','loader-wait-end','catalog-refresh-start','catalog-refresh-end','catalog-refresh-error','terminal-error'])
  const observeRoleGuestMessage = (item, args) => {
    const detailsMessage=args[0]?.message
    const message=typeof detailsMessage==='string'?detailsMessage:args[2]
    if(typeof message!=='string'||message.length>96)return
    const match=/^TL-ROLE-GUEST-PHASE\|([a-z-]+)\|(chat|files)$/u.exec(message)
    if(!match||!roleGuestPhases.has(match[1])||match[2]!==item.surface)return
    try {
      if(closed||item.view.webContents.isDestroyed())return
      const id=key(item.sceneId,item.panelId),seat=registry.get(item.sceneId,item.panelId)
      if(views.get(id)!==item||seat?.view!==item.wrapper)return
      if(match[1]==='terminal-error'&&args[0]?.frame!==item.view.webContents.mainFrame)return
      if(match[1]==='terminal-error')emit(item,'error')
      try { observePhase({operation:'role-guest',phase:match[1],surface:item.surface}) } catch {}
    } catch {}
  }
  const observeRoleGuestListProbeMessage = (item, args) => {
    const details=args[0]
    const message=typeof details?.message==='string'?details.message:args[2]
    if(typeof message!=='string'||message.length>180)return
    const v1=/^TL-ROLE-GUEST-LIST-PROBE\|(guest-list-after-refresh-v1)\|(ok|result-error|throw|unknown)\|([^|]{1,64})\|(chat|files)\|([0-9]{1,16})$/u.exec(message)
    const v2=/^TL-ROLE-GUEST-LIST-PROBE\|(guest-list-after-refresh-v2)\|(ok|result-error|throw|unknown)\|([^|]{1,64})\|(withdrawn-prefix|carrier-prefix|rpc-call|result-decode|unclassified|none)\|(chat|files)\|([0-9]{1,16})$/u.exec(message)
    const match=v2||v1
    if(!match)return
    const version=v2?2:1, outcome=match[2], code=match[3], reasonHint=v2?match[4]:null
    const surface=match[v2?5:4], generationText=match[v2?6:5]
    const validCode=code==='none'||code==='unknown'||code.length<=64&&/^[A-Za-z][A-Za-z0-9_-]*(?:\/[A-Za-z0-9_-]+)*(?![\s\S])/u.test(code)
    if(!validCode || (outcome==='ok' ? code!=='none' : code==='none'))return
    if(version===2) {
      if((outcome==='ok') !== (reasonHint==='none') || (outcome!=='ok' && reasonHint==='none'))return
      if(['withdrawn-prefix','carrier-prefix','rpc-call','result-decode'].includes(reasonHint) && code!=='gateway/internal')return
    }
    try {
      const contents=item.view.webContents, frame=details?.frame
      if(closed || contents.isDestroyed() || frame!==contents.mainFrame)return
      const id=key(item.sceneId,item.panelId), seat=registry.get(item.sceneId,item.panelId), generation=Number(generationText)
      if(views.get(id)!==item || !seat || seat.view!==item.wrapper || seat.window?.window!==item.parent
        || surface!==item.surface || !Number.isSafeInteger(item.generation) || !Number.isSafeInteger(generation)
        || generation!==item.generation)return
      const fields={operation:'role-guest',phase:'list-probe',surface:item.surface,probeTag:match[1],outcome,code}
      if(version===2)fields.reasonHint=reasonHint
      try { observePhase(fields) } catch {}
    } catch {}
  }
  const emit = (item, status) => { item.status=status; const seat=registry.get(item.sceneId,item.panelId),placement=seat?.rehomed?'popped-out':'docked',origin=windows.get(item.sceneId)??main;for(const w of new Set([seat?.window.window,origin].filter(Boolean)))if(!w.isDestroyed())try{w.webContents.send('source-shell:status-event',{sceneId:item.sceneId,panelId:item.panelId,status,placement})}catch{} }
  const findRoleTargetForSession = async sessionId => {
    const currentConfig = await getConfig()
    const scenes = Array.isArray(currentConfig?.scenes) ? currentConfig.scenes : []
    const candidates = []
    for (const scene of scenes) {
      for (const panel of Array.isArray(scene?.panels) ? scene.panels : []) {
        if (panel?.type !== 'native-chat' || typeof scene.id !== 'string' || typeof panel.id !== 'string') continue
        const binding = await resolveBinding({ sceneId: scene.id, panelId: panel.id })
        if (binding?.sceneId !== scene.id || binding?.panelId !== panel.id || binding.bindingStatus !== 'bound'
          || binding.sessionId !== sessionId || typeof binding.roleId !== 'string' || !binding.roleId) continue
        candidates.push({ sceneId: scene.id, panelId: panel.id, roleId: binding.roleId, sceneRoleId: scene.roleId })
      }
    }
    if (!candidates.length) return undefined
    const visible = candidates.filter(candidate => {
      const item = views.get(key(candidate.sceneId, candidate.panelId))
      return item?.visible === true && item.parent === main && item.sessionId === sessionId
    })
    if (visible.length === 1) return visible[0]
    if (visible.length > 1) return visible.find(candidate => candidate.sceneId === candidate.roleId) ?? visible[0]
    const defaults = candidates.filter(candidate => candidate.sceneId === candidate.roleId || candidate.sceneRoleId === candidate.roleId)
    if (defaults.length === 1) return defaults[0]
    if (defaults.length > 1) return defaults.find(candidate => candidate.sceneId === candidate.roleId)
    return candidates.length === 1 ? candidates[0] : undefined
  }
  const revoke = item => {
    const id=key(item.sceneId,item.panelId),child=rolePopouts.get(id)
    onNativeDescriptorChanged(item.view.webContents,null)
    if (!closed) registry.revoke(item.sceneId,item.panelId)
    views.delete(id); rolePopouts.delete(id)
    try { item.parent.contentView.removeChildView(item.view) } catch {}
    if(child && !child.isDestroyed()) { closingRolePopouts.add(child); try { child.destroy() } catch {} }
  }
  const relocate = (sceneId, from, to, commit = () => {}) => {
    const workflow=sceneComponent?.sceneId===sceneId?sceneComponent:undefined
    const items=[...views.values()].filter(item=>item.sceneId===sceneId && item.parent===from)
    if(workflow && workflow.parent===from)items.push(workflow)
    const moved=[]
    try {
      for (const item of items) {
        const entry={item, index:contentChildIndex(from,item.view), dockIndex:item.dockIndex, removed:false, added:false}; moved.push(entry)
        from.contentView.removeChildView(item.view); entry.removed=true
        to.contentView.addChildView(item.view); entry.added=true; item.parent=to
        updateOwnership(item.view.webContents,to)
        if(item===workflow)item.dockIndex=contentChildIndex(to,item.view)
      }
      commit(); for(const {item} of moved)if(item!==workflow)item.failed=false
    } catch(error) {
      const failures=[]
      for(const entry of moved.reverse()) {
        try { if(entry.added) to.contentView.removeChildView(entry.item.view); if(entry.removed) { from.contentView.addChildView(entry.item.view,entry.index>=0?entry.index:undefined); entry.item.parent=from; restoreContentChildIndex(from,entry.item.view,entry.index) } if(entry.item===workflow)entry.item.dockIndex=entry.dockIndex; updateOwnership(entry.item.view.webContents,from) } catch(rollbackError) { failures.push(rollbackError) }
      }
      if(failures.length) { for(const {item} of moved)if(item!==workflow)item.failed=true; throw new AggregateError([error,...failures],'surface migration rollback failed') }
      throw error
    }
    for(const {item} of moved)if(item!==workflow)notifyRoleLayout(item)
    if(workflow)notifySceneComponent(workflow)
  }
  const rolePlacement = item => registry.get(item.sceneId,item.panelId)?.rehomed ? 'popped-out' : 'docked'
  const roleDockWindow = item => (windows.get(item.sceneId) ?? main)
  const setRolePopoutBounds = item => {
    const child=rolePopouts.get(key(item.sceneId,item.panelId))
    if(!child || child.isDestroyed() || item.parent!==child || child.isMinimized?.())return
    const bounds=child.getContentBounds(); item.popoutRect={x:0,y:0,width:bounds.width,height:bounds.height}; item.rect=item.popoutRect
    item.view.setVisible(true); item.visible=true; applyBounds(item)
  }
  const returnRoleSeat = async (item, child) => {
    const id=key(item.sceneId,item.panelId)
    if(rolePopouts.get(id)!==child || item.parent!==child)throw Error('role surface is not popped out')
    if(hasNativeModal(child) || hasNativeModal(main))throw Error('invalid role return')
    const seat=registry.get(item.sceneId,item.panelId)
    if(!seat?.rehomed || seat.window.window!==child)throw Error('role popout ownership unavailable')
    const previousWrapper=seat.window,previousRect=item.rect,previousDockedRect=item.dockedRect
    const returned=registry.returnSeat(item.sceneId,item.panelId),target=returned.window.window
    if(!target || target.isDestroyed()) { registry.rehome(item.sceneId,item.panelId,previousWrapper); throw Error('role dock owner unavailable') }
    try {
      child.contentView.removeChildView(item.view)
      target.contentView.addChildView(item.view)
      item.parent=target; item.popoutOwner=undefined; updateOwnership(item.view.webContents,target)
      item.rect=item.dockedRect ?? null; item.dockedRect=undefined; item.visible=false; item.view.setVisible(false)
      rolePopouts.delete(id)
    } catch(error) {
      try { try { target.contentView.removeChildView(item.view) } catch {}; child.contentView.addChildView(item.view); item.parent=child; updateOwnership(item.view.webContents,child); item.rect=previousRect; item.dockedRect=previousDockedRect; registry.rehome(item.sceneId,item.panelId,wrap(child)) } catch(rollbackError) { throw new AggregateError([error,rollbackError],'role surface return rollback failed') }
      throw error
    }
    notifyRoleLayout(item)
    emit(item,item.status)
    target.focus?.()
    closingRolePopouts.add(child)
    if(!child.isDestroyed())child.close()
    return {status:item.status,placement:'docked'}
  }
  const popOutRoleSeat = async (event,sceneId,panelId) => {
    const requester=assertWindow(event),id=key(sceneId,panelId),expected=windows.get(sceneId)??main,item=views.get(id)
    if(requester!==expected || !item || item.sceneId!==sceneId || item.panelId!==panelId || item.surface!=='chat' || hasNativeModal(requester))throw Error('invalid role popout')
    const existing=rolePopouts.get(id)
    if(existing && !existing.isDestroyed()) { existing.show?.(); existing.focus?.(); return {status:item.status,placement:'popped-out'} }
    if(rolePopoutCreating.has(id))return rolePopoutCreating.get(id)
    const task=(async()=>{
      const child=new BrowserWindow({frame:true,autoHideMenuBar:true,width:1040,height:760,minWidth:600,minHeight:420,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}})
      child.webContents.setZoomFactor(uiScale)
      const seat=registry.get(sceneId,panelId),from=item.parent
      if(!seat || seat.window.window!==from || from!==requester) { child.destroy(); throw Error('role popout owner changed') }
      const panel=scene(sceneId).panels.find(value=>value.id===panelId),title=`织贸助手 · ${typeof panel?.title==='string'?panel.title:'原生助手'}`
      child.setTitle?.(title.slice(0,128))
      rolePopouts.set(id,child)
      try {
        await child.webContents.loadURL('about:blank')
        if(closed || child.isDestroyed() || assertWindow(event)!==requester || views.get(id)!==item || item.parent!==from || hasNativeModal(from) || hasNativeModal(child))throw Error('role surface unavailable')
        from.contentView.removeChildView(item.view)
        try {
          child.contentView.addChildView(item.view)
          updateOwnership(item.view.webContents,child)
          registry.rehome(sceneId,panelId,wrap(child))
          item.parent=child; item.popoutOwner=requester; item.dockedRect=item.rect; item.visible=true
          const bounds=child.getContentBounds();item.rect={x:0,y:0,width:bounds.width,height:bounds.height}
          item.view.setVisible(true);applyBounds(item)
          const refresh=()=>setRolePopoutBounds(item)
          child.on('resize',refresh);child.on('maximize',refresh);child.on('unmaximize',refresh);child.on('restore',refresh)
          child.on('close',closeEvent=>{
            if(closingRolePopouts.has(child) || rolePopouts.get(id)!==child)return
            closeEvent.preventDefault()
            void returnRoleSeat(item,child).catch(error=>console.error('source shell: role return failed',error))
          })
          child.once('closed',()=>{if(rolePopouts.get(id)===child)rolePopouts.delete(id);closingRolePopouts.delete(child)})
          child.show?.();child.focus?.();notifyRoleLayout(item);emit(item,item.status)
          return {status:item.status,placement:'popped-out'}
        } catch(error) {
          try { try { child.contentView.removeChildView(item.view) } catch {}; from.contentView.addChildView(item.view); item.parent=from; item.popoutOwner=undefined; updateOwnership(item.view.webContents,from); if(registry.get(sceneId,panelId)?.rehomed)registry.returnSeat(sceneId,panelId); item.rect=item.dockedRect??item.rect; item.dockedRect=undefined; item.view.setVisible(item.visible===true) } catch(rollbackError) { throw new AggregateError([error,rollbackError],'role popout rollback failed') }
          throw error
        }
      } catch(error) { if(rolePopouts.get(id)===child)rolePopouts.delete(id); closingRolePopouts.add(child); if(!child.isDestroyed())child.destroy(); throw error }
    })()
    rolePopoutCreating.set(id,task)
    try{return await task}finally{if(rolePopoutCreating.get(id)===task)rolePopoutCreating.delete(id)}
  }
  const windowOptions = () => {
    const options = { width:1440, height:900, webPreferences:{preload:sourcePreload,contextIsolation:true,nodeIntegration:false,sandbox:true} }
    if (process.platform !== 'win32') return { ...options, frame:false }
    if (typeof getNativeCaptionFallback !== 'function') return { ...options, frame:false }
    const fallback = getNativeCaptionFallback()
    return { ...options, titleBarStyle:'hidden', titleBarOverlay:{
      height:fallback.height,
      color:sourceThemeSnapshot?.palette.header ?? fallback.color,
      symbolColor:sourceThemeSnapshot?.palette.text ?? fallback.symbolColor,
    } }
  }
  const geometryObservedWindows = new WeakSet()
  const attachPanelGeometryObserver = window => {
    if (geometryObservedWindows.has(window)) return
    geometryObservedWindows.add(window)
    let remaining = 24
    const contents = window.webContents
    const onMessage = details => {
      if (remaining <= 0 || ![...windows.values()].includes(window) || window.isDestroyed()
        || contents.isDestroyed() || details?.level !== 'info' || !details.frame
        || details.frame !== contents.mainFrame || typeof details.message !== 'string'
        || details.message.length > 100000 || !details.message.startsWith('TL-S506-GEOMETRY|')) return
      try {
        const url = new URL(details.frame.url)
        if (url.protocol !== 'dsh-app:' || url.host !== 'app' || url.username || url.password || url.hash
          || url.pathname !== '/source-shell/renderer/source-entry.html') return
        const value = JSON.parse(details.message.slice('TL-S506-GEOMETRY|'.length))
        if (!validPanelGeometryRecord(value)) return
        remaining -= 1
        observePhase({ operation: 'panel-geometry', ...value })
      } catch { /* Untrusted console data is never an action or an authority. */ }
    }
    const dispose = () => {
      contents.removeListener('console-message', onMessage)
      contents.removeListener('destroyed', dispose)
      window.removeListener('closed', dispose)
    }
    contents.on('console-message', onMessage)
    window.once('closed', dispose)
    contents.once('destroyed', dispose)
  }
  const createSourceWindow = options => {
    const window = new BrowserWindow(options)
    attachPanelGeometryObserver(window)
    if (process.platform === 'win32' && options.titleBarStyle === 'hidden' && options.titleBarOverlay) nativeCaptionWindows.add(window)
    return window
  }
  const sourceCaptionHeightDip = window => nativeCaptionWindows.has(window)
    ? getNativeCaptionFallback().height
    : Math.round(40*uiScale)
  const accountSidebarWidthValue = () => { const bounds=accountSidebar?.parent.getContentBounds(),available=Number.isFinite(bounds?.width)?Math.max(0,Math.floor(bounds.width/(uiScale||1))):520,maxDip=Math.min(520,available),minDip=Math.min(280,maxDip);accountSidebarWidthDip=Math.max(minDip,Math.min(maxDip,accountSidebarWidthDip));return {widthDip:accountSidebarWidthDip,minDip,maxDip} }
  const notifyAccountSidebarWidth = () => { const value=accountSidebarWidthValue();for(const w of new Set([main,accountPopout].filter(Boolean)))if(!w.isDestroyed())try{w.webContents.send('source-shell:account-sidebar-width-event',value)}catch{} }
  const notifyAccountSidebar = () => { for(const w of new Set([main,accountPopout].filter(Boolean))) if(!w.isDestroyed()) try { w.webContents.send('source-shell:account-sidebar-event',accountSidebarOpen) } catch {} }
  const applyAccountSidebarBounds = item => { if(!item || item.view.webContents.isDestroyed())return;accountSidebarWidthValue();const b=item.parent.getContentBounds(),headerDip=sourceCaptionHeightDip(item.parent),sidebarDip=Math.round(accountSidebarWidthDip*uiScale);item.view.setBounds({x:0,y:Math.min(headerDip,Math.max(0,b.height)),width:Math.min(sidebarDip,Math.max(0,b.width)),height:Math.max(0,b.height-headerDip)}) }
  const raiseAccountOverlay = parent => {const item=accountOverlay?.item;if(item && item.parent===parent && !accountGlobalPanel && parent.contentView.children?.at(-1)!==item.view)parent.contentView.addChildView(item.view)}
  // Overlay the complete account document, preserving its session and native layout.
  const applyAccountOverlayBounds = item => {
    const b=item.parent.getContentBounds(),top=Math.min(Math.round(sourceCaptionHeightDip(item.parent)),Math.max(0,Math.floor(b.height)))
    const available={width:Math.max(0,Math.floor(b.width)),height:Math.max(0,Math.floor(b.height-top))},z=item.view.webContents.getZoomFactor()
    // Presentation is transient and independent of accountOverlay.rect (the saved dock layout).
    const desired=accountOverlay?.item===item?accountOverlay.presentationRect:undefined
    const rect={x:0,y:top,width:Math.min(available.width,Math.max(Math.min(available.width,Math.ceil(664*z)),Math.round(desired?.width??available.width))),height:Math.min(available.height,Math.max(Math.min(available.height,Math.ceil(240*z)),Math.round(desired?.height??available.height)))}
    item.view.setBounds(rect);raiseAccountOverlay(item.parent);return rect
  }
  const accountOverlayBoundsValue = () => {
    const item=accountOverlay.item,rect=item.view.getBounds(),b=item.parent.getContentBounds(),z=item.view.webContents.getZoomFactor()
    const maxWidth=Math.max(0,Math.floor(b.width))/z,maxHeight=Math.max(0,Math.floor(b.height-rect.y))/z
    return {requestId:accountOverlayRequest.requestId,generation:item.generation,width:rect.width/z,height:rect.height/z,
      minWidth:Math.min(maxWidth,Math.ceil(664*z)/z),minHeight:Math.min(maxHeight,Math.ceil(240*z)/z),maxWidth,maxHeight}
  }
  const publishAccountOverlayRequest = () => {
    const item=account, contents=item?.view.webContents, frame=contents?.mainFrame
    const requestId=++inventorySequence
    const eligible=!!(item && accountOverlay?.item===item && accountSidebarOpen && !accountGlobalPanel
      && item.parent===main && item.placement==='docked' && item.status==='context-mounted'
      && !contents.isDestroyed() && frame)
    accountOverlayRequest=eligible?{requestId,generation:item.generation,item,contents,frame}:undefined
    accountOverlayState={requestId,generation:item?.generation??0,eligible}
    if(contents && !contents.isDestroyed())try{contents.send('source-shell:account-overlay-state',accountOverlayState)}catch{}
  }
  const closeAccountOverlay = (restoreVisible=false) => {
    const saved=accountOverlay;if(!saved)return
    accountOverlay=undefined;accountSidebarOpen=false
    publishAccountOverlayRequest()
    for(const [name,fn] of saved.listeners)saved.item.parent.removeListener(name,fn)
    const item=saved.item
    if(account===item && !item.view.webContents.isDestroyed()){
      item.rect=saved.rect;item.visible=restoreVisible && saved.visible;item.view.setVisible(item.visible)
      if(item.rect)applyBounds(item)
      restoreContentChildIndex(item.parent,item.view,saved.childIndex)
    }
    notifyAccountSidebar()
  }
  const setAccountSidebarWidth = value => { if(!Number.isFinite(value))throw Error('invalid account sidebar width');const current=accountSidebarWidthValue();accountSidebarWidthDip=Math.max(current.minDip,Math.min(current.maxDip,Math.round(value)));if(accountSidebar)applyAccountSidebarBounds(accountSidebar);notifyAccountSidebarWidth();return accountSidebarWidthValue() }
  const disposeAccountSidebar = () => {
    closeAccountOverlay()
    const item=accountSidebar
    accountSidebarRequest++
    accountSidebar=undefined
    accountSidebarCreating=undefined
    accountSidebarOpen=false
    if(item){for(const [name,listener] of item.listeners??[])item.parent.removeListener(name,listener);try{item.parent.contentView.removeChildView(item.view)}catch{};if(!item.view.webContents.isDestroyed())item.view.webContents.destroy()}
    notifyAccountSidebar()
  }
  const setAccountSidebarOpen = async open => {
    if(typeof open!=='boolean')throw Error('invalid account sidebar state')
    const parent=account?.parent
    const validParent=parent===main && account?.placement==='docked' || parent===accountPopout && account?.placement==='popout' && accountPopout!==undefined && !accountPopout.isDestroyed()
    if(!account || !validParent || account.status!=='context-mounted')throw Error('account sidebar unavailable')
    if(!open && accountOverlay){closeAccountOverlay();return false}
    if(open){
      if(!accountOverlay){
        const item=account,listeners=[]
        accountOverlay={item,rect:item.rect?{...item.rect}:undefined,visible:item.visible===true,childIndex:contentChildIndex(parent,item.view),listeners}
        const refresh=()=>{if(accountOverlay?.item===item)applyAccountOverlayBounds(item)}
        const visibility=()=>{if(accountOverlay?.item===item)item.view.setVisible(!parent.isMinimized?.())}
        for(const name of ['resize','maximize','unmaximize']){parent.on(name,refresh);listeners.push([name,refresh])}
        for(const name of ['minimize','restore']){parent.on(name,visibility);listeners.push([name,visibility])}
      }
      accountSidebarOpen=true;parent.contentView.addChildView(account.view);applyAccountOverlayBounds(account);account.visible=true;account.view.setVisible(!parent.isMinimized?.());publishAccountOverlayRequest();notifyAccountSidebar();notifyAccount(account);return true
    }
    const request=++accountSidebarRequest
    if(!open){accountSidebarOpen=false;if(accountSidebar)accountSidebar.view.setVisible(false);notifyAccountSidebar();return false}
    if(!accountSidebar){
      const view=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}})
      const item={kind:'account-sidebar',generation:++generation,accountGeneration:account.generation,view,parent,listeners:[]}
      accountSidebar=item
      const creating=(async()=>{try{
        item.parent.contentView.addChildView(view);view.setVisible(false);view.webContents.setZoomFactor(uiScale);applyAccountSidebarBounds(item)
        const refresh=()=>{applyAccountSidebarBounds(item);notifyAccountSidebarWidth()},hide=()=>{if(item.parent.isMinimized?.())view.setVisible(false);else if(accountSidebar===item && accountSidebarOpen)view.setVisible(true)}
        for(const name of ['resize','maximize','unmaximize']){item.parent.on(name,refresh);item.listeners.push([name,refresh])}
        for(const name of ['minimize','restore']){item.parent.on(name,hide);item.listeners.push([name,hide])}
        view.webContents.once('destroyed',()=>{if(accountSidebar===item)disposeAccountSidebar()})
        view.webContents.once('render-process-gone',()=>{if(accountSidebar===item)disposeAccountSidebar()})
        await view.webContents.loadURL('dsh-app://app/')
        if(accountSidebar!==item || account!==undefined && account.generation!==item.accountGeneration)throw Error('account sidebar owner changed')
      }catch(error){if(accountSidebar===item)disposeAccountSidebar();else if(!view.webContents.isDestroyed())view.webContents.destroy();throw error}})()
      accountSidebarCreating=creating
      try{await creating}finally{if(accountSidebarCreating===creating)accountSidebarCreating=undefined}
    }else if(accountSidebarCreating){
      await accountSidebarCreating
    }
    if(request!==accountSidebarRequest || !accountSidebar || accountSidebar.accountGeneration!==account.generation)return false
    accountSidebarOpen=true;accountSidebar.parent.contentView.addChildView(accountSidebar.view);applyAccountSidebarBounds(accountSidebar);accountSidebar.view.setVisible(!accountSidebar.parent.isMinimized?.());notifyAccountSidebar();return true
  }
  const accountStatusValue = item => ({status:item?.status ?? 'unbound',placement:item?.placement ?? 'docked',visible:item?.visible===true})
  const accountGlobalPanelState = () => ({mode:accountGlobalPanel?.mode ?? null,open:accountGlobalPanel !== undefined,panelId:accountGlobalPanel?.panelId ?? null})
  const notifyAccountGlobalPanel = value => { publishAccountOverlayRequest();if(main && !main.isDestroyed())try{main.webContents.send('source-shell:account-global-panel-event',value)}catch{} }
  const contentChildIndex = (parent,view) => Array.isArray(parent?.contentView?.children) ? parent.contentView.children.indexOf(view) : -1
  const restoreContentChildIndex = (parent,view,index) => {
    if(!Number.isInteger(index) || index<0 || !parent || parent.isDestroyed?.())return
    const children=parent.contentView.children
    if(!Array.isArray(children) || children[index]===view)return
    parent.contentView.removeChildView(view)
    parent.contentView.addChildView(view,Math.min(index,children.length))
  }
  const isFocusableMainContents = contents => {
    if(!contents || contents.isDestroyed?.() || !main || main.isDestroyed())return false
    if(contents===main.webContents)return true
    if(account?.parent===main && account.visible===true && account.view.webContents===contents)return true
    if(accountSidebar?.parent===main && accountSidebarOpen && accountSidebar.view.webContents===contents)return true
    if(sceneComponent?.parent===main && sceneComponent.visible===true && sceneComponent.view.webContents===contents)return true
    if(erpNextStatusComponent?.parent===main && erpNextStatusComponent.visible===true && erpNextStatusComponent.view.webContents===contents)return true
    for(const item of views.values())if(item.parent===main && item.visible===true && item.view.webContents===contents && !item.failed)return true
    return false
  }
  const captureMainFocus = () => {
    const remembered=focusedGuests.get(main)
    if(remembered?.isFocused?.()===true && isFocusableMainContents(remembered))return remembered
    return main?.webContents.isFocused?.()===true && isFocusableMainContents(main.webContents)?main.webContents:undefined
  }
  const restoreMainFocus = contents => {
    const target=isFocusableMainContents(contents)?contents:main && !main.isDestroyed()?main.webContents:undefined
    if(target && !target.isDestroyed?.())target.focus?.()
  }
  const restoreAccountGlobalPanel = (item,sendCommand) => {
    const current=accountGlobalPanel
    if(!current || current.item!==item)return false
    if(sendCommand && !item.view.webContents.isDestroyed())try{item.view.webContents.send('dsh-desktop:account-sidebar-command-received',current.mode==='settings'?{action:'closeSettings'}:{action:'selectPanel',panelId:null})}catch{}
    accountGlobalPanel=undefined
    if(item===account && item.parent===main && !item.view.webContents.isDestroyed()){
      item.rect=current.previousRect ? {...current.previousRect} : undefined
      item.visible=current.previousVisible===true
      item.view.setVisible(item.visible)
      if(item.rect)applyBounds(item)
      restoreContentChildIndex(main,item.view,current.previousChildIndex)
      if(accountSidebarOpen && accountSidebar)main.contentView.addChildView(accountSidebar.view)
    }
    notifyAccountGlobalPanel({mode:null,open:false,panelId:null})
    if(item===account)notifyAccount(item)
    if(current.mode==='settings')restoreMainFocus(current.previousFocused)
    return true
  }
  const showAccountGlobalPanel = (item,mode,panelId=null) => {
    if(item!==account || item.status!=='context-mounted' || item.parent!==main || item.placement!=='docked')throw Error('global account panel unavailable')
    closeAccountOverlay(true)
    if(!accountGlobalPanel)accountGlobalPanel={item,previousRect:item.rect?{...item.rect}:undefined,previousVisible:item.visible===true,previousChildIndex:contentChildIndex(main,item.view),previousFocused:mode==='settings'?captureMainFocus():undefined}
    else if(accountGlobalPanel.item!==item)throw Error('global account panel owner changed')
    else if(mode==='settings' && accountGlobalPanel.mode!=='settings')accountGlobalPanel={...accountGlobalPanel,previousFocused:captureMainFocus()}
    accountGlobalPanel={...accountGlobalPanel,mode,panelId}
    const bounds=main.getContentBounds(),zoom=main.webContents.getZoomFactor(),headerDip=sourceCaptionHeightDip(main)
    item.rect={x:0,y:headerDip/zoom,width:bounds.width/zoom,height:Math.max(0,bounds.height-headerDip)/zoom}
    main.contentView.addChildView(item.view)
    item.view.setVisible(true);item.visible=true;applyBounds(item)
    notifyAccountGlobalPanel({mode,open:true,panelId})
    notifyAccount(item)
    if(mode==='settings')item.view.webContents.focus?.()
    return true
  }
  const notifyAccount = item => { const value=accountStatusValue(item); for(const w of new Set([main,accountPopout].filter(Boolean)))if(!w.isDestroyed())try{w.webContents.send('source-shell:account-status-event',value)}catch(error){console.error('source shell: account status notification failed',error)} }
  const moveAccountView = (item,to,placement) => {
    closeAccountOverlay(true)
    if(accountSidebar)disposeAccountSidebar()
    const from=item.parent,previous={rect:item.rect,dockedRect:item.dockedRect,popoutRect:item.popoutRect,placement:item.placement,visible:item.visible,focused:focusedGuests.get(from)}
    if(from===to && item.placement===placement)return
    try {
      from.contentView.removeChildView(item.view)
      to.contentView.addChildView(item.view)
      item.parent=to
      updateOwnership(item.view.webContents,to)
      if(focusedGuests.get(from)===item.view.webContents)focusedGuests.delete(from)
      focusedGuests.set(to,item.view.webContents)
      const detachPreviousShortcuts=item.detachShortcuts
      item.detachShortcuts=attachAccountShortcuts?.(to,item.view.webContents,()=>account===item && item.visible===true)
      detachPreviousShortcuts?.()
      if(placement==='popout'){
        item.dockedRect=previous.rect
        const bounds=to.getContentBounds();item.rect={x:0,y:0,width:bounds.width,height:bounds.height}
      }else{
        item.popoutRect=previous.rect
        item.rect=previous.dockedRect ?? null
        item.dockedRect=undefined
      }
      item.placement=placement
      item.view.setVisible(item.visible===true)
      applyBounds(item)
      notifyAccount(item)
    }catch(error){
      const rollbackErrors=[]
      try{try{to.contentView.removeChildView(item.view)}catch{};from.contentView.addChildView(item.view);item.parent=from;updateOwnership(item.view.webContents,from);if(focusedGuests.get(to)===item.view.webContents)focusedGuests.delete(to);if(previous.focused)focusedGuests.set(from,previous.focused);item.detachShortcuts?.();item.detachShortcuts=attachAccountShortcuts?.(from,item.view.webContents,()=>account===item && item.visible===true);item.rect=previous.rect;item.dockedRect=previous.dockedRect;item.popoutRect=previous.popoutRect;item.placement=previous.placement;item.visible=previous.visible;item.view.setVisible(previous.visible===true);applyBounds(item)}catch(rollbackError){rollbackErrors.push(rollbackError)}
      if(rollbackErrors.length)throw new AggregateError([error,...rollbackErrors],'account view migration rollback failed')
      throw error
    }
  }
  const accountOwner = event => { const w=assertWindow(event);if(!account || w!==account.parent)throw Error('wrong account owner');return account }
  const workflowCanvasRoute = () => {
    const route=config?.businessRoutes?.['/agent-center']
    const current=config?.scenes?.find(value=>value.id===route?.sceneId)
    const panel=current?.panels?.find(value=>value.id===route?.panelId)
    if(!route || typeof route.sceneId!=='string' || typeof route.panelId!=='string' || !current || !panel)throw Error('workflow canvas route unavailable')
    return {sceneId:route.sceneId,panelId:route.panelId}
  }
  const erpNextStatusRoute = () => {
    const matches=[]
    for(const current of config?.scenes ?? []) for(const panel of current.panels ?? []) if(panel.type==='erpnext-status')matches.push({sceneId:current.id,panelId:panel.id})
    if(matches.length!==1 || matches[0].sceneId!=='erpnext')throw Error('ERPNext status route unavailable')
    return matches[0]
  }
  const disposeSceneComponent = item => {
    if(sceneComponent===item)sceneComponent=undefined
    if(erpNextStatusComponent===item)erpNextStatusComponent=undefined
    const child=componentPopouts.get(item.componentKey)
    if(child){componentPopouts.delete(item.componentKey);closingComponentPopouts.add(child);if(!child.isDestroyed())child.destroy()}
    try{item.parent.contentView.removeChildView(item.view)}catch{}
    if(!item.view.webContents.isDestroyed())item.view.webContents.destroy()
  }
  const workflowDockOwner = () => windows.get(workflowCanvasRoute().sceneId) ?? main
  const componentDockOwner = item => item?.componentKey==='workflow-canvas-native' ? windows.get(item.sceneId) ?? main : main
  const componentForKey = componentKey => componentKey==='workflow-canvas-native'?sceneComponent:componentKey==='erpnext-status-native'?erpNextStatusComponent:undefined
  const componentPlacement = item => item && componentPopouts.get(item.componentKey)===item.parent?'popped-out':'docked'
  const componentStatusValue = item => ({status:item?.status ?? 'unavailable',visible:item?.visible===true,placement:componentPlacement(item),componentKey:item?.componentKey,sceneId:item?.sceneId,panelId:item?.panelId})
  const notifySceneComponent = item => {
    const dockOwner=componentDockOwner(item)
    if(closed || !dockOwner || dockOwner.isDestroyed())return
    const channel=item.componentKey==='workflow-canvas-native'?'source-shell:workflow-canvas-status':'source-shell:erpnext-status-event'
    try{dockOwner.webContents.send(channel,componentStatusValue(item))}catch{}
  }
  const applySceneComponentBounds = (item,rect) => {
    if(!rect || !['x','y','width','height'].every(key=>Number.isFinite(rect[key])) || rect.width<0 || rect.height<0)throw Error('invalid scene component bounds')
    const next={x:rect.x,y:rect.y,width:rect.width,height:rect.height}
    if(componentPlacement(item)==='popped-out'){item.dockedRect=next;return next}
    item.rect=next;item.dockedRect=next
    return applyBounds(item)
  }
  const setSceneComponentVisible = (item,visible) => {
    if(typeof visible!=='boolean')throw Error('invalid scene component visibility')
    item.dockedVisible=visible
    if(componentPlacement(item)==='popped-out'){item.visible=true;item.view.setVisible(true)}
    else {item.visible=visible;item.view.setVisible(visible)}
    notifySceneComponent(item)
    return {status:item.status,visible:item.visible,placement:componentPlacement(item)}
  }
  const returnSceneComponentToDock = (item,child,closeWindow=true) => {
    const componentKey=item?.componentKey,dockOwner=componentDockOwner(item)
    if(!item || componentPopouts.get(componentKey)!==child || item.parent!==child)throw Error('scene component is not popped out')
    if(closed || !dockOwner || dockOwner.isDestroyed())throw Error('scene component dock owner unavailable')
    if(hasNativeModal(child) || hasNativeModal(dockOwner))throw Error('invalid scene component return')
    const oldRect=item.rect,oldVisible=item.visible,dockRect=item.dockedRect?{...item.dockedRect}:null,dockVisible=item.dockedVisible===true,dockIndex=item.dockedChildIndex
    try{
      child.contentView.removeChildView(item.view)
      dockOwner.contentView.addChildView(item.view,Number.isInteger(dockIndex)&&dockIndex>=0?dockIndex:undefined)
      restoreContentChildIndex(dockOwner,item.view,dockIndex)
      updateOwnership(item.view.webContents,dockOwner)
      item.parent=dockOwner;item.rect=dockRect;item.visible=dockVisible;item.dockedRect=undefined;item.dockedVisible=undefined;item.dockedChildIndex=undefined
      if(item.rect)applyBounds(item)
      item.view.setVisible(item.visible)
      componentPopouts.delete(componentKey)
      notifySceneComponent(item)
    }catch(error){
      try{try{dockOwner.contentView.removeChildView(item.view)}catch{};child.contentView.addChildView(item.view);item.parent=child;item.rect=oldRect;item.visible=oldVisible;item.dockedRect=dockRect;item.dockedVisible=dockVisible;item.dockedChildIndex=dockIndex;item.view.setVisible(true);updateOwnership(item.view.webContents,child);componentPopouts.set(componentKey,child)}catch(rollbackError){throw new AggregateError([error,rollbackError],'scene component return rollback failed')}
      throw error
    }
    if(closeWindow && !child.isDestroyed()){closingComponentPopouts.add(child);child.close()}
    return componentStatusValue(item)
  }
  const popOutSceneComponent = async (event,componentKey) => {
    const requester=assertWindow(event),item=componentForKey(componentKey),dockOwner=componentDockOwner(item)
    if(requester!==dockOwner || !['workflow-canvas-native','erpnext-status-native'].includes(componentKey) || !item || item.view.webContents.isDestroyed() || hasNativeModal(dockOwner))throw Error('invalid scene component popout')
    const existing=componentPopouts.get(componentKey)
    if(existing && !existing.isDestroyed() && item.parent===existing){if(existing.isMinimized?.())existing.restore?.();existing.show?.();existing.focus?.();return componentStatusValue(item)}
    if(componentPopoutCreating.has(componentKey))return componentPopoutCreating.get(componentKey)
    if(item.parent!==dockOwner)throw Error('scene component owner changed')
    const task=(async()=>{
      const child=new BrowserWindow({frame:true,width:1040,height:760,minWidth:600,minHeight:420,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}})
      child.webContents.setZoomFactor(uiScale)
      const dockRect=item.rect?{...item.rect}:null,dockVisible=item.visible===true,dockIndex=Number.isInteger(item.dockIndex)&&item.dockIndex>=0?item.dockIndex:contentChildIndex(dockOwner,item.view),from=item.parent
      child.setTitle?.(componentKey==='workflow-canvas-native'?'织贸助手 · 工作流画布':'织贸助手 · ERPNext 状态')
      try{
        await child.webContents.loadURL('about:blank')
        if(closed || child.isDestroyed() || dockOwner.isDestroyed() || componentForKey(componentKey)!==item || componentDockOwner(item)!==dockOwner || item.parent!==from || from!==dockOwner || hasNativeModal(dockOwner))throw Error('scene component unavailable')
        from.contentView.removeChildView(item.view)
        child.contentView.addChildView(item.view)
        updateOwnership(item.view.webContents,child)
        item.parent=child;item.dockedRect=dockRect;item.dockedVisible=dockVisible;item.dockedChildIndex=dockIndex;item.visible=true
        const bounds=child.getContentBounds(),zoom=child.webContents.getZoomFactor()||1
        item.rect={x:0,y:0,width:bounds.width/zoom,height:bounds.height/zoom}
        componentPopouts.set(componentKey,child)
        item.view.setVisible(true);applyBounds(item)
        const refresh=()=>{if(componentPopouts.get(componentKey)!==child || item.parent!==child || child.isDestroyed() || child.isMinimized?.())return;const b=child.getContentBounds(),z=child.webContents.getZoomFactor()||1;item.rect={x:0,y:0,width:b.width/z,height:b.height/z};item.view.setVisible(true);applyBounds(item)}
        child.on('resize',refresh);child.on('maximize',refresh);child.on('unmaximize',refresh);child.on('restore',refresh)
        child.on('close',closeEvent=>{if(closed || closingComponentPopouts.has(child))return;closeEvent.preventDefault();try{returnSceneComponentToDock(item,child)}catch(error){console.error('source shell: scene component return failed',error)}})
        child.once('closed',()=>{if(componentPopouts.get(componentKey)===child && item.parent===child && !closed){try{returnSceneComponentToDock(item,child,false)}catch(error){item.status='error';item.visible=false;try{item.view.setVisible(false)}catch{};notifySceneComponent(item);console.error('source shell: scene component recovery failed',error)}}closingComponentPopouts.delete(child)})
        child.show?.();child.focus?.();notifySceneComponent(item)
        return componentStatusValue(item)
      }catch(error){
        try{if(item.parent===child || item.parent===from){try{child.contentView.removeChildView(item.view)}catch{};if(item.parent===child || !from.contentView.children?.includes(item.view))from.contentView.addChildView(item.view,Number.isInteger(dockIndex)&&dockIndex>=0?dockIndex:undefined);restoreContentChildIndex(from,item.view,dockIndex);item.parent=from;item.rect=dockRect;item.visible=dockVisible;item.dockedRect=undefined;item.dockedVisible=undefined;item.dockedChildIndex=undefined;item.view.setVisible(dockVisible);updateOwnership(item.view.webContents,from)}}catch(rollbackError){throw new AggregateError([error,rollbackError],'scene component popout rollback failed')}
        componentPopouts.delete(componentKey);closingComponentPopouts.add(child);if(!child.isDestroyed())child.destroy();throw error
      }
    })()
    componentPopoutCreating.set(componentKey,task)
    try{return await task}finally{if(componentPopoutCreating.get(componentKey)===task)componentPopoutCreating.delete(componentKey)}
  }
  const armInitialSourcePaint = () => {
    let resolveReady,rejectReady,deadline,done=false,navigated=false
    const promise=new Promise((resolve,reject)=>{resolveReady=resolve;rejectReady=reject})
    promise.catch(()=>{}) // start awaits loadURL before consuming this rejection.
    const contents=main.webContents,listeners=[]
    const finish=(reason)=>{
      if(done)return;done=true
      if(deadline!==undefined){clearTimeout(deadline);deadline=undefined}
      for(const [target,name,listener] of listeners)target.removeListener(name,listener)
      if(initialSourcePaint===token)initialSourcePaint=undefined
      if(reason){const missing=['caption','scene','theme','layout','paint'].filter(stage=>!token.progress[stage]).join(',')||'none';const accountStatus=['loading','document-loaded','context-mounted','error'].includes(account?.status)?account.status:(account?'unknown':'unbound');rejectReady(Error('source first paint failed: '+reason+(reason==='timeout'?'; missing='+missing+'; accountStatus='+accountStatus+'; snapshotPresent='+Boolean(sourceThemeSnapshot):'')))}else resolveReady()
    }
    const token={window:main,finish,promise,progress:{caption:false,scene:false,theme:false,layout:false,paint:false}}
    const on=(target,name,listener)=>{target.on(name,listener);listeners.push([target,name,listener])}
    on(main,'closed',()=>finish('closed'))
    on(contents,'destroyed',()=>finish('closed'))
    on(contents,'render-process-gone',()=>finish('renderer'))
    on(contents,'did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame && code!==-3)finish('load')})
    on(contents,'did-start-navigation',details=>{if(!details.isMainFrame || details.isSameDocument)return;if(navigated || details.url!==SOURCE_URL)finish('navigation');else navigated=true})
    initialSourcePaint=token
    deadline=setTimeout(()=>finish('timeout'),15_000);deadline.unref?.()
    return token
  }
  controller = {
    async start() {
      if (main || closed) throw new Error('controller already started or closed')
      ui18Diagnostic('diagnostic', 'initialized', ui18AccountFields())
      config = await getConfig()
      if (!Array.isArray(config?.scenes)) throw new Error('invalid trusted configuration')
      const storedOrder=await loadSceneOrder();if(!storedOrder || typeof storedOrder.saved!=='boolean' || !Array.isArray(storedOrder.ids))throw Error('invalid scene order');orderSaved=storedOrder.saved;orderMigrationAllowed=storedOrder.corrupt!==true;config={...config,scenes:orderedScenes(storedOrder.ids)}
      uiScale=await loadUiScale();if(!validScale(uiScale))throw Error('invalid stored UI scale')
      // The Desktop-owned installer registers source and app protocol handlers on this partition.
      await installProtocol(ownedPartition)
       main = primaryWindow ?? createSourceWindow(windowOptions())
      if (process.platform === 'win32' && typeof getNativeCaptionFallback === 'function' && typeof main.setTitleBarOverlay === 'function') nativeCaptionWindows.add(main)
       windows.set('main', main); attachPanelGeometryObserver(main); registry = createRegistry(wrap(main))
      main.webContents.setZoomFactor(uiScale)
      let previousCpu
      bind('systemLoad', event => {
        assertWindow(event)
        const samples=systemInfo.cpus(), totals=samples.reduce((acc,cpu)=>{const t=cpu.times;acc.idle+=t.idle;acc.total+=t.user+t.nice+t.sys+t.idle+t.irq;return acc},{idle:0,total:0})
        const delta=previousCpu && totals.total-previousCpu.total, idle=previousCpu && totals.idle-previousCpu.idle
        const cpu=delta>0 ? Math.max(0,Math.min(100,Math.round((1-idle/delta)*100))) : null
        previousCpu=totals
        const total=systemInfo.totalmem(),free=systemInfo.freemem(),used=total-free,gb=1024**3
        return {ok:true,cpu,gpu:null,mem:{usedPct:total>0?Math.round(used/total*100):null,usedGB:Number((used/gb).toFixed(2)),totalGB:Number((total/gb).toFixed(2))}}
      })
      const assertSystemOwner = event => { assertWindow(event) }
      const folderKeys=['app','desktop','documents','downloads']
      bind('systemDisks',async event=>{assertSystemOwner(event);return {drives:await Promise.all(['C','D','E','F'].map(async drive=>{try{const stat=await diskStat(drive+':\\');const total=Number(stat.blocks)*Number(stat.bsize),free=Number(stat.bavail)*Number(stat.bsize);if(!Number.isFinite(total)||total<=0||!Number.isFinite(free)||free<0||free>total)throw Error('invalid disk statistics');const used=Math.max(0,total-free);return {drive:drive+':',ok:true,total,free,used,percent:Math.round(used/total*1000)/10}}catch{return {drive:drive+':',ok:false}}}))}})
      bind('knownFolders',async event=>{assertSystemOwner(event);if(typeof getKnownFolders!=='function')throw Error('known folders unavailable');const folders=await getKnownFolders();return folderKeys.map(key=>({key,path:typeof folders?.[key]==='string'&&folders[key]?folders[key]:null}))})
      bind('openKnownFolder',async(event,key)=>{assertSystemOwner(event);if(!folderKeys.includes(key))throw Error('invalid folder key');if(typeof openKnownFolder!=='function')throw Error('known folders unavailable');const result=await openKnownFolder(key);if(result!=='')throw Error('folder open failed');return {accepted:true}})
      bind('initialPaintReady',(event,value)=>{
        if(assertWindow(event)!==main || !initialSourcePaint || initialSourcePaint.window!==main)throw Error('source initial paint owner rejected')
        if(!value || typeof value!=='object' || Array.isArray(value))throw Error('invalid initial paint acknowledgement')
        if(value.status==='progress' && Object.keys(value).sort().join(',')==='stage,status' && ['caption','scene','theme','layout','paint'].includes(value.stage)){initialSourcePaint.progress[value.stage]=true;return {ready:false}}
        if(value.status==='ready' && Object.keys(value).join(',')==='status'){initialSourcePaint.frame=event.senderFrame;initialSourcePaint.finish();return {ready:true}}
        if(value.status==='failed' && Object.keys(value).sort().join(',')==='reason,status' && ['boot','caption','theme','scene','layout'].includes(value.reason)){initialSourcePaint.finish(value.reason);return {ready:false}}
        throw Error('invalid initial paint acknowledgement')
      })
      bind('config', event => { assertWindow(event); return config })
      bind('draftFlushResult', (event, value) => {
        if (!value || Object.keys(value).sort().join(',') !== 'requestId,saved' || typeof value.saved !== 'boolean') throw Error('invalid draft save result')
        const pending = draftFlushes.get(value.requestId)
        const guest = controller.resolveGuest(event.sender, event.senderFrame)
        if (!pending || guest?.scope !== 'role' || guest.view !== pending.item.view
          || views.get(key(pending.item.sceneId, pending.item.panelId)) !== pending.item
          || JSON.stringify(descriptor(pending.item)) !== JSON.stringify(pending.expected)) throw Error('stale draft save result')
        pending.resolve(value.saved)
        return { accepted: true }
      })
      const configurationOwner = event => {
        const window = assertWindow(event), frame = event.senderFrame
        if (window !== main) throw Error('scene configuration requires the source worktable')
        return () => { if (closed || assertWindow(event) !== window || event.senderFrame !== frame || window.isDestroyed()) throw Error('scene configuration owner changed') }
      }
      const queueConfiguration = operation => {
        const result = configurationQueue.catch(() => {}).then(operation)
        configurationQueue = result.catch(() => {})
        return result
      }
      bind('nativeUtility', (event, request) => this.nativeUtility(event, request))
      bind('configurationApply', event => {
        const assertOwner = configurationOwner(event)
        return queueConfiguration(async () => {
          assertOwner()
          const next = await getConfig(); assertOwner()
          if (changedRoleViews(next).length && !await confirmConfigurationChange(main)) return { cancelled: true, saved: true, applied: false }
          assertOwner()
          return applyConfiguration(next, assertOwner)
        })
      })
      bind('engineGeneration', (event, request) => {
        const assertOwner = configurationOwner(event)
        if (typeof engineGenerationAction !== 'function') throw Error('engine generation unavailable')
        return engineGenerationAction(main, request, assertOwner)
      })
      bind('configurationSave', (event, input) => {
        const assertOwner = configurationOwner(event)
        if (!input || Object.keys(input).sort().join(',') !== 'configuration,expectedRevision') throw Error('invalid scene configuration request')
        return queueConfiguration(async () => {
          assertOwner()
          if (changedRoleViews(input.configuration).length && !await confirmConfigurationChange(main)) return { cancelled: true, saved: false, applied: false }
          assertOwner()
          const saved = await saveConfig(input)
          assertOwner()
          try { return await applyConfiguration(saved, assertOwner) }
          catch { return { saved: true, applied: false, configurationRevision: saved.configurationRevision, error: 'saved-not-applied' } }
        })
      })
      const rotationOwner = event => {
        const requester = assertThemeWindow(event)
        const registered = [...windows].find(([, value]) => value === requester)
        if (!registered || requester.isDestroyed() || event.senderFrame !== requester.webContents.mainFrame
          || event.senderFrame.url !== (registered[0] === 'main' ? SOURCE_URL : SOURCE_URL + '?solo=1&scene=' + encodeURIComponent(registered[0]))) {
          throw Error('scene rotation owner rejected')
        }
        return { window: requester, frame: event.senderFrame, url: event.senderFrame.url, id: registered[0] }
      }
      const refreshRoleRotationSurfaces = async (result, assertCapturedOwner) => {
        const refreshed = await getConfig()
        assertCapturedOwner()
        if (!refreshed || !Array.isArray(refreshed.scenes) || !refreshed.sessionBindings
          || refreshed.sessionBindings[result.roleId] !== result.sessionId) throw Error('scene rotation binding refresh rejected')
        const savedSceneOrder = config.scenes.map(item => item.id)
        config = { ...refreshed, scenes: refreshed.scenes }
        config = { ...config, scenes: orderedScenes(savedSceneOrder) }
        const rolePanels = new Map()
        for (const sceneConfig of config.scenes) {
          for (const panel of sceneConfig.panels ?? []) {
            if (!['native-chat', 'native-workspace'].includes(panel.type)) continue
            const roleId = panel.roleId || sceneConfig.roleId
            if (roleId === result.roleId) rolePanels.set(key(sceneConfig.id, panel.id), true)
          }
        }
        for (const item of [...views.values()]) {
          const id = key(item.sceneId, item.panelId)
          if (!rolePanels.has(id) || views.get(id) !== item || item.view.webContents.isDestroyed()) continue
          const binding = await resolveBinding({ sceneId: item.sceneId, panelId: item.panelId })
          assertCapturedOwner()
          if (binding?.sceneId !== item.sceneId || binding?.panelId !== item.panelId
            || binding.bindingStatus !== 'bound' || binding.sessionId !== result.sessionId
            || typeof binding.bindingRevision !== 'string') throw Error('scene rotation surface binding changed')
          const capturedBinding = captureRoleBinding(binding, item.sceneId, item.panelId)
          if (capturedBinding.roleId !== result.roleId) throw Error('scene rotation role changed')
          const seat = registry.get(item.sceneId, item.panelId)
          if (!seat || seat.view !== item.wrapper) throw Error('scene rotation surface owner changed')
          const previous = { sessionId: item.sessionId, bindingRevision: item.bindingRevision,
            seatWindow: seat.window, rehomed: seat.rehomed === true }
          const previousPopout = previous.seatWindow?.window
          assertCapturedOwner()
          registry.revoke(item.sceneId, item.panelId)
          try {
            registry.attach({ sceneId: item.sceneId, panelId: item.panelId, sessionId: result.sessionId,
              surface: item.surface, view: item.wrapper, partition: ownedPartition })
            if (previous.rehomed && previousPopout && !previousPopout.isDestroyed?.()
              && rolePopouts.get(id) === previousPopout) registry.rehome(item.sceneId, item.panelId, wrap(previousPopout))
          } catch (error) {
            try {
              if (registry.get(item.sceneId, item.panelId)) registry.revoke(item.sceneId, item.panelId)
              registry.attach({ sceneId: item.sceneId, panelId: item.panelId, sessionId: previous.sessionId,
                surface: item.surface, view: item.wrapper, partition: ownedPartition })
              if (previous.rehomed && previousPopout && !previousPopout.isDestroyed?.()
                && rolePopouts.get(id) === previousPopout) registry.rehome(item.sceneId, item.panelId, wrap(previousPopout))
            } catch (restoreError) { throw new AggregateError([error, restoreError], 'scene rotation surface restore failed') }
            throw error
          }
          Object.assign(item, capturedBinding)
          notifyGuest(item)
          emit(item, item.status)
        }
      }
      const runRotationRequest = async (event, action, request) => {
        const captured = rotationOwner(event)
        const assertCapturedOwner = () => {
          const current = rotationOwner(event)
          if (current.window !== captured.window || current.frame !== captured.frame
            || current.url !== captured.url || current.id !== captured.id
            || windows.get(captured.id) !== captured.window) throw Error('scene rotation owner changed')
        }
        const result = await action(request)
        assertCapturedOwner()
        if (result?.roleId && result?.sessionId && ['bound', 'completed', 'archive_pending'].includes(result.status)) {
          await refreshRoleRotationSurfaces(result, assertCapturedOwner)
        }
        assertCapturedOwner()
        return result
      }
      bind('sceneRotationPreview', (event, request) => runRotationRequest(event, sceneRotationPreview, request))
      bind('sceneRotationConfirm', (event, request) => runRotationRequest(event, sceneRotationConfirm, request))
      bind('sceneRotationStatus', (event, request) => runRotationRequest(event, sceneRotationStatus, request))
      bind('sceneRotationResume', (event, request) => runRotationRequest(event, sceneRotationResume, request))
      bind('sceneRotationCancel', (event, request) => runRotationRequest(event, sceneRotationCancel, request))
      bind('sceneRotationAbandon', (event, request) => runRotationRequest(event, sceneRotationAbandon, request))
      bind('getUiScale',event=>{assertWindow(event);return uiScale})
      bind('themeSnapshot',event=>{if(!controller.resolveGuest(event.sender,event.senderFrame))assertThemeWindow(event);return sourceThemeSnapshot})
      bind('themePreference', (event, preference) => {
        assertThemeWindow(event)
        if(!themePreference(preference))throw Error('invalid source theme preference')
        if(themeRequest)return Promise.resolve(false)
        return new Promise(resolve=>{
          const request={id:++themeSequence,event,preference,resolve,dispatched:false}
          request.callerDestroyed=()=>finishThemeRequest(false)
          request.timer=setTimeout(()=>finishThemeRequest(false),inventoryTimeoutMs)
          themeRequest=request;event.sender.once('destroyed',request.callerDestroyed)
          if(!dispatchThemeRequest() && themeRequest===request){pendingSourceThemePreference=preference;ui18Diagnostic('theme','preference-queued',ui18AccountFields())}
        })
      })
      bind('themePreferenceResult',(event,metadata,ok)=>{
        const request=themeRequest
        const owned=controller.resolveGuest(event.sender,event.senderFrame)
        if(!owned || owned.scope!=='account')throw Error('wrong source theme guest')
        if(!request || !request.dispatched || !exactKeys(metadata,['requestId','generation']) || typeof ok!=='boolean'
          || metadata.requestId!==request.id || metadata.generation!==request.item?.generation
          || request.item!==account || request.contents!==event.sender || request.frame!==event.senderFrame
          || sourceThemePublisher?.item!==account || sourceThemePublisher.generation!==metadata.generation
          || sourceThemePublisher.frame!==event.senderFrame)return false
        finishThemeRequest(ok);return true
      })
      bind('themePublish', (event, value) => {
        let owned
        try { owned = controller.resolveGuest(event.sender,event.senderFrame) } catch {
          ui18Diagnostic('theme', 'publish-rejected', { ...ui18AccountFields(), failure: 'owner-resolver-failed' })
          throw Error('wrong source theme guest')
        }
        if (!owned || owned.scope !== 'account' || !account || descriptor(account).businessNavigation !== 'shell') {
          const failure = !owned ? 'scope-rejected' : owned.scope !== 'account' ? 'scope-rejected' : !account ? 'account-missing' : 'navigation-rejected'
          ui18Diagnostic('theme', 'publish-rejected', { ...ui18AccountFields(), failure })
          throw Error('wrong source theme guest')
        }
        let snapshot
        try { snapshot = safeThemeMaterials(value) } catch {
          ui18Diagnostic('theme', 'publish-rejected', { ...ui18AccountFields(), failure: 'snapshot-invalid' })
          throw Error('invalid source theme snapshot')
        }
        sourceThemeMaterials = snapshot
        publishCanonicalTheme()
        sourceThemePublisher = {item:account,generation:account.generation,frame:event.senderFrame}
        if (pendingSourceThemePreference !== undefined) dispatchThemeRequest()
        return undefined
      })
      bind('mobileLink', event => {
        if (assertWindow(event) !== main || !account || account.status !== 'context-mounted') throw Error('mobile link unavailable')
        const item = account, contents = item.view.webContents, frame = contents.mainFrame, request = { requestId: ++inventorySequence, generation: item.generation }
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => { mobileLinkRequests.delete(request.requestId); reject(Error('mobile link unavailable')) }, inventoryTimeoutMs)
          mobileLinkRequests.set(request.requestId, { item, contents, frame, request, resolve, reject, timer })
          try { contents.send('dsh-desktop:mobile-link-request', request) }
          catch { clearTimeout(timer); mobileLinkRequests.delete(request.requestId); reject(Error('mobile link unavailable')) }
        })
      })
      bind('workflowCanvasMount', async event => {
        const dockOwner=workflowDockOwner()
        if(assertWindow(event)!==dockOwner)throw Error('workflow canvas owner rejected')
        const route=workflowCanvasRoute()
        if(sceneComponent && !sceneComponent.view.webContents.isDestroyed() && sceneComponent.sceneId===route.sceneId && sceneComponent.panelId===route.panelId)return {status:sceneComponent.status,componentKey:'workflow-canvas-native',sceneId:route.sceneId,panelId:route.panelId}
        if(sceneComponent)disposeSceneComponent(sceneComponent)
        const view=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}})
        const item={kind:'scene-component',componentKey:'workflow-canvas-native',sceneId:route.sceneId,panelId:route.panelId,generation:++generation,view,parent:dockOwner,status:'loading',loaded:false,visible:false,rect:null,dockedRect:null,dockedVisible:false,dockedChildIndex:-1,dockIndex:-1}
        sceneComponent=item
        const notify=()=>notifySceneComponent(item)
        try{
          dockOwner.contentView.addChildView(view);item.dockIndex=contentChildIndex(dockOwner,view);item.dockedChildIndex=item.dockIndex;view.setVisible(false);view.webContents.setZoomFactor(uiScale);updateOwnership(view.webContents,dockOwner);raiseAccountOverlay(dockOwner)
          view.webContents.on('focus',()=>{if(view.webContents.isDestroyed())return;const owned=controller.resolveGuest(view.webContents,view.webContents.mainFrame);if(owned?.view!==view)return;focusedGuests.set(owned.window,view.webContents);owned.window.webContents.send('source-shell:native-focus')})
          view.webContents.once('destroyed',()=>{if(sceneComponent===item)sceneComponent=undefined})
          view.webContents.once('render-process-gone',()=>{if(sceneComponent===item){item.status='error';notify();disposeSceneComponent(item)}})
          view.webContents.on('did-start-navigation',details=>{if(details.isMainFrame && item.loaded && !(details.isSameDocument && typeof details.url==='string' && details.url.startsWith('dsh-app://app/')))disposeSceneComponent(item)})
          view.webContents.once('did-finish-load',()=>{item.loaded=true;if(item.status!=='context-mounted'){item.status='document-loaded';notify()}})
          await view.webContents.loadURL(SCENE_COMPONENT_URL)
          return {status:item.status,componentKey:'workflow-canvas-native',sceneId:item.sceneId,panelId:item.panelId}
        }catch(error){disposeSceneComponent(item);throw error}
      })
      bind('workflowCanvasPopOut',event=>popOutSceneComponent(event,'workflow-canvas-native'))
      bind('workflowCanvasReturnToDock',event=>{if(assertWindow(event)!==workflowDockOwner())throw Error('workflow canvas return owner rejected');const item=componentForKey('workflow-canvas-native'),child=componentPopouts.get('workflow-canvas-native');if(!item)throw Error('workflow canvas unavailable');return child?returnSceneComponentToDock(item,child):componentStatusValue(item)})
      bind('workflowCanvasBounds',(event,rect)=>{
        if(assertWindow(event)!==workflowDockOwner() || !sceneComponent)throw Error('workflow canvas unavailable')
        if(!rect || !['x','y','width','height'].every(key=>Number.isFinite(rect[key])) || rect.width<0 || rect.height<0)throw Error('invalid workflow canvas bounds')

        return applySceneComponentBounds(sceneComponent,rect)
      })
      bind('workflowCanvasVisible',(event,visible)=>{
        if(assertWindow(event)!==workflowDockOwner() || !sceneComponent)throw Error('workflow canvas unavailable')
        return setSceneComponentVisible(sceneComponent,visible)

      })
      bind('workflowCanvasStatus',event=>{
        if(assertWindow(event)!==workflowDockOwner())throw Error('workflow canvas owner rejected')
        return sceneComponent?componentStatusValue(sceneComponent):{status:'unavailable',visible:false}
      })
      bind('erpNextStatusMount',async event=>{
        if(assertWindow(event)!==main)throw Error('ERPNext status owner rejected')
        const route=erpNextStatusRoute()
        if(erpNextStatusComponent && !erpNextStatusComponent.view.webContents.isDestroyed())return {status:erpNextStatusComponent.status,componentKey:erpNextStatusComponent.componentKey,sceneId:erpNextStatusComponent.sceneId,panelId:erpNextStatusComponent.panelId}
        const view=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}})
        const item={kind:'scene-component',componentKey:'erpnext-status-native',sceneId:route.sceneId,panelId:route.panelId,generation:++generation,view,parent:main,status:'loading',loaded:false,visible:false,rect:null,dockedRect:null,dockedVisible:false,dockedChildIndex:-1,dockIndex:-1}
        erpNextStatusComponent=item
        const notify=()=>notifySceneComponent(item)
        try{
          main.contentView.addChildView(view);item.dockIndex=contentChildIndex(main,view);item.dockedChildIndex=item.dockIndex;view.setVisible(false);view.webContents.setZoomFactor(uiScale);updateOwnership(view.webContents,main);raiseAccountOverlay(main)
          view.webContents.on('focus',()=>{if(view.webContents.isDestroyed())return;const owned=controller.resolveGuest(view.webContents,view.webContents.mainFrame);if(owned?.view!==view)return;focusedGuests.set(owned.window,view.webContents);owned.window.webContents.send('source-shell:native-focus')})
          view.webContents.once('destroyed',()=>{if(erpNextStatusComponent===item)erpNextStatusComponent=undefined})
          view.webContents.once('render-process-gone',()=>{if(erpNextStatusComponent===item){item.status='error';notify();disposeSceneComponent(item)}})
          view.webContents.on('did-start-navigation',details=>{if(details.isMainFrame && item.loaded && !(details.isSameDocument && typeof details.url==='string' && details.url.startsWith('dsh-app://app/')))disposeSceneComponent(item)})
          view.webContents.once('did-finish-load',()=>{item.loaded=true;if(item.status!=='context-mounted'){item.status='document-loaded';notify()}})
          await view.webContents.loadURL(SCENE_COMPONENT_URL)
          return {status:item.status,componentKey:item.componentKey,sceneId:item.sceneId,panelId:item.panelId}
        }catch(error){disposeSceneComponent(item);throw error}
      })
      bind('erpNextStatusPopOut',event=>popOutSceneComponent(event,'erpnext-status-native'))
      bind('erpNextStatusReturnToDock',event=>{if(assertWindow(event)!==main)throw Error('ERPNext status return owner rejected');const item=componentForKey('erpnext-status-native'),child=componentPopouts.get('erpnext-status-native');if(!item)throw Error('ERPNext status component unavailable');return child?returnSceneComponentToDock(item,child):componentStatusValue(item)})
      bind('erpNextStatusBounds',(event,rect)=>{
        if(assertWindow(event)!==main || !erpNextStatusComponent)throw Error('ERPNext status component unavailable')
        if(!rect || !['x','y','width','height'].every(key=>Number.isFinite(rect[key])) || rect.width<0 || rect.height<0)throw Error('invalid ERPNext status bounds')

        return applySceneComponentBounds(erpNextStatusComponent,rect)
      })
      bind('erpNextStatusVisible',(event,visible)=>{
        if(assertWindow(event)!==main || !erpNextStatusComponent)throw Error('ERPNext status component unavailable')
        return setSceneComponentVisible(erpNextStatusComponent,visible)

      })
      bind('erpNextStatusStatus',event=>{
        if(assertWindow(event)!==main)throw Error('ERPNext status owner rejected')
        return erpNextStatusComponent?{status:erpNextStatusComponent.status,visible:erpNextStatusComponent.visible,componentKey:erpNextStatusComponent.componentKey,sceneId:erpNextStatusComponent.sceneId,panelId:erpNextStatusComponent.panelId}:{status:'unavailable',visible:false}
      })
      bind('pluginInventory',async event=>{assertWindow(event);if(!account || account.status!=='context-mounted')throw Error('plugin inventory unavailable');const item=account,contents=item.view.webContents,frame=contents.mainFrame,id=++inventorySequence,request={requestId:id,generation:item.generation};return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{inventoryRequests.delete(id);reject(Error('plugin inventory timeout'))},inventoryTimeoutMs);inventoryRequests.set(id,{item,contents,frame,resolve,reject,timer});try{contents.send('dsh-desktop:plugin-inventory-request',request)}catch(error){clearTimeout(timer);inventoryRequests.delete(id);reject(error)}})})
      bind('modelCatalog',async event=>{assertWindow(event);if(!account || account.status!=='context-mounted')throw Error('model catalog unavailable');const item=account,contents=item.view.webContents,frame=contents.mainFrame,id=++inventorySequence,request={requestId:id,generation:item.generation};return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{modelRequests.delete(id);reject(Error('model catalog timeout'))},inventoryTimeoutMs);modelRequests.set(id,{item,contents,frame,resolve,reject,timer});try{contents.send('dsh-desktop:model-catalog-request',request)}catch(error){clearTimeout(timer);modelRequests.delete(id);reject(error)}})})
      bind('settingsOpen',async event=>{
        try { assertWindow(event) } catch { ui18Diagnostic('settings','request-rejected',{...ui18AccountFields(),failure:'source-owner-rejected'});throw Error('settings unavailable') }
        const dockedAccount=account?.parent===main
        if(!account || account.status!=='context-mounted' || (!dockedAccount && (account.visible!==true || !account.rect || account.rect.width<=0 || account.rect.height<=0))){ui18Diagnostic('settings','request-rejected',{...ui18AccountFields(),failure:'owner-not-mounted'});throw Error('settings unavailable')}
        const item=account,contents=item.view.webContents,frame=contents.mainFrame,id=++inventorySequence,request={requestId:id,generation:item.generation},pending={item,contents,frame,resolve:null,reject:null,timer:null,claimed:false,resultReceived:false}
        return await new Promise((resolve,reject)=>{
          pending.resolve=resolve;pending.reject=reject
          pending.timer=setTimeout(()=>{settingsRequests.delete(id);ui18Diagnostic('settings','timeout',{...ui18AccountFields(),failure:pending.claimed?'no-result':'no-claim',claimed:pending.claimed});reject(Error('settings timeout'))},inventoryTimeoutMs)
          settingsRequests.set(id,pending)
          try { contents.send('dsh-desktop:settings-open-request',request);ui18Diagnostic('settings','request-sent',ui18AccountFields()) }
          catch(error){clearTimeout(pending.timer);settingsRequests.delete(id);ui18Diagnostic('settings','request-rejected',{...ui18AccountFields(),failure:'send-failed'});reject(error)}
        })
      })
      bind('accountGlobalPanelClose',event=>{if(assertWindow(event)!==main)throw Error('global panel owner rejected');if(!accountGlobalPanel || accountGlobalPanel.item!==account)return false;return restoreAccountGlobalPanel(account,true)})
      bind('setUiScale',async(event,value)=>{assertWindow(event);if(!validScale(value))throw Error('invalid UI scale');if(value===uiScale)return uiScale;const previous=uiScale;try{uiScale=value;applyScale(value);await saveUiScale(value)}catch(error){uiScale=previous;applyScale(previous);throw error}for(const w of new Set([...windows.values(),...(accountPopout?[accountPopout]:[])]))w.webContents.send('source-shell:ui-scale-event',value);return value})
      for (const name of ['minimize','close']) bind(name, event => { const w=assertWindow(event); w[name]() })
      bind('toggleMaximize',event=>{const w=assertWindow(event); w.isMaximized()?w.unmaximize():w.maximize()})
      bind('isMaximized',event=>assertWindow(event).isMaximized())
       bind('windowInfo',event=>{const w=assertWindow(event); return {isMain:w===main,isAccountPopout:w===accountPopout,nativeCaption:nativeCaptionWindows.has(w),sceneId:[...windows].find(([,value])=>value===w)?.[0]}})
      bind('windowScenes',event=>{assertWindow(event); return [...windows.keys()].filter(x=>x!=='main')})
      bind('listScenarios',event=>{assertWindow(event); return config.scenes})
      bind('getScenario',(event,id)=>{assertWindow(event); return scene(id)})
      bind('getSceneOrder',event=>{assertWindow(event); return orderState()})
      const saveOrder=(event,order,migrate)=>{assertWindow(event);if(!Array.isArray(order))throw Error('invalid order');const task=orderQueue.then(async()=>{assertWindow(event);if(migrate && (orderSaved || !orderMigrationAllowed))return orderState();const next=orderedScenes(order),ids=normalizeOrder(next.map(s=>s.id));await saveSceneOrder(ids);config={...config,scenes:next};orderSaved=true;orderMigrationAllowed=false;const state=orderState();for(const w of windows.values())try{w.webContents.send('source-shell:scene-order-event',state)}catch(error){console.error('scene order notification failed',error)}return state});orderQueue=task.catch(()=>{});return task}
      bind('setSceneOrder',(event,order)=>saveOrder(event,order,false))
      bind('migrateSceneOrder',(event,order)=>saveOrder(event,order,true))
      const assertAccountStatus = event => { const w=assertWindow(event);if(w!==main && w!==accountPopout)throw Error('wrong account status owner');return account }
      const emitAccount = (item,status) => { item.status=status; notifyAccount(item) }
  const revokeAccount = item => { if(account!==item)return; if(sourceThemePublisher?.item===item)sourceThemePublisher=undefined; if(accountGlobalPanel?.item===item){accountGlobalPanel=undefined;notifyAccountGlobalPanel({mode:null,open:false,panelId:null})}disposeAccountSidebar();failInventory();account=undefined;if(focusedGuests.get(item.parent)===item.view.webContents)focusedGuests.delete(item.parent);item.detachShortcuts?.();try{item.parent.contentView.removeChildView(item.view)}catch{};const child=accountPopout;accountPopout=undefined;if(child && !child.isDestroyed())try{child.close()}catch{} }
      bind('accountCreate',async event=>{
        const requester=assertWindow(event);if(requester!==main && requester!==accountPopout)throw Error('wrong account creator'); if(account)return accountStatusValue(account); if(requester!==main)throw Error('wrong account creator'); if(accountCreating)return accountCreating
        accountCreating=(async()=>{ const v=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true,additionalArguments:['--tradeloom-account-parent-caption']}})
          const item={kind:'account',generation:++generation,view:v,parent:main,status:'loading',loaded:false,placement:'docked'}; account=item
          try { main.contentView.addChildView(v); v.setVisible(false); v.webContents.setZoomFactor(uiScale); updateOwnership(v.webContents,main);item.detachShortcuts=attachAccountShortcuts?.(main,v.webContents,()=>account===item && item.visible===true)
            v.webContents.once('destroyed',()=>revokeAccount(item)); v.webContents.once('render-process-gone',()=>{emitAccount(item,'error');revokeAccount(item)})
            v.webContents.on('focus',()=>{focusedGuests.set(item.parent,v.webContents);item.parent.webContents.send('source-shell:native-focus')})
            v.webContents.on('did-start-navigation',details=>{if(details.isMainFrame && item.loaded && !(details.isSameDocument && typeof details.url==='string' && details.url.startsWith('dsh-app://app/')))revokeAccount(item)})
            v.webContents.once('did-finish-load',()=>{item.loaded=true;if(item.status!=='context-mounted')emitAccount(item,'document-loaded')})
            await v.webContents.loadURL('dsh-app://app/'); return accountStatusValue(item)
          } catch(error) { emitAccount(item,'error'); revokeAccount(item); v.webContents.destroy(); throw error }
        })(); try { return await accountCreating } finally { accountCreating=undefined }
      })
      bind('accountBounds',(event,rect)=>{const item=accountOwner(event);if(!rect || !['x','y','width','height'].every(k=>Number.isFinite(rect[k])) || rect.width<0 || rect.height<0)throw Error('invalid account bounds');if(accountOverlay?.item===item)accountOverlay.rect={...rect};item.rect=rect;if(item.placement==='popout')item.popoutRect=rect;else item.dockedRect=rect;return applyBounds(item)})
      bind('accountVisible',(event,visible)=>{const item=accountOwner(event);if(typeof visible!=='boolean')throw Error('invalid account visibility');if(accountOverlay?.item===item){accountOverlay.visible=visible;return notifyAccount(item)}item.view.setVisible(visible);item.visible=visible;if(!visible){if(accountSidebar && !accountGlobalPanel)disposeAccountSidebar();else if(accountSidebar)accountSidebar.view.setVisible(false);resetAccountShortcuts?.(item.view.webContents);for(const request of settingsRequests.values()){clearTimeout(request.timer);request.reject(Error('settings unavailable'))}settingsRequests.clear()}else if(accountGlobalPanel?.item===item){main.contentView.addChildView(item.view);if(accountSidebarOpen && accountSidebar)main.contentView.addChildView(accountSidebar.view)}notifyAccount(item)})
      bind('accountSidebarToggle',async event=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return setAccountSidebarOpen(!accountSidebarOpen)})
      bind('accountSidebarSet',async (event,open)=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return setAccountSidebarOpen(open)})
      bind('accountSidebarStatus',event=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return accountSidebarOpen})
      bind('accountSidebarWidth',event=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return accountSidebarWidthValue()})
      bind('accountSidebarSetWidth',(event,widthDip)=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');if(!accountSidebar || !accountSidebarOpen)throw Error('account sidebar unavailable');return setAccountSidebarWidth(widthDip)})
      bind('accountGlobalPanelStatus',event=>{if(assertWindow(event)!==main)throw Error('wrong global panel owner');return accountGlobalPanelState()})
      bind('accountStatus',event=>{assertAccountStatus(event);return accountStatusValue(account)})
      bind('accountPopOut',async event=>{
        if(assertWindow(event)!==main || hasNativeModal(main) || (accountPopout && hasNativeModal(accountPopout)))throw Error('invalid account popout')
        if(!account)throw Error('account surface unavailable')
        if(account.parent===accountPopout && accountPopout){accountPopout.focus?.();return accountStatusValue(account)}
        if(accountPopoutCreating)return accountPopoutCreating
        const item=account
        const task=(async()=>{
          const baseOptions=windowOptions()
          const child=createSourceWindow({...baseOptions,width:1120,height:760,minWidth:640,show:false,webPreferences:{...baseOptions.webPreferences,partition:ownedPartition}})
          child.webContents.setZoomFactor(uiScale)
          accountPopout=child
          child.on('close',closeEvent=>{
            if(accountPopout!==child)return
            if(hasNativeModal(child) || hasNativeModal(main)){closeEvent.preventDefault();return}
            try{moveAccountView(account,main,'docked');accountPopout=undefined}
            catch(error){closeEvent.preventDefault();console.error('source shell: account return failed',error)}
          })
          child.once('closed',()=>{if(accountPopout===child && account?.parent!==child)accountPopout=undefined})
          try{
            await child.webContents.loadURL(ACCOUNT_URL)
            if(closed || account!==item || main.isDestroyed() || child.isDestroyed())throw Error('account surface unavailable')
            if(hasNativeModal(main) || hasNativeModal(child))throw Error('invalid account popout')
            moveAccountView(item,child,'popout')
            child.show?.();child.focus?.()
            return accountStatusValue(account)
          }catch(error){
            if(account===item && item.parent===child){try{moveAccountView(item,main,'docked')}catch(rollbackError){throw new AggregateError([error,rollbackError],'account popout rollback failed')}}
            if(accountPopout===child)accountPopout=undefined
            if(!child.isDestroyed())child.destroy()
            throw error
          }
        })()
        accountPopoutCreating=task
        try{return await task}finally{if(accountPopoutCreating===task)accountPopoutCreating=undefined}
      })
      bind('accountReturnToDock',async event=>{
        const requester=assertWindow(event)
        if(requester!==main && requester!==accountPopout)throw Error('wrong account return owner')
        if(accountPopoutCreating)await accountPopoutCreating
        if(!account)throw Error('account surface unavailable')
        if(account.placement==='docked')return accountStatusValue(account)
        if(hasNativeModal(requester) || hasNativeModal(main) || (accountPopout && hasNativeModal(accountPopout)))throw Error('invalid account return')
        const child=accountPopout
        moveAccountView(account,main,'docked')
        accountPopout=undefined
        if(child && !child.isDestroyed())child.close()
        return accountStatusValue(account)
      })
      bind('create', async (event, sceneId, panelId) => {
        observeCreatePhase('create-start')
        const w = assertWindow(event), panel = scene(sceneId).panels.find(p => p.id === panelId)
        if (!panel || !['native-chat', 'native-workspace'].includes(panel.type)) throw new Error('not a native panel')
        if (views.has(key(sceneId,panelId))) {
          const existing=views.get(key(sceneId,panelId)),seat=registry.get(sceneId,panelId),dockWindow=windows.get(sceneId)??main
          if(seat?.rehomed && w===dockWindow)return {status:existing.status,placement:'popped-out'}
          owner(w,sceneId,panelId);return {status:existing.status,placement:'docked'}
        }
        observeCreatePhase('binding-start')
        const capturedEpoch = configurationEpoch
        const binding = await resolveBinding({ sceneId, panelId })
        if (capturedEpoch !== configurationEpoch || closed) throw Error('scene configuration changed during binding resolution')
        observeCreatePhase('binding-end')
        if (binding?.sceneId !== sceneId || binding?.panelId !== panelId) throw new Error('binding mismatch')
        if (binding.bindingStatus === 'unbound') return { status:'unbound' }
        if (binding.bindingStatus !== 'bound' || !binding.sessionId) throw new Error('binding unavailable')
        const capturedBinding = captureRoleBinding(binding, sceneId, panelId)
        // Recheck authority after awaiting the Host, including the hidden-seat reuse path.
        if (closed || assertWindow(event)!==w) throw new Error('owner closed')
        const surface=panel.type==='native-chat'?'chat':'files'
        const existing=registry.findSession(binding.sessionId,surface)
        if(existing) {
          const oldKey=key(existing.sceneId,existing.panelId),item=views.get(oldKey)
          if(existing.rehomed && item && w===item.popoutOwner) {
            const child=rolePopouts.get(oldKey)
            if(child && !child.isDestroyed() && item.parent===child && existing.window?.window===child) {
              if(child.isMinimized?.())child.restore?.()
              child.show?.();child.focus?.()
              return {status:'owned-elsewhere',owner:{sceneId:existing.sceneId,panelId:existing.panelId},placement:'popped-out',focused:true}
            }
          }
          if(w===main && item?.parent===main && existing.window?.window===main && !existing.rehomed
            && item.visible===false && existing.surface===surface) {
            registry.transfer(binding.sessionId,sceneId,panelId,surface)
            views.delete(oldKey);item.sceneId=sceneId;item.panelId=panelId;item.surface=surface;Object.assign(item,capturedBinding)
            item.status=item.loaded?'document-loaded':'loading';views.set(key(sceneId,panelId),item)
            notifyGuest(item);emit(item,item.status)
            return {status:item.status,placement:'docked'}
          }
          return {status:'owned-elsewhere',sceneId:existing.sceneId,panelId:existing.panelId}
        }
        const v = new WebContentsView({ webPreferences:{ preload:appPreload, partition:ownedPartition, contextIsolation:true,nodeIntegration:false,sandbox:true,additionalArguments:['--tradeloom-account-parent-caption'] } })
        const wrapper={ get frame() { return v.webContents.mainFrame }, destroy:()=>v.webContents.destroy() }
        try { registry.attach({sceneId,panelId,sessionId:binding.sessionId,surface,view:wrapper,partition:ownedPartition}); owner(w,sceneId,panelId) } catch(error) { registry.revoke(sceneId,panelId); v.webContents.destroy(); throw error }
        const item={sceneId,panelId,...capturedBinding,surface,generation:++generation,view:v,wrapper,parent:w,status:'loading',loaded:false}; views.set(key(sceneId,panelId),item)
        w.contentView.addChildView(v); v.setVisible(false); v.webContents.setZoomFactor(uiScale); updateOwnership(v.webContents,w);raiseAccountOverlay(w)
        if(accountSidebarOpen&&accountSidebar&&accountSidebar.parent===w&&!accountGlobalPanel)w.contentView.addChildView(accountSidebar.view)
        v.webContents.on('console-message',(...args)=>{observeRoleGuestMessage(item,args);observeRoleGuestListProbeMessage(item,args)})
        v.webContents.once('destroyed',()=>revoke(item)); v.webContents.once('render-process-gone',()=>{ emit(item,'error'); revoke(item) })
        v.webContents.on('focus',()=>{focusedGuests.set(item.parent,v.webContents);item.parent.webContents.send('source-shell:native-focus')})
        v.webContents.on('did-start-navigation',details=>{ if(details.isMainFrame && item.loaded && !(details.isSameDocument && typeof details.url==='string' && details.url.startsWith('dsh-app://app/'))) revoke(item) })
        v.webContents.once('did-finish-load',()=>{ item.loaded=true; if(!['context-mounted','error'].includes(item.status))emit(item,'document-loaded') })
        try { observeCreatePhase('load-start'); await v.webContents.loadURL('dsh-app://app/'); observeCreatePhase('load-end') } catch(error) { emit(item,'error'); revoke(item); v.webContents.destroy(); throw error }
        return {status:item.status}
      })
      bind('transfer',async(event,s,p)=>{
        const w=assertWindow(event), panel=scene(s).panels.find(x=>x.id===p)
        if(!panel || !['native-chat','native-workspace'].includes(panel.type) || (windows.get(s) ?? main)!==w || hasNativeModal(w)) throw new Error('invalid transfer')
        const capturedEpoch=configurationEpoch
        const binding=await resolveBinding({sceneId:s,panelId:p}); if(capturedEpoch!==configurationEpoch)throw Error('scene configuration changed during transfer')
        const capturedBinding=captureRoleBinding(binding,s,p)
        if(closed || assertWindow(event)!==w) throw new Error('owner closed')
        const seat=registry.findSession(binding.sessionId,panel.type==='native-chat'?'chat':'files'); if(!seat || hasNativeModal(seat.window.window) || hasNativeModal(w)) throw new Error('transfer unavailable')
        const oldKey=key(seat.sceneId,seat.panelId), item=views.get(oldKey); if(!item) throw new Error('missing view')
        const oldParent=item.parent, oldScene=item.sceneId, oldPanel=item.panelId
        oldParent.contentView.removeChildView(item.view)
        try { w.contentView.addChildView(item.view); updateOwnership(item.view.webContents,w); registry.transfer(binding.sessionId,s,p,panel.type==='native-chat'?'chat':'files') }
        catch(error) { try { w.contentView.removeChildView(item.view) } catch {} oldParent.contentView.addChildView(item.view); updateOwnership(item.view.webContents,oldParent); throw error }
        item.parent=w; views.delete(oldKey); item.sceneId=s; item.panelId=p; Object.assign(item,capturedBinding); item.surface=panel.type==='native-chat'?'chat':'files'; item.status=item.loaded?'document-loaded':'loading'; views.set(key(s,p),item); notifyGuest(item); return {status:item.status}
      })
      bind('bounds',(event,s,p,rect)=>{ const w=assertWindow(event);owner(w,s,p);const item=views.get(key(s,p));if(!rect||!['x','y','width','height'].every(k=>Number.isFinite(rect[k]))||rect.width<0||rect.height<0)throw Error('invalid bounds');item.rect=rect;return applyBounds(item) })
      bind('visible',(event,s,p,visible)=>{ const w=assertWindow(event); owner(w,s,p); if(typeof visible!=='boolean') throw new Error('invalid visibility'); const item=views.get(key(s,p));item.view.setVisible(visible);item.visible=visible })
      bind('status',(event,s,p)=>{
        const w=assertWindow(event),id=key(s,p),item=views.get(id),dockWindow=windows.get(s)??main
        if(item){const seat=registry.get(s,p),child=rolePopouts.get(id);if(!seat || (seat.window.window!==w && !(child && w===dockWindow)))throw Error('wrong scene owner');return {status:item.status,placement:seat.rehomed?'popped-out':'docked'}}
        if(dockWindow!==w)throw Error('wrong scene owner');return {status:'unbound',placement:'docked'}
      })
      bind('rolePopOut',(event,s,p)=>popOutRoleSeat(event,s,p))
      bind('roleReturnToDock',async(event,s,p)=>{
        const w=assertWindow(event),dockWindow=windows.get(s)??main,id=key(s,p),item=views.get(id),child=rolePopouts.get(id)
        if(w!==dockWindow || !item)throw Error('invalid role return owner')
        if(!child)return {status:item.status,placement:'docked'}
        return returnRoleSeat(item,child)
      })
      bind('detach',async(event,s)=>{
        if(assertWindow(event)!==main || windows.has(s) || hasNativeModal(main)) throw new Error('invalid detach')
        scene(s); const child=createSourceWindow(windowOptions()); child.webContents.setZoomFactor(uiScale); let registered=false
        child.on('close',event=>{ if(closed || !windows.has(s))return; if(hasNativeModal(child) || hasNativeModal(main)){ event.preventDefault(); return } try { relocate(s,child,main,()=>{ if(registered) registry.returnScene(s); windows.delete(s) }); for(const item of views.values()) if(item.sceneId===s) item.failed=false } catch(error) { event.preventDefault(); console.error('source shell: scene return failed', error) } })
        try { relocate(s,main,child,()=>{ registry.registerScene(s,wrap(child)); registered=true; windows.set(s,child) }) }
        catch(error) { if(error instanceof AggregateError) windows.set(s,child); else child.destroy(); throw error }
        await child.webContents.loadURL(`${SOURCE_URL}?solo=1&scene=${encodeURIComponent(s)}`); return {status:'detached'}
      })
      main.on('close',event=>{ if(!closed && (hasNativeModal(main) || (accountPopout && hasNativeModal(accountPopout)) || [...rolePopouts.values()].some(w=>hasNativeModal(w)) || [...componentPopouts.values()].some(w=>hasNativeModal(w)) || [...windows.values()].some(w=>hasNativeModal(w)))) event.preventDefault() })
      main.once('closed',()=>this.destroy())
      const firstPaint=armInitialSourcePaint()
      try{await Promise.all([main.webContents.loadURL(SOURCE_URL),firstPaint.promise]);if(main.isDestroyed() || main.webContents.isDestroyed() || main.webContents.mainFrame!==firstPaint.frame || firstPaint.frame?.url!==SOURCE_URL)throw Error('source first paint failed: navigation')}
      catch(error){firstPaint.finish('load');throw error}
      return main
    },
    getGuest(s,p) { return views.get(key(s,p))?.view },
    getAccountGuest() { return account?.view },
    getAccountSidebarGuest() { return accountSidebar?.view },
    getAccountViewBounds() { return account?.view.getBounds?.() },
    findScene(s) { return windows.get(s) },
    async nativeUtility(event, request) {
      if (!exactKeys(request, ['sceneId','panelId','action']) || !['scene-memory','session-speech','session-skills'].includes(request.action)) throw Error('source shell: invalid native utility')
      const window = assertWindow(event), frame = event.senderFrame, epoch = configurationEpoch
      const { sceneId, panelId, action } = request
      const target = scene(sceneId).panels.find(panel => panel.id === panelId)
      if (target?.type !== 'native-chat') throw Error('source shell: native utility target unavailable')
      owner(window, sceneId, panelId)
      const item = views.get(key(sceneId, panelId))
      if (!item || item.failed || item.parent !== window || item.surface !== 'chat' || item.status !== 'context-mounted' || item.view.webContents.isDestroyed()) throw Error('source shell: native utility target unavailable')
      const expected = descriptor(item), contents = item.view.webContents, guestFrame = contents.mainFrame
      const binding = await resolveBinding({ sceneId, panelId })
      if (binding?.bindingStatus !== 'bound' || binding.sceneId !== sceneId || binding.panelId !== panelId) throw Error('source shell: native utility binding unavailable')
      const currentBinding = captureRoleBinding(binding, sceneId, panelId)
      if (closed || configurationEpoch !== epoch || assertWindow(event) !== window || event.senderFrame !== frame
        || views.get(key(sceneId, panelId)) !== item || item.parent !== window || item.failed || item.status !== 'context-mounted'
        || contents.isDestroyed() || contents.mainFrame !== guestFrame || !this.resolveGuest(contents, guestFrame)
        || ['roleId','sessionId','bindingRevision'].some(name => currentBinding[name] !== expected[name])
        || JSON.stringify(descriptor(item)) !== JSON.stringify(expected)) throw Error('source shell: stale native utility target')
      owner(window, sceneId, panelId)
      // Only a fixed UI intent crosses frames. Host grants and operations must
      // still be issued by the actual guest's existing checked action.
      contents.send('dsh-desktop:native-utility-request', { action, descriptor: expected })
      return { delivered: true }
    },
    trustedSourceShellWindow(event) {
      const window=assertWindow(event)
      if(window.isDestroyed() || window.webContents.isDestroyed() || ![...windows.values()].includes(window))throw Error('source shell: rejected source window')
      return window
    },
    sourceShellWindows() {
      const result=[]
      for(const window of new Set(windows.values())) {
        try { if(this.trustedSourceShellWindow({sender:window.webContents,senderFrame:window.webContents.mainFrame})===window)result.push(window) } catch {}
      }
      return result
    },
    menuOwner(event,sourceEditor=false) { const guest=this.resolveGuest(event.sender,event.senderFrame); if(guest) return {window:guest.window,editingContents:event.sender,view:guest.view}; const window=assertWindow(event), remembered=focusedGuests.get(window); const owned=remembered && this.resolveGuest(remembered,remembered.mainFrame); const item=owned?.scope==='account'?account:owned?.scope==='scene-component'?componentForKey(owned.componentKey):owned?.scope==='role'?views.get(key(owned.sceneId,owned.panelId)):undefined; return {window,editingContents:!sourceEditor && owned?.window===window && item?.visible?remembered:window.webContents} },
    resolveGuest(contents,frame) { if(sceneComponent && sceneComponent.view.webContents===contents && frame===contents.mainFrame && frame?.url===SCENE_COMPONENT_URL && sceneComponent.parent && (sceneComponent.parent===componentDockOwner(sceneComponent) || componentPopouts.get('workflow-canvas-native')===sceneComponent.parent) && !sceneComponent.parent.isDestroyed())return {window:sceneComponent.parent,view:sceneComponent.view,sceneId:sceneComponent.sceneId,panelId:sceneComponent.panelId,componentKey:sceneComponent.componentKey,scope:'scene-component'};if(erpNextStatusComponent && erpNextStatusComponent.view.webContents===contents && frame===contents.mainFrame && frame?.url===SCENE_COMPONENT_URL && erpNextStatusComponent.parent && (erpNextStatusComponent.parent===main || componentPopouts.get('erpnext-status-native')===erpNextStatusComponent.parent) && !erpNextStatusComponent.parent.isDestroyed())return {window:erpNextStatusComponent.parent,view:erpNextStatusComponent.view,sceneId:erpNextStatusComponent.sceneId,panelId:erpNextStatusComponent.panelId,componentKey:erpNextStatusComponent.componentKey,scope:'scene-component'};if(accountSidebar && account && accountSidebar.accountGeneration===account.generation && accountSidebar.view.webContents===contents && frame===contents.mainFrame && typeof frame?.url==='string' && frame.url.startsWith('dsh-app://app/') && accountSidebar.parent===account.parent && !accountSidebar.parent.isDestroyed()) return {window:accountSidebar.parent,view:accountSidebar.view,scope:'account-sidebar'}; if(account && account.view.webContents===contents && frame===contents.mainFrame && typeof frame?.url==='string' && frame.url.startsWith('dsh-app://app/') && account.parent && !account.parent.isDestroyed()) return {window:account.parent,view:account.view,scope:'account'}; for(const item of views.values()) { const seat=registry.get(item.sceneId,item.panelId); if(!item.failed && item.view.webContents===contents && frame && typeof frame.url==='string' && frame.url.startsWith('dsh-app://app/') && registry.authorizeGuest(item.wrapper,frame) && seat && !item.parent.isDestroyed()) return {window:item.parent,view:item.view,sceneId:item.sceneId,panelId:item.panelId,sessionId:item.sessionId,bindingRevision:item.bindingRevision,generation:item.generation,scope:'role'} } return undefined },
    isGuest(contents,frame) { return this.resolveGuest(contents,frame) !== undefined },
    nativeLayout(contents,frame) {
      const owned=this.resolveGuest(contents,frame)
      if(owned?.scope!=='role')throw Error('source shell: layout owner rejected')
      const item=views.get(key(owned.sceneId,owned.panelId)),seat=registry.get(owned.sceneId,owned.panelId)
      if(!item || item.parent!==owned.window || seat?.window.window!==item.parent)throw Error('source shell: layout owner rejected')
      owner(owned.window,owned.sceneId,owned.panelId)
      const embedded=rolePopouts.get(key(item.sceneId,item.panelId))!==item.parent
      const z=embedded?1:item.parent.webContents.getZoomFactor(),width=item.rect?.width/z,height=item.rect?.height/z
      const boundsReady=Number.isFinite(width)&&width>0&&Number.isFinite(height)&&height>0
      return {embedded,boundsReady,width:boundsReady?width:0,height:boundsReady?height:0}
    },
    nativeDescriptor(contents,frame) { const owned=this.resolveGuest(contents,frame); if(!owned)return undefined; const item=owned.scope==='account'?account:owned.scope==='account-sidebar'?accountSidebar:owned.scope==='scene-component'?owned.componentKey==='erpnext-status-native'?erpNextStatusComponent:sceneComponent:views.get(key(owned.sceneId,owned.panelId)); return descriptor(item) },
    accountOverlayStatus(contents,frame) {
      if(this.resolveGuest(contents,frame)?.scope!=='account' || frame!==contents.mainFrame)throw Error('account overlay owner rejected')
      return {...accountOverlayState}
    },
    nativeMounted(contents,frame,ack) { const current=this.nativeDescriptor(contents,frame); if(!current || !ack || Object.keys(current).some(k=>ack[k]!==current[k]) || Object.keys(ack).length!==Object.keys(current).length) throw Error('source shell: rejected mounted acknowledgement'); if(current.kind==='account'){account.status='context-mounted';notifyAccount(account)}else if(current.kind==='scene-component'&&current.componentKey==='workflow-canvas-native'){sceneComponent.status='context-mounted';notifySceneComponent(sceneComponent)}else if(current.kind==='scene-component'&&current.componentKey==='erpnext-status-native'){erpNextStatusComponent.status='context-mounted';notifySceneComponent(erpNextStatusComponent)}else if(current.kind==='role'){const item=views.get(key(current.sceneId,current.panelId));emit(item,'context-mounted')} return undefined },
    accountSidebarCommand(contents,frame,request) {
      if(['get-workbench-pair-bounds','resize-workbench-pair','restore-workbench-pair-bounds'].includes(request?.action)){
        const resizing=request.action==='resize-workbench-pair'
        if(!exactKeys(request,resizing?['action','requestId','generation','width','height']:['action','requestId','generation'])
          || !Number.isSafeInteger(request.requestId) || !Number.isSafeInteger(request.generation)
          || (resizing && (!Number.isFinite(request.width) || !Number.isFinite(request.height) || request.width<=0 || request.height<=0)))throw Error('invalid account overlay bounds request')
        const pending=accountOverlayRequest,current=this.nativeDescriptor(contents,frame)
        if(!pending || current?.kind!=='account' || current.businessNavigation!=='shell'
          || pending.item!==account || pending.contents!==contents || pending.frame!==frame || contents.mainFrame!==frame
          || pending.generation!==current.generation || pending.generation!==request.generation || pending.requestId!==request.requestId
          || accountOverlay?.item!==account || !accountSidebarOpen || accountGlobalPanel || account.status!=='context-mounted'
          || account.parent!==main || account.placement!=='docked')throw Error('stale account overlay bounds request')
        const z=contents.getZoomFactor()
        if(!Number.isFinite(z) || z<=0)throw Error('invalid account overlay zoom')
        if(resizing){const limits=accountOverlayBoundsValue();accountOverlay.presentationRect={width:Math.min(limits.maxWidth,Math.max(limits.minWidth,request.width))*z,height:Math.min(limits.maxHeight,Math.max(limits.minHeight,request.height))*z}}
        else if(request.action==='restore-workbench-pair-bounds')accountOverlay.presentationRect=undefined
        if(resizing || request.action==='restore-workbench-pair-bounds')applyAccountOverlayBounds(account)
        return accountOverlayBoundsValue()
      }
      if(request?.action==='collapse-workbench-pair'){
        if(!exactKeys(request,['action','requestId','generation']) || !Number.isSafeInteger(request.requestId) || !Number.isSafeInteger(request.generation))throw Error('invalid account overlay request')
        const pending=accountOverlayRequest, current=this.nativeDescriptor(contents,frame)
        if(!pending || current?.kind!=='account' || current.businessNavigation!=='shell'
          || pending.item!==account || pending.contents!==contents || pending.frame!==frame || contents.mainFrame!==frame
          || pending.generation!==current.generation || pending.generation!==request.generation || pending.requestId!==request.requestId
          || accountOverlay?.item!==account || !accountSidebarOpen || accountGlobalPanel || account.status!=='context-mounted' || account.parent!==main || account.placement!=='docked')throw Error('stale account overlay request')
        closeAccountOverlay();return true
      }
      if(!request || typeof request!=='object' || Array.isArray(request) || !Number.isSafeInteger(request.generation) || !Number.isSafeInteger(request.accountGeneration) || !request.command || typeof request.command!=='object' || Array.isArray(request.command))throw Error('invalid account sidebar command')
      const current=this.nativeDescriptor(contents,frame),cmd=request.command
      if(!current || !account || request.accountGeneration!==account.generation)throw Error('stale account sidebar owner')
      const ownerAccount=account
      const assertRequestStillCurrent=()=>{
        const latest=this.nativeDescriptor(contents,frame)
        if(account!==ownerAccount || ownerAccount.generation!==request.accountGeneration || !latest
          || latest.kind!==current.kind || latest.generation!==request.generation
          || latest.accountGeneration!==request.accountGeneration
          || (current.kind==='account-sidebar' && !accountSidebarOpen))throw Error('stale account sidebar owner')
      }
      const validTarget = target => typeof target==='string' ? target.length>0 && target.length<=256
        : !!target && typeof target==='object' && !Array.isArray(target)
          && Object.keys(target).sort().join(',')==='childSessionId,mode,parentSessionId'
          && typeof target.parentSessionId==='string' && target.parentSessionId.length>0 && target.parentSessionId.length<=256
          && typeof target.childSessionId==='string' && target.childSessionId.length>0 && target.childSessionId.length<=256
          && ['one-shot','continuable','unknown'].includes(target.mode)
      const validStart = () => Object.keys(cmd).every(key=>['action','workspaceId','options'].includes(key))
        && (cmd.workspaceId===undefined || (typeof cmd.workspaceId==='string' && cmd.workspaceId.length>0 && cmd.workspaceId.length<=256))
        && (cmd.options===undefined || (cmd.options && typeof cmd.options==='object' && !Array.isArray(cmd.options)
          && Object.keys(cmd.options).every(key=>['prompt','clearPreviousDraft','whenDraftExists','agentPreset'].includes(key))
          && (cmd.options.prompt===undefined || (typeof cmd.options.prompt==='string' && cmd.options.prompt.length<=100000))
          && (cmd.options.clearPreviousDraft===undefined || typeof cmd.options.clearPreviousDraft==='boolean')
          && (cmd.options.whenDraftExists===undefined || ['replace','append','keep'].includes(cmd.options.whenDraftExists))
          && (cmd.options.agentPreset===undefined || (typeof cmd.options.agentPreset==='string' && cmd.options.agentPreset.length>0 && cmd.options.agentPreset.length<=128))))
      const openInAccount = () => {
        if(account.status!=='context-mounted')throw Error('account navigation service unavailable')
        account.view.webContents.send('dsh-desktop:account-sidebar-command-received',cmd)
        if(account.parent===main)main.webContents.send('source-shell:show-account-chat',{action:cmd.action})
        return undefined
      }
      const routeOpenTarget = target => {
        if(typeof target!=='string')return openInAccount()
        // A config/binding lookup error is not a miss: keep the current visible
        // role surface intact so a retry cannot silently become editable account chat.
        return findRoleTargetForSession(target).then(roleTarget => {
          assertRequestStillCurrent()
          if(roleTarget){
            if(account.parent===main)main.webContents.send('source-shell:show-account-chat',{action:'openBoundSession',sceneId:roleTarget.sceneId,panelId:roleTarget.panelId,sessionId:target})
            return {status:'role-session',sceneId:roleTarget.sceneId,panelId:roleTarget.panelId}
          }
          return openInAccount()
        })
      }
      if(current.kind==='role' || current.kind==='scene-component'){
        if(request.generation!==current.generation || current.accountGeneration!==account.generation)throw Error('stale native navigation owner')
        if(cmd.action==='openSession' && Object.keys(cmd).length===2 && validTarget(cmd.target))return routeOpenTarget(cmd.target)
        if(cmd.action==='startSession' && validStart())return openInAccount()
        throw Error('unsupported native navigation command')
      }
      if(current.kind==='account-sidebar'){
        if(request.generation!==current.generation || current.accountGeneration!==account.generation || !accountSidebarOpen)throw Error('stale account sidebar generation')
        if(cmd.action==='closeSidebar' && Object.keys(cmd).length===1)return setAccountSidebarOpen(false)
        if(cmd.action==='getSidebarWidth' && Object.keys(cmd).length===1){assertRequestStillCurrent();return accountSidebarWidthValue()}
        if(cmd.action==='setSidebarWidth' && Object.keys(cmd).sort().join(',')==='action,widthDip'){assertRequestStillCurrent();return setAccountSidebarWidth(cmd.widthDip)}
        if(cmd.action==='openSession' && Object.keys(cmd).length===2 && validTarget(cmd.target))return routeOpenTarget(cmd.target)
        if(cmd.action==='startSession' && validStart())return openInAccount()
        if(cmd.action==='selectPanel' && Object.keys(cmd).length===2 && (cmd.panelId===null || (typeof cmd.panelId==='string' && cmd.panelId.length>0 && cmd.panelId.length<=160))){account.view.webContents.send('dsh-desktop:account-sidebar-command-received',cmd);if(cmd.panelId===null)restoreAccountGlobalPanel(account,false);else showAccountGlobalPanel(account,'panel',cmd.panelId);return setAccountSidebarOpen(false)}
        if(cmd.action==='openSettings' && Object.keys(cmd).length===1){account.view.webContents.send('dsh-desktop:account-sidebar-command-received',cmd);return setAccountSidebarOpen(false)}
        throw Error('unsupported account sidebar command')
      }
      if(current.kind==='account' && request.generation===current.generation && cmd.action==='toggleSidebar' && Object.keys(cmd).length===1)return setAccountSidebarOpen(!accountSidebarOpen)
      throw Error('account sidebar command rejected')
    },
    completeMobileLink(contents,frame,request,result) {
      const pending=mobileLinkRequests.get(request?.requestId)
      if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || this.nativeDescriptor(contents,frame)?.kind!=='account' || request.generation!==account.generation || pending.request.generation!==request.generation)throw Error('mobile link rejected sender')
      clearTimeout(pending.timer);mobileLinkRequests.delete(request.requestId)
      if(result?.error==='unavailable' && Object.keys(result).length===1){pending.reject(Error('mobile link unavailable'));return}
      if(!result || Object.keys(result).sort().join(',')!=='qrMatrix,url' || typeof result.url!=='string' || result.url.length>2048){pending.reject(Error('mobile link unavailable'));return}
      const matrix=result.qrMatrix
      if(!matrix || Object.keys(matrix).sort().join(',')!=='modules,quietZone,size' || !Number.isInteger(matrix.size) || matrix.size<21 || matrix.size>177 || matrix.quietZone!==4 || !Array.isArray(matrix.modules) || matrix.modules.length!==matrix.size || matrix.modules.some(row=>typeof row!=='string'||row.length!==matrix.size||!/^[01]+$/.test(row))){pending.reject(Error('mobile link unavailable'));return}
      let target
      try{target=new URL(result.url)}catch{pending.reject(Error('mobile link unavailable'));return}
      const octets=target.hostname.split('.').map(value=>/^\d{1,3}$/.test(value)?Number(value):-1)
      const privateHost=octets.length===4&&octets.every(value=>value>=0&&value<=255)&&(octets[0]===10||octets[0]===192&&octets[1]===168||octets[0]===172&&octets[1]>=16&&octets[1]<=31)
      if(!['http:','https:'].includes(target.protocol)||target.username||target.password||!privateHost||!target.port){pending.reject(Error('mobile link unavailable'));return}
      pending.resolve({url:result.url,qrMatrix:{size:matrix.size,quietZone:4,modules:[...matrix.modules]}})
    },
    completePluginInventory(contents,frame,request,result) { const pending=inventoryRequests.get(request?.requestId);if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || this.nativeDescriptor(contents,frame)?.kind!=='account' || request.generation!==account.generation)throw Error('plugin inventory rejected sender');clearTimeout(pending.timer);inventoryRequests.delete(request.requestId);if(result?.error){pending.reject(Error('plugin inventory unavailable'));return}if(!Array.isArray(result?.entries)){pending.reject(Error('invalid plugin inventory'));return}pending.resolve({entries:result.entries}) },
    completeModelCatalog(contents,frame,request,result) { const pending=modelRequests.get(request?.requestId);if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || this.nativeDescriptor(contents,frame)?.kind!=='account' || request.generation!==account.generation)throw Error('model catalog rejected sender');clearTimeout(pending.timer);modelRequests.delete(request.requestId);if(result?.error){pending.reject(Error('model catalog unavailable'));return}if(!Array.isArray(result?.groups)){pending.reject(Error('invalid model catalog'));return}pending.resolve({groups:result.groups,defaultModel:result.defaultModel,failures:result.failures}) },
    settingsOpenStateChanged(contents,frame,value) {
      const surface=this.nativeDescriptor(contents,frame)
      if(!value || Object.keys(value).sort().join(',')!=='generation,open' || !Number.isSafeInteger(value.generation) || typeof value.open!=='boolean' || !account || value.generation!==account.generation || surface?.kind!=='account' || surface.businessNavigation!=='shell' || account.parent!==main){ui18Diagnostic('settings','state-rejected',{...ui18AccountFields(),failure:'state-rejected'});throw Error('settings owner rejected')}
      const opened=value.open?showAccountGlobalPanel(account,'settings',null):accountGlobalPanel?.mode==='settings'?restoreAccountGlobalPanel(account,false):false
      ui18Diagnostic('settings',opened?'state-accepted':'state-rejected',{...ui18AccountFields(),...(opened?{}:{failure:'state-rejected'}),opened})
      return opened
    },
    claimSettingsOpen(contents,frame,request) {
      const pending=settingsRequests.get(request?.requestId)
      const surface=this.nativeDescriptor(contents,frame)
      if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || surface?.kind!=='account' || request.generation!==account?.generation){
        const failure=!pending?'request-missing':pending.contents!==contents || pending.frame!==frame?'sender-mismatch':surface?.kind!=='account'?'wrong-kind':'generation-mismatch'
        ui18Diagnostic('settings','claim-rejected',{...ui18AccountFields(),failure})
        throw Error('settings rejected sender')
      }
      pending.claimed=true
      ui18Diagnostic('settings','claim-accepted',ui18AccountFields())
      return undefined
    },
    completeSettingsOpen(contents,frame,request,result) {
      const pending=settingsRequests.get(request?.requestId)
      const surface=this.nativeDescriptor(contents,frame)
      if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || surface?.kind!=='account' || request.generation!==account?.generation){
        const failure=!pending?'request-missing':pending.contents!==contents || pending.frame!==frame?'sender-mismatch':surface?.kind!=='account'?'wrong-kind':'generation-mismatch'
        ui18Diagnostic('settings','result-rejected',{...ui18AccountFields(),failure,opened:result?.opened===true})
        throw Error('settings rejected sender')
      }
      pending.resultReceived=true
      clearTimeout(pending.timer);settingsRequests.delete(request.requestId)
      if(result?.error){const fixedFailures=new Set(['service-missing','open-threw','open-state-missing','state-report-rejected']);const failure=fixedFailures.has(result.error)?result.error:'listener-error';ui18Diagnostic('settings','result-rejected',{...ui18AccountFields(),failure,opened:false});pending.reject(Error('settings unavailable'));return}
      if(result?.opened!==true){ui18Diagnostic('settings','result-rejected',{...ui18AccountFields(),failure:'opened-false',opened:false});pending.reject(Error('settings unavailable'));return}
      ui18Diagnostic('settings','result-accepted',{...ui18AccountFields(),opened:true})
      pending.resolve({opened:true})
    },
    applyNativeThemeSource(source) {
      if (closed || !sourceThemeMaterials || source !== sourceThemeMaterials.preference) return false
      publishCanonicalTheme(); return true
    },
    destroy() { if(closed)return; closed=true;releaseNativeTheme?.();failInventory();disposeAccountSidebar();if(sceneComponent)disposeSceneComponent(sceneComponent);if(erpNextStatusComponent)disposeSceneComponent(erpNextStatusComponent);for(const child of componentPopouts.values()){closingComponentPopouts.add(child);if(!child.isDestroyed())child.destroy()}componentPopouts.clear();for(const channel of channels)ipcMain.removeHandler(channel);for(const child of rolePopouts.values()){closingRolePopouts.add(child);if(!child.isDestroyed())child.destroy()}rolePopouts.clear();registry?.destroy(); const popout=accountPopout;accountPopout=undefined;if(account){const item=account;account=undefined;item.detachShortcuts?.();try{item.parent.contentView.removeChildView(item.view)}catch{};item.view.webContents.destroy()}if(popout && !popout.isDestroyed())popout.destroy(); for(const w of windows.values())if(!w.isDestroyed())w.destroy(); windows.clear(); views.clear() },
  }
  releaseNativeTheme = subscribeNativeTheme(() => { if (!closed) publishCanonicalTheme() })
  return controller
}












