import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { workflowCatalog } from '../workflow-schema.js'
const root=path.resolve(import.meta.dirname,'../../../../../..')
const output=process.env.S5_08_OUTPUT || path.join(root,'stage5-build-artifacts-20261113/s5-07-auth-order01-author/higher-generation-readback')
const ui=path.join(output,'renderer/source-shell/replica-ui')
const fallback=path.join(root,'workspace/source-worktrees/stage5-seven-on-048/apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui')
const sourceBridge = new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/business-bridge.js', import.meta.url)
function read(name) {
 const current = path.join(ui,name)
 const overrides = {
  'business-bridge.js': process.env.S5_08_WORKFLOW_BRIDGE || sourceBridge,
  'renderer.js': process.env.S5_08_RENDERER,
  'scenes-data.js': new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/scenes-data.js', import.meta.url),
 }
 return fs.readFileSync(overrides[name] || (fs.existsSync(current) ? current : path.join(fallback,name)), 'utf8')
}
const sceneContext={window:{}};vm.runInNewContext(read('scenes-data.js'),sceneContext)
const scene=sceneContext.window.__SCENES__.scenes.find(s=>s.id==='agent-center')
test('workflow keeps an independently registered plan closed by default without changing canvas identity',()=>{
 assert.ok(scene.panels.some(p=>p.id==='workflow-plan'&&p.type==='doc'&&p.closedByDefault===true))
 const canvas=scene.panels.find(p=>p.id==='workflow-main');assert.equal(canvas.type,'canvas');assert.equal(canvas.tabs,undefined)
 const cells=new Set();for(const p of scene.panels)for(let y=p.row;y<p.row+p.h;y++)for(let x=p.col;x<p.col+p.w;x++){const key=x+','+y;assert.ok(!cells.has(key));cells.add(key)}
})
function loadWorkflow({addSecondCanvas=false, activeRun}={}){
 let exported; const state=[],effects=[],refs=[];let index=0,refIndex=0
 const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(Boolean)}),useState:v=>{const i=index++;if(!Object.hasOwn(state,i))state[i]=typeof v==='function'?v():v;return[state[i],n=>{state[i]=typeof n==='function'?n(state[i]):n}]},useRef:v=>{const i=refIndex++;return refs[i]??=( {current:v})},useEffect:f=>effects.push(f),useMemo:f=>f(),useCallback:f=>f,useId:()=>':test:',Fragment:'fragment'}
 const context={window:{crypto:globalThis.crypto,__ModuleLoader__:{load:m=>{exported=m.factory(()=>React)}}},console,AbortController,clearTimeout,setTimeout,crypto:globalThis.crypto,fetch:(...args)=>context.onFetch(...args)}
 vm.runInNewContext(fs.readFileSync(new URL('../client.workflow.js',import.meta.url),'utf8'),context)
 const doc={version:1,id:'wf-test',title:'Test',confirmed:true,source:'manual',nodes:[{id:'a',kind:'agent',agent:'product',title:'A',instruction:'',position:{x:0,y:0}}],edges:[]}
 const second={...doc,id:'wf-second',title:'Second',confirmed:false}
 const list=addSecondCanvas ? [doc,second] : [doc]
 const catalog=workflowCatalog()
 const render=()=>{index=0;refIndex=0;effects.length=0;return exported.WorkflowCanvas({initial:{doc,list,catalog,editing:false,run:activeRun}})}
 const tree=render()
 return{tree,state,effects,doc,second,list,catalog,context,render}
}
function all(node){return node&&typeof node==='object'?[node,...(node.children||[]).flatMap(all)]:[]}
function label(node){return typeof node==='string'?node:(node?.children||[]).map(label).join('')}
test('opening node counts repositions the existing view menu, and a category item adds a node', {
  skip: !process.env.TRADELOOM_DOM_MODULE || !process.env.TRADELOOM_REACT_LIBRARY,
}, async () => {
  const { JSDOM } = await import(pathToFileURL(process.env.TRADELOOM_DOM_MODULE).href)
  const require = createRequire(process.env.TRADELOOM_REACT_LIBRARY)
  const React = require('react')
  const { createRoot } = require('react-dom/client')
  const act = React.act ?? require('react-dom/test-utils').act
  const { window } = new JSDOM('<main></main>', { pretendToBeVisual: true })
  const globals = { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true }
  const previous = Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)])
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, value })
  let root
  try {
    let Canvas
    window.__ModuleLoader__ = { load(module) { Canvas = module.factory(() => React).WorkflowCanvas } }
    vm.runInNewContext(fs.readFileSync(new URL('../client.workflow.js', import.meta.url), 'utf8'), {
      window, document: window.document, MutationObserver: window.MutationObserver,
      getComputedStyle: window.getComputedStyle, setInterval, clearInterval, setTimeout, clearTimeout,
    })
    const doc = { version: 1, id: 'fixture', title: '合成工作流', confirmed: true, source: 'manual',
      nodes: [{ id: 'in', kind: 'input', title: '输入', position: { x: 0, y: 0 } }], edges: [] }
    root = createRoot(window.document.querySelector('main'))
    await act(async () => root.render(React.createElement(Canvas, { initial: { doc, catalog: workflowCatalog(), editing: false } })))
    const find = selector => window.document.querySelector(selector)
    const viewMenu = find('.tl-wf-view-menu')
    const actions = find('.tl-wf-view-actions')
    const status = find('.tl-wf-status-menu')
    const counts = find('.tl-wf-status-list')
    find('.tl-wf').getBoundingClientRect = () => ({ left: 0, right: 400, top: 0, bottom: 280, width: 400, height: 280 })
    viewMenu.getBoundingClientRect = () => ({ left: 285, top: 150 })
    viewMenu.querySelector('summary').getBoundingClientRect = () => ({ left: 285, top: 150, bottom: 175 })
    actions.getBoundingClientRect = () => ({ width: 130 })
    Object.defineProperty(actions, 'scrollHeight', { get: () => status.open ? 224 : 82 })
    const click = element => act(async () => { element.click(); await new Promise(resolve => setTimeout(resolve, 20)) })
    await click(viewMenu.querySelector('summary'))
    assert.equal(viewMenu.open, true)
    assert.equal(actions.style.maxHeight, '82px')
    await click(status.querySelector('summary'))
    assert.equal(status.open, true, 'the native nested disclosure actually toggles')
    assert.equal(viewMenu.open, true, 'the parent disclosure stays open')
    assert.match(counts.textContent, /等待：1/)
    assert.equal(actions.style.maxHeight, '142px', 'expanded counts make the existing viewport recalculate instead of retaining its closed size')
    assert.equal(actions.style.top, '-142px', 'the menu moves toward the available space above its anchor')
    assert.equal(find('.tl-wf-view-actions'), actions)
    await click(status.querySelector('summary'))
    assert.equal(status.open, false)
    assert.equal(viewMenu.open, true)
    assert.equal(actions.style.maxHeight, '82px')
    assert.equal(actions.style.top, '29px', 'closing the counts restores the shorter downward menu')

    const category = [...window.document.querySelectorAll('.tl-wf-category')].find(item => item.querySelector('summary').textContent === '输入')
    await click(category.querySelector('summary'))
    assert.equal(category.open, true)
    const option = category.querySelector('button')
    await act(async () => { option.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true })); option.click() })
    assert.equal(category.open, false)
    assert.equal(window.document.querySelectorAll('.tl-wf-node[data-node-id]').length, 2)
  } finally {
    if (root) await act(async () => root.unmount())
    window.close()
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete globalThis[key]
    }
  }
})
test('canvas tabs use saved workflow identities and link the selected tab to the canvas', async () => {
 const f = loadWorkflow({addSecondCanvas:true}), requests=[]
 const tabs = tree => all(tree).filter(node => node.props?.role === 'tab')
 const tabList = all(f.tree).find(node => node.props?.role === 'tablist')
 const panel = all(f.tree).find(node => node.props?.role === 'tabpanel')
 assert.deepEqual(tabs(f.tree).map(label), ['Test','Second（待确认）'])
 assert.equal(tabs(f.tree)[0].props['aria-controls'],panel.props.id)
 assert.equal(panel.props['aria-labelledby'],tabs(f.tree)[0].props.id)
 let focused = false
 const elements = [{}, {focus(){focused=true}}]
 tabList.props.onKeyDown({key:'ArrowRight',target:elements[0],currentTarget:{querySelectorAll:()=>elements},preventDefault(){}})
 assert.equal(focused,true)
 f.context.onFetch=async url=>{requests.push(url);return{ok:true,json:async()=>({workflow:f.second})}}
 tabs(f.tree)[1].props.onClick()
 await tick()
 assert.deepEqual(requests,['/tradeloom/workflows?id=wf-second'])
 assert.equal(tabs(f.render())[1].props['aria-selected'],true)
})
test('refresh reads the selected saved canvas and its list, without replacing edits during the read', async () => {
 const f = loadWorkflow(), requests=[]
 const fetched={...f.doc,title:'Server title'}
 f.context.onFetch=async (url,options)=>{
  requests.push([url,options.method])
  return {ok:true,json:async()=>url.endsWith('wf-test') ? {workflow:fetched} : {workflows:[fetched],catalog:f.catalog}}
 }
 await button(f.tree,'刷新画布').props.onClick()
 assert.deepEqual(requests,[['/tradeloom/workflows?id=wf-test','GET'],['/tradeloom/workflows','GET']])
 assert.equal(f.state[2].title,'Server title')
 let finish
 f.context.onFetch=async url=>url.endsWith('wf-test')
  ? {ok:true,json:()=>new Promise(resolve=>{finish=resolve})}
  : {ok:true,json:async()=>({workflows:[fetched],catalog:f.catalog})}
 const tree=f.render(), pending=button(tree,'刷新画布').props.onClick()
 await tick()
 const node=all(tree).find(item=>item.type==='details'&&item.props.className==='tl-wf-category')
 all(node).find(item=>item.type==='button').props.onClick({currentTarget:{closest:()=>({querySelector:()=>null})}})
 finish({workflow:{...fetched,title:'Late server response'}})
 await pending
 assert.equal(f.state[2].title,'Server title')
 assert.equal(f.state[2].nodes.length,2)
 assert.equal(button(f.render(),'刷新画布').props.disabled,true)
})
test('refresh stays unavailable in the editor, during a run, or while a write is pending', async () => {
 const f=loadWorkflow(), requests=[]
 const node=all(f.tree).find(item=>item.props.className?.startsWith('tl-wf-node'))
 node.props.onDoubleClick()
 assert.equal(button(f.render(),'刷新画布').props.disabled,true)
 const running=loadWorkflow({activeRun:{id:'run',nodes:{}}})
 assert.equal(button(running.tree,'刷新画布').props.disabled,true)
 const saving=loadWorkflow()
 let finishSave
 saving.context.onFetch=async (url,options)=>{
  requests.push(options.method)
  return {ok:true,json:async()=>options.method==='POST'
   ? new Promise(resolve=>{finishSave=resolve}) : {workflows:saving.list,catalog:saving.catalog}}
 }
 const saved=button(saving.tree,'保存').props.onClick()
 await tick()
 await button(saving.tree,'刷新画布').props.onClick()
 assert.deepEqual(requests,['POST'])
 finishSave({workflow:saving.doc})
 await saved
 assert.deepEqual(requests,['POST','GET'])
})
test('actual WorkflowCanvas exposes native prepare/save/history and catalog categories in top toolbar',async()=>{
 const f=loadWorkflow(),toolbar=all(f.tree).find(n=>n.props?.role==='toolbar')
 const primary=toolbar.children.find(n=>n.props.className==='tl-wf-primary')
 const buttons=primary.children.filter(n=>n.type==='button')
 assert.deepEqual(buttons.slice(0,4).map(label),['+','开始…','保存','历史'])
 assert.equal(buttons[0].props['aria-label'],'新建工作流')
 assert.equal(buttons[3].props.className,'tl-wf-history','history is aligned at the right edge of the primary toolbar')
 const categories=all(toolbar).filter(n=>n.type==='details'&&n.props.className==='tl-wf-category')
 assert.equal(categories.length,f.catalog.kinds.length)
 assert.equal(typeof categories[0].props.onMouseEnter,'function')
 assert.equal(typeof categories[0].props.onMouseLeave,'function')
 const hoverMenu={open:false,ownerDocument:{activeElement:null},contains:()=>false}
 categories[0].props.onMouseEnter({currentTarget:hoverMenu});assert.equal(hoverMenu.open,true,'hover opens the node submenu')
 categories[0].props.onMouseLeave({currentTarget:hoverMenu});assert.equal(hoverMenu.open,false,'leaving the category closes an unfocused submenu')
 hoverMenu.open=true;hoverMenu.ownerDocument.activeElement={};hoverMenu.contains=()=>true
 categories[0].props.onMouseLeave({currentTarget:hoverMenu});assert.equal(hoverMenu.open,true,'keyboard focus keeps the submenu open after pointer exit')
 assert.deepEqual(all(categories[1]).filter(n=>n.type==='button').map(label),f.catalog.agents.map(item=>`${item.icon} ${item.label}`))
 const calls=[];f.context.onFetch=async(url,options)=>{calls.push({url,body:options.body&&JSON.parse(options.body)});return{ok:true,status:200,json:async()=>({workflow:f.doc,catalog:f.catalog,workflows:[f.doc],schemaVersion:1,ok:true,executionMode:'native_dsh',action:'list',runs:[]})}}
 await buttons[2].props.onClick();assert.equal(calls[0].body.action,'save')
 calls.length=0;buttons[3].props.onClick();await new Promise(r=>setTimeout(r,0));assert.equal(calls[0].body.action,'list')
 calls.length=0;buttons[1].props.onClick();await new Promise(r=>setTimeout(r,0));assert.equal(calls[0].body.action,'prepare');assert.ok(!calls.some(c=>c.body?.action==='submit'))
 // All add controls execute the production addNode path from actual catalog, not demo nodes.
 const before=f.state[2].nodes.length
 let focusCount=0
 const summary={focus(){focusCount++}}
 const menu={open:true,querySelector:()=>summary,contains:node=>node===summary}
 const event={currentTarget:menu,relatedTarget:summary,key:'Escape',preventDefault(){},stopPropagation(){}}
 categories[1].props.onBlur(event);assert.equal(menu.open,true)
 categories[1].props.onKeyDown(event);assert.equal(menu.open,false);assert.equal(focusCount,1)
 menu.open=true
 const add=all(categories[1]).find(n=>n.type==='button');add.props.onClick({currentTarget:{closest:()=>menu}})
 assert.equal(menu.open,false);assert.equal(focusCount,2)
 assert.equal(f.state[2].nodes.length,before+1);assert.equal(f.state[2].nodes.at(-1).kind,'agent')
})
function fn(source,name){const start=source.indexOf(`  function ${name}(`);assert.ok(start>=0,`missing ${name}`);const next=source.indexOf('\n  function ',start+12);return source.slice(start,next<0?undefined:next)}
function element(){return{style:{},dataset:{},children:[],isConnected:true,hidden:false,setAttribute(){},listeners:new Map(),addEventListener(type,fn){this.listeners.set(type,fn)},removeEventListener(type){this.listeners.delete(type)},append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=nodes},contains(n){return this.children.includes(n)},closest(){return this.panel},getBoundingClientRect(){return{left:0,top:0,width:600,height:400}},querySelector(){return null},classList:{toggle(){},add(){}}}}
function bridge(mount, status=async()=>({})){
 const source=read('business-bridge.js'),calls=[],observers=[],state={phase:'ready',sceneId:'agent-center',workflowMounted:false,config:{}},content=element();content.panel=element()
 const app={workflowCanvas:{mount,status,setBounds:async()=>calls.push('bounds'),setVisible:async v=>calls.push(v)}}
 const c={state,app,document:{createElement:element},nativePaneVisible:()=>true,routeForPath:()=>({route:{sceneId:'agent-center',panelId:'business-main'}}),renderBusinessPanel(){throw Error('hidden plan not allowed')},ResizeObserver:class{constructor(){observers.push(this)}observe(){this.observing=true}disconnect(){this.observing=false}}};vm.createContext(c)
 const start=source.indexOf('  function onWorkflowStatus('),end=source.indexOf('  function renderWorkflowPanel(',start);vm.runInContext(source.slice(start,end)+fn(source,'renderWorkflowPanel'),c);return{c,content,calls,observers,state}
}
const tick=()=>new Promise(r=>setTimeout(r,0))
test('actual independent canvas mounts Host business-main, shows no tabs and cleans visibility',async()=>{
 const f=bridge(async()=>({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted',placement:'docked'}));const cleanup=f.c.renderWorkflowPanel({standaloneCanvas:true,title:'工作流画布'},f.content);await tick();assert.equal(f.content.children.length,1);assert.equal(f.content.children[0].dataset.workflowCanvasHost,'true');assert.ok(f.calls.includes(true));assert.equal(f.observers.length,1,JSON.stringify({calls:f.calls,note:f.state.workflowRecord.note.textContent,status:f.state.workflowRecord.status}));assert.equal(f.observers[0].observing,true);cleanup();await tick();assert.equal(f.content.children.length,0);assert.equal(f.calls.at(-1),false);assert.equal(f.observers[0].observing,false)
})
test('workflow main keeps the native guest hidden until the canvas owner mounts and restores it on re-entry', async () => {
 const target = {componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',placement:'docked'}
 let status = 'document-loaded'
 let mounts = 0
 const f = bridge(async () => { mounts++; return {...target,status} }, async () => ({...target,status}))
 const cleanup = f.c.renderWorkflowPanel({standaloneCanvas:true}, f.content)
 await tick()
 assert.deepEqual(f.calls, [])
 assert.equal(f.state.workflowRecord.note.hidden,false)
 f.c.onWorkflowStatus({...target,sceneId:'other',status:'context-mounted'})
 await tick()
 assert.deepEqual(f.calls, [])
 status = 'context-mounted'
 f.c.onWorkflowStatus({...target,status})
 await tick()
 assert.deepEqual(f.calls, ['bounds',true])
 assert.equal(f.state.workflowRecord.note.hidden,true)
 cleanup()
 await tick()
 assert.equal(f.calls.at(-1),false)
 f.c.renderWorkflowPanel({standaloneCanvas:true}, f.content)
 await tick()
 assert.equal(mounts,1)
 assert.deepEqual(f.calls.slice(-2),['bounds',true])
 f.c.onWorkflowStatus({...target,status:'error'})
 await tick()
 assert.equal(f.calls.at(-1),false)
})
test('workflow main keeps a canvas acknowledgement that arrives before the initial mount response', async () => {
 let resolveMount
 const f = bridge(() => new Promise(resolve => { resolveMount = resolve }))
 const target = {componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main'}
 f.c.renderWorkflowPanel({standaloneCanvas:true}, f.content)
 f.c.onWorkflowStatus({...target,status:'context-mounted'})
 resolveMount({...target,status:'document-loaded'})
 await tick()
 assert.equal(f.state.workflowRecord.status,'context-mounted')
 assert.equal(f.calls.at(-1),true)
})
test('native visibility acknowledgements do not recursively resynchronize the workflow canvas', async () => {
 const target = {
  componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',
  status:'context-mounted',placement:'docked',
 }
 const f = bridge(async () => target)
 let notifications = 0
 const setVisible = f.c.app.workflowCanvas.setVisible
 f.c.app.workflowCanvas.setVisible = async visible => {
  await setVisible(visible)
  // The production Main handler publishes status on every visibility call.
  // Bound the echo so a regression terminates with a useful assertion.
  if (++notifications < 6) queueMicrotask(() => f.c.onWorkflowStatus({...target,visible}))
 }
 f.c.renderWorkflowPanel({standaloneCanvas:true}, f.content)
 await tick()
 assert.deepEqual(f.calls,['bounds',true])
})
test('legacy workflow tabs show the canvas only after it mounts and preserve it across tab changes', async () => {
 const target = {componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted'}
 let mounts = 0
 const f = bridge(async () => { mounts++; return target })
 let planUnloads = 0
 f.c.renderBusinessPanel = () => () => { planUnloads++ }
 const cleanup = f.c.renderWorkflowPanel({activeTab:'工作流画布'}, f.content)
 await tick()
 const [tabs,plan,canvas] = f.content.children
 assert.equal(canvas.style.display,'flex')
 assert.equal(f.calls.at(-1),true)
 tabs.children[0].listeners.get('click')()
 await tick()
 assert.equal(plan.style.display,'flex')
 assert.equal(f.calls.at(-1),false)
 tabs.children[1].listeners.get('click')()
 await tick()
 assert.equal(canvas.style.display,'flex')
 assert.equal(f.calls.at(-1),true)
 assert.equal(mounts,1)
 cleanup()
 assert.equal(planUnloads,1)
})
test('actual canvas late mount after cleanup is ignored and wrong owner stays visible error',async()=>{
 let complete;const pending=new Promise(r=>complete=r),f=bridge(()=>pending);const cleanup=f.c.renderWorkflowPanel({standaloneCanvas:true},f.content);cleanup();complete({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted'});await tick();assert.ok(!f.calls.includes(true));assert.equal(f.observers.length,0)
 const bad=bridge(async()=>({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'workflow-main',status:'context-mounted'}));bad.c.renderWorkflowPanel({standaloneCanvas:true},bad.content);await tick();assert.equal(bad.state.workflowRecord.note.dataset.state,'error');assert.equal(bad.state.workflowRecord.note.hidden,false)
})
test('actual commitScenario keeps the default-closed plan registered beside the standalone canvas',()=>{
 const panels=[], grid={style:{setProperty(){}}}, calls=[]
 const c={grid,window:{businessBridge:{sceneSelected(){calls.push('selected')}}},activePanelDragCancel:null,currentTab:null,
  clearScene(){panels.length=0},makePanel(meta){calls.push(meta.id);panels.push(meta)},$(){return{}},tabListOf:()=>[],
  applyTabCollapse(){},updateSidebarScene(){},initialSceneCommit:null}
 const source=read('renderer.js'),start=source.indexOf('function commitScenario('),end=source.indexOf('\nfunction loadInitialScenario(',start)
 vm.runInNewContext(source.slice(start,end),c)
 assert.equal(c.commitScenario(scene),true)
 assert.equal(calls[0],'selected')
 assert.equal(panels.length,5)
 assert.equal(panels.find(panel=>panel.id==='workflow-plan').closedByDefault,true)
 assert.equal(panels.find(panel=>panel.id==='workflow-main').standaloneCanvas,true)
})
test('actual plan bridge resolves registered business-plan owners for the canonical workflow and its trusted copy',async()=>{
 const f=bridge(async()=>({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted'})),config=JSON.parse(fs.readFileSync(new URL('../scenes.json',import.meta.url),'utf8'))
 const hostScene=config.scenes.find(s=>s.id==='agent-center'),copyScene={...structuredClone(hostScene),id:'s6-f7-workflow-copy',templateSceneId:'agent-center'}
 hostScene.panelMap=new Map(hostScene.panels.map(p=>[p.id,p]));copyScene.panelMap=new Map(copyScene.panels.map(p=>[p.id,p]))
 f.state.config={raw:config,scenes:new Map([[hostScene.id,hostScene],[copyScene.id,copyScene]])};f.c.allowedRoutes=new Set(['/agent-center'])
 f.c.stateNode=(content,text,status)=>{const note=element();note.textContent=text;note.dataset.state=status;content.replaceChildren(note);return note}
 const bridgeSource=read('business-bridge.js')
 vm.runInContext(['routeForPath','workflowTemplateRoute','renderBusinessPanel'].map(name=>fn(bridgeSource,name)).join('\n'),f.c)
 const plan=element(),meta={...scene.panels.find(p=>p.id==='workflow-plan'),sceneId:'agent-center'},cleanup=f.c.renderBusinessPanel(meta,plan,'/agent-center')
 assert.equal(plan.children[0].dataset.tradeloomPanelId,'business-plan');assert.equal(plan.children[0].dataset.tradeloomBusinessSceneId,'agent-center');assert.equal(plan.children[0].src,'/business/agent-center')
 const copyPlan=element(),copyMeta={...meta,sceneId:copyScene.id},copyCleanup=f.c.renderBusinessPanel(copyMeta,copyPlan,'/agent-center')
 assert.equal(copyPlan.children[0].dataset.tradeloomPanelId,'business-plan');assert.equal(copyPlan.children[0].dataset.tradeloomBusinessSceneId,copyScene.id);assert.equal(copyPlan.children[0].src,'/business/agent-center')
 copyCleanup();assert.equal(copyPlan.children.length,0)
 copyScene.templateSceneId='runs';const nonmatching=element();f.c.renderBusinessPanel(copyMeta,nonmatching,'/agent-center');assert.equal(nonmatching.children[0].dataset.state,'error')
 const canvas=element();canvas.panel=element();f.c.renderWorkflowPanel({standaloneCanvas:true},canvas);await tick();assert.ok(f.calls.includes(true));const before=f.calls.length;cleanup();assert.equal(plan.children.length,0);assert.equal(f.calls.length,before)
 hostScene.panelMap.delete('business-plan');const denied=element();f.c.renderBusinessPanel(meta,denied,'/agent-center');assert.equal(denied.children[0].dataset.state,'error')
})
const button=(tree,text)=>all(tree).find(n=>n.type==='button'&&label(n)===text)

test('selected files preserve the native slot and the business bridge requires the declared owner', async () => {
 const active = name => fs.readFileSync(new URL('../../../apps/tradeloom-launcher/stage5-source06/asar/renderer/source-shell/replica-ui/'+name, import.meta.url),'utf8')
 const config=JSON.parse(fs.readFileSync(new URL('../scenes.json',import.meta.url),'utf8'))
 const {SCENE_COMPONENT_CATALOG,validateSceneConfig}=await import('../scene-layout.js')
 const component=SCENE_COMPONENT_CATALOG[0]
 const copied={...structuredClone(config.scenes.find(value=>value.id==='runs')),id:'runs-copy',templateSceneId:'runs'}
 delete copied.defaultBusinessRoute
 config.scenes.push(copied)
 const panel=copied.panels.find(value=>value.id==='reference')
 const original={...panel}
 Object.assign(panel,{componentId:component.id,path:component.path,title:component.label})
 const product=SCENE_COMPONENT_CATALOG.find(value=>value.id==='product-catalog')
 const auxiliary=copied.panels.find(value=>value.id===product.panelId)
 const originalAuxiliary={...auxiliary}
 Object.assign(auxiliary,{componentId:product.id,path:product.path,title:'商品筛选',h:1})
 validateSceneConfig(config)
 const templates={window:{}};vm.runInNewContext(active('scenes-data.js'),templates)
 const source=active('renderer.js'), projection={configurationTemplates:templates.window.__SCENES__.scenes}
 vm.createContext(projection);vm.runInContext(source.slice(source.indexOf('const hostPanelFor'),source.indexOf('function applyTrustedSceneConfiguration')),projection)
 const projected=projection.projectTrustedScene(copied)
 const meta={...projected.panels.find(value=>value.id==='reference-material'),sceneId:copied.id}
 assert.equal(meta.hostPanelId,panel.id)
 assert.equal(meta.componentId,component.id)
 assert.deepEqual(['col','row','w','h'].map(key=>meta[key]),['col','row','w','h'].map(key=>original[key]))
 const f=bridge(async()=>({}))
 f.state.config={raw:config,scenes:new Map(config.scenes.map(value=>[value.id,{...value,panelMap:new Map(value.panels.map(item=>[item.id,item]))}]))}
 f.c.allowedRoutes=new Set(['/artifacts','/products'])
 f.c.stateNode=(content,text,status)=>{const note=element();note.textContent=text;note.dataset.state=status;content.replaceChildren(note);return note}
 const bridgeSource=active('business-bridge.js')
 const registered=[]
 Object.assign(f.c,{pathForScene:()=>'/runs',location:{protocol:'dsh-app:',host:'app'},
  fileBridgeMounts:new Map(),window:{addEventListener(){},removeEventListener(){},TradeLoomBusinessFileBridge:{
   create(options){registered.push(options);return Object.assign(()=>{}, {requestFileExport(){},requestFileFocus(){}})}
  }}})
 vm.runInContext(['routeForPath','renderBusinessPanel','findCompanionPath','releaseFileCompanion','mountFileCompanion','renderCompanion']
  .map(name=>fn(bridgeSource,name)).join('\n'),f.c)
 const content=element(),cleanup=f.c.renderCompanion(meta,content,'files')
 assert.equal(registered[0].scene.id,copied.id)
 assert.equal(typeof content.__businessFileExport,'function')
 assert.equal(typeof content.__businessFileFocus,'function')
 assert.equal(content.children[0].dataset.tradeloomBusinessSceneId,copied.id)
 assert.equal(content.children[0].dataset.tradeloomPanelId,panel.id)
 assert.equal(content.children[0].src,'/business/artifacts#files')
 const taskMeta={...projected.panels.find(value=>value.id==='tasks'),sceneId:copied.id}
 assert.equal(taskMeta.hostPanelId,'auxiliary')
 assert.equal(taskMeta.title,'商品筛选')
 assert.equal(taskMeta.h,1)
 const products=element(),cleanupProducts=f.c.renderBusinessPanel(taskMeta,products,taskMeta.path)
 assert.equal(products.children[0].dataset.tradeloomBusinessSceneId,copied.id)
 assert.equal(products.children[0].dataset.tradeloomPanelId,auxiliary.id)
 assert.equal(products.children[0].src,'/business/products')
 cleanupProducts()
 f.c.renderBusinessPanel({...taskMeta,hostPanelId:'reference'},products,taskMeta.path)
 assert.equal(products.children[0].dataset.state,'error')
 delete auxiliary.componentId;Object.assign(auxiliary,originalAuxiliary)
 copied.panels.find(value=>value.id==='business-main').h=1
 const instance={...auxiliary,id:'component-products',componentId:product.id,path:product.path,title:product.label,col:1,row:2,w:1,h:1}
 copied.panels.push(instance)
 validateSceneConfig(config)
 f.state.config.scenes.get(copied.id).panelMap.set(instance.id,instance)
 const dynamic={...projection.projectTrustedScene(copied).panels.find(value=>value.id===instance.id),sceneId:copied.id}
 assert.equal(dynamic.hostPanelId,instance.id)
 assert.equal(projection.projectTrustedScene(copied).panels.find(value=>value.id==='tasks').path,originalAuxiliary.path)
 const cleanupDynamic=f.c.renderBusinessPanel(dynamic,products,dynamic.path)
 assert.equal(products.children[0].dataset.tradeloomPanelId,instance.id)
 assert.equal(products.children[0].dataset.tradeloomBusinessSceneId,copied.id)
 assert.equal(products.children[0].src,'/business/products')
 cleanupDynamic()
 cleanup()
 assert.equal(content.__businessFileFocus,undefined)
 for(const forged of [{...meta,sceneId:'runs'},{...meta,hostPanelId:'auxiliary'},{...meta,path:'/artifacts'}]){
  f.c.renderCompanion(forged,content,forged.path.endsWith('#files')?'files':'preview')
  assert.equal(content.children[0].dataset.state,'error')
 }
 delete panel.componentId;Object.assign(panel,original)
 assert.equal(projection.projectTrustedScene(copied).panels.find(value=>value.id===meta.id).path,original.path)
})

test('workflow deletion is available in the document menu and requires confirmation', async () => {
 const f = loadWorkflow()
 const calls = [], prompts = []
 let confirmed = false
 f.context.window.confirm = message => { prompts.push(message); return confirmed }
 f.context.onFetch = async (url, options) => {
  calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) })
  return { ok: true, json: async () => ({ catalog: f.catalog, workflows: [] }) }
 }
 const menu = tree => all(tree).find(node => node.props['aria-label'] === '工作流文档操作菜单')
 const remove = button(menu(f.tree), '删除')
 assert.equal(remove.props.disabled, false)
 remove.props.onClick()
 assert.deepEqual(prompts, ['删除工作流「Test」？'])
 assert.deepEqual(calls, [])
 confirmed = true
 remove.props.onClick()
 await tick()
 assert.deepEqual(calls, [
  { url: '/tradeloom/workflows', method: 'POST', body: { action: 'delete', id: f.doc.id } },
  { url: '/tradeloom/workflows', method: 'GET', body: undefined },
 ])
 assert.equal(button(menu(f.render()), '删除').props.disabled, true)
})

test('registered workflow artifacts expose only the native file download route', async t => {
 const runId = 'aaaaaaaa-0000-4000-8000-000000000001'
 const id = 'bbbbbbbb-0000-4000-8000-000000000001'
 const route = '/tradeloom/workflows/native/artifact'
 const query = new URLSearchParams({ runId, id, action: 'download' })
 const downloadUrl = `${route}?${query}`
 for (const [name, urlForReceipt, availability, expected] of [
  ['ready file route', downloadUrl, 'ready', downloadUrl],
  ['collection route', `${route}s?${query}`, 'ready', undefined],
  ['external route', `//outside.invalid${downloadUrl}`, 'ready', undefined],
  ['unavailable version', downloadUrl, 'unavailable', undefined],
 ]) await t.test(name, async () => {
  const f = loadWorkflow()
  const identity = { childId: 'child', nativeRunId: 'child-run', toolCallId: 'tool-call' }
  const source = { path: 'synthetic.txt', presentCallId: 'present', sourceSessionSeq: 2, fileIndex: 0, sourceTurn: 1 }
  const receipt = { ...identity, workflowRunId: runId, nodeId: 'a', attempt: 1, sequence: 1,
   source: 'subagent/end', stopReason: 'completed', status: 'completed' }
  const run = { id: runId, workflowId: f.doc.id, executionMode: 'native_dsh', sessionId: 'center',
   definitionRevision: 'sha256:' + 'a'.repeat(64), bindingRevision: '1',
   status: 'done', settled: true, succeeded: true, terminalReceipt: [receipt],
   nodes: [{ ...identity, id: 'a', roleId: 'product', attempt: 1, status: 'done', settled: true, succeeded: true,
    terminalReceipt: receipt, artifactState: 'declared', artifactEvidence: { schema: 'tradeloom.presented-evidence/v1',
     range: { childSessionId: identity.childId, nativeRunId: identity.nativeRunId, startInclusive: 1, endExclusive: 3 },
     declarations: [source] } }] }
  const calls = []
  f.context.onFetch = async (url, options) => {
   const body = JSON.parse(options.body)
   calls.push({ url, method: options.method, credentials: options.credentials, body })
   const envelope = { schemaVersion: 1, ok: true, executionMode: 'native_dsh', action: body.action }
   const value = body.action === 'list' ? { ...envelope, runs: [run] } : body.action === 'get' ? { ...envelope, run }
    : { ok: true, version: { id, runId, nodeId: 'a', attempt: 1, name: source.path,
     source: { seq: source.sourceSessionSeq, index: source.fileIndex }, availability, downloadUrl: urlForReceipt } }
   return { ok: true, status: 200, json: async () => value }
  }
  button(f.tree, '历史').props.onClick()
  await tick()
  all(f.render()).find(node => node.props['aria-label'] === '查看原生记录 1').props.onClick()
  await tick()
  button(f.render(), '导入产物').props.onClick()
  await tick()
  assert.deepEqual(calls.at(-1), { url: route + 's', method: 'POST', credentials: 'same-origin',
   body: { runId, nodeId: 'a', attempt: 1, sourceSessionSeq: source.sourceSessionSeq, fileIndex: source.fileIndex } })
  const tree = f.render()
  assert.ok(button(tree, '已登记'))
  assert.equal(all(tree).find(node => node.type === 'a' && label(node).trim() === '下载登记版本')?.props.href, expected)
 })
})
function preparedFor(doc){return{workflowId:doc.id,title:doc.title,eligible:true,confirmed:true,executionMode:'native_dsh',definitionRevision:'sha256:'+'b'.repeat(64),bindingRevision:'7',center:{roleId:'center',sessionId:'synthetic-session',workspaceId:'synthetic-workspace',archiveState:'unarchived'},node:{id:'a',roleId:'product',agentPreset:'synthetic-preset'}}}
test('actual native prepare requires explicit confirm; close aborts late response and errors remain visible',async()=>{
 const f=loadWorkflow(),calls=[];let complete,signal
 f.context.onFetch=async(url,options)=>{calls.push(JSON.parse(options.body));signal=options.signal;return new Promise(r=>complete=r)}
 button(f.tree,'开始…').props.onClick();assert.equal(calls[0].action,'prepare');assert.ok(!calls.some(c=>c.action==='submit'))
 const pending=f.render();button(pending,'关闭').props.onClick();assert.equal(signal.aborted,true)
 complete({ok:true,status:200,json:async()=>({schemaVersion:1,ok:true,executionMode:'native_dsh',action:'prepare',prepared:preparedFor(f.doc)})});await tick();assert.ok(!all(f.render()).some(n=>n.props?.className==='tl-wf-native'))
 f.context.onFetch=async()=>({ok:false,status:409,json:async()=>({error_code:'binding_revision_mismatch'})})
 button(f.render(),'开始…').props.onClick();await tick();assert.ok(all(f.render()).some(n=>n.props?.role==='alert'&&label(n).includes('绑定')))
})
test('actual confirmation sends native submit with prepared definition and binding identity only after click',async()=>{
 const f=loadWorkflow(),calls=[];f.context.onFetch=async(url,options)=>{const body=JSON.parse(options.body);calls.push(body);return{ok:true,status:200,json:async()=>({schemaVersion:1,ok:true,executionMode:'native_dsh',action:'prepare',prepared:preparedFor(f.doc)})}}
 button(f.tree,'开始…').props.onClick();await tick();assert.equal(calls.length,1)
 const ready=f.render(),confirm=button(ready,'确认并启动真实原生执行');assert.ok(confirm)
 f.context.onFetch=async(url,options)=>{calls.push(JSON.parse(options.body));return{ok:false,status:409,json:async()=>({error_code:'binding_revision_mismatch'})}}
 confirm.props.onClick();await tick();assert.equal(calls[1].action,'submit');assert.equal(calls[1].confirm,true);assert.equal(calls[1].expectedBindingRevision,'7');assert.equal(calls[1].expectedDefinitionRevision,'sha256:'+'b'.repeat(64));assert.ok(all(f.render()).some(n=>n.props?.role==='alert'))
})
test('actual trusted projection preserves custom and cloned scene geometry and validates candidate Host defaults',async()=>{
 const config=JSON.parse(fs.readFileSync(new URL('../scenes.json',import.meta.url),'utf8')),{validateSceneConfig}=await import('../scene-layout.js');assert.equal(validateSceneConfig(config),config)
 const source=read('renderer.js'),start=source.indexOf('const hostPanelFor'),end=source.indexOf('function applyTrustedSceneConfiguration',start),c={configurationTemplates:sceneContext.window.__SCENES__.scenes};vm.createContext(c);vm.runInContext(source.slice(start,end),c)
 const host=config.scenes.find(s=>s.id==='agent-center'),fresh=c.projectTrustedScene(host);assert.equal(fresh.panels.find(p=>p.id==='workflow-main').hostPanelId,'business-main');assert.equal(fresh.panels.find(p=>p.id==='workflow-plan').hostPanelId,'business-plan')
 const old=structuredClone(host);old.panels=old.panels.filter(p=>p.id!=='business-plan');Object.assign(old.panels.find(p=>p.id==='business-main'),{col:1,w:3});const before=JSON.stringify(old);assert.equal(c.projectTrustedScene(old).panels.length,4);assert.equal(JSON.stringify(old),before)
 Object.assign(old.panels.find(p=>p.id==='business-main'),{w:2});const custom=c.projectTrustedScene(old);assert.equal(custom.panels.length,4);assert.equal(custom.workflowLayoutGap,'custom-legacy-layout');assert.equal(custom.panels.find(p=>p.id==='workflow-main').w,2)
 old.id='user-copy';old.templateSceneId='agent-center';assert.equal(c.projectTrustedScene(old).panels.length,4)
})
test('old Host configurations keep their declared four panels even with an added optional component',async()=>{
 const config=JSON.parse(fs.readFileSync(new URL('../scenes.json',import.meta.url),'utf8')),{validateSceneConfig}=await import('../scene-layout.js'),host=config.scenes.find(s=>s.id==='agent-center')
 host.panels=host.panels.filter(p=>p.id!=='business-plan');Object.assign(host.panels.find(p=>p.id==='business-main'),{col:1,w:3})
 const source=read('renderer.js'),start=source.indexOf('const hostPanelFor'),end=source.indexOf('function applyTrustedSceneConfiguration',start),c={configurationTemplates:sceneContext.window.__SCENES__.scenes};vm.createContext(c);vm.runInContext(source.slice(start,end),c)
 assert.equal(validateSceneConfig(config),config);assert.equal(host.panels.length,8);assert.equal(c.projectTrustedScene(host).panels.length,4)
 host.panels.push({id:'custom-workspace',type:'native-workspace',optional:true,title:'Custom',col:4,row:3,w:1,h:2})
 assert.equal(validateSceneConfig(config),config);const before=JSON.stringify(host),result=c.projectTrustedScene(host)
 assert.equal(result.workflowLayoutGap,'custom-legacy-layout');assert.equal(result.panels.length,4);assert.equal(result.panels.find(p=>p.id==='workflow-main').col,1);assert.equal(result.panels.find(p=>p.id==='workflow-main').w,3);assert.equal(JSON.stringify(host),before)
})
