import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
const R=new URL('../',import.meta.url),desktop=process.env.TL_NATIVE_CAPTION_DESKTOP_ROOT
const read=name=>readFile(new URL(name,R),'utf8')
function skillController(source){const start=source.indexOf('    function createBoundSkillCatalogue('),end=source.indexOf('    async function register(',start);assert.ok(start>=0&&end>start,'actual SourceNative needs a checked bound-session skill catalogue caller');const a=source.indexOf('    const valid ='),b=source.indexOf('    const reportRoleGuestPhase',a);return new Function(source.slice(a,b)+source.slice(start,end)+';return createBoundSkillCatalogue;')()}
const owner={kind:'role',surface:'chat',sceneId:'scene',panelId:'panel',roleId:'center',sessionId:'session-one',bindingRevision:'4',generation:1}

// Actual controller method and IPC registration; only Electron ownership objects
// and binding transport/await timing are controlled, not the fence predicates.
async function sourceRoleIdentity() {
 const source=await readFile(path.join(desktop,'lib/tradeloom-source-shell/source-shell-controller.mjs'),'utf8')
 const takeLine=prefix=>{const line=source.split('\n').find(x=>x.startsWith(prefix));assert.ok(line,prefix);return line}
 const a=source.indexOf('  const captureRoleBinding ='),b=source.indexOf('  const changedRoleViews',a);assert.ok(a>=0&&b>a)
 const m=source.indexOf('    async nativeUtility('),n=source.indexOf('    trustedSourceShellWindow(',m);assert.ok(m>0&&n>m)
 const aw=source.indexOf('  const assertWindow ='),awEnd=source.indexOf('\n  const ',aw+3);assert.ok(aw>=0&&awEnd>aw)
 const primary={webContents:{mainFrame:{url:'controlled-source-shell'}},isDestroyed:()=>false},contents={mainFrame:{url:'dsh-app://app/synthetic'},isDestroyed:()=>false,messages:[],send(channel,...args){this.messages.push({channel,args})}}
 let binding={...owner,bindingStatus:'bound'},pending
 const resolveBinding=async()=>pending?await new Promise(resolve=>{pending=resolve}):({...binding})
 const build=new Function('primary','contents','resolveBinding',`
  let closed=false,configurationEpoch=0,sceneComponent,erpNextStatusComponent,accountSidebar,account;
  const item={...${JSON.stringify(owner)},parent:primary,status:'context-mounted',view:{webContents:contents},wrapper:{}};
  const key=(s,p)=>JSON.stringify([s,p]),views=new Map([[key(item.sceneId,item.panelId),item]]);
  const scene=id=>({id,roleId:item.roleId,panels:[{id:item.panelId,type:'native-chat',roleId:item.roleId}]});
  const SOURCE_URL='controlled-source-shell',ACCOUNT_URL='controlled-account',windows=new Map([['main',primary]]),rolePopouts=new Map();let accountPopout;
  ${source.slice(aw,awEnd)}
  ${takeLine('  const owner =')}
  const registry={get:()=>({window:{window:primary}}),authorizeGuest:(wrapper,frame)=>wrapper===item.wrapper&&frame===contents.mainFrame};
  ${source.slice(a,b)}
  ${takeLine('  const exactKeys =')}
  ${takeLine('  const descriptor =')}
  const controller={${source.slice(m,n)}${takeLine('    resolveGuest(')}};
  const handlers=new Map(),bind=(name,callback)=>handlers.set('source-shell:'+name,callback);
  (function(){${takeLine("      bind('nativeUtility',")}}).call(controller);
  return {controller,handlers,item,descriptor:()=>descriptor(item),bumpEpoch:()=>configurationEpoch++};
 `)
 const f=build(primary,contents,resolveBinding)
 return {...f,primary,sceneId:owner.sceneId,panelId:owner.panelId,view:()=>f.item.view,
  deferBinding(){pending=true},finishBinding(next={}){binding={...binding,...next};const resolve=pending;pending=undefined;resolve({...binding})},
  hasPendingBinding:()=>typeof pending==='function'}
}

test('actual native skills controller uses only the retained bound session and cancels stale/closed results',async()=>{
 const create=skillController(await read('client.source-native.js'));let current={...owner},intent,changed,reply,using=0,released=0;const states=[],calls=[]
 const ctx={sessions:{binding:id=>id===owner.sessionId?{}:undefined,async using(id,options,action){assert.equal(id,owner.sessionId);using++;try{return await action({binding:{session:{getSnapshot:()=>({openState:'open'})}}})}finally{released++}}},remote:{skills:{list:async(arg,signal)=>{calls.push({arg,signal});return new Promise(resolve=>reply=resolve)}}}}
 const bridge={nativeSurfaceDescriptor:async()=>({...current}),onNativeUtilityRequested:fn=>{intent=fn;return()=>{intent=undefined}},onNativeSurfaceChanged:fn=>{changed=fn;return()=>{changed=undefined}}}
 const view=create(ctx,bridge,owner,x=>states.push(x)),tick=()=>new Promise(r=>setImmediate(r))
 await intent({action:'session-skills',descriptor:{...owner,sessionId:'wrong'}});assert.equal(calls.length,0)
 const first=intent({action:'session-skills',descriptor:owner});while(!reply)await tick();assert.deepEqual(calls[0].arg,{sessionId:owner.sessionId})
 reply({ok:true,value:{skills:[{name:'bound-only',description:'synthetic skill',userInvocable:true}]}});await first;assert.equal(states.at(-1).skills[0].name,'bound-only');assert.equal(using,released)
 reply=undefined;const late=intent({action:'session-skills',descriptor:owner});while(!reply)await tick();current={...owner,bindingRevision:'5'};changed(current);assert.equal(calls.at(-1).signal.aborted,true);reply({ok:true,value:{skills:[{name:'must-not-land'}]}});await late;assert.equal(states.at(-1),undefined)
 current={...owner};reply=undefined;const closing=intent({action:'session-skills',descriptor:owner});while(!reply)await tick();view.dispose();reply({ok:true,value:{skills:[{name:'must-not-land'}]}});await closing;assert.equal(intent,undefined);assert.equal(changed,undefined);assert.equal(using,released)
})

test('actual title skills producer delivers through current source-preload and ownerchecked Main, not global agent-data',async t=>{
 const source=await readFile(path.join(desktop,'renderer/source-shell/replica-ui/business-bridge.js'),'utf8')
 const helperStart=source.indexOf('  function insertRoleControl('),helperEnd=source.indexOf('  function renderRolePanel(',helperStart);assert.ok(helperStart>0&&helperEnd>helperStart,'actual renderRolePanel needs the title skill control and its placement helper')
 const f=await sourceRoleIdentity(t),expected=await f.descriptor();assert.equal(expected.sessionId,owner.sessionId)
 const menuStart=source.indexOf('  function panelMenuCapabilities('),menuEnd=source.indexOf('  async function requestPanelPlacement(',menuStart)
 const state={sceneId:'ui',sceneRevision:1,roleRecord:undefined}
 const fullscreen={className:'pi-fullscreen'}
 const titleControls={
  children:[fullscreen],
  querySelector(selector){assert.equal(selector,':scope > .pi-fullscreen');return fullscreen},
  insertBefore(item,anchor){assert.equal(anchor,fullscreen);this.children.splice(this.children.indexOf(anchor),0,item)},
 }
 const panel={isConnected:true,querySelector(selector){assert.equal(selector,':scope > .panel-header > .panel-controls');return titleControls}}
 const record={panel,content:{isConnected:true},created:true,target:{sceneId:f.sceneId,panelId:f.panelId},status:'context-mounted',revision:1,uiSceneId:'ui',placement:'docked'};state.roleRecord=record
 const preload=await readFile(path.join(desktop,'lib/tradeloom-source-shell/source-preload.cjs'),'utf8');let app
 vm.runInNewContext(preload,{require:()=>({contextBridge:{exposeInMainWorld(_n,value){app=value}},ipcRenderer:{invoke:(name,...args)=>f.handlers.get(name)({sender:f.primary.webContents,senderFrame:f.primary.webContents.mainFrame},...args)}})})
 const nodes=[];const make=()=>({children:[],attrs:{},append(...xs){this.children.push(...xs)},setAttribute(k,v){this.attrs[k]=v},addEventListener(k,fn){this[k]=fn},remove(){this.removed=true}});const document={createElement:()=>{const n=make();nodes.push(n);return n},createElementNS:()=>make()}
 const install=new Function('state','app','document',`const isCurrentRole=r=>r===state.roleRecord&&r.revision===state.sceneRevision&&r.uiSceneId===state.sceneId&&!r.disposed;${source.slice(menuStart,menuEnd)}${source.slice(helperStart,helperEnd)};return installRoleSkillsControl;`)(state,app,document)
 const button=install(record);assert.deepEqual(titleControls.children,[button,fullscreen],'actual producer inserts the skills button before the existing fullscreen control');assert.equal(button.disabled,false);assert.equal(button.attrs['aria-label'],'当前助手技能');assert.equal(button.children[0].attrs.viewBox,'0 0 24 24')
 await button.click({preventDefault(){},stopPropagation(){}})
 const sent=f.view().webContents.messages.filter(x=>x.channel==='dsh-desktop:native-utility-request').at(-1);assert.equal(sent.args[0].action,'session-skills');assert.deepEqual(sent.args[0].descriptor,expected)
 record.disposed=true;const count=f.view().webContents.messages.length;await button.click({preventDefault(){},stopPropagation(){}});assert.equal(f.view().webContents.messages.length,count)
 const body=source.slice(helperEnd,source.indexOf('  function onWorkflowStatus(',helperEnd));assert.ok(body.includes('installRoleSkillsControl(record)'),'actual render caller installs this control');assert.ok(body.includes('skillsButton?.remove()'))
 const html=await readFile(path.join(desktop,'renderer/source-shell/replica-ui/index.html'),'utf8');assert.doesNotMatch(html,/id="btn-skills"/)
})


test('actual native skills Main IPC rejects wrong frame and binding or epoch changes during await',async()=>{
 const f=await sourceRoleIdentity(),request={sceneId:f.sceneId,panelId:f.panelId,action:'session-skills'}
 const call=event=>f.handlers.get('source-shell:nativeUtility')(event,request)
 const event=()=>({sender:f.primary.webContents,senderFrame:f.primary.webContents.mainFrame})
 await assert.rejects(call({...event(),senderFrame:{}}),/source shell: rejected sender/)
 assert.equal(f.view().webContents.messages.length,0)
 f.deferBinding();const late=call(event());while(!f.hasPendingBinding())await new Promise(r=>setImmediate(r));f.finishBinding({bindingRevision:'5'})
 await assert.rejects(late,/stale native utility target/);assert.equal(f.view().webContents.messages.length,0)
 const g=await sourceRoleIdentity();g.deferBinding();const epoch=g.handlers.get('source-shell:nativeUtility')({sender:g.primary.webContents,senderFrame:g.primary.webContents.mainFrame},{...request});while(!g.hasPendingBinding())await new Promise(r=>setImmediate(r));g.bumpEpoch();g.finishBinding()
 await assert.rejects(epoch,/stale native utility target/);assert.equal(g.view().webContents.messages.length,0)
})

test('owned fine-pointer cost entry restores original native constraints without altering plugin logic or account CSS',async()=>{
 const plugin=await readFile(process.env.TL_COST_PLUGIN_CLIENT,'utf8');let spec,css
 const document={querySelector:()=>null,createElement:()=>({dataset:{}}),head:{appendChild:node=>{css=node.textContent}}}
 vm.runInNewContext(plugin,{window:{__ModuleLoader__:{load:value=>spec=value}},document,console});spec.factory(name=>name==='react'?{}:{Tooltip(){}})
 assert.match(css,/@media\(max-width:1023px\)[\s\S]*\.cm-btn,\.cm-tab,\.cm-foot,\.cm-corner-chip\{min-height:36px;height:auto\}/)
 const native=await read('client.source-native.js'),a=native.indexOf('    const nativeChatStyles = `'),b=native.indexOf('    const whaleAutoBases',a);let own
 const doc={createElement:()=>({dataset:{},remove(){}}),head:{append:node=>{own=node.textContent}}};vm.runInNewContext(native.slice(a,b)+';installNativeChatStyles()',{document:doc})
 assert.match(own,/@media\s*\(pointer:fine\)\s*\{\s*\[data-source-native-root\]\s+\.cm-btn\.cm-stat-entry\s*\{\s*min-height:initial;\s*\}/)
 assert.doesNotMatch(own,/\.cm-btn\.cm-stat-entry[^}]*\b(?:height:30px|font-size:|padding:)/)
 assert.ok(css.includes('.cm-btn.cm-stat-entry{font-size:12px;line-height:20px;padding:0 6px;'))
})
