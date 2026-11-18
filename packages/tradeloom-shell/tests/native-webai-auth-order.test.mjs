import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
const root=process.env.TL_AUTH_OUTPUT_ROOT
const main=await readFile(path.join(root,'lib/main.js'),'utf8')
const renderer=await readFile(path.join(root,'renderer/source-shell/replica-ui/renderer.js'),'utf8')
const preload=await readFile(path.join(root,'lib/tradeloom-source-shell/source-preload.cjs'),'utf8')
const part=(s,a,b)=>{const i=s.indexOf(a),j=s.indexOf(b,i);assert.ok(i>=0&&j>i,a);return s.slice(i,j)}
const adapterSource=part(main,'const PROVIDERS = Object.freeze(', 'function createAuthGenerationProjector()')
test('actual compiled auth adapter calls its DTO factory rather than the unrelated bundled Zod unknown binding',()=>{
 const zodUnknown=part(main,'function unknown() {','const ZodNever')
 assert.match(zodUnknown,/ZodUnknown/,'actual competing lexical binding identified')
 assert.doesNotMatch(adapterSource,/\bunknown\(/,'auth adapter must use its existing unknownAuthState DTO helper, not Zod unknown')
})

const tick=()=>new Promise(r=>setImmediate(r))
function actualRuntime(){
 const dto=part(main,'function unknownAuthState(', 'function projectAuthDiagnosticDto(')
 const projector=part(main,'function createAuthGenerationProjector()', 'function isPositiveWebAiAuthState(')
 const classes=part(main,'var DesktopAiWebWindow = class {','const desktopPanePopoutTickets')
 return new Function(adapterSource+dto+projector+classes+';return {Adapter:createWebAiAuthStateAdapter,Site:DesktopAiWebWindow,Manager:DesktopAiWebWindows};')()
}
function frontend(api){
 const listeners=new Map(),buttons=Object.fromEntries(['deepseek','doubao'].map(p=>['btn-'+p,{dataset:{},setAttribute(){}}]))
 const window={app:{aiWeb:api},addEventListener(n,fn){listeners.set(n,fn)},removeEventListener(n){listeners.delete(n)}}
 const document={getElementById:id=>buttons[id]}
 const init=new Function('window','document',part(renderer,'function initWebAiAuthState()','\nfunction ',renderer.indexOf('function initWebAiAuthState()')+1)+';return initWebAiAuthState;')(window,document)
 const control=init();return {control,buttons,close(){listeners.get('pagehide')?.()},focus(){listeners.get('focus')?.()}}
}
async function fixture(){
 const {EventEmitter}=await import('node:events'),{Adapter,Site,Manager}=actualRuntime(),targets=[]
 const contents=()=>{const c=new EventEmitter();c.dead=false;c.mainFrame={};c.isDestroyed=()=>c.dead;c.send=(channel,value)=>c.emit(channel,{},value);return c}
 const owner={dead:false,webContents:contents(),isDestroyed(){return this.dead}}
 const broadcastBody=part(main,'\t}, (owner, state) => {','\n\t});\n\tlet injections').replace(/^\t}, \(owner, state\) => \{/,'')
 const broadcaster=new Function('sourceMode','sourceController','return (owner,state)=>{'+broadcastBody+'};')(true,{sourceShellWindows:()=>targets})
 const manager=new Manager(()=>'',()=>{},broadcaster),sites={}
 for(const provider of ['deepseek','doubao']){
  const host=provider==='deepseek'?'chat.deepseek.com':'www.doubao.com',doc={url:'https://'+host+'/',documentId:'synthetic-1',alive:true};let lifecycle,probeWait,probeEntered=false,negativeVisible=false,probeFailure=false
  const menu=Object.fromEntries((provider==='deepseek'?['menuVisible','downloadMobileAppVisible','settingsVisible','helpAndFeedbackVisible','logoutVisible','sameContainer','triggerPresent','triggerVisible','hasPopup','linked','shortcutAttributePresent']:['menuVisible','addAccountVisible','logoutVisible','sameMenu','accountMenuLinkedVisible','triggerPresent','triggerVisible','hasPopup','linked','shortcutAttributePresent']).map(k=>[k,true]))
  const adapter=Adapter({provider,readDocumentIdentity:()=>({...doc}),subscribeLifecycle:fn=>{lifecycle=fn;return()=>{}},executeReadOnlyProbe:async script=>{probeEntered=true;if(probeWait)await probeWait.promise;if(probeFailure)throw Error('synthetic unavailable probe');return script.includes('to_login_button')?negativeVisible:menu}})
  const site=new Site(()=>'',{provider,url:doc.url,host},()=>{},broadcaster),win=new EventEmitter();win.dead=false;win.visible=true;win.focused=true;win.webContents=contents();win.webContents.getURL=()=>doc.url;win.isDestroyed=()=>win.dead;win.isVisible=()=>win.visible;win.isFocused=()=>win.focused;win.isMinimized=()=>false;win.hide=()=>{win.visible=false;win.focused=false;win.emit('hide')};site.window=win;site.owner=owner;site.authAdapter=adapter;manager.windows.set(provider,site)
  // Exact Main ownership/document fences, publisher and bounded hidden recheck.
  const scopes=part(main,'\t\tconst owned = () => this.window === window && this.owner === owner','\t\tconst triggerProvider =')
  const publish=part(main,'\t\tconst publish = state => {','\t\tlet triggerModulePromise;')
  const hide=part(main,'\t\tconst recheckHiddenAuth = () => {','\t\twindow.once("closed", () => {\n\t\t\tdeepseekBootstrapActive')
  const install=new Function('window','owner','suppliedAdapter','initialDocumentId',`
   let ownerFrame=owner.webContents.mainFrame,documentId=initialDocumentId;
   ${scopes}
   adapter=suppliedAdapter;
   let deepseekBootstrapActive,deepseekBootstrapPromise,doubaoBootstrapPromise,userCloseHidden=false,shuttingDown=false,hiddenPromotionPending=false,hiddenCloseRecheck=null,hiddenCloseRestore;
   const releaseHiddenRenderLease=()=>{},onBlur=()=>{},onFocus=()=>{},cancelHiddenObserver=()=>{},maybeRunDeepseekBootstrap=async()=>null,maybeRunDoubaoBootstrap=async()=>null;
   ${publish}
   ${hide}
   return {publish,invalidateDocument(next){documentId=next},scopeIsAlive,captureBootstrapScope};
  `).call(site,win,owner,adapter,doc.documentId)
  sites[provider]={site,win,adapter,doc,install,setNegativeVisible(v){negativeVisible=v},setProbeFailure(v){probeFailure=v},lifecycle:()=>lifecycle,waitProbe(){probeEntered=false;let resolve;probeWait={promise:new Promise(r=>resolve=r),resolve};return()=>{probeWait.resolve();probeWait=undefined}},get probeEntered(){return probeEntered}}
 }
 const handlers=new Map(),ipcMain={handle:(name,fn)=>handlers.set(name,fn)}
 const start=main.indexOf('\tconst assertSourceShellAuthOwner ='),end=main.indexOf('\n\tipcMain.handle(DESKTOP_IPC.browserAcquire',start);assert.ok(start>0&&end>start)
 new Function('ipcMain','aiWebWindows','sourceMode','mainWindow','sourceController',main.slice(start,end))(ipcMain,manager,true,owner,{trustedSourceShellWindow(){}})
 function newFrontend({deferAuthDispatch=false,holdPush=false}={}){
  const dispatch=[],pushes=[]
  const target={webContents:contents(),isDestroyed:()=>false};targets.push(target);const held=[]
  if(holdPush)target.webContents.send=(channel,value)=>pushes.push({channel,value})
  const ipcRenderer={on:(n,fn)=>target.webContents.on(n,fn),removeListener:(n,fn)=>target.webContents.removeListener(n,fn),invoke:async(channel,...args)=>{
   if(deferAuthDispatch&&channel==='source-shell:aiWebAuthState')await new Promise(resolve=>dispatch.push(resolve))
   const snapshot=handlers.get(channel)({sender:owner.webContents,senderFrame:owner.webContents.mainFrame},...args)
   if(channel==='source-shell:aiWebAuthState')return await new Promise(resolve=>held.push({provider:args[0],snapshot,resolve}))
   return snapshot
  }};let app
  vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld(_n,v){app=v}},ipcRenderer})})
  const view=frontend(app.aiWeb);return {...view,held,target,pushes,dispatchAuthReads(){for(const fn of dispatch.splice(0))fn()},deliverNextPush(provider){const i=pushes.findIndex(x=>x.value.provider===provider);assert.ok(i>=0);const packet=pushes.splice(i,1)[0];target.webContents.emit(packet.channel,{},packet.value);return packet.value},release(provider){const q=held.find(x=>x.provider===provider&&!x.done);assert.ok(q);q.done=true;q.resolve(q.snapshot);return q.snapshot}}
 }
 return {sites,owner,manager,newFrontend}
}
test('actual Main permits same-generation unknown read then positive push; delayed read cannot overwrite push',async()=>{
 const f=await fixture(),v=f.newFrontend();await tick()
 for(const provider of ['deepseek','doubao']){
  const site=f.sites[provider],initial=v.held.find(x=>x.provider===provider).snapshot
  assert.equal(initial.authState,'unknown');await site.site.sampleAuthState(site.win,site.adapter)
  const positive=site.site.authState;assert.equal(positive.authState,'authenticated');assert.equal(positive.generation,initial.generation,'same generation is produced by actual Main+adapter, not fabricated')
  assert.equal(v.buttons['btn-'+provider].dataset.authState,'authenticated');v.release(provider);await tick();assert.equal(v.buttons['btn-'+provider].dataset.authState,'authenticated','late cached query must not undo newer push')
 }
})
test('actual close-to-hidden recheck samples fresh evidence and cannot retain an authenticated DTO when evidence is unavailable',async()=>{
 const f=await fixture(),s=f.sites.deepseek;await s.site.sampleAuthState(s.win,s.adapter);assert.equal(s.site.authState.authState,'authenticated')
 s.doc.documentId='new-hidden-document';s.install.invalidateDocument(s.doc.documentId);s.lifecycle()('navigation-committed')
 s.doc.url='https://unsupported.invalid/';s.site.hideForAuthRecheck();await s.site.recheckHiddenAuth();assert.equal(s.win.visible,false);assert.equal(s.site.authState.authState,'unknown','real adapter recheck cannot persist old authenticated status')
})
test('new source-window snapshot/event order is fenced and disposed document ignores later packets',async()=>{
 const f=await fixture(),v=f.newFrontend();await tick();await f.sites.deepseek.site.sampleAuthState(f.sites.deepseek.win,f.sites.deepseek.adapter);v.release('deepseek');await tick();assert.equal(v.buttons['btn-deepseek'].dataset.authState,'authenticated')
 const n=f.newFrontend();await tick();await f.sites.deepseek.site.sampleAuthState(f.sites.deepseek.win,f.sites.deepseek.adapter);n.release('deepseek');await tick();assert.equal(n.buttons['btn-deepseek'].dataset.authState,'authenticated')
 const db=f.sites.doubao;await db.site.sampleAuthState(db.win,db.adapter);const newer=f.newFrontend();await tick();const oldPositive=newer.held.find(x=>x.provider==='doubao').snapshot;assert.equal(oldPositive.authState,'authenticated')
 db.setNegativeVisible(true);await db.site.sampleAuthState(db.win,db.adapter);assert.equal(db.site.authState.generation,oldPositive.generation,'actual same-document negative has same generation');assert.equal(newer.buttons['btn-doubao'].dataset.authState,'unauthenticated');newer.release('doubao');await tick();assert.equal(newer.buttons['btn-doubao'].dataset.authState,'unauthenticated','old positive read cannot repaint newer negative')
 db.setNegativeVisible(false);await db.site.sampleAuthState(db.win,db.adapter);assert.equal(newer.buttons['btn-doubao'].dataset.authState,'authenticated');db.setProbeFailure(true);newer.control.opened('doubao');await tick();await tick();assert.equal(newer.buttons['btn-doubao'].dataset.authState,'unknown','fresh post-event query and unavailable evidence must clear green, not sticky positive')

 v.close();f.sites.deepseek.doc.url='https://chat.deepseek.com/sign_in';f.sites.deepseek.lifecycle()('navigation-committed');await f.sites.deepseek.site.sampleAuthState(f.sites.deepseek.win,f.sites.deepseek.adapter);assert.equal(v.buttons['btn-deepseek'].dataset.authState,'authenticated','disposed renderer ignores packets');assert.equal(n.buttons['btn-deepseek'].dataset.authState,'unauthenticated')
})
test('actual hidden scope rejects old document and destroyed owner after awaited probe',async()=>{
 for(const change of ['document','owner']){
  const f=await fixture(),s=f.sites.deepseek;let publishes=0;s.site.onAuthChanged=()=>publishes++;const release=s.waitProbe();s.site.hideForAuthRecheck();while(!s.probeEntered)await tick()
  if(change==='document'){s.doc.documentId='replacement';s.install.invalidateDocument(s.doc.documentId);s.lifecycle()('navigation-committed')}else f.owner.dead=true
  release();await s.site.recheckHiddenAuth();assert.equal(publishes,0,change+' must not publish stale result');assert.notEqual(s.site.authState?.authState,'authenticated')
 }
})

test('higher-generation unknown query remains authoritative after an older queued positive event arrives',async()=>{
 const f=await fixture(),v=f.newFrontend({deferAuthDispatch:true,holdPush:true}),s=f.sites.deepseek
 await s.site.sampleAuthState(s.win,s.adapter)
 const sentPositive=v.pushes.find(x=>x.value.provider==='deepseek').value
 assert.equal(sentPositive.authState,'authenticated')
 s.doc.documentId='actual-new-document';s.install.invalidateDocument(s.doc.documentId);s.lifecycle()('navigation-committed')
 v.dispatchAuthReads();await tick()
 const queried=v.held.find(x=>x.provider==='deepseek').snapshot
 assert.equal(queried.authState,'unknown');assert.ok(queried.generation>sentPositive.generation,'actual lifecycle invalidation and Main projector create higher generation')
 assert.ok(v.pushes.some(x=>x.value.provider==='deepseek'&&x.value.generation===queried.generation),'actual Main also queues its newer unknown event; it is not yet delivered')
 assert.equal(v.deliverNextPush('deepseek'),sentPositive,'event order within provider remains FIFO')
 assert.equal(v.buttons['btn-deepseek'].dataset.authState,'authenticated')
 v.release('deepseek');await tick()
 assert.equal(v.buttons['btn-deepseek'].dataset.authState,'unknown','a delayed old push must not block the already captured newer-document snapshot')
})
