import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'
import test from 'node:test'
const require=createRequire(import.meta.url)

test('usage real ReactDOM preserves native zero/unknown projections, groups, async updates and every dismissal',async t=>{
 const {TRADELOOM_REACT_LIBRARY:reactPath,TRADELOOM_REACT_SERVER_LIBRARY:serverPath,TRADELOOM_DOM_MODULE:domPath}=process.env
 if(!reactPath||!serverPath||!domPath)return t.skip('requires pinned React and JSDOM paths')
 const React=require(reactPath),{createRoot}=createRequire(serverPath)('react-dom/client'),{JSDOM}=require(domPath)
  const dom=new JSDOM('<div id="root"></div><button id="outside">外部</button>',{url:'http://fixture.local',pretendToBeVisual:true})
 dom.window.HTMLElement.prototype.showPopover=function(){this.setAttribute('data-test-top-layer-open','')}
 dom.window.HTMLElement.prototype.hidePopover=function(){this.removeAttribute('data-test-top-layer-open')}
 const previous={window:globalThis.window,document:globalThis.document,act:globalThis.IS_REACT_ACT_ENVIRONMENT}
 Object.assign(globalThis,{window:dom.window,document:dom.window.document,IS_REACT_ACT_ENVIRONMENT:true})
 let root
 try{
  let registration,Top,capture=false,catalog={phase:'ready',ids:[],byId:{}},pressure={pressureTokens:0,contextWindow:128000}
  const catalogListeners=new Set(),pressureListeners=new Set(),calls={retain:0,create:0,search:0,refresh:0}
  const bridge={...React,useState:initial=>capture?[typeof initial==='function'?initial():initial,()=>{}]:React.useState(initial),useEffect:(...args)=>capture?undefined:React.useEffect(...args)}
  dom.window.__ModuleLoader__={load:r=>{registration=r}}
  runInNewContext(await readFile(new URL('../client.js',import.meta.url),'utf8'),{window:dom.window,document:dom.window.document,URL,URLSearchParams})
  const state={config:{roles:[{id:'center',assistantLabel:'中心助手'},{id:'product',assistantLabel:'商品助手'}]},sessionBindings:{center:'live',product:'not-in-directory'}}
  const scene={register(){},SceneTabs:()=>null,getSnapshot:()=>state,subscribe:()=>()=>{}}
  const clientRequire=Object.assign(name=>name==='react'?bridge:{createPortal:child=>child},{async:async()=>scene})
  const plugin=registration.factory(clientRequire)
  await plugin.apply({slots:{inject:(_n,fn)=>fn(),register:(spec,component)=>{if(spec.name==='shell.top')Top=component;return()=>{}}},layout:{},uiWorkspace:{},sessions:{
   list:{getSnapshot:()=>catalog,subscribe:fn=>{catalogListeners.add(fn);return()=>catalogListeners.delete(fn)}},
   scope:id=>id==='live'?{id}:undefined,sessionOf:()=>({projections:{faceOf:key=>{assert.equal(key,'contextPressure');return {getSnapshot:()=>pressure,subscribe:fn=>{pressureListeners.add(fn);return()=>pressureListeners.delete(fn)}}}}}),
   ...Object.fromEntries(Object.keys(calls).map(key=>[key,()=>{calls[key]++;throw new Error('usage must not '+key)}]))
  }})
  capture=true;const top=Top({usePanelInfo:()=>({})});capture=false
  const Tools=top.props.children[1].props.children.at(-1).type
  root=createRoot(dom.window.document.querySelector('#root'));await React.act(async()=>root.render(React.createElement(Tools)))
  const button=label=>[...dom.window.document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')===label||n.textContent===label)
  const click=node=>React.act(async()=>node.dispatchEvent(new dom.window.MouseEvent('click',{bubbles:true})))
  const panel=()=>dom.window.document.querySelector('.tl-session-usage-panel')
  const usageTrigger=button('显示会话用量')
  usageTrigger.getBoundingClientRect=()=>({left:310,top:50,right:350,bottom:84,width:40,height:34})
  const open=async()=>{await click(button('显示会话用量'))}
  const publish=async value=>React.act(async()=>{catalog=value;for(const fn of catalogListeners)fn()})
  await open();assert.match(panel().textContent,/暂无记录/);assert.match(panel().textContent,/1 个角色绑定|2 个角色绑定/)
  assert.equal(panel().getAttribute('popover'),'manual','usage uses the native top-layer popover mechanism')
  assert.equal(panel().hasAttribute('data-tl-topbar-popover-open'),true,'the modal stack sees the anchored usage popover')
  assert.equal(dom.window.document.querySelector('.tl-workspace-modal-backdrop'),null,'usage remains a nonmodal anchored popover')
  assert.match(panel().style.maxHeight,/520px/,'the positioning effect preserves the authored 520px scaled height cap')
  assert.equal(panel().style.getPropertyValue('--tl-viewport-max-height'),`${dom.window.innerHeight-usageTrigger.getBoundingClientRect().bottom-12}px`,'the viewport ceiling uses only space below the trigger and bottom gutter')
  assert.equal(button('打开工具菜单').getAttribute('aria-expanded'),'false','usage opens independently of the ellipsis menu')
  assert.equal(panel().style.top,'88px','usage panel is positioned from its dedicated topbar trigger')
  const byId={live:{title:'真实零'},unknown:{title:'没有投影'},over:{title:'超出窗口',origin:'subagent',parentId:'live',projectionValues:{contextPressure:{projectedTokens:539000,contextWindow:100000}}},partial:{title:'容量已知，用量未知',projectionValues:{contextPressure:{contextWindow:1000}}},zeroCapacity:{title:'真实零容量',projectionValues:{contextPressure:{projectedTokens:0,contextWindow:0}}}}
  await publish({phase:'ready',ids:Object.keys(byId),byId})
  const row=id=>panel().querySelector(`[data-session-id="${id}"]`)
  assert.equal(panel().querySelectorAll('[data-session-id]').length,5)
  assert.match(panel().textContent,/场景会话.*助手会话.*其他会话/s);assert.match(panel().textContent,/1 个角色绑定尚未由目录确认/)
  assert.equal(row('live').querySelector('[data-usage-value="used"]').textContent,'0');assert.equal(row('live').querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),'0')
  assert.equal(row('unknown').querySelector('[data-usage-value="used"]').textContent,'未知');assert.equal(row('unknown').querySelector('[data-usage-value="capacity"]').textContent,'未知');assert.equal(row('unknown').querySelector('[role="progressbar"]'),null);assert.equal(row('unknown').dataset.usageTone,'muted')
  assert.equal(row('partial').querySelector('[data-usage-value="used"]').textContent,'未知');assert.equal(row('partial').querySelector('[data-usage-value="capacity"]').textContent,'1,000');assert.equal(row('partial').querySelector('[role="progressbar"]'),null)
  assert.equal(row('zeroCapacity').querySelector('[data-usage-value="capacity"]').textContent,'0');assert.equal(row('zeroCapacity').querySelector('[role="progressbar"]'),null)
  assert.match(row('over').textContent,/539%/);assert.equal(row('over').dataset.usageTone,'danger');assert(row('over').querySelector('.tl-session-usage-warning'));assert.equal(row('over').querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),'100');assert.match(row('over').querySelector('[role="progressbar"]').getAttribute('aria-valuetext'),/539%/)
  assert.match(panel().querySelector('.tl-session-usage-footer summary').textContent,/轮数.*压缩.*成本：未知/)
  assert.equal(panel().querySelector('.tl-session-usage-footer').open,false);await click(panel().querySelector('.tl-session-usage-footer summary'));assert.equal(panel().querySelector('.tl-session-usage-footer').open,true)
  await React.act(async()=>{pressure={projectedTokens:64000,contextWindow:128000};for(const fn of pressureListeners)fn()});assert.match(row('live').textContent,/50%/);assert.equal(row('live').querySelector('[role="progressbar"]').getAttribute('aria-valuenow'),'50')
  await publish({phase:'pending',ids:[],byId:{}});assert.match(panel().textContent,/正在读取/);assert.doesNotMatch(panel().textContent,/目录中暂无记录/)
  await publish({phase:'unavailable',ids:[],byId:{}});assert.match(panel().textContent,/目录不可用/)
  await publish({phase:'ready',ids:Array.from({length:18},(_,i)=>'grown-'+i),byId:Object.fromEntries(Array.from({length:18},(_,i)=>['grown-'+i,{title:'异步目录 '+i}]))});assert.equal(panel().querySelectorAll('[data-session-id]').length,18)
  await click(button('关闭会话用量'));assert.equal(panel(),null);assert.equal(dom.window.document.activeElement,button('显示会话用量'));assert.equal(catalogListeners.size,0);assert.equal(pressureListeners.size,0)
  await open();await React.act(async()=>dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true})));assert.equal(panel(),null);assert.equal(dom.window.document.activeElement,button('显示会话用量'))
  await open();dom.window.document.querySelector('#outside').focus();await click(dom.window.document.querySelector('#outside'));assert.equal(panel(),null);assert.equal(dom.window.document.activeElement,dom.window.document.querySelector('#outside'),'outside dismissal does not steal focus from the clicked control')
  await open();await click(button('打开工具菜单'));assert.equal(panel(),null)
  assert.deepEqual(calls,{retain:0,create:0,search:0,refresh:0});assert.equal(state.sessionBindings.product,'not-in-directory')
 }finally{
  if(root)await React.act(async()=>root.unmount());dom.window.close()
  for(const [key,value]of Object.entries({window:previous.window,document:previous.document,IS_REACT_ACT_ENVIRONMENT:previous.act})){if(value===undefined)delete globalThis[key];else globalThis[key]=value}
 }
})
