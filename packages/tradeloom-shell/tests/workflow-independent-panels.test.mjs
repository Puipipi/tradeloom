import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import path from 'node:path'
import { workflowCatalog } from '../workflow-schema.js'
const root=path.resolve(import.meta.dirname,'../../../../../..')
const output=process.env.S5_08_OUTPUT || path.join(root,'stage5-build-artifacts-20261113/s5-07-auth-order01-author/higher-generation-readback')
const ui=path.join(output,'renderer/source-shell/replica-ui')
const fallback=path.join(root,'workspace/source-worktrees/stage5-seven-on-048/apps/tradeloom-launcher/accepted-runtime/renderer/source-shell/replica-ui')
const read=name=>fs.readFileSync(name==='renderer.js'&&process.env.S5_08_RENDERER ? process.env.S5_08_RENDERER : path.join(fs.existsSync(path.join(ui,name))?ui:fallback,name),'utf8')
const sceneContext={window:{}};vm.runInNewContext(read('scenes-data.js'),sceneContext)
const scene=sceneContext.window.__SCENES__.scenes.find(s=>s.id==='agent-center')
test('default workflow has two visible independent panels without changing canvas identity',()=>{
 assert.ok(scene.panels.some(p=>p.id==='workflow-plan'&&p.type==='doc'))
 const canvas=scene.panels.find(p=>p.id==='workflow-main');assert.equal(canvas.type,'canvas');assert.equal(canvas.tabs,undefined)
 const cells=new Set();for(const p of scene.panels)for(let y=p.row;y<p.row+p.h;y++)for(let x=p.col;x<p.col+p.w;x++){const key=x+','+y;assert.ok(!cells.has(key));cells.add(key)}
})
function loadWorkflow(){
 let exported; const state=[],effects=[],refs=[];let index=0,refIndex=0
 const React={createElement:(type,props,...children)=>({type,props:props||{},children:children.flat(Infinity).filter(Boolean)}),useState:v=>{const i=index++;if(!Object.hasOwn(state,i))state[i]=typeof v==='function'?v():v;return[state[i],n=>{state[i]=typeof n==='function'?n(state[i]):n}]},useRef:v=>{const i=refIndex++;return refs[i]??=( {current:v})},useEffect:f=>effects.push(f),useMemo:f=>f(),useCallback:f=>f,Fragment:'fragment'}
 const context={window:{crypto:globalThis.crypto,__ModuleLoader__:{load:m=>{exported=m.factory(()=>React)}}},console,AbortController,clearTimeout,setTimeout,crypto:globalThis.crypto,fetch:(...args)=>context.onFetch(...args)}
 vm.runInNewContext(fs.readFileSync(new URL('../client.workflow.js',import.meta.url),'utf8'),context)
 const doc={version:1,id:'wf-test',title:'Test',confirmed:true,source:'manual',nodes:[{id:'a',kind:'agent',agent:'product',title:'A',instruction:'',position:{x:0,y:0}}],edges:[]}
 const catalog=workflowCatalog()
 const render=()=>{index=0;refIndex=0;effects.length=0;return exported.WorkflowCanvas({initial:{doc,list:[doc],catalog,editing:false}})}
 const tree=render()
 return{tree,state,effects,doc,catalog,context,render}
}
function all(node){return node&&typeof node==='object'?[node,...(node.children||[]).flatMap(all)]:[]}
function label(node){return typeof node==='string'?node:(node?.children||[]).map(label).join('')}
test('actual WorkflowCanvas exposes native prepare/save/history and catalog categories in top toolbar',async()=>{
 const f=loadWorkflow(),toolbar=all(f.tree).find(n=>n.props?.role==='toolbar')
 const buttons=toolbar.children.filter(n=>n.type==='button')
 assert.deepEqual(buttons.slice(0,4).map(label),['新建','开始…','保存','历史'])
 const categories=all(toolbar).filter(n=>n.type==='details'&&n.props.className==='tl-wf-category')
 assert.equal(categories.length,f.catalog.kinds.length)
 const hover={open:false};categories[0].props.onMouseEnter({currentTarget:hover});assert.equal(hover.open,true)
 assert.deepEqual(all(categories[1]).filter(n=>n.type==='button').map(label),f.catalog.agents.map(item=>`${item.icon} ${item.label}`))
 const calls=[];f.context.onFetch=async(url,options)=>{calls.push({url,body:options.body&&JSON.parse(options.body)});return{ok:true,status:200,json:async()=>({workflow:f.doc,catalog:f.catalog,workflows:[f.doc],schemaVersion:1,ok:true,executionMode:'native_dsh',action:'list',runs:[]})}}
 await buttons[2].props.onClick();assert.equal(calls[0].body.action,'save')
 calls.length=0;buttons[3].props.onClick();await new Promise(r=>setTimeout(r,0));assert.equal(calls[0].body.action,'list')
 calls.length=0;buttons[1].props.onClick();await new Promise(r=>setTimeout(r,0));assert.equal(calls[0].body.action,'prepare');assert.ok(!calls.some(c=>c.body?.action==='submit'))
 // All add controls execute the production addNode path from actual catalog, not demo nodes.
 const before=f.state[2].nodes.length
 const add=all(categories[1]).find(n=>n.type==='button');add.props.onClick({currentTarget:{closest:()=>({open:true})}})
 assert.equal(f.state[2].nodes.length,before+1);assert.equal(f.state[2].nodes.at(-1).kind,'agent')
})
function fn(source,name){const start=source.indexOf(`  function ${name}(`);assert.ok(start>=0,`missing ${name}`);const next=source.indexOf('\n  function ',start+12);return source.slice(start,next<0?undefined:next)}
const plain=v=>JSON.parse(JSON.stringify(v))
function layout(stored){
 const source=read('panel-interactions.js'),storage=new Map([['uiPanelSplitTree:v2',JSON.stringify({version:2,scenes:stored})]])
 const c={window:{},SPLIT_TREE_STORAGE_KEY:'uiPanelSplitTree:v2',localStorage:{getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)}};vm.createContext(c)
 for(const name of ['readSplitTrees','validSplitTree','treeTopology','migrateWorkflowDefaultLayout','saveSplitTree','savedTree'])vm.runInContext(fn(source,name),c)
 return{c,storage,read:()=>JSON.parse(storage.get('uiPanelSplitTree:v2'))}
}
const leaf=id=>({kind:'leaf',id}),split=(axis,boundary,first,second,ratio=.5)=>({kind:'split',axis,boundary,path:`${axis}:${boundary}`,first,second,ratio})
function legacy(){const f=layout({});const tree=split('y',3,split('x',4,leaf('workflow-main'),leaf('files'),.75),split('x',2,leaf('preview'),leaf('workflow-chat'),.25));return{tree,topology:f.c.treeTopology(tree),geometry:[{id:'workflow-main',col:1,row:1,w:3,h:2},{id:'files',col:4,row:1,w:1,h:2},{id:'preview',col:1,row:3,w:1,h:2},{id:'workflow-chat',col:2,row:3,w:3,h:2}]}}
test('production migration and savedTree preserve recoverable default snapshot and branch ratios',()=>{
 const old=legacy(),f=layout({'agent-center':old,other:{keep:7}});assert.equal(f.c.migrateWorkflowDefaultLayout(scene),scene)
 const saved=f.read().scenes['agent-center'];assert.deepEqual(saved.legacyWorkflowV1,old);assert.deepEqual(f.read().scenes.other,{keep:7});assert.equal(f.c.validSplitTree(saved.tree,scene.panels.map(p=>p.id)),true)
 assert.equal(saved.tree.ratio,old.tree.ratio);assert.equal(saved.tree.first.ratio,old.tree.first.ratio)
 const restored=f.c.savedTree({sceneId:'agent-center',geometry:scene.panels});assert.deepEqual(plain(restored.geometry),saved.geometry)
 f.c.saveSplitTree('agent-center',restored);assert.deepEqual(f.read().scenes['agent-center'].legacyWorkflowV1,old)
 assert.equal(f.c.validSplitTree(saved.legacyWorkflowV1.tree,old.geometry.map(p=>p.id)),true)
})
test('production custom restore uses old geometry and ratios; unknown and invalid are not rewritten',()=>{
 const custom=legacy();[custom.geometry[0].w,custom.geometry[1].col,custom.geometry[1].w]=[2,3,2];custom.tree.first.ratio=.63
 const f=layout({'agent-center':custom}),result=f.c.migrateWorkflowDefaultLayout(scene);assert.equal(result.workflowLayoutGap,'custom-legacy-layout');assert.equal(result.panels.length,4)
 assert.deepEqual(plain(result.panels.map(({id,col,row,w,h})=>({id,col,row,w,h}))).sort((a,b)=>a.id.localeCompare(b.id)),custom.geometry.toSorted((a,b)=>a.id.localeCompare(b.id)))
 assert.equal(f.c.savedTree({sceneId:'agent-center',geometry:result.panels}).tree.first.ratio,.63);assert.deepEqual(f.read().scenes['agent-center'],custom)
 const unknown={...scene,id:'user-defined'};assert.equal(f.c.migrateWorkflowDefaultLayout(unknown),unknown)
 const bad=legacy();bad.tree.first.first.id='files';const broken=layout({'agent-center':bad}),before=broken.storage.get('uiPanelSplitTree:v2');assert.equal(broken.c.migrateWorkflowDefaultLayout(scene),scene);assert.equal(broken.storage.get('uiPanelSplitTree:v2'),before);assert.equal(broken.c.validSplitTree(bad.tree,bad.geometry.map(p=>p.id)),false)
})
function element(){return{style:{},dataset:{},children:[],isConnected:true,hidden:false,setAttribute(){},addEventListener(){},removeEventListener(){},append(...nodes){this.children.push(...nodes)},replaceChildren(...nodes){this.children=nodes},contains(n){return this.children.includes(n)},closest(){return this.panel},getBoundingClientRect(){return{left:0,top:0,width:600,height:400}},querySelector(){return null},classList:{toggle(){},add(){}}}}
function bridge(mount){
 const source=read('business-bridge.js'),calls=[],observers=[],state={phase:'ready',sceneId:'agent-center',workflowMounted:false,config:{}},content=element();content.panel=element()
 const app={workflowCanvas:{mount,setBounds:async()=>calls.push('bounds'),setVisible:async v=>calls.push(v)}}
 const c={state,app,document:{createElement:element},nativePaneVisible:()=>true,routeForPath:()=>({route:{sceneId:'agent-center',panelId:'business-main'}}),renderBusinessPanel(){throw Error('hidden plan not allowed')},ResizeObserver:class{constructor(){observers.push(this)}observe(){this.observing=true}disconnect(){this.observing=false}}};vm.createContext(c)
 const start=source.indexOf('  async function syncWorkflow('),end=source.indexOf('  function renderWorkflowPanel(',start);vm.runInContext(source.slice(start,end)+fn(source,'renderWorkflowPanel'),c);return{c,content,calls,observers,state}
}
const tick=()=>new Promise(r=>setTimeout(r,0))
test('actual independent canvas mounts Host business-main, shows no tabs and cleans visibility',async()=>{
 const f=bridge(async()=>({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted',placement:'docked'}));const cleanup=f.c.renderWorkflowPanel({standaloneCanvas:true,title:'工作流画布'},f.content);await tick();assert.equal(f.content.children.length,1);assert.equal(f.content.children[0].dataset.workflowCanvasHost,'true');assert.ok(f.calls.includes(true));assert.equal(f.observers.length,1,JSON.stringify({calls:f.calls,note:f.state.workflowRecord.note.textContent,status:f.state.workflowRecord.status}));assert.equal(f.observers[0].observing,true);cleanup();await tick();assert.equal(f.content.children.length,0);assert.equal(f.calls.at(-1),false);assert.equal(f.observers[0].observing,false)
})
test('actual canvas late mount after cleanup is ignored and wrong owner stays visible error',async()=>{
 let complete;const pending=new Promise(r=>complete=r),f=bridge(()=>pending);const cleanup=f.c.renderWorkflowPanel({standaloneCanvas:true},f.content);cleanup();complete({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted'});await tick();assert.ok(!f.calls.includes(true));assert.equal(f.observers.length,0)
 const bad=bridge(async()=>({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'workflow-main',status:'context-mounted'}));bad.c.renderWorkflowPanel({standaloneCanvas:true},bad.content);await tick();assert.equal(bad.state.workflowRecord.note.dataset.state,'error');assert.equal(bad.state.workflowRecord.note.hidden,false)
})
// Execute the production scene commit before the production treeFor restore.
test('actual commitScene dispatches migration and treeFor restores the resulting five-leaf layout',()=>{
 const f=layout({'agent-center':legacy()}),panels=[],grid={style:{setProperty(){}}}
 Object.assign(f.c,{grid,activePanelDragCancel:null,currentTab:null,clearScene(){panels.length=0},makePanel(meta){panels.push({dataset:{panelId:meta.id},__meta:meta})},document:{querySelector(){return{}}},$(){return{}},tabListOf:()=>[],applyTabCollapse(){},updateSidebarScene(){},initialSceneCommit:null,resizeTrees:new Map()})
 f.c.window.businessBridge={sceneSelected(){}};const source=read('renderer.js'),start=source.indexOf('function commitScenario('),end=source.indexOf('\nfunction loadInitialScenario(',start)
 vm.runInContext(source.slice(start,end)+fn(read('panel-interactions.js'),'treeFor'),f.c)
 assert.equal(f.c.commitScenario(scene),true);assert.equal(panels.length,5)
 const geometry=panels.map(p=>{const{id,col,row,w,h}=p.__meta;return{id,col,row,w,h}}),restored=f.c.treeFor({sceneId:'agent-center',geometry,panels,signature:'synthetic-grid'})
 assert.equal(f.c.validSplitTree(restored.tree,geometry.map(p=>p.id)),true);assert.equal(panels.find(p=>p.dataset.panelId==='workflow-main').dataset.col,'2')
})
test('actual plan bridge resolves registered business-plan owner and cleanup does not hide canvas',async()=>{
 const f=bridge(async()=>({componentKey:'workflow-canvas-native',sceneId:'agent-center',panelId:'business-main',status:'context-mounted'})),config=JSON.parse(fs.readFileSync(new URL('../scenes.json',import.meta.url),'utf8'))
 const hostScene=config.scenes.find(s=>s.id==='agent-center');hostScene.panelMap=new Map(hostScene.panels.map(p=>[p.id,p]))
 f.state.config={raw:config,scenes:new Map([[hostScene.id,hostScene]])};f.c.allowedRoutes=new Set(['/agent-center'])
 f.c.stateNode=(content,text,status)=>{const note=element();note.textContent=text;note.dataset.state=status;content.replaceChildren(note);return note}
 vm.runInContext(fn(read('business-bridge.js'),'routeForPath')+fn(read('business-bridge.js'),'renderBusinessPanel'),f.c)
 const plan=element(),meta={...scene.panels.find(p=>p.id==='workflow-plan'),sceneId:'agent-center'},cleanup=f.c.renderBusinessPanel(meta,plan,'/agent-center')
 assert.equal(plan.children[0].dataset.tradeloomPanelId,'business-plan');assert.equal(plan.children[0].dataset.tradeloomBusinessSceneId,'agent-center');assert.equal(plan.children[0].src,'/business/agent-center')
 const canvas=element();canvas.panel=element();f.c.renderWorkflowPanel({standaloneCanvas:true},canvas);await tick();assert.ok(f.calls.includes(true));const before=f.calls.length;cleanup();assert.equal(plan.children.length,0);assert.equal(f.calls.length,before)
 hostScene.panelMap.delete('business-plan');const denied=element();f.c.renderBusinessPanel(meta,denied,'/agent-center');assert.equal(denied.children[0].dataset.state,'error')
})
const button=(tree,text)=>all(tree).find(n=>n.type==='button'&&label(n)===text)
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
 const old=structuredClone(host);old.panels=old.panels.filter(p=>p.id!=='business-plan');Object.assign(old.panels.find(p=>p.id==='business-main'),{col:1,w:3});const before=JSON.stringify(old);assert.equal(c.projectTrustedScene(old).panels.length,5);assert.equal(JSON.stringify(old),before)
 Object.assign(old.panels.find(p=>p.id==='business-main'),{w:2});const custom=c.projectTrustedScene(old);assert.equal(custom.panels.length,4);assert.equal(custom.workflowLayoutGap,'custom-legacy-layout');assert.equal(custom.panels.find(p=>p.id==='workflow-main').w,2)
 old.id='user-copy';old.templateSceneId='agent-center';assert.equal(c.projectTrustedScene(old).panels.length,4)
})
test('exact known old Host ID set excludes an additional legal custom panel from default migration',async()=>{
 const config=JSON.parse(fs.readFileSync(new URL('../scenes.json',import.meta.url),'utf8')),{validateSceneConfig}=await import('../scene-layout.js'),host=config.scenes.find(s=>s.id==='agent-center')
 host.panels=host.panels.filter(p=>p.id!=='business-plan');Object.assign(host.panels.find(p=>p.id==='business-main'),{col:1,w:3})
 const source=read('renderer.js'),start=source.indexOf('const hostPanelFor'),end=source.indexOf('function applyTrustedSceneConfiguration',start),c={configurationTemplates:sceneContext.window.__SCENES__.scenes};vm.createContext(c);vm.runInContext(source.slice(start,end),c)
 assert.equal(validateSceneConfig(config),config);assert.equal(host.panels.length,8);assert.equal(c.projectTrustedScene(host).panels.length,5)
 host.panels.push({id:'custom-workspace',type:'native-workspace',optional:true,title:'Custom',col:4,row:3,w:1,h:2})
 assert.equal(validateSceneConfig(config),config);const before=JSON.stringify(host),result=c.projectTrustedScene(host)
 assert.equal(result.workflowLayoutGap,'custom-legacy-layout');assert.equal(result.panels.length,4);assert.equal(result.panels.find(p=>p.id==='workflow-main').col,1);assert.equal(result.panels.find(p=>p.id==='workflow-main').w,3);assert.equal(JSON.stringify(host),before)
})
