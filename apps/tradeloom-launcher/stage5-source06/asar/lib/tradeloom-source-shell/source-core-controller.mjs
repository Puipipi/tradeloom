import { cpus, totalmem, freemem } from 'node:os'
import { statfs } from 'node:fs/promises'
import { createSurfaceOwner } from './surface-owner.mjs'
const SOURCE_URL = 'dsh-app://app/source-shell/renderer/source-entry.html'
const ACCOUNT_URL = 'dsh-app://app/source-shell/renderer/account-window.html'
const SCENE_COMPONENT_URL = 'dsh-app://app/'
export function createSourceShellController({ BrowserWindow, WebContentsView, ipcMain, appPreload, sourcePreload, ownedPartition, getConfig, resolveBinding, installProtocol, primaryWindow, hasNativeModal = () => false, updateOwnership = () => {}, createRegistry = createSurfaceOwner, loadUiScale = async () => 1, saveUiScale = async () => { throw Error('UI scale persistence unavailable') }, loadSceneOrder = async () => ({saved:false,ids:[]}), saveSceneOrder = async () => { throw Error('scene order persistence unavailable') }, inventoryTimeoutMs = 5000, systemInfo = { cpus, totalmem, freemem }, diskStat = statfs, getKnownFolders, openKnownFolder, attachAccountShortcuts, resetAccountShortcuts, observeFailure = () => {} }) {
  if (!appPreload || !sourcePreload || !ownedPartition || typeof getConfig !== 'function' || typeof resolveBinding !== 'function' || typeof installProtocol !== 'function') throw new Error('missing trusted desktop configuration')
  let main, accountPopout, accountPopoutCreating, registry, config, account, accountGlobalPanel, sceneComponent, erpNextStatusComponent, accountSidebar, accountSidebarOpen=false, accountSidebarRequest=0, accountSidebarCreating, accountCreating, closed = false, generation = 0, uiScale=1, orderSaved=false, orderMigrationAllowed=true, orderQueue=Promise.resolve(), sourceThemeSnapshot, pendingSourceThemePreference
  const windows = new Map(), views = new Map(), rolePopouts = new Map(), rolePopoutCreating = new Map(), closingRolePopouts = new Set(), componentPopouts = new Map(), componentPopoutCreating = new Map(), closingComponentPopouts = new Set(), channels = [], focusedGuests = new Map(), inventoryRequests = new Map(), modelRequests = new Map(), settingsRequests = new Map(), mobileLinkRequests = new Map()
  let inventorySequence=0
  const failMobileLinks = item => { for(const [id,request] of mobileLinkRequests){if(item && request.item!==item)continue;clearTimeout(request.timer);mobileLinkRequests.delete(id);request.reject(Error('mobile link unavailable'))} }
  const failInventory = () => { for(const request of inventoryRequests.values()){clearTimeout(request.timer);request.reject(Error('plugin inventory unavailable'))}inventoryRequests.clear(); for(const request of modelRequests.values()){clearTimeout(request.timer);request.reject(Error("model catalog unavailable"))}modelRequests.clear(); for(const request of settingsRequests.values()){clearTimeout(request.timer);request.reject(Error("settings unavailable"))}settingsRequests.clear();failMobileLinks() }
  const key = (s, p) => JSON.stringify([s, p])
  const wrap = w => ({ id: w.id, get frame() { return w.webContents.mainFrame }, get bounds() { return w.getContentBounds() }, window: w })
  const assertWindow = event => {
    const w = [...windows.values(), ...(accountPopout ? [accountPopout] : []), ...rolePopouts.values()].find(x => x.webContents === event.sender && x.webContents.mainFrame === event.senderFrame)
    const id = [...windows].find(([,value]) => value === w)?.[0]
    const expected = w===accountPopout ? ACCOUNT_URL : [...rolePopouts.values()].includes(w) ? 'about:blank' : id && id !== 'main' ? SOURCE_URL + '?solo=1&scene=' + encodeURIComponent(id) : SOURCE_URL
    if (!w || event.senderFrame.url !== expected) throw new Error('source shell: rejected sender')
    return w
  }
  const scene = id => { const value = config.scenes.find(s => s.id === id); if (!value) throw new Error('unknown scene'); return value }
  const normalizeOrder = ids => {const result=[];for(const raw of Array.isArray(ids)?ids:[]){if(typeof raw!=='string')continue;const id=raw.trim();if(!id || result.includes(id))continue;result.push(id);if(result.length===200)break}return result}
  const orderedScenes = ids => {const saved=normalizeOrder(ids),byId=new Map(config.scenes.map(s=>[s.id,s]));const ordered=saved.map(id=>byId.get(id)).filter(Boolean).concat(config.scenes.filter(s=>!saved.includes(s.id)));return ordered.filter(s=>s.first).concat(ordered.filter(s=>!s.first))}
  const orderState = () => ({saved:orderSaved,ids:config.scenes.map(s=>s.id)})
  const owner = (w,s,p) => { const seat=registry.get(s,p); if (!seat || seat.window.window!==w) throw new Error('wrong scene owner'); return seat }
  const validScale = value => [0.85,0.9,0.95,1,1.1,1.25].includes(value)
  const themePreference = value => value === 'light' || value === 'dark' || value === 'system'
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
  const scaledRect = (w,rect) => { const z=w.webContents.getZoomFactor(); return Object.fromEntries(['x','y','width','height'].map(k=>[k,rect[k]*z])) }
  const applyBounds = item => { if(!item.rect)return;const w=item.parent,seat=item.kind==='account'||item.kind==='scene-component'?undefined:registry.get(item.sceneId,item.panelId),rect=seat?.rehomed?item.rect:scaledRect(w,item.rect);if(item.kind==='account'||item.kind==='scene-component'){if(!['x','y','width','height'].every(k=>Number.isFinite(rect[k]))||rect.width<0||rect.height<0)throw Error('invalid account bounds');const b=w.getContentBounds(),x=Math.max(0,Math.min(b.width,Math.floor(rect.x))),y=Math.max(0,Math.min(b.height,Math.floor(rect.y)));const clipped={x,y,width:Math.max(0,Math.min(b.width-x,Math.floor(rect.width))),height:Math.max(0,Math.min(b.height-y,Math.floor(rect.height)))};item.view.setBounds(clipped);return clipped}owner(w,item.sceneId,item.panelId);const result=registry.bounds({sender:seat.window,frame:w.webContents.mainFrame},item.sceneId,item.panelId,rect);item.view.setBounds(result);return result }
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
  const descriptor = item => item.kind === 'account' ? {kind:'account',generation:item.generation,businessNavigation:'shell'} : item.kind==='account-sidebar' ? {kind:'account-sidebar',generation:item.generation,accountGeneration:item.accountGeneration} : item.kind==='scene-component' ? {kind:'scene-component',componentKey:item.componentKey,sceneId:item.sceneId,panelId:item.panelId,generation:item.generation,...(account?{accountGeneration:account.generation}:{})} : {kind:'role',sceneId:item.sceneId,panelId:item.panelId,sessionId:item.sessionId,surface:item.surface,generation:item.generation,...(account?{accountGeneration:account.generation}:{})}
  const notifyGuest = item => { item.generation=++generation; item.status=item.loaded?'document-loaded':'loading'; try { item.view.webContents.send('dsh-desktop:native-surface-changed',descriptor(item)) } catch(error) { item.status='context-update-failed'; console.error('source shell: guest notification failed',error) } }
  const observedOperations = Object.freeze({
    create:'role-create',status:'role-status',bounds:'role-bounds',visible:'role-visibility',
    workflowCanvasMount:'workflow-create',workflowCanvasStatus:'workflow-status',workflowCanvasBounds:'workflow-bounds',workflowCanvasVisible:'workflow-visibility',
    erpNextStatusMount:'erpnext-create',erpNextStatusStatus:'erpnext-status',erpNextStatusBounds:'erpnext-bounds',erpNextStatusVisible:'erpnext-visibility',
    accountSidebarToggle:'sidebar-open',accountSidebarSet:'sidebar-open',accountSidebarStatus:'sidebar-status',themePreference:'theme-preference',
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
    if (!closed) registry.revoke(item.sceneId,item.panelId)
    views.delete(id); rolePopouts.delete(id)
    try { item.parent.contentView.removeChildView(item.view) } catch {}
    if(child && !child.isDestroyed()) { closingRolePopouts.add(child); try { child.destroy() } catch {} }
  }
  const relocate = (sceneId, from, to, commit = () => {}) => {
    const items=[...views.values()].filter(item=>item.sceneId===sceneId && item.parent===from), moved=[]
    try {
      for (const item of items) {
        const entry={item, removed:false, added:false, synced:false}; moved.push(entry)
        from.contentView.removeChildView(item.view); entry.removed=true
        to.contentView.addChildView(item.view); entry.added=true; item.parent=to
        updateOwnership(item.view.webContents,to); entry.synced=true
      }
      commit(); for(const {item} of moved) item.failed=false
    } catch(error) {
      const failures=[]
      for(const entry of moved.reverse()) {
        try { if(entry.added) to.contentView.removeChildView(entry.item.view); if(entry.removed) { from.contentView.addChildView(entry.item.view); entry.item.parent=from } updateOwnership(entry.item.view.webContents,from) } catch(rollbackError) { failures.push(rollbackError) }
      }
      if(failures.length) { for(const {item} of moved) item.failed=true; throw new AggregateError([error,...failures],'surface migration rollback failed') }
      throw error
    }
      for(const {item} of moved) notifyGuest(item)
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
      const child=new BrowserWindow({frame:true,width:1040,height:760,minWidth:600,minHeight:420,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}})
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
          child.show?.();child.focus?.();emit(item,item.status)
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
  const windowOptions = { frame:false, width:1440, height:900, webPreferences:{preload:sourcePreload,contextIsolation:true,nodeIntegration:false,sandbox:true} }
  const notifyAccountSidebar = () => { for(const w of new Set([main,accountPopout].filter(Boolean))) if(!w.isDestroyed()) try { w.webContents.send('source-shell:account-sidebar-event',accountSidebarOpen) } catch {} }
  const applyAccountSidebarBounds = item => { if(!item || item.view.webContents.isDestroyed())return;const b=item.parent.getContentBounds(),headerDip=Math.round(40*uiScale),sidebarDip=Math.round(340*uiScale);item.view.setBounds({x:0,y:Math.min(headerDip,Math.max(0,b.height)),width:Math.min(sidebarDip,Math.max(0,b.width)),height:Math.max(0,b.height-headerDip)}) }
  const disposeAccountSidebar = () => {
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
    const request=++accountSidebarRequest
    if(!open){accountSidebarOpen=false;if(accountSidebar)accountSidebar.view.setVisible(false);notifyAccountSidebar();return false}
    if(!accountSidebar){
      const view=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}})
      const item={kind:'account-sidebar',generation:++generation,accountGeneration:account.generation,view,parent,listeners:[]}
      accountSidebar=item
      const creating=(async()=>{try{
        item.parent.contentView.addChildView(view);view.setVisible(false);view.webContents.setZoomFactor(uiScale);applyAccountSidebarBounds(item)
        const refresh=()=>applyAccountSidebarBounds(item),hide=()=>{if(item.parent.isMinimized?.())view.setVisible(false);else if(accountSidebar===item && accountSidebarOpen)view.setVisible(true)}
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
  const notifyAccountGlobalPanel = value => { if(main && !main.isDestroyed())try{main.webContents.send('source-shell:account-global-panel-event',value)}catch{} }
  const contentChildIndex = (parent,view) => Array.isArray(parent?.contentView?.children) ? parent.contentView.children.indexOf(view) : -1
  const restoreContentChildIndex = (parent,view,index) => {
    if(!Number.isInteger(index) || index<0 || !parent || parent.isDestroyed?.())return
    const children=parent.contentView.children
    if(!Array.isArray(children) || children[index]===view)return
    parent.contentView.removeChildView(view)
    parent.contentView.addChildView(view,Math.min(index,children.length))
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
    return true
  }
  const showAccountGlobalPanel = (item,mode,panelId=null) => {
    if(item!==account || item.status!=='context-mounted' || item.parent!==main || item.placement!=='docked')throw Error('global account panel unavailable')
    if(!accountGlobalPanel)accountGlobalPanel={item,previousRect:item.rect?{...item.rect}:undefined,previousVisible:item.visible===true,previousChildIndex:contentChildIndex(main,item.view)}
    else if(accountGlobalPanel.item!==item)throw Error('global account panel owner changed')
    accountGlobalPanel={...accountGlobalPanel,mode,panelId}
    const bounds=main.getContentBounds(),zoom=main.webContents.getZoomFactor(),header=Math.round(40*uiScale)
    item.rect={x:0,y:40,width:bounds.width/zoom,height:Math.max(0,bounds.height-header)/zoom}
    main.contentView.addChildView(item.view)
    item.view.setVisible(true);item.visible=true;applyBounds(item)
    notifyAccountGlobalPanel({mode,open:true,panelId})
    notifyAccount(item)
    return true
  }
  const notifyAccount = item => { const value=accountStatusValue(item); for(const w of new Set([main,accountPopout].filter(Boolean)))if(!w.isDestroyed())try{w.webContents.send('source-shell:account-status-event',value)}catch(error){console.error('source shell: account status notification failed',error)} }
  const moveAccountView = (item,to,placement) => {
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
  const componentForKey = componentKey => componentKey==='workflow-canvas-native'?sceneComponent:componentKey==='erpnext-status-native'?erpNextStatusComponent:undefined
  const componentPlacement = item => item && componentPopouts.get(item.componentKey)===item.parent?'popped-out':'docked'
  const componentStatusValue = item => ({status:item?.status ?? 'unavailable',visible:item?.visible===true,placement:componentPlacement(item),componentKey:item?.componentKey,sceneId:item?.sceneId,panelId:item?.panelId})
  const notifySceneComponent = item => {
    if(closed || !main || main.isDestroyed())return
    const channel=item.componentKey==='workflow-canvas-native'?'source-shell:workflow-canvas-status':'source-shell:erpnext-status-event'
    try{main.webContents.send(channel,componentStatusValue(item))}catch{}
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
    const componentKey=item?.componentKey
    if(!item || componentPopouts.get(componentKey)!==child || item.parent!==child)throw Error('scene component is not popped out')
    if(closed || !main || main.isDestroyed())throw Error('scene component dock owner unavailable')
    if(hasNativeModal(child) || hasNativeModal(main))throw Error('invalid scene component return')
    const oldRect=item.rect,oldVisible=item.visible,dockRect=item.dockedRect?{...item.dockedRect}:null,dockVisible=item.dockedVisible===true,dockIndex=item.dockedChildIndex
    try{
      child.contentView.removeChildView(item.view)
      main.contentView.addChildView(item.view,Number.isInteger(dockIndex)&&dockIndex>=0?dockIndex:undefined)
      restoreContentChildIndex(main,item.view,dockIndex)
      updateOwnership(item.view.webContents,main)
      item.parent=main;item.rect=dockRect;item.visible=dockVisible;item.dockedRect=undefined;item.dockedVisible=undefined;item.dockedChildIndex=undefined
      if(item.rect)applyBounds(item)
      item.view.setVisible(item.visible)
      componentPopouts.delete(componentKey)
      notifySceneComponent(item)
    }catch(error){
      try{try{main.contentView.removeChildView(item.view)}catch{};child.contentView.addChildView(item.view);item.parent=child;item.rect=oldRect;item.visible=oldVisible;item.dockedRect=dockRect;item.dockedVisible=dockVisible;item.dockedChildIndex=dockIndex;item.view.setVisible(true);updateOwnership(item.view.webContents,child);componentPopouts.set(componentKey,child)}catch(rollbackError){throw new AggregateError([error,rollbackError],'scene component return rollback failed')}
      throw error
    }
    if(closeWindow && !child.isDestroyed()){closingComponentPopouts.add(child);child.close()}
    return componentStatusValue(item)
  }
  const popOutSceneComponent = async (event,componentKey) => {
    const requester=assertWindow(event),item=componentForKey(componentKey)
    if(requester!==main || !['workflow-canvas-native','erpnext-status-native'].includes(componentKey) || !item || item.view.webContents.isDestroyed() || hasNativeModal(main))throw Error('invalid scene component popout')
    const existing=componentPopouts.get(componentKey)
    if(existing && !existing.isDestroyed() && item.parent===existing){if(existing.isMinimized?.())existing.restore?.();existing.show?.();existing.focus?.();return componentStatusValue(item)}
    if(componentPopoutCreating.has(componentKey))return componentPopoutCreating.get(componentKey)
    if(item.parent!==main)throw Error('scene component owner changed')
    const task=(async()=>{
      const child=new BrowserWindow({frame:true,width:1040,height:760,minWidth:600,minHeight:420,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true}})
      child.webContents.setZoomFactor(uiScale)
      const dockRect=item.rect?{...item.rect}:null,dockVisible=item.visible===true,dockIndex=Number.isInteger(item.dockIndex)&&item.dockIndex>=0?item.dockIndex:contentChildIndex(main,item.view),from=item.parent
      child.setTitle?.(componentKey==='workflow-canvas-native'?'织贸助手 · 工作流画布':'织贸助手 · ERPNext 状态')
      try{
        await child.webContents.loadURL('about:blank')
        if(closed || child.isDestroyed() || main.isDestroyed() || componentForKey(componentKey)!==item || item.parent!==from || from!==main || hasNativeModal(main))throw Error('scene component unavailable')
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
        try{try{child.contentView.removeChildView(item.view)}catch{};if(item.parent===child || !from.contentView.children?.includes(item.view))from.contentView.addChildView(item.view,Number.isInteger(dockIndex)&&dockIndex>=0?dockIndex:undefined);restoreContentChildIndex(from,item.view,dockIndex);item.parent=from;item.rect=dockRect;item.visible=dockVisible;item.dockedRect=undefined;item.dockedVisible=undefined;item.dockedChildIndex=undefined;item.view.setVisible(dockVisible);updateOwnership(item.view.webContents,from)}catch(rollbackError){throw new AggregateError([error,rollbackError],'scene component popout rollback failed')}
        componentPopouts.delete(componentKey);closingComponentPopouts.add(child);if(!child.isDestroyed())child.destroy();throw error
      }
    })()
    componentPopoutCreating.set(componentKey,task)
    try{return await task}finally{if(componentPopoutCreating.get(componentKey)===task)componentPopoutCreating.delete(componentKey)}
  }
  return {
    async start() {
      if (main || closed) throw new Error('controller already started or closed')
      config = await getConfig()
      if (!Array.isArray(config?.scenes)) throw new Error('invalid trusted configuration')
      const storedOrder=await loadSceneOrder();if(!storedOrder || typeof storedOrder.saved!=='boolean' || !Array.isArray(storedOrder.ids))throw Error('invalid scene order');orderSaved=storedOrder.saved;orderMigrationAllowed=storedOrder.corrupt!==true;config={...config,scenes:orderedScenes(storedOrder.ids)}
      uiScale=await loadUiScale();if(!validScale(uiScale))throw Error('invalid stored UI scale')
      // The Desktop-owned installer registers source and app protocol handlers on this partition.
      await installProtocol(ownedPartition)
      main = primaryWindow ?? new BrowserWindow(windowOptions)
      windows.set('main', main); registry = createRegistry(wrap(main))
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
      bind('config', event => { assertWindow(event); return config })
      bind('getUiScale',event=>{assertWindow(event);return uiScale})
      bind('themeSnapshot',event=>{if(assertWindow(event)!==main)throw Error('wrong source theme owner');return sourceThemeSnapshot})
      bind('themePreference', (event, preference) => {
        if (assertWindow(event) !== main || !themePreference(preference)) throw Error('invalid source theme preference')
        if (account && descriptor(account).businessNavigation === 'shell') account.view.webContents.send('source-shell:theme-preference-event', preference)
        else pendingSourceThemePreference = preference
        return undefined
      })
      bind('themePublish', (event, value) => {
        const owned = this.resolveGuest(event.sender,event.senderFrame)
        if (!owned || owned.scope !== 'account' || !account || descriptor(account).businessNavigation !== 'shell') throw Error('wrong source theme guest')
        const snapshot = safeThemeSnapshot(value)
        sourceThemeSnapshot = snapshot
        main.webContents.send('source-shell:theme-event', snapshot)
        if (pendingSourceThemePreference !== undefined) {
          const preference = pendingSourceThemePreference
          pendingSourceThemePreference = undefined
          account.view.webContents.send('source-shell:theme-preference-event', preference)
        }
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
        if(assertWindow(event)!==main)throw Error('workflow canvas owner rejected')
        const route=workflowCanvasRoute()
        if(sceneComponent && !sceneComponent.view.webContents.isDestroyed() && sceneComponent.sceneId===route.sceneId && sceneComponent.panelId===route.panelId)return {status:sceneComponent.status,componentKey:'workflow-canvas-native',sceneId:route.sceneId,panelId:route.panelId}
        if(sceneComponent)disposeSceneComponent(sceneComponent)
        const view=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}})
        const item={kind:'scene-component',componentKey:'workflow-canvas-native',sceneId:route.sceneId,panelId:route.panelId,generation:++generation,view,parent:main,status:'loading',loaded:false,visible:false,rect:null,dockedRect:null,dockedVisible:false,dockedChildIndex:-1,dockIndex:-1}
        sceneComponent=item
        const notify=()=>notifySceneComponent(item)
        try{
          main.contentView.addChildView(view);item.dockIndex=contentChildIndex(main,view);item.dockedChildIndex=item.dockIndex;view.setVisible(false);view.webContents.setZoomFactor(uiScale);updateOwnership(view.webContents,main)
          view.webContents.once('destroyed',()=>{if(sceneComponent===item)sceneComponent=undefined})
          view.webContents.once('render-process-gone',()=>{if(sceneComponent===item){item.status='error';notify();disposeSceneComponent(item)}})
          view.webContents.on('did-start-navigation',details=>{if(details.isMainFrame && item.loaded && !(details.isSameDocument && typeof details.url==='string' && details.url.startsWith('dsh-app://app/')))disposeSceneComponent(item)})
          view.webContents.once('did-finish-load',()=>{item.loaded=true;if(item.status!=='context-mounted'){item.status='document-loaded';notify()}})
          await view.webContents.loadURL(SCENE_COMPONENT_URL)
          return {status:item.status,componentKey:'workflow-canvas-native',sceneId:item.sceneId,panelId:item.panelId}
        }catch(error){disposeSceneComponent(item);throw error}
      })
      bind('workflowCanvasPopOut',event=>popOutSceneComponent(event,'workflow-canvas-native'))
      bind('workflowCanvasReturnToDock',event=>{if(assertWindow(event)!==main)throw Error('workflow canvas return owner rejected');const item=componentForKey('workflow-canvas-native'),child=componentPopouts.get('workflow-canvas-native');if(!item)throw Error('workflow canvas unavailable');return child?returnSceneComponentToDock(item,child):componentStatusValue(item)})
      bind('workflowCanvasBounds',(event,rect)=>{
        if(assertWindow(event)!==main || !sceneComponent)throw Error('workflow canvas unavailable')
        if(!rect || !['x','y','width','height'].every(key=>Number.isFinite(rect[key])) || rect.width<0 || rect.height<0)throw Error('invalid workflow canvas bounds')

        return applySceneComponentBounds(sceneComponent,rect)
      })
      bind('workflowCanvasVisible',(event,visible)=>{
        if(assertWindow(event)!==main || !sceneComponent)throw Error('workflow canvas unavailable')
        return setSceneComponentVisible(sceneComponent,visible)

      })
      bind('workflowCanvasStatus',event=>{
        if(assertWindow(event)!==main)throw Error('workflow canvas owner rejected')
        return sceneComponent?{status:sceneComponent.status,visible:sceneComponent.visible}:{status:'unavailable',visible:false}
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
          main.contentView.addChildView(view);item.dockIndex=contentChildIndex(main,view);item.dockedChildIndex=item.dockIndex;view.setVisible(false);view.webContents.setZoomFactor(uiScale);updateOwnership(view.webContents,main)
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
      bind('settingsOpen',async event=>{assertWindow(event);const dockedAccount=account?.parent===main;if(!account || account.status!=='context-mounted' || (!dockedAccount && (account.visible!==true || !account.rect || account.rect.width<=0 || account.rect.height<=0)))throw Error('settings unavailable');const item=account,contents=item.view.webContents,frame=contents.mainFrame,id=++inventorySequence,request={requestId:id,generation:item.generation};return await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{settingsRequests.delete(id);reject(Error('settings timeout'))},inventoryTimeoutMs);settingsRequests.set(id,{item,contents,frame,resolve,reject,timer});try{contents.send('dsh-desktop:settings-open-request',request)}catch(error){clearTimeout(timer);settingsRequests.delete(id);reject(error)}})})
      bind('accountGlobalPanelClose',event=>{if(assertWindow(event)!==main)throw Error('global panel owner rejected');if(!accountGlobalPanel || accountGlobalPanel.item!==account)return false;return restoreAccountGlobalPanel(account,true)})
      bind('setUiScale',async(event,value)=>{assertWindow(event);if(!validScale(value))throw Error('invalid UI scale');if(value===uiScale)return uiScale;const previous=uiScale;try{uiScale=value;applyScale(value);await saveUiScale(value)}catch(error){uiScale=previous;applyScale(previous);throw error}for(const w of new Set([...windows.values(),...(accountPopout?[accountPopout]:[])]))w.webContents.send('source-shell:ui-scale-event',value);return value})
      for (const name of ['minimize','close']) bind(name, event => { const w=assertWindow(event); w[name]() })
      bind('toggleMaximize',event=>{const w=assertWindow(event); w.isMaximized()?w.unmaximize():w.maximize()})
      bind('isMaximized',event=>assertWindow(event).isMaximized())
      bind('windowInfo',event=>{const w=assertWindow(event); return {isMain:w===main,isAccountPopout:w===accountPopout,sceneId:[...windows].find(([,value])=>value===w)?.[0]}})
      bind('windowScenes',event=>{assertWindow(event); return [...windows.keys()].filter(x=>x!=='main')})
      bind('listScenarios',event=>{assertWindow(event); return config.scenes})
      bind('getScenario',(event,id)=>{assertWindow(event); return scene(id)})
      bind('getSceneOrder',event=>{assertWindow(event); return orderState()})
      const saveOrder=(event,order,migrate)=>{assertWindow(event);if(!Array.isArray(order))throw Error('invalid order');const task=orderQueue.then(async()=>{assertWindow(event);if(migrate && (orderSaved || !orderMigrationAllowed))return orderState();const next=orderedScenes(order),ids=normalizeOrder(next.map(s=>s.id));await saveSceneOrder(ids);config={...config,scenes:next};orderSaved=true;orderMigrationAllowed=false;const state=orderState();for(const w of windows.values())try{w.webContents.send('source-shell:scene-order-event',state)}catch(error){console.error('scene order notification failed',error)}return state});orderQueue=task.catch(()=>{});return task}
      bind('setSceneOrder',(event,order)=>saveOrder(event,order,false))
      bind('migrateSceneOrder',(event,order)=>saveOrder(event,order,true))
      const assertAccountStatus = event => { const w=assertWindow(event);if(w!==main && w!==accountPopout)throw Error('wrong account status owner');return account }
      const emitAccount = (item,status) => { item.status=status; notifyAccount(item) }
  const revokeAccount = item => { if(account!==item)return; if(accountGlobalPanel?.item===item){accountGlobalPanel=undefined;notifyAccountGlobalPanel({mode:null,open:false,panelId:null})}disposeAccountSidebar();failInventory();account=undefined;if(focusedGuests.get(item.parent)===item.view.webContents)focusedGuests.delete(item.parent);item.detachShortcuts?.();try{item.parent.contentView.removeChildView(item.view)}catch{};const child=accountPopout;accountPopout=undefined;if(child && !child.isDestroyed())try{child.close()}catch{} }
      bind('accountCreate',async event=>{
        const requester=assertWindow(event);if(requester!==main && requester!==accountPopout)throw Error('wrong account creator'); if(account)return accountStatusValue(account); if(requester!==main)throw Error('wrong account creator'); if(accountCreating)return accountCreating
        accountCreating=(async()=>{ const v=new WebContentsView({webPreferences:{preload:appPreload,partition:ownedPartition,contextIsolation:true,nodeIntegration:false,sandbox:true}})
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
      bind('accountBounds',(event,rect)=>{const item=accountOwner(event);if(!rect || !['x','y','width','height'].every(k=>Number.isFinite(rect[k])) || rect.width<0 || rect.height<0)throw Error('invalid account bounds');item.rect=rect;if(item.placement==='popout')item.popoutRect=rect;else item.dockedRect=rect;return applyBounds(item)})
      bind('accountVisible',(event,visible)=>{const item=accountOwner(event);if(typeof visible!=='boolean')throw Error('invalid account visibility');item.view.setVisible(visible);item.visible=visible;if(!visible){if(accountSidebar && !accountGlobalPanel)disposeAccountSidebar();else if(accountSidebar)accountSidebar.view.setVisible(false);resetAccountShortcuts?.(item.view.webContents);for(const request of settingsRequests.values()){clearTimeout(request.timer);request.reject(Error('settings unavailable'))}settingsRequests.clear()}else if(accountGlobalPanel?.item===item){main.contentView.addChildView(item.view);if(accountSidebarOpen && accountSidebar)main.contentView.addChildView(accountSidebar.view)}notifyAccount(item)})
      bind('accountSidebarToggle',async event=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return setAccountSidebarOpen(!accountSidebarOpen)})
      bind('accountSidebarSet',async (event,open)=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return setAccountSidebarOpen(open)})
      bind('accountSidebarStatus',event=>{const requester=assertWindow(event);if(!account || requester!==account.parent)throw Error('wrong account sidebar owner');return accountSidebarOpen})
      bind('accountStatus',event=>{assertAccountStatus(event);return accountStatusValue(account)})
      bind('accountPopOut',async event=>{
        if(assertWindow(event)!==main || hasNativeModal(main) || (accountPopout && hasNativeModal(accountPopout)))throw Error('invalid account popout')
        if(!account)throw Error('account surface unavailable')
        if(account.parent===accountPopout && accountPopout){accountPopout.focus?.();return accountStatusValue(account)}
        if(accountPopoutCreating)return accountPopoutCreating
        const item=account
        const task=(async()=>{
          const child=new BrowserWindow({...windowOptions,width:1120,height:760,minWidth:640,show:false,webPreferences:{...windowOptions.webPreferences,partition:ownedPartition}})
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
        const w = assertWindow(event), panel = scene(sceneId).panels.find(p => p.id === panelId)
        if (!panel || !['native-chat', 'native-workspace'].includes(panel.type)) throw new Error('not a native panel')
        if (views.has(key(sceneId,panelId))) {
          const existing=views.get(key(sceneId,panelId)),seat=registry.get(sceneId,panelId),dockWindow=windows.get(sceneId)??main
          if(seat?.rehomed && w===dockWindow)return {status:existing.status,placement:'popped-out'}
          owner(w,sceneId,panelId);return {status:existing.status,placement:'docked'}
        }
        const binding = await resolveBinding({ sceneId, panelId })
        if (binding?.sceneId !== sceneId || binding?.panelId !== panelId) throw new Error('binding mismatch')
        if (binding.bindingStatus === 'unbound') return { status:'unbound' }
        if (binding.bindingStatus !== 'bound' || !binding.sessionId) throw new Error('binding unavailable')
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
            views.delete(oldKey);item.sceneId=sceneId;item.panelId=panelId;item.surface=surface
            item.status=item.loaded?'document-loaded':'loading';views.set(key(sceneId,panelId),item)
            notifyGuest(item);emit(item,item.status)
            return {status:item.status,placement:'docked'}
          }
          return {status:'owned-elsewhere',sceneId:existing.sceneId,panelId:existing.panelId}
        }
        const v = new WebContentsView({ webPreferences:{ preload:appPreload, partition:ownedPartition, contextIsolation:true,nodeIntegration:false,sandbox:true } })
        const wrapper={ get frame() { return v.webContents.mainFrame }, destroy:()=>v.webContents.destroy() }
        try { registry.attach({sceneId,panelId,sessionId:binding.sessionId,surface,view:wrapper,partition:ownedPartition}); owner(w,sceneId,panelId) } catch(error) { registry.revoke(sceneId,panelId); v.webContents.destroy(); throw error }
        const item={sceneId,panelId,sessionId:binding.sessionId,surface,generation:++generation,view:v,wrapper,parent:w,status:'loading',loaded:false}; views.set(key(sceneId,panelId),item)
        w.contentView.addChildView(v); v.setVisible(false); v.webContents.setZoomFactor(uiScale); updateOwnership(v.webContents,w)
        v.webContents.once('destroyed',()=>revoke(item)); v.webContents.once('render-process-gone',()=>{ emit(item,'error'); revoke(item) })
        v.webContents.on('focus',()=>{focusedGuests.set(item.parent,v.webContents);item.parent.webContents.send('source-shell:native-focus')})
        v.webContents.on('did-start-navigation',details=>{ if(details.isMainFrame && item.loaded && !(details.isSameDocument && typeof details.url==='string' && details.url.startsWith('dsh-app://app/'))) revoke(item) })
        v.webContents.once('did-finish-load',()=>{ item.loaded=true; emit(item,'document-loaded') })
        try { await v.webContents.loadURL('dsh-app://app/') } catch(error) { emit(item,'error'); revoke(item); v.webContents.destroy(); throw error }
        return {status:item.status}
      })
      bind('transfer',async(event,s,p)=>{
        const w=assertWindow(event), panel=scene(s).panels.find(x=>x.id===p)
        if(!panel || !['native-chat','native-workspace'].includes(panel.type) || (windows.get(s) ?? main)!==w || hasNativeModal(w)) throw new Error('invalid transfer')
        const binding=await resolveBinding({sceneId:s,panelId:p}); if(binding?.sceneId!==s || binding?.panelId!==p || binding.bindingStatus!=='bound' || !binding.sessionId) throw new Error('binding unavailable')
        if(closed || assertWindow(event)!==w) throw new Error('owner closed')
        const seat=registry.findSession(binding.sessionId,panel.type==='native-chat'?'chat':'files'); if(!seat || hasNativeModal(seat.window.window) || hasNativeModal(w)) throw new Error('transfer unavailable')
        const oldKey=key(seat.sceneId,seat.panelId), item=views.get(oldKey); if(!item) throw new Error('missing view')
        const oldParent=item.parent, oldScene=item.sceneId, oldPanel=item.panelId
        oldParent.contentView.removeChildView(item.view)
        try { w.contentView.addChildView(item.view); updateOwnership(item.view.webContents,w); registry.transfer(binding.sessionId,s,p,panel.type==='native-chat'?'chat':'files') }
        catch(error) { try { w.contentView.removeChildView(item.view) } catch {} oldParent.contentView.addChildView(item.view); updateOwnership(item.view.webContents,oldParent); throw error }
        item.parent=w; views.delete(oldKey); item.sceneId=s; item.panelId=p; item.surface=panel.type==='native-chat'?'chat':'files'; item.status=item.loaded?'document-loaded':'loading'; views.set(key(s,p),item); notifyGuest(item); return {status:item.status}
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
        scene(s); const child=new BrowserWindow(windowOptions); child.webContents.setZoomFactor(uiScale); let registered=false
        child.on('close',event=>{ if(closed || !windows.has(s))return; if(hasNativeModal(child) || hasNativeModal(main)){ event.preventDefault(); return } try { relocate(s,child,main,()=>{ if(registered) registry.returnScene(s) }); for(const item of views.values()) if(item.sceneId===s) item.failed=false; windows.delete(s) } catch(error) { event.preventDefault(); console.error('source shell: scene return failed', error) } })
        try { relocate(s,main,child,()=>{ registry.registerScene(s,wrap(child)); registered=true }); windows.set(s,child) }
        catch(error) { if(error instanceof AggregateError) windows.set(s,child); else child.destroy(); throw error }
        await child.webContents.loadURL(`${SOURCE_URL}?solo=1&scene=${encodeURIComponent(s)}`); return {status:'detached'}
      })
      main.on('close',event=>{ if(!closed && (hasNativeModal(main) || (accountPopout && hasNativeModal(accountPopout)) || [...rolePopouts.values()].some(w=>hasNativeModal(w)) || [...componentPopouts.values()].some(w=>hasNativeModal(w)) || [...windows.values()].some(w=>hasNativeModal(w)))) event.preventDefault() })
      main.once('closed',()=>this.destroy())
      await main.webContents.loadURL(SOURCE_URL)
      return main
    },
    getGuest(s,p) { return views.get(key(s,p))?.view },
    getAccountGuest() { return account?.view },
    getAccountSidebarGuest() { return accountSidebar?.view },
    getAccountViewBounds() { return account?.view.getBounds?.() },
    findScene(s) { return windows.get(s) },
    menuOwner(event,sourceEditor=false) { const guest=this.resolveGuest(event.sender,event.senderFrame); if(guest) return {window:guest.window,editingContents:event.sender,view:guest.view}; const window=assertWindow(event), remembered=focusedGuests.get(window); const owned=remembered && this.resolveGuest(remembered,remembered.mainFrame); const item=owned?.scope==='account'?account:owned && views.get(key(owned.sceneId,owned.panelId)); return {window,editingContents:!sourceEditor && owned?.window===window && item?.visible?remembered:window.webContents} },
    resolveGuest(contents,frame) { if(sceneComponent && sceneComponent.view.webContents===contents && frame===contents.mainFrame && frame?.url===SCENE_COMPONENT_URL && sceneComponent.parent && (sceneComponent.parent===main || componentPopouts.get('workflow-canvas-native')===sceneComponent.parent) && !sceneComponent.parent.isDestroyed())return {window:sceneComponent.parent,view:sceneComponent.view,sceneId:sceneComponent.sceneId,panelId:sceneComponent.panelId,componentKey:sceneComponent.componentKey,scope:'scene-component'};if(erpNextStatusComponent && erpNextStatusComponent.view.webContents===contents && frame===contents.mainFrame && frame?.url===SCENE_COMPONENT_URL && erpNextStatusComponent.parent && (erpNextStatusComponent.parent===main || componentPopouts.get('erpnext-status-native')===erpNextStatusComponent.parent) && !erpNextStatusComponent.parent.isDestroyed())return {window:erpNextStatusComponent.parent,view:erpNextStatusComponent.view,sceneId:erpNextStatusComponent.sceneId,panelId:erpNextStatusComponent.panelId,componentKey:erpNextStatusComponent.componentKey,scope:'scene-component'};if(accountSidebar && account && accountSidebar.accountGeneration===account.generation && accountSidebar.view.webContents===contents && frame===contents.mainFrame && typeof frame?.url==='string' && frame.url.startsWith('dsh-app://app/') && accountSidebar.parent===account.parent && !accountSidebar.parent.isDestroyed()) return {window:accountSidebar.parent,view:accountSidebar.view,scope:'account-sidebar'}; if(account && account.view.webContents===contents && frame===contents.mainFrame && typeof frame?.url==='string' && frame.url.startsWith('dsh-app://app/') && account.parent && !account.parent.isDestroyed()) return {window:account.parent,view:account.view,scope:'account'}; for(const item of views.values()) { const seat=registry.get(item.sceneId,item.panelId); if(!item.failed && item.view.webContents===contents && frame && typeof frame.url==='string' && frame.url.startsWith('dsh-app://app/') && registry.authorizeGuest(item.wrapper,frame) && seat && !item.parent.isDestroyed()) return {window:item.parent,view:item.view,sceneId:item.sceneId,panelId:item.panelId,scope:'role'} } return undefined },
    isGuest(contents,frame) { return this.resolveGuest(contents,frame) !== undefined },
    nativeDescriptor(contents,frame) { const owned=this.resolveGuest(contents,frame); if(!owned)return undefined; const item=owned.scope==='account'?account:owned.scope==='account-sidebar'?accountSidebar:owned.scope==='scene-component'?owned.componentKey==='erpnext-status-native'?erpNextStatusComponent:sceneComponent:views.get(key(owned.sceneId,owned.panelId)); return descriptor(item) },
    nativeMounted(contents,frame,ack) { const current=this.nativeDescriptor(contents,frame); if(!current || !ack || Object.keys(current).some(k=>ack[k]!==current[k]) || Object.keys(ack).length!==Object.keys(current).length) throw Error('source shell: rejected mounted acknowledgement'); if(current.kind==='account'){account.status='context-mounted';notifyAccount(account)}else if(current.kind==='scene-component'&&current.componentKey==='workflow-canvas-native'){sceneComponent.status='context-mounted';notifySceneComponent(sceneComponent)}else if(current.kind==='scene-component'&&current.componentKey==='erpnext-status-native'){erpNextStatusComponent.status='context-mounted';notifySceneComponent(erpNextStatusComponent)}else if(current.kind==='role'){const item=views.get(key(current.sceneId,current.panelId));emit(item,'context-mounted')} return undefined },
    accountSidebarCommand(contents,frame,request) {
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
    settingsOpenStateChanged(contents,frame,value) { const surface=this.nativeDescriptor(contents,frame);if(!value || Object.keys(value).sort().join(',')!=='generation,open' || !Number.isSafeInteger(value.generation) || typeof value.open!=='boolean' || !account || value.generation!==account.generation || surface?.kind!=='account' || surface.businessNavigation!=='shell' || account.parent!==main)throw Error('settings owner rejected');if(value.open)return showAccountGlobalPanel(account,'settings',null);return accountGlobalPanel?.mode==='settings'?restoreAccountGlobalPanel(account,false):false },
    claimSettingsOpen(contents,frame,request) { const pending=settingsRequests.get(request?.requestId); if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || this.nativeDescriptor(contents,frame)?.kind!=='account' || request.generation!==account.generation) throw Error('settings rejected sender'); return undefined },
    completeSettingsOpen(contents,frame,request,result) { const pending=settingsRequests.get(request?.requestId);if(!pending || pending.item!==account || pending.contents!==contents || pending.frame!==frame || this.nativeDescriptor(contents,frame)?.kind!=='account' || request.generation!==account.generation)throw Error('settings rejected sender');clearTimeout(pending.timer);settingsRequests.delete(request.requestId);if(result?.error){pending.reject(Error('settings unavailable'));return}if(result?.opened!==true){pending.reject(Error('settings unavailable'));return}pending.resolve({opened:true}) },
    destroy() { if(closed)return; closed=true;failInventory();disposeAccountSidebar();if(sceneComponent)disposeSceneComponent(sceneComponent);if(erpNextStatusComponent)disposeSceneComponent(erpNextStatusComponent);for(const child of componentPopouts.values()){closingComponentPopouts.add(child);if(!child.isDestroyed())child.destroy()}componentPopouts.clear();for(const channel of channels)ipcMain.removeHandler(channel);for(const child of rolePopouts.values()){closingRolePopouts.add(child);if(!child.isDestroyed())child.destroy()}rolePopouts.clear();registry?.destroy(); const popout=accountPopout;accountPopout=undefined;if(account){const item=account;account=undefined;item.detachShortcuts?.();try{item.parent.contentView.removeChildView(item.view)}catch{};item.view.webContents.destroy()}if(popout && !popout.isDestroyed())popout.destroy(); for(const w of windows.values())if(!w.isDestroyed())w.destroy(); windows.clear(); views.clear() },
  }
}












