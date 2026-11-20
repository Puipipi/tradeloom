import test from 'node:test'
import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import vm from 'node:vm'
import path from 'node:path'
const sdk=process.env.TL_SEVEN_SDK_RUNTIME
assert.ok(sdk,'explicit actual rc2 SDK required')
const requireSDK=createRequire(path.join(sdk,'package.json'))
const {Context}=requireSDK('@deepseek-ai/cordis')
// Controlled hook scheduler only: no React mount/DOM or preservation claim.
let probes=[]
const React=new Proxy({Component:class {},createElement:(type,props,...children)=>({type,props,children}),Fragment:'fragment',useState:v=>[v,()=>{}],useRef:v=>({current:v}),useEffect(){},useCallback:f=>f,useSyncExternalStore(sub,get){probes.push({sub,get});return get()}},{get:(o,k)=>k in o?o[k]:(()=>({}))})
function load(text,require){let spec;vm.runInNewContext(text,{window:{__ModuleLoader__:{load:s=>spec=s}},console,AbortController,queueMicrotask,Promise});return spec.factory(require)}
const nativeText=await readFile(new URL('../client.source-native.js',import.meta.url),'utf8')
const rendererText=await readFile(path.join(sdk,'node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js'),'utf8')
const raw=await readFile(process.env.TL_SEVEN_SLOT_CORE_ENTRY,'utf8')
const {SlotCore}=vm.runInNewContext(raw,{console,queueMicrotask})
const renderer=load(rendererText,n=>n==='@deepseek-ai/dsh-client-ui-slots'?{SlotCore}:n==='react'?React:n.startsWith('react')?{}:requireSDK(n))
const descriptor={kind:'role',sceneId:'scene',panelId:'files',roleId:'center',sessionId:'session',bindingRevision:'1',surface:'files',generation:1}

test('SourceNative factory availability uses the actual rc2 public host face through late registration and withdrawal',async()=>{
 const ctx=new Context(),slots=new renderer.SlotRegistry(ctx)
 const stopRoot=slots.register({name:'root',children:{main:{kind:'keyed',scope:'root'}}},()=>null)
 probes=[]
 const host=slots.hostFace(), observedAvailability=[]
 const actualFactoryOf=host.factoryOf
 host.factoryOf=name=>{const definition=actualFactoryOf(name);observedAvailability.push(definition);return definition}
 const req=n=>n==='react'?React:{};req.async=async()=>({register:async()=>()=>{}})
 const native=load(nativeText,req)
 ctx.layout={selectPanel(){}}
 await native.register(ctx,descriptor,{nativeSurfaceMounted(){},onNativeSurfaceChanged:()=>()=>{}})
 await new Promise(resolve=>setImmediate(resolve))
 const entry=slots.entriesOfSlot('main').find(e=>e.options.key==='source-native')
 assert.ok(entry,'actual production SourceNative registered')
 const render=()=>entry.component({SessionProvider:({children})=>children,renderFactorySlot:()=>null})
 try {
  assert.doesNotThrow(render,'production SourceNative must support the real rc2 Slots public interface')
  assert.equal(observedAvailability.at(-1),undefined,'production lookup sees absent factory')
  const probe=probes[0];assert.ok(probe)
  const initial=probe.get();let notifications=0;const off=probe.sub(()=>notifications++)
  const remove=slots.registerFactory({name:'sidebar.surface',scope:'session'},()=>null)
  await new Promise(resolve=>setImmediate(resolve));assert.ok(probe.get()>initial);assert.equal(notifications,1)
  assert.doesNotThrow(render,'late factory must remain renderable')
  assert.equal(observedAvailability.at(-1),actualFactoryOf('sidebar.surface'),'production lookup sees actual late factory')
  const registered=probe.get();remove();await new Promise(resolve=>setImmediate(resolve));assert.ok(probe.get()>registered);assert.equal(notifications,2)
  render();assert.equal(observedAvailability.at(-1),undefined,'production lookup sees withdrawal')
  off();slots.registerFactory({name:'sidebar.surface',scope:'session'},()=>null);await new Promise(resolve=>setImmediate(resolve));assert.equal(notifications,2,'subscription cleanup')
 } finally {stopRoot();await ctx.fiber.dispose()}
})
