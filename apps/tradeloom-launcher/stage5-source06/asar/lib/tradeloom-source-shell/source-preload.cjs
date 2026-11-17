const { contextBridge, ipcRenderer } = require('electron')
const call = (name, ...args) => ipcRenderer.invoke(`source-shell:${name}`, ...args)
const isStrictAiWebAuthState = value => {
  const expected = value.provider === 'deepseek'
    ? { none: 'unknown', 'deepseek-sign-in-path': 'unauthenticated', 'deepseek-account-menu': 'authenticated' }
    : { none: 'unknown', 'doubao-login-button': 'unauthenticated', 'doubao-account-menu': 'authenticated' }
  return Object.hasOwn(expected, value.evidence) && expected[value.evidence] === value.authState
}
contextBridge.exposeInMainWorld('app', Object.freeze({
  initialPaintReady: value => call('initialPaintReady', value),
  minimize: () => call('minimize'), toggleMaximize: () => call('toggleMaximize'), isMaximized: () => call('isMaximized'), close: () => call('close'),
  openWindowsMenu: (name,x,y,sourceEditor) => ipcRenderer.invoke('dsh-desktop:windows-menu',name,x,y,sourceEditor),
  onNativeFocus: callback => { const listener=()=>callback();ipcRenderer.on('source-shell:native-focus',listener);return ()=>ipcRenderer.removeListener('source-shell:native-focus',listener) },
  win: Object.freeze({ info: () => call('windowInfo'), scenes: () => call('windowScenes'), openScene: id => call('detach',id), closeSelf: () => call('close'), onChanged: callback => { const listener=(_event,value)=>callback(value); ipcRenderer.on('source-shell:window-changed',listener); return () => ipcRenderer.removeListener('source-shell:window-changed',listener) } }),
  topbar: Object.freeze({}),
  sys: Object.freeze({ load: () => call('systemLoad'), disks: () => call('systemDisks') }),
  knownFolders: () => call('knownFolders'), openKnownFolder: key => call('openKnownFolder',key),
  sourceConfig: () => call('config'),
  nativeUtility: request => call('nativeUtility', request),
  engineGeneration: request => call('engineGeneration', request),
  saveSceneConfiguration: request => call('configurationSave', request),
  applySceneConfiguration: () => call('configurationApply'),
  onSceneConfigurationChanged: callback => {
    const listener = (_event, value) => callback(value)
    ipcRenderer.on('source-shell:configuration-changed', listener)
    return () => ipcRenderer.removeListener('source-shell:configuration-changed', listener)
  },
  sceneRotation: Object.freeze({
    preview: request => call('sceneRotationPreview', request),
    confirm: request => call('sceneRotationConfirm', request),
    status: request => call('sceneRotationStatus', request),
    resume: request => call('sceneRotationResume', request),
    cancel: request => call('sceneRotationCancel', request),
    abandon: request => call('sceneRotationAbandon', request),
  }),
  openAiWebWindow: request => call('aiWebOpenOrFocus', request),
  aiWeb: Object.freeze({
    authState: provider => call('aiWebAuthState', provider),
    authControlSample: provider => call('aiWebAuthControlSample', provider),
    subscribeAuthState: callback => {
      const listener = (_event, value) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)
          || Object.keys(value).sort().join(',') !== 'authState,evidence,generation,provider'
          || !['deepseek','doubao'].includes(value.provider)
          || !['unknown','unauthenticated','authenticated'].includes(value.authState)
          || !isStrictAiWebAuthState(value)
          || !Number.isSafeInteger(value.generation) || value.generation < 0) return
        callback(Object.freeze({ provider: value.provider, authState: value.authState, evidence: value.evidence, generation: value.generation }))
      }
      ipcRenderer.on('source-shell:ai-web-auth-state-event', listener)
      return () => ipcRenderer.removeListener('source-shell:ai-web-auth-state-event', listener)
    },
  }),
  mobileLink: () => call('mobileLink'),
  sourceTheme: Object.freeze({getSnapshot:()=>call('themeSnapshot'),setPreference:preference=>call('themePreference',preference),onChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:theme-event',listener);return()=>ipcRenderer.removeListener('source-shell:theme-event',listener)}}),
  workflowCanvas: Object.freeze({mount:()=>call('workflowCanvasMount'),setBounds:rect=>call('workflowCanvasBounds',rect),setVisible:visible=>call('workflowCanvasVisible',visible),status:()=>call('workflowCanvasStatus'),popOut:()=>call('workflowCanvasPopOut'),returnToDock:()=>call('workflowCanvasReturnToDock'),onStatus:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:workflow-canvas-status',listener);return()=>ipcRenderer.removeListener('source-shell:workflow-canvas-status',listener)}}),
  erpNextStatus: Object.freeze({mount:()=>call('erpNextStatusMount'),setBounds:rect=>call('erpNextStatusBounds',rect),setVisible:visible=>call('erpNextStatusVisible',visible),status:()=>call('erpNextStatusStatus'),popOut:()=>call('erpNextStatusPopOut'),returnToDock:()=>call('erpNextStatusReturnToDock'),onStatus:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:erpnext-status-event',listener);return()=>ipcRenderer.removeListener('source-shell:erpnext-status-event',listener)}}),
  pluginInventory: () => call('pluginInventory'),
  modelCatalog: () => call('modelCatalog'),
  settingsOpen: () => call('settingsOpen'),
  getUiScale: () => call('getUiScale'), setUiScale: value => call('setUiScale',value), onUiScaleChanged: callback => {const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:ui-scale-event',listener);return ()=>ipcRenderer.removeListener('source-shell:ui-scale-event',listener)},
  accountSurface: Object.freeze({create:()=>call('accountCreate'),setBounds:rect=>call('accountBounds',rect),setVisible:visible=>call('accountVisible',visible),status:()=>call('accountStatus'),popOut:()=>call('accountPopOut'),returnToDock:()=>call('accountReturnToDock'),toggleSidebar:()=>call('accountSidebarToggle'),setSidebarOpen:open=>call('accountSidebarSet',open),sidebarOpen:()=>call('accountSidebarStatus'),sidebarWidth:()=>call('accountSidebarWidth'),setSidebarWidth:widthDip=>call('accountSidebarSetWidth',widthDip),globalPanelStatus:()=>call('accountGlobalPanelStatus'),closeGlobalPanel:()=>call('accountGlobalPanelClose'),onGlobalPanelChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:account-global-panel-event',listener);return ()=>ipcRenderer.removeListener('source-shell:account-global-panel-event',listener)},onStatus:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:account-status-event',listener);return ()=>ipcRenderer.removeListener('source-shell:account-status-event',listener)},onSidebarChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:account-sidebar-event',listener);return ()=>ipcRenderer.removeListener('source-shell:account-sidebar-event',listener)},onSidebarWidthChanged:callback=>{const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:account-sidebar-width-event',listener);return ()=>ipcRenderer.removeListener('source-shell:account-sidebar-width-event',listener)}}),
  listScenarios: async () => (await call('listScenarios')).map(scene => ({...scene,name:scene.label ?? scene.name})), getScenario: async id => { const scene=await call('getScenario',id); return {...scene,name:scene.label ?? scene.name} }, getSceneOrder: () => call('getSceneOrder'), setSceneOrder: order => call('setSceneOrder',order), migrateSceneOrder: order => call('migrateSceneOrder',order), onSceneOrderChanged: callback => {const listener=(_event,value)=>callback(value);ipcRenderer.on('source-shell:scene-order-event',listener);return ()=>ipcRenderer.removeListener('source-shell:scene-order-event',listener)},
  harnessSurface: Object.freeze({
    create: (sceneId, panelId) => call('create', sceneId, panelId),
    transfer: (sceneId, panelId) => call('transfer', sceneId, panelId),
    setBounds: (sceneId, panelId, bounds) => call('bounds', sceneId, panelId, bounds),
    setVisible: (sceneId, panelId, visible) => call('visible', sceneId, panelId, visible),
    popOut: (sceneId, panelId) => call('rolePopOut', sceneId, panelId),
    returnToDock: (sceneId, panelId) => call('roleReturnToDock', sceneId, panelId),
    status: (sceneId, panelId) => call('status', sceneId, panelId),
    onStatus: callback => { const listener = (_event, status) => callback(status); ipcRenderer.on('source-shell:status-event', listener); return () => ipcRenderer.removeListener('source-shell:status-event', listener) },
  }),
  onAccountChatRequested: callback => { const listener = (_event, value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return
    const keys = Object.keys(value).sort().join(',')
    if ((value.action === 'openSession' || value.action === 'startSession') && keys === 'action') callback(value)
    else if (value.action === 'openBoundSession' && keys === 'action,panelId,sceneId,sessionId'
      && [value.sceneId, value.panelId, value.sessionId].every(item => typeof item === 'string' && item.length > 0 && item.length <= 256)) callback(value)
  }; ipcRenderer.on('source-shell:show-account-chat', listener); return () => ipcRenderer.removeListener('source-shell:show-account-chat', listener) },
}))



