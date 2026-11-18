import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'
import { sourceRoleIdentity } from './fixtures/source-role-identity.mjs'
const sourceRoot = new URL('../', import.meta.url)
const actualRoot = process.env.TL_SEVEN_SDK_RUNTIME
const desktop = process.env.TL_NATIVE_CAPTION_DESKTOP_ROOT
const corePath = process.env.TL_SEVEN_SLOT_CORE_ENTRY
const descriptor = {kind:'role',sceneId:'scene',panelId:'chat',roleId:'center',sessionId:'session',bindingRevision:'1',surface:'chat',generation:1}
const React = {createElement:(type,props,...children)=>({type,props:{...props,children}}),Fragment:'fragment'}
function factory(text, requires, globals={}) {let spec;const window={__ModuleLoader__:{load:s=>spec=s},...globals.window};vm.runInNewContext(text,{window,console,AbortController,Promise,queueMicrotask,structuredClone,...globals});return spec.factory(requires)}
const read = name=>readFile(new URL(name,sourceRoot),'utf8')

test('actual SourceNative registration uses an owned root without global rail and pins the main key even after global routing',async()=>{
 const raw=await readFile(corePath);assert.equal(createHash('sha256').update(raw).digest('hex'),'d0a784c4868bd9188af70ecd124f69c69daa67af30e671c13adb15cff28aabe6')
 const {SlotCore}=vm.runInNewContext(raw.toString(),{queueMicrotask,console});const core=new SlotCore()
 const original=()=>null
 core.register({name:'root',children:{main:{kind:'keyed',scope:'root'},sidebar:{kind:'single',scope:'root'},'shell.overlay':{kind:'list',scope:'root'}}},original)
 let active='conversation';const ctx={effect(){},layout:{selectPanel:id=>{active=id}},slots:{inject:(_n,fn)=>fn(),register:(o,c)=>core.register(o,c)}}
 const req=name=>name==='react'?React:{};req.async=async()=>({register:async()=>()=>{}})
 const nativeSource=await read('client.source-native.js'),native=factory(nativeSource,req)
 await native.register(ctx,descriptor,{nativeSurfaceMounted(){},onNativeSurfaceChanged:()=>()=>{}})
 const owned=core.entriesOfSlot('root')[0];assert.notEqual(owned.component,original,'role must not keep AppFrame/sidebar as its rendered root')
 const calls=[];const renderSlot=(name,props,options)=>{calls.push({name,props,options});return{name,props,options}}
 const tree=owned.component({renderSlot});assert.deepEqual(calls.map(x=>x.name),['main','shell.overlay'])
 assert.equal(tree.props.style.position,'relative');assert.equal(tree.props.children[1].props['data-shell-overlay'],true)
 assert.equal(tree.props.children[1].props.style.pointerEvents,'none','empty native overlay cannot intercept the conversation')
 const styles=[],styleStart=nativeSource.indexOf('    const nativeChatStyles = `'),styleEnd=nativeSource.indexOf('    const whaleAutoBases',styleStart)
 const document={createElement:()=>({dataset:{},remove(){}}),head:{append:node=>styles.push(node)}}
 const installStyle=vm.runInNewContext(nativeSource.slice(styleStart,styleEnd)+';installNativeChatStyles',{document})
 const releaseStyle=installStyle()
 const rule=/\[data-source-owned-role\]\s*>\s*\[data-shell-overlay\]\s*>\s*\*\s*\{([^}]+)\}/.exec(styles[0].textContent)
 assert.ok(rule,'actual installed owned-role CSS must retain the official direct overlay-child hit contract')
 assert.match(rule[1],/pointer-events\s*:\s*auto/);assert.doesNotMatch(rule[1],/!important/,'plugin inline pointer-events:none remains authoritative')
 releaseStyle()
 assert.equal(calls[0].options.entryKey,'source-native');assert.equal(active,'source-native')
 ctx.layout.selectPanel('github');calls.length=0;owned.component({renderSlot});assert.equal(calls[0].options.entryKey,'source-native','a plugin route cannot replace a fixed role conversation')
 assert.equal(core.entriesOfSlot('main').filter(x=>x.options.key==='source-native').length,1)
 const account=new SlotCore();account.register({name:'root'},original);assert.equal(account.entriesOfSlot('root')[0].component,original,'separate account root remains official')
})

async function runtime() {
 const req=createRequire(path.join(actualRoot,'package.json')), {Context}=req('@deepseek-ai/cordis')
 const Schema=req('@deepseek-ai/schemastery').default??req('@deepseek-ai/schemastery')
 const settingsText=await readFile(path.join(actualRoot,'node_modules/@deepseek-ai/dsh-client-ui-settings/lib/client.js'),'utf8')
 const storeRaw=await readFile(process.env.TL_SEVEN_STORE_BUILTIN_ENTRY);const store=vm.runInNewContext(storeRaw.toString(),{queueMicrotask,console});
 const settings=factory(settingsText,n=>n==='@deepseek-ai/dsh-client-store'?store:req(n));const services=new Context()
 let value={preference:'light',fontSize:14,codeFontSize:12,terminalFontSize:12,textFontFamily:'',codeFontFamily:'',terminalFontFamily:''},accepted=true,revision=1
 const writes=[];const schema=Schema.object({preference:Schema.string()}).toJSON()
 const view=()=>({ns:'ui-theme',revision,value:{...value},schema,base:{},user:{...value}})
 const remote={settings:{async describe(){return{ok:true,value:{namespaces:[view()],writable:true,hasDocument:true}}},async mutate(ns,ops,expectedRevision){
   assert.equal(ns,'ui-theme');writes.push({ops,expectedRevision});
   if(!accepted)return{ok:false,error:{message:'controlled settings refusal'}}
   assert.equal(expectedRevision,revision);for(const op of ops){assert.equal(op.op,'set');value={...value,[op.path[0]]:op.value}}revision++;return{ok:true,value:view()}
 }},$on(){return()=>{}}}
 services.provide('remote',remote);settings.apply(services)
 const forms=services.get('configForms'),host=forms.get('ui-theme')
 for(let n=0;host.getSnapshot().status!=='ready'&&n<100;n++)await new Promise(resolve=>setImmediate(resolve))
 assert.equal(host.getSnapshot().status,'ready','actual SettingsDescribeMirror/ConfigForm initial Host view')
 const js=await readFile(path.join(actualRoot,'node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js'),'utf8')
 const listeners=new Map(),effects=[],media={matches:false,addEventListener(_n,fn){this.listener=fn},removeEventListener(){}}
 const ctx={configForms:forms,remote,inject(){return()=>{}},effect(fn){const release=fn();effects.push(release);return release},on(n,fn){const set=listeners.get(n)??new Set();set.add(fn);listeners.set(n,set);return()=>set.delete(fn)},emit(n,...args){for(const fn of listeners.get(n)??[])fn(...args)}}
 const document={querySelector:()=>null,createElement:()=>({dataset:{},setAttribute(){},appendChild(){},style:{}}),head:{appendChild(){}},documentElement:{dataset:{dsThemeSource:'light'}},body:{style:{getPropertyValue:()=>''}}}
 const mod=factory(js,n=>n==='react'?React:{}, {document,matchMedia:()=>media})
 const theme=new mod.ThemeRuntime(ctx,host);ctx.theme=theme
 return {ctx,host,theme,forms,remote,view,media,writes,refuse:()=>{accepted=false},allow:()=>{accepted=true},serverUpdate(next){value={...value,...next};revision++},replace(next){value={...value,...next};revision++;forms.describe().acceptView(view())},async dispose(){for(const fn of effects.reverse())if(typeof fn==='function')fn();await services.fiber.dispose()}}
}
function accountBridge(source,ctx,bridge) {
 const start=source.indexOf('    async function installSourceAccountThemeBridge('),end=source.indexOf('    function registerAccountMobileLink(',start);assert.ok(start>=0&&end>start)
 const palette=Object.fromEntries(['canvas','panel','header','border','text','muted','accent','accentStrong','accentSoft','teal','buttonInk','danger','dangerBackground','dangerBorder','warning','warningBackground','warningBorder','success','successBackground'].map(k=>[k,'#111111']))
 return new Function('ctx','bridge',`let activeColorScheme,activeResolvedPalette;const syncWorkbenchFontSize=()=>{},resolveWorkbenchPalette=()=>(${JSON.stringify(palette)}),workbenchUiTokens={fontFamily:'Segoe UI',fontBody:14,fontCompact:12,lineHeight:1.6,topRowHeight:48,navHeight:38,modelControl:31,sceneTabHeight:28,dockTabHeight:28,controlHeight:28,toolbarHeight:30,iconSize:15,cornerRadius:8};${source.slice(start,end)};return installSourceAccountThemeBridge(ctx,bridge)`)(ctx,bridge)
}
test('actual void ThemeRuntime uses real preference ACK seam: light/dark/system, refusal then retry, OS scheme separate',async()=>{
 const r=await runtime();try{
 const source=await read('client.js');const callbacks={},published=[],completed=[]
 r.ctx.theme=r.theme
 await accountBridge(source,r.ctx,{sourceTheme:{publishSnapshot:async s=>published.push(s),onPreferenceSet(fn){callbacks.set=fn;return()=>{}},completePreference:async(m,ok)=>completed.push({m,ok})}})
 const select=p=>callbacks.set(p,{requestId:completed.length+1,generation:1})
 await select('dark');assert.equal(completed.at(-1).ok,true,'void setTheme is not a false persistence ACK '+JSON.stringify({form:r.host.getSnapshot(),theme:r.theme.getTheme().preference,writes:r.writes}));assert.equal(r.theme.getTheme().preference,'dark')
 await select('system');assert.equal(completed.at(-1).ok,true);assert.equal(r.theme.getTheme().active.colorScheme,'light')
 r.media.matches=true;r.media.listener();assert.equal(r.theme.getTheme().preference,'system');assert.equal(r.theme.getTheme().active.colorScheme,'dark')
 await select('light');assert.equal(r.theme.getTheme().active.colorScheme,'light');assert.equal(completed.at(-1).ok,true)
 r.refuse();await select('dark');assert.equal(completed.at(-1).ok,false);assert.equal(r.theme.getTheme().preference,'light')
 r.allow();await select('dark');assert.equal(completed.at(-1).ok,true,'failed click does not poison next request');assert.equal(r.theme.getTheme().preference,'dark')
 assert.equal(published.at(-1).preference,'dark');assert.ok(r.writes.every(x=>x.ops.length===1&&x.ops[0].path[0]==='preference'))
 }finally{await r.dispose()}
})

test('actual controller snapshot and broadcast include owned role guest and role pop-out, reject foreign frame',async t=>{
 const f=await sourceRoleIdentity(t),event={sender:f.primary.webContents,senderFrame:f.primary.webContents.mainFrame}
 const controller=await readFile(path.join(desktop,'lib/tradeloom-source-shell/source-shell-controller.mjs'),'utf8')
 const palette=Object.fromEntries(/const paletteKeys = (\[[^\n]+\])/.exec(controller)[1].replaceAll("'",'"')&&JSON.parse(/const paletteKeys = (\[[^\n]+\])/.exec(controller)[1].replaceAll("'",'"')).map(k=>[k,'#111111']))
 const ui=Object.fromEntries(JSON.parse(/const uiKeys = (\[[^\n]+\])/.exec(controller)[1].replaceAll("'",'"')).map(k=>[k,k==='fontFamily'?'Segoe UI':14]))
 const snapshot={preference:'dark',colorScheme:'dark',palette,ui};const account=f.controller.getAccountGuest().webContents
 await f.handlers.get('source-shell:themePublish')({sender:account,senderFrame:account.mainFrame},snapshot)
 assert.ok(f.view().webContents.messages.some(x=>x.channel==='source-shell:theme-event'),'actual publication must reach the role guest')
 const got=await f.handlers.get('source-shell:themeSnapshot')(f.roleEvent());assert.equal(got.preference,'dark')
 await assert.rejects(async()=>f.handlers.get('source-shell:themeSnapshot')({sender:f.view().webContents,senderFrame:{url:'dsh-app://app/'}}),/sender|owner|guest|frame/)
 const view=f.view();await f.handlers.get('source-shell:rolePopOut')(event,f.sceneId,f.panelId)
 await f.handlers.get('source-shell:themePublish')({sender:account,senderFrame:account.mainFrame},{...snapshot,preference:'system'})
 assert.equal(f.view(),view);assert.equal(view.webContents.messages.at(-1).channel,'source-shell:theme-event');assert.equal(view.webContents.messages.at(-1).args[0].preference,'system')
})

test('actual packaged runtimeResources canonicalizes its SDK before real Host entry/argv and original boot/reconcile',async()=>{
 const source=await readFile(path.join(desktop,'lib/main.js'),'utf8')
 const start=source.indexOf('function runtimeResources() {'),end=source.indexOf('\nfunction developmentPrimaryRuntime()',start)
 const appPath=path.dirname(actualRoot),lower=appPath.replace(/Desktop[\\/]ICT/,x=>x.replace('ICT','ict'))
 const resources=app=>new Function('app','process','join','realpathSync',source.slice(start,end)+';return runtimeResources();')(
   app,{execPath:'controlled-electron.exe',resourcesPath:'controlled-resources',env:{DSH_DESKTOP_DSH_DIR:'unchanged-development-sdk'}},path.join,realpathSync)
 const a=resources({isPackaged:true,getAppPath:()=>lower}),b=resources({isPackaged:true,getAppPath:()=>appPath})
 assert.equal(a.dsh,path.join(realpathSync.native(appPath),'dsh'),'lexical lower-case launch must yield the physical SDK installation root')
 assert.equal(a.dsh,b.dsh)
 assert.equal(resources({isPackaged:false,getAppPath:()=>lower}).dsh,'unchanged-development-sdk','development overrides keep their semantics')
 const environmentStart=source.indexOf('function desktopNodeEnvironment('),environmentEnd=source.indexOf('\n//#endregion',environmentStart)
 const bridgeStart=source.indexOf('function resolveDesktopHostBridge('),classStart=source.indexOf('var DesktopHostProcess = class {',bridgeStart),classEnd=source.indexOf('\n//#endregion',classStart)
 const calls=[],child=new EventEmitter();child.connected=true;child.stdout=new EventEmitter();child.stdout.pipe=()=>process.stdout;child.stderr=new EventEmitter();child.stderr.setEncoding=()=>{}
 const collector=()=>({push(){},reset(){}})
 const Host=new Function('createRequire','pathToFileURL','join','spawn','createNativeImportConfirmationRequests','createUi18ThemeReceiptLineCollector','createUi18RootIdentityLineCollector','observeStartup',
  source.slice(environmentStart,environmentEnd)+source.slice(bridgeStart,classEnd)+';return DesktopHostProcess;')(
    createRequire,pathToFileURL,path.join,(...args)=>{calls.push(args);return child},()=>({dispose(){}}),collector,collector,()=>{})
 const host=new Host(a.node,a.dsh,'controlled-profile',undefined,{},()=>{}),ready=host.start();assert.equal(calls.length,1)
 const argv=calls[0][1];assert.equal(argv[1],path.join(a.dsh,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'));assert.equal(argv[2],a.dsh)
 child.emit('message',{type:'ready',url:'http://127.0.0.1:12345',injections:{}});await ready;host.cancelNativeImportConfirmations();child.removeAllListeners()
 const modulePath=root=>path.join(root,'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')
 const left=await import(pathToFileURL(modulePath(a.dsh)).href),right=await import(pathToFileURL(modulePath(b.dsh)).href)
 assert.equal(left.boot,right.boot);assert.equal(left.reconcileProfilePatches,right.reconcileProfilePatches)
 const empty=path.join(process.env.TL_SEVEN_TEST_ROOT,'canonical-runtime-empty.json');await writeFile(empty,'[]')
 let ctx;try{ctx=await left.boot('controlled-runtime-case',empty,[]);await right.reconcileProfilePatches(ctx,[],'controlled-runtime-case')}
 finally{await ctx?.fiber.dispose()}
})


test('actual native theme follower folds real Host views through official mirror without writes and rejects late owner/dispose results',async()=>{
 const r=await runtime();try{
  const source=await read('client.js'),start=source.indexOf('    async function installSourceNativeThemeBridge('),end=source.indexOf('    function registerAccountMobileLink(',start)
  assert.ok(start>=0&&end>start)
  const install=new Function('ctx','bridge','initial',`const reportRoleGuestPhase=()=>{};${source.slice(start,end)};return installSourceNativeThemeBridge(ctx,bridge,initial)`)
  const events={};let current={...descriptor};const releases=[]
  const beforeEffects=r.ctx.effect;r.ctx.effect=fn=>{const stop=fn();releases.push(stop);return stop}
  const bridge={nativeSurfaceDescriptor:async()=>({...current}),onNativeSurfaceChanged:fn=>{events.owner=fn;return()=>{delete events.owner}},sourceTheme:{getSnapshot:async()=>({preference:'light'}),onChanged:fn=>{events.theme=fn;return()=>{delete events.theme}}}}
  await install(r.ctx,bridge,descriptor)
  const tick=()=>new Promise(resolve=>setImmediate(resolve))
  const update=async(preference)=>{const old=r.theme.getTheme().preference;r.serverUpdate({preference});assert.equal(r.theme.getTheme().preference,old,'Host-only update must not pre-fold the local mirror');events.theme({preference});await tick();assert.equal(r.theme.getTheme().preference,preference)}
  await update('dark');await update('system');r.media.matches=true;r.media.listener();assert.equal(r.theme.getTheme().active.colorScheme,'dark');assert.equal(r.writes.length,0)
  // Keep the actual form/mirror light while one fresh Host response is held.
  r.replace({preference:'light'});let deliver
  r.remote.settings.describe=()=>new Promise(resolve=>{deliver=resolve})
  events.theme({preference:'dark'});while(!deliver)await tick()
  const late={...r.view(),revision:r.view().revision+1,value:{...r.view().value,preference:'dark'}}
  current={...current,sessionId:'new-session',bindingRevision:'2'};deliver({ok:true,value:{namespaces:[late],writable:true,hasDocument:true}});await tick()
  assert.equal(r.theme.getTheme().preference,'light','late old binding cannot fold settings into the new owner')
  deliver=undefined;events.theme({preference:'dark'});while(!deliver)await tick()
  for(const release of releases.reverse())release();deliver({ok:true,value:{namespaces:[late],writable:true,hasDocument:true}});await tick()
  assert.equal(r.theme.getTheme().preference,'light');assert.equal(events.theme,undefined);assert.equal(events.owner,undefined);assert.equal(r.writes.length,0)
  r.ctx.effect=beforeEffects
 }finally{await r.dispose()}
})
