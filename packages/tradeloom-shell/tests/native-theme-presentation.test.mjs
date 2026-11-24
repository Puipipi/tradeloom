import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import vm from 'node:vm'
const source=await readFile(new URL('../client.js',import.meta.url),'utf8')
const start=source.indexOf('    async function installSourceNativeThemeBridge('),end=source.indexOf('    function registerAccountMobileLink(',start)
const snapshot=(preference,colorScheme=preference)=>({preference,colorScheme,palette:{panel:colorScheme==='dark'?'#202022':'#ffffff'}})
function setup(){
 const attrs=()=>{const values=new Map();return{values,style:{setProperty:(k,v)=>values.set(k,v)},setAttribute:(k,v)=>values.set(k,v),removeAttribute:k=>values.delete(k)}}
 const document={documentElement:attrs(),body:attrs()},events={},effects=[],listeners=[];let resolveInitial,resolveDescribe,writes=0
 const initial=new Promise(r=>resolveInitial=r),pending=[]
 const owner={kind:'role',generation:1,roleId:'r',sessionId:'s',bindingRevision:'1'}
 const ctx={on:(_n,fn)=>{listeners.push(fn);return()=>listeners.splice(listeners.indexOf(fn),1)},effect:fn=>effects.push(fn()),remote:{settings:{describe:()=>new Promise(r=>pending.push(r))}},configForms:{describe:()=>({acceptView:()=>writes++})}}
 const bridge={nativeSurfaceDescriptor:async()=>owner,onNativeSurfaceChanged:fn=>{events.owner=fn;return()=>{}},sourceTheme:{getSnapshot:()=>initial,onChanged:fn=>{events.theme=fn;return()=>{}}}}
 const run=vm.runInNewContext(`(ctx,bridge,initial)=>{const reportRoleGuestPhase=()=>{};${source.slice(start,end)};return installSourceNativeThemeBridge(ctx,bridge,initial)}`,{document})
 return{document,events,effects,listeners,pending,resolveInitial,done:run(ctx,bridge,owner),writes:()=>writes}
}
test('native presentation applies immediately and retains newest scheme over stale startup and runtime events',async()=>{
 const r=setup();r.events.theme(snapshot('dark'))
 assert.equal(r.document.body.values.has('data-ds-dark-theme'),true)
 assert.equal(r.document.documentElement.values.get('--tl-native-panel'),'#202022')
 r.resolveInitial(snapshot('light'));await r.done
 assert.equal(r.document.body.values.has('data-ds-dark-theme'),true,'late startup snapshot cannot restore light')
 for(const mode of ['light','dark','light','dark'])r.events.theme(snapshot(mode))
 for(const fn of r.listeners)fn({active:{colorScheme:'light'}})
 assert.equal(r.document.body.values.has('data-ds-dark-theme'),true,'older Host presenter event cannot overwrite latest presentation')
 r.events.theme(snapshot('system','light'));assert.equal(r.document.body.values.has('data-ds-dark-theme'),false)
 assert.equal(r.document.documentElement.values.get('data-ds-theme-source'),'system')
 r.events.theme(snapshot('system','dark'));assert.equal(r.document.body.values.has('data-ds-dark-theme'),true)
 for(const dispose of r.effects)dispose()
 r.events.theme(snapshot('light'));assert.equal(r.document.body.values.has('data-ds-dark-theme'),true,'disposed adapter cannot change presentation')
 assert.equal(r.writes(),0)
})

const controller=await readFile(new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/lib/tradeloom-source-shell/source-shell-controller.mjs',import.meta.url),'utf8')
test('Main previews validated dispatched preference before persistence and restores durable theme after refusal',()=>{
 const a=controller.indexOf('  const finishThemeRequest ='),b=controller.indexOf('  const paletteKeys =',a)
 const c=controller.indexOf('  const canonicalThemeSnapshot ='),d=controller.indexOf('  const publishCanonicalTheme =',c)
 const build=vm.runInNewContext(`()=>{
  let pendingSourceThemePreference,themeRequest,sourceThemeMaterials={preference:'light',palettes:{light:{panel:'#ffffff'},dark:{panel:'#202022'}},ui:{}};
  const broadcasts=[],sent=[],account={generation:1,view:{webContents:{isDestroyed:()=>false,mainFrame:{}}}};
  const sourceThemePublisher={item:account,generation:1,frame:account.view.webContents.mainFrame};
  const controller={resolveGuest:()=>({scope:'account'})},descriptor=()=>({businessNavigation:'shell'}),assertThemeWindow=()=>{},ui18Diagnostic=()=>{},ui18AccountFields=()=>({});
  const resolveNativeTheme=p=>p==='system'?'dark':p,safeThemeSnapshot=v=>v;
  ${controller.slice(a,b)}
  ${controller.slice(c,d)}
  const publishCanonicalTheme=()=>{const value=canonicalThemeSnapshot();broadcasts.push(value);return value};
  return{broadcasts,sent,dispatch(preference){themeRequest={preference,id:1,event:{sender:{removeListener(){}}},resolve:ok=>sent.push(ok)};account.view.webContents.send=(...args)=>sent.push(args);return dispatchThemeRequest()},finish:finishThemeRequest,save(preference){sourceThemeMaterials={...sourceThemeMaterials,preference}},disable(){sourceThemePublisher.generation++}}
 }`,{clearTimeout:()=>{}})
 const r=build();assert.equal(r.dispatch('dark'),true);assert.equal(r.broadcasts.at(-1).colorScheme,'dark');r.finish(false);assert.equal(r.broadcasts.at(-1).colorScheme,'light');assert.equal(r.sent.at(-1),false)
 assert.equal(r.dispatch('system'),true);assert.equal(r.broadcasts.at(-1).colorScheme,'dark');r.save('system');const beforeSuccess=r.broadcasts.length;r.finish(true);assert.equal(r.broadcasts.length,beforeSuccess,'success must not rebroadcast the already presented durable preference');assert.equal(r.broadcasts.at(-1).preference,'system');assert.equal(r.sent.at(-1),true)
 const old=r.broadcasts.length;r.disable();assert.equal(r.dispatch('light'),false);assert.equal(r.broadcasts.length,old,'unvalidated owner cannot preview');r.finish(false);assert.equal(r.broadcasts.length,old,'undispatched request has no preview to undo')
})
