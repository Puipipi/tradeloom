import assert from 'node:assert/strict'
import {readFile} from 'node:fs/promises'
import {createRequire} from 'node:module'
import {runInNewContext} from 'node:vm'
import test from 'node:test'
import {createConfirmedWorkflowDefinition} from '../workflow-definition.js'
import {projectNativeWorkflowRun} from '../workflow-native-ui.js'

// Real React/JSDOM component, synthetic HTTP DTOs and explicit polling clock.
// No native executor, model, PostgreSQL, Host or business service is exercised.
const load=createRequire(import.meta.url)
const revision='sha256:'+'a'.repeat(64),runId='11111111-1111-4111-8111-111111111111'
const item=(id,agent)=>({id,kind:'agent',agent,title:id,instruction:'合成测试任务',position:{x:40,y:60}})
const documentFor=(count=2)=>({version:1,id:'workflow',title:'商品与市场协作',confirmed:true,source:'manual',nodes:[item('product-step','product'),...(count>1?[item('market-step','market')]:[])],edges:count>1?[{from:'product-step',to:'market-step'}]:[]})
function preparedFor(doc,{legacy=false}={}){
  const nodes=doc.nodes.map(n=>({id:n.id,roleId:n.agent,agentPreset:'preset-'+n.agent}))
  return{workflowId:doc.id,title:doc.title,eligible:true,confirmed:true,executionMode:'native_dsh',definitionRevision:revision,bindingRevision:'7',center:{roleId:'center',sessionId:'actual-center-binding',workspaceId:'actual-workspace',archiveState:'unarchived'},
    ...(legacy?{node:nodes[0]}:{graph:{nodeCount:nodes.length,edgeCount:doc.edges.length,maxConcurrent:1,roleIds:[...new Set(nodes.map(n=>n.roleId))],nodes},...(nodes.length===1?{node:nodes[0]}:{nodes})})}
}
function completedRun(doc){
  const nodes=doc.nodes.map((n,i)=>{const node={id:n.id,roleId:n.agent,agentPreset:'preset-'+n.agent,status:'done',attempt:1,attemptState:'settled',childId:'actual-child-'+i,nativeRunId:'actual-native-'+i,toolCallId:'actual-tool-'+i,output:'合成输出 '+n.id,error:'',settled:true,succeeded:true}
    node.terminalReceipt={source:'subagent/end',status:'completed',stopReason:'completed',workflowRunId:runId,nodeId:node.id,attempt:1,childId:node.childId,nativeRunId:node.nativeRunId,toolCallId:node.toolCallId,sequence:i+1};return node})
  return{id:runId,workflowId:doc.id,status:'done',revision:3,executionMode:'native_dsh',sessionId:'actual-center-binding',definitionRevision:revision,bindingRevision:'7',nodes,settled:true,succeeded:true,terminalReceipt:nodes.map(n=>n.terminalReceipt)}
}
function interruptedRun(doc=documentFor()){
  const run=completedRun(doc),node=run.nodes.at(-1)
  Object.assign(node,{status:'interrupted',succeeded:false});Object.assign(node.terminalReceipt,{status:'interrupted',stopReason:'aborted'})
  Object.assign(run,{status:'interrupted',succeeded:false,terminalReceipt:run.nodes.map(n=>n.terminalReceipt)})
  return run
}
const resumePlanFor=run=>({runId:run.id,expectedRunRevision:run.revision,definitionRevision:run.definitionRevision,bindingRevision:run.bindingRevision,resumePlanHash:'sha256:'+'c'.repeat(64),eligible:true,eligibleNodeIds:[run.nodes.at(-1).id],completedNodeIds:run.nodes.slice(0,-1).map(n=>n.id),blocked:[]})
async function fixture(t,{doc=documentFor(),prepared=preparedFor(doc),run=completedRun(doc),records=[run],prepareError,cancellation,resumePlan=resumePlanFor(run),resumeMode,resumeError}={}){
  const React=load(process.env.TRADELOOM_REACT_LIBRARY),{JSDOM}=load(process.env.TRADELOOM_DOM_MODULE)
  const{createRoot}=createRequire(process.env.TRADELOOM_REACT_SERVER_LIBRARY)('react-dom/client'),act=React.act
  const dom=new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>',{url:'http://owned.test',pretendToBeVisual:true})
  const previous={window:globalThis.window,document:globalThis.document,act:globalThis.IS_REACT_ACT_ENVIRONMENT}
  globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true
  dom.window.HTMLElement.prototype.scrollIntoView=function(){}
  let registration,root,timerId=0
  const timers=new Map(),requests=[];let resumeCalls=0,currentResumeError=resumeError
  const response=(action,extra,status=200)=>new Response(JSON.stringify({schemaVersion:1,ok:status<400,executionMode:'native_dsh',action,...extra}),{status})
  const fetch=async(url,options)=>{
    assert.equal(url,'/tradeloom/workflows/native');const body=JSON.parse(options.body);requests.push(body)
    if(body.action==='prepare')return prepareError?response(body.action,{error_code:prepareError},409):response(body.action,{prepared})
    if(body.action==='submit')return response(body.action,{operationId:body.operationId,submission:{runId,accepted:true,settled:false}},202)
    if(body.action==='get')return response(body.action,{run})
    if(body.action==='list')return response(body.action,{runs:records})
    if(body.action==='cancel')return response(body.action,{operationId:body.operationId,cancellation:cancellation??{runId,abortRequested:true,reason:'abort_requested',settled:false}})
    if(body.action==='prepare_resume')return response(body.action,{preparedResume:resumePlan})
    if(body.action==='resume'){
      resumeCalls++
      if(resumeMode==='lost-first'&&resumeCalls===1)throw new TypeError('Synthetic lost response; server outcome unknown')
      if(currentResumeError)return response(body.action,{error_code:currentResumeError.code},currentResumeError.status)
      return response(body.action,{operationId:body.operationId,resumption:{runId:resumeMode==='wrong-ack'?'22222222-2222-4222-8222-222222222222':runId,accepted:true,reused:resumeCalls>1,settled:false}},202)
    }
    throw Error('Unexpected action '+body.action)
  }
  dom.window.__ModuleLoader__={load:r=>registration=r}
  runInNewContext(await readFile(new URL('../client.workflow.js',import.meta.url),'utf8'),{
    window:dom.window,document:dom.window.document,fetch,AbortController,MutationObserver:dom.window.MutationObserver,
    getComputedStyle:dom.window.getComputedStyle.bind(dom.window),ResizeObserver:class { observe(){} disconnect(){} },setTimeout:(fn)=>{timers.set(++timerId,fn);return timerId},clearTimeout:id=>timers.delete(id),setInterval:()=>0,clearInterval:()=>{},console,
  })
  const component=registration.factory(id=>{assert.equal(id,'react');return React}).WorkflowCanvas
  const catalog={agents:[{id:'product',label:'商品助手'},{id:'market',label:'市场助手'}],kinds:[]}
  const render=async(next=doc)=>act(async()=>root.render(React.createElement(component,{initial:{doc:next,list:[next],catalog,editing:false}})))
  t.after(async()=>{if(root)await act(async()=>root.unmount());dom.window.close();globalThis.window=previous.window;globalThis.document=previous.document;globalThis.IS_REACT_ACT_ENVIRONMENT=previous.act})
  root=createRoot(dom.window.document.getElementById('root'));await render()
  const button=label=>[...dom.window.document.querySelectorAll('button')].find(b=>b.textContent===label||b.getAttribute('aria-label')===label)
  const click=async label=>{const b=button(label);assert(b,'button '+label);assert(!b.disabled,'button disabled: '+label);b.closest('details')?.setAttribute('open','');await act(async()=>{b.click();await Promise.resolve()})}
  const poll=async()=>{const next=timers.entries().next().value;assert(next,'expected scheduled status query');timers.delete(next[0]);await act(async()=>{next[1]();await Promise.resolve()})}
  return{doc,prepared,run,resumePlan,requests,button,click,poll,render,setResumeError:value=>currentResumeError=value,window:dom.window,text:()=>dom.window.document.body.textContent,panel:()=>dom.window.document.querySelector('.tl-wf-native')}
}

test('native canvas accepts a connected multi-agent graph and shows every prepared role without inventing panel/session identity',async t=>{
  const f=await fixture(t);await f.click('原生运行…')
  assert(f.button('确认并启动真实原生执行'))
  assert.match(f.panel().textContent,/2 个助手节点/)
  assert.match(f.panel().textContent,/product-step/);assert.match(f.panel().textContent,/market-step/)
  assert.match(f.panel().textContent,/商品助手/);assert.match(f.panel().textContent,/市场助手/)
  assert.match(f.panel().textContent,/实际并发上限 1/)
  assert.deepEqual(f.requests,[{action:'prepare',workflowId:'workflow'}])
  assert(!f.panel().textContent.includes('actual-child-'))
})

test('completed native text blocks render as text and unknown blocks remain unavailable',async t=>{
  const doc=documentFor(1),run=completedRun(doc)
  run.nodes[0].output=[{type:'text',text:'测试执行成功。<b>纯文本</b>'},{type:'image',text:'不显示未知块'}]
  const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/测试执行成功。<b>纯文本<\/b>/)
  assert.match(f.panel().textContent,/结果文本格式尚不可显示/)
  assert.doesNotMatch(f.panel().textContent,/不显示未知块/)
  assert.equal(f.panel().querySelector('pre b'),null)
})

test('legacy single-node prepare remains readable and confirmation sends only the established submit contract',async t=>{
  const doc=documentFor(1),f=await fixture(t,{doc,prepared:preparedFor(doc,{legacy:true})})
  await f.click('原生运行…');await f.click('确认并启动真实原生执行')
  assert.match(f.panel().textContent,/请求已接受，尚未核验执行结果/)
  assert(!f.panel().textContent.includes('已成功结束'))
  const submit=f.requests.find(r=>r.action==='submit')
  assert.deepEqual(Object.keys(submit).sort(),['action','workflowId','operationId','expectedDefinitionRevision','expectedBindingRevision','confirm'].sort())
  assert.equal(submit.expectedDefinitionRevision,revision);assert.equal(submit.expectedBindingRevision,'7')
  await f.poll();assert.match(f.panel().textContent,/已成功结束/)
})

test('legacy single-node run with no projected role/preset remains readable without borrowing current document identity',async t=>{
  const doc=documentFor(1),run=completedRun(doc)
  delete run.nodes[0].roleId;delete run.nodes[0].agentPreset
  const f=await fixture(t,{doc,prepared:preparedFor(doc,{legacy:true}),run})
  await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/已成功结束/)
  assert.match(f.panel().querySelector('[aria-label="原生节点 product-step"]').textContent,/角色未提供/)
})

test('multi-node status shows child, native-run and tool-call facts separately from center binding',async t=>{
  const f=await fixture(t);await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/已成功结束/)
  for(const value of ['actual-center-binding','actual-child-0','actual-child-1','actual-native-0','actual-tool-1'])assert(f.panel().textContent.includes(value),value)
  assert.match(f.panel().textContent,/面板：未提供/)
})

for(const mode of ['wrong-node','wrong-role','wrong-count','wrong-edge-count','wrong-role-order','missing-array','fake-single'])test('multi-node preparation refuses '+mode,async t=>{
  const doc=documentFor(),p=preparedFor(doc)
  if(mode==='wrong-node')p.graph.nodes[1].id='foreign'
  if(mode==='wrong-role')p.graph.nodes[1].roleId='product'
  if(mode==='wrong-count')p.graph.nodeCount=1
  if(mode==='wrong-edge-count')p.graph.edgeCount=0
  if(mode==='wrong-role-order')p.graph.roleIds.reverse()
  if(mode==='missing-array')delete p.nodes
  if(mode==='fake-single')p.node=p.nodes[0]
  const f=await fixture(t,{doc,prepared:p});assert(!f.button('原生运行…').disabled);await f.click('原生运行…')
  assert.match(f.panel().textContent,/原生返回格式无法核验/);assert(!f.button('确认并启动真实原生执行'))
})

test('history keeps a past definition and node list instead of imposing current canvas nodes',async t=>{
  const old=documentFor(),history=completedRun(old);history.definitionRevision='sha256:'+'b'.repeat(64)
  const current=documentFor(1);current.nodes[0].id='current-other-node'
  const f=await fixture(t,{doc:current,records:[history],run:history})
  await f.click('原生记录');await f.click('查看原生记录 1')
  assert.match(f.panel().textContent,/已成功结束/);assert.match(f.panel().textContent,/market-step/)
  assert(f.panel().textContent.includes(history.definitionRevision))
})

test('verified upstream failure and undelivered blocked child settle as failure, not successful child execution',async t=>{
  const doc=documentFor(),run=completedRun(doc),first=run.nodes[0],second=run.nodes[1]
  first.status='failed';first.succeeded=false;first.terminalReceipt={...first.terminalReceipt,status:'failed',stopReason:'error'}
  Object.assign(second,{status:'skipped',attempt:0,childId:null,nativeRunId:null,toolCallId:null,succeeded:false,output:'',terminalReceipt:{source:'native-run-journal',status:'skipped',reason:'UPSTREAM_FAILED',workflowRunId:runId,nodeId:second.id,blockedBy:[first.id],sequence:3}})
  run.status='failed';run.succeeded=false;run.terminalReceipt=run.nodes.map(n=>n.terminalReceipt)
  const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/已失败结束/);assert.match(f.panel().textContent,/上游失败，未派发/)
  assert(!f.panel().textContent.includes('actual-child-1'));assert(!f.panel().textContent.includes('已成功结束'))
})

test('a partial run with done status and missing receipt never becomes successful',async t=>{
  const doc=documentFor(),run=completedRun(doc)
  Object.assign(run.nodes[1],{settled:false,succeeded:false,terminalReceipt:null});run.settled=false;run.succeeded=false;run.terminalReceipt=null
  const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/尚无可核验终结回执/);assert(!f.panel().textContent.includes('已成功结束'))
})

for(const mode of ['foreign-node','foreign-run','old-attempt','wrong-child','fake-success','duplicate-node','blocked-with-child'])test('run projection refuses '+mode,async t=>{
  const doc=documentFor(),run=completedRun(doc),node=run.nodes[1]
  if(mode==='foreign-node')node.terminalReceipt.nodeId='foreign-node'
  if(mode==='foreign-run')node.terminalReceipt.workflowRunId='22222222-2222-4222-8222-222222222222'
  if(mode==='old-attempt')node.terminalReceipt.attempt=0
  if(mode==='wrong-child')node.terminalReceipt.childId='role-persistent-session'
  if(mode==='fake-success'){node.succeeded=false;run.succeeded=true}
  if(mode==='duplicate-node')node.id=run.nodes[0].id
  if(mode==='blocked-with-child'){node.succeeded=false;node.status='skipped';node.terminalReceipt={source:'native-run-journal',status:'skipped',reason:'UPSTREAM_FAILED',workflowRunId:runId,nodeId:node.id,blockedBy:[run.nodes[0].id],sequence:3};run.succeeded=false;run.status='failed'}
  run.terminalReceipt=run.nodes.map(n=>n.terminalReceipt)
  const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/原生返回格式无法核验/);assert(!f.panel().textContent.includes('已成功结束'))
})

test('closing native details returns focus and never cancels a run or edits the document',async t=>{
  const f=await fixture(t);const before=JSON.stringify(f.doc)
  await f.click('原生运行…');await f.click('关闭原生执行详情')
  assert.equal(f.panel(),null);assert.equal(JSON.stringify(f.doc),before)
  assert.equal(f.window.document.activeElement?.textContent,'执行');assert.equal(f.requests.length,1)
})

test('multi-node cancellation acknowledgement remains pending until real per-node terminal evidence arrives',async t=>{
  const doc=documentFor(),run=completedRun(doc)
  for(const node of run.nodes)Object.assign(node,{settled:false,succeeded:false,terminalReceipt:null,status:'running'})
  Object.assign(run,{settled:false,succeeded:false,terminalReceipt:null,status:'running'})
  const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行')
  await f.click('请求停止原生执行')
  assert.match(f.panel().textContent,/已收到停止请求回执，尚未核验终结/)
  assert(!f.panel().textContent.includes('已成功结束'));assert.equal(f.requests.filter(r=>r.action==='cancel').length,1)
  assert.deepEqual(Object.keys(f.requests.find(r=>r.action==='cancel')).sort(),['action','operationId','runId'])
  await f.poll();assert.match(f.panel().textContent,/尚无可核验终结回执/)
})

for(const code of ['unsupported_model_selection','upstream_terminal_unverified','upstream_output_unavailable','native_prompt_too_large'])test('fixed preparation failure remains actionable: '+code,async t=>{
  const f=await fixture(t,{prepareError:code});await f.click('原生运行…')
  assert(f.panel().querySelector('[role="alert"]'));assert(!f.button('确认并启动真实原生执行'))
  assert(!f.panel().textContent.includes('请检查当前权限与服务后手动重试'))
})

for(const mode of ['completed','upstream-failed','unknown'])test('current backend projector DTO renders in real component: '+mode,async t=>{
  const doc=documentFor(),definition=createConfirmedWorkflowDefinition(doc)
  const journal={id:runId,workflowId:doc.id,status:mode==='upstream-failed'?'failed':'done',executionMode:'native_dsh',journalSchema:'tradeloom.native-run-journal/v1',document:definition.document,definitionRevision:definition.definitionRevision,bindingRevision:'7',sessionId:'actual-center-binding',parentAgentId:'synthetic-parent',revision:3,nodes:{},events:[]}
  for(const [index,node]of doc.nodes.entries()){
    const raw={status:mode==='upstream-failed'?(index===0?'failed':'skipped'):'done',attempt:index===1&&mode==='upstream-failed'?0:1,attemptState:'settled',requestId:'request-'+index,toolCallId:'tool-'+index,childId:'child-'+index,nativeRunId:'native-'+index,output:'合成持久事件样本，非实际原生执行',error:''}
    journal.nodes[node.id]=raw
    const identity={workflowRunId:runId,nodeId:node.id,parentAgentId:journal.parentAgentId,sessionId:journal.sessionId,bindingRevision:'7',definitionRevision:journal.definitionRevision,sequence:index+1}
    if(index===1&&mode==='upstream-failed'){
      Object.assign(raw,{childId:null,nativeRunId:null,toolCallId:null,blockedBy:[doc.nodes[0].id]})
      journal.events.push({...identity,source:'native-run-journal',type:'node-blocked',status:'skipped',errorCategory:'UPSTREAM_FAILED',blockedBy:raw.blockedBy})
    }else if(mode!=='unknown'||index===0){
      const failed=mode==='upstream-failed'
      journal.events.push({...identity,source:'subagent/end',type:failed?'node-error':'node-terminal',status:failed?'failed':'done',stopReason:failed?'error':'completed',attempt:1,requestId:raw.requestId,toolCallId:raw.toolCallId,childId:raw.childId,nativeRunId:raw.nativeRunId})
    }
  }
  const run=projectNativeWorkflowRun(journal),prepared=preparedFor(doc)
  prepared.definitionRevision=run.definitionRevision
  for(const [index,node]of prepared.graph.nodes.entries())node.agentPreset=run.nodes[index].agentPreset
  const f=await fixture(t,{doc,prepared,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert(!f.panel().querySelector('[role="alert"]'))
  assert.equal(f.panel().querySelectorAll('.tl-wf-native-node').length,2)
  if(mode==='completed')assert.match(f.panel().textContent,/已成功结束/)
  else if(mode==='upstream-failed')assert.match(f.panel().textContent,/上游失败，未派发/)
  else{assert.match(f.panel().textContent,/结束回执尚未核验/);assert(!f.panel().textContent.includes('已成功结束'))}
})

async function history(f){await f.click('原生记录');await f.click('查看原生记录 1')}
test('resume preparation lists eligible and retained nodes without dispatching until explicit confirmation',async t=>{
  const f=await fixture(t,{run:interruptedRun()});await history(f);await f.click('检查恢复条件')
  assert.match(f.panel().textContent,/可恢复节点/);assert.match(f.panel().textContent,/本次保留、不重跑/)
  assert(f.button('确认恢复所列节点'));assert.equal(f.requests.filter(r=>r.action==='resume').length,0)
  assert.deepEqual(f.requests.find(r=>r.action==='prepare_resume'),{action:'prepare_resume',runId})
  await f.click('确认恢复所列节点')
  const body=f.requests.find(r=>r.action==='resume')
  assert.deepEqual(Object.keys(body).sort(),['action','runId','operationId','expectedRunRevision','expectedDefinitionRevision','expectedBindingRevision','resumePlanHash','confirm'].sort())
  assert.equal(body.confirm,true);assert.equal(body.expectedRunRevision,3);assert.equal(body.resumePlanHash,f.resumePlan.resumePlanHash)
  assert.match(f.panel().textContent,/恢复请求已接受，尚未核验执行结果/);assert(!f.panel().textContent.includes('已成功结束'))
})

test('lost resume response retries exactly the same operation after close and reopen, without a new plan',async t=>{
  const f=await fixture(t,{run:interruptedRun(),resumeMode:'lost-first'});await history(f);await f.click('检查恢复条件');await f.click('确认恢复所列节点')
  assert(f.button('重试同一次恢复请求'));await f.click('关闭原生执行详情');await f.click('原生运行…')
  await f.click('重试同一次恢复请求')
  const requests=f.requests.filter(r=>r.action==='resume');assert.equal(requests.length,2);assert.deepEqual(requests[0],requests[1])
  assert.equal(f.requests.filter(r=>r.action==='prepare_resume').length,1)
  assert.match(f.panel().textContent,/恢复请求已接受，尚未核验执行结果/)
})

test('reading status after a lost resume response does not discard its retry operation',async t=>{
  const f=await fixture(t,{run:interruptedRun(),resumeMode:'lost-first'});await history(f);await f.click('检查恢复条件');await f.click('确认恢复所列节点')
  await f.click('重新查询原生状态');assert(f.button('重试同一次恢复请求'))
  await f.click('重试同一次恢复请求')
  const requests=f.requests.filter(r=>r.action==='resume');assert.deepEqual(requests[0],requests[1])
})

test('resume acknowledgement keeps keyboard focus inside details after removing its confirmation button',async t=>{
  const f=await fixture(t,{run:interruptedRun()});await history(f);await f.click('检查恢复条件')
  f.button('确认恢复所列节点').focus();await f.click('确认恢复所列节点')
  assert(f.panel().contains(f.window.document.activeElement),'removing a pending action must not leave focus on body')
})

for(const reason of ['run_not_interrupted','child_terminal_unverified','run_active_in_service'])test('resume blocker is displayed without a confirm action: '+reason,async t=>{
  const run=interruptedRun(),plan=resumePlanFor(run)
  plan.eligible=false;plan.blocked=[{nodeId:reason==='child_terminal_unverified'?run.nodes[1].id:null,reason}]
  if(reason==='child_terminal_unverified')plan.eligibleNodeIds=[]
  const f=await fixture(t,{run,resumePlan:plan});await history(f);await f.click('检查恢复条件')
  assert(!f.button('确认恢复所列节点'));assert.match(f.panel().textContent,/暂不能恢复/)
  assert(!f.panel().textContent.includes('原生返回格式无法核验'));assert.equal(f.requests.filter(r=>r.action==='resume').length,0)
})

for(const mode of ['wrong-run','bad-hash','bad-revision','wrong-definition','wrong-binding','foreign-node','overlap','blocked-eligible'])test('resume plan refuses '+mode,async t=>{
  const run=interruptedRun(),plan=resumePlanFor(run)
  if(mode==='wrong-run')plan.runId='22222222-2222-4222-8222-222222222222'
  if(mode==='bad-hash')plan.resumePlanHash='unverified'
  if(mode==='bad-revision')plan.expectedRunRevision=0
  if(mode==='wrong-definition')plan.definitionRevision='sha256:'+'d'.repeat(64)
  if(mode==='wrong-binding')plan.bindingRevision='8'
  if(mode==='foreign-node')plan.eligibleNodeIds=['foreign']
  if(mode==='overlap')plan.completedNodeIds.push(plan.eligibleNodeIds[0])
  if(mode==='blocked-eligible')plan.blocked=[{nodeId:null,reason:'run_active_in_service'}]
  const f=await fixture(t,{run,resumePlan:plan});await history(f);await f.click('检查恢复条件')
  assert.match(f.panel().textContent,/原生返回格式无法核验/);assert(!f.button('确认恢复所列节点'))
})

test('definitive resume revision conflict requires a new explicit plan and a new operation',async t=>{
  const f=await fixture(t,{run:interruptedRun(),resumeError:{status:409,code:'resume_revision_conflict'}})
  await history(f);await f.click('检查恢复条件');await f.click('确认恢复所列节点')
  assert.match(f.panel().textContent,/运行记录已变化/);assert(!f.button('重试同一次恢复请求'))
  f.setResumeError(null);await f.click('检查恢复条件');await f.click('确认恢复所列节点')
  const requests=f.requests.filter(r=>r.action==='resume');assert.equal(requests.length,2);assert.notEqual(requests[0].operationId,requests[1].operationId)
})

test('an unverifiable resume acknowledgement retains the same retry identity and never claims completion',async t=>{
  const f=await fixture(t,{run:interruptedRun(),resumeMode:'wrong-ack'});await history(f);await f.click('检查恢复条件');await f.click('确认恢复所列节点')
  assert.match(f.panel().textContent,/原生返回格式无法核验/);assert(f.button('重试同一次恢复请求'));assert(!f.panel().textContent.includes('已成功结束'))
})

test('a new cancel after resume uses a fresh operation instead of replaying the previous activation cancel',async t=>{
  const run=interruptedRun();run.settled=false;run.terminalReceipt=null
  Object.assign(run.nodes[1],{settled:false,terminalReceipt:null})
  const f=await fixture(t,{run});await history(f);await f.click('请求停止原生执行')
  await f.click('检查恢复条件');await f.click('确认恢复所列节点');await f.click('请求停止原生执行')
  const requests=f.requests.filter(r=>r.action==='cancel');assert.equal(requests.length,2);assert.notEqual(requests[0].operationId,requests[1].operationId)
})

test('completed runs cannot offer an executable resume and remain intact',async t=>{
  const f=await fixture(t);await history(f)
  assert(!f.button('检查恢复条件')||f.button('检查恢复条件').disabled)
  assert.equal(f.requests.filter(r=>r.action==='prepare_resume'||r.action==='resume').length,0)
})

test('canvas keeps accepted native submission unknown until validated node status arrives',async t=>{
  const f=await fixture(t);await f.click('原生运行…');await f.click('确认并启动真实原生执行')
  const canvas=()=>f.window.document.querySelector('.tl-wf')
  assert.equal(canvas().dataset.stateOwner,'native')
  assert.equal(canvas().querySelectorAll('.tl-wf-node.is-done').length,0)
  assert.equal(canvas().querySelectorAll('.tl-wf-node.is-unknown').length,2)
  await f.poll()
  assert.equal(canvas().querySelectorAll('.tl-wf-node.is-done').length,2)
  assert.equal(canvas().querySelectorAll('.tl-wf-edge.is-done').length,1)
  assert.match(canvas().querySelector('.tl-wf-source').textContent,/原生运行/)
})

for(const status of ['running','waiting'])test('canvas projects native '+status+' and never offers mock decide buttons',async t=>{
    const doc=documentFor(),run=completedRun(doc)
    Object.assign(run,{status,settled:false,succeeded:false,terminalReceipt:null})
    Object.assign(run.nodes[1],{status,settled:false,succeeded:false,terminalReceipt:null})
    const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
    assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-'+status).length,1)
    assert.equal(f.window.document.querySelectorAll('.tl-wf-edge.is-flowing').length,1)
    assert.equal(f.window.document.querySelectorAll('.tl-wf-quick-btn').length,0)
    assert.equal(f.requests.filter(r=>r.action==='decide').length,0)
})

test('canvas never paints an unverified done string as successful completion',async t=>{
  const doc=documentFor(),run=completedRun(doc)
  Object.assign(run,{status:'running',settled:false,succeeded:false,terminalReceipt:null})
  Object.assign(run.nodes[1],{status:'done',settled:false,succeeded:false,terminalReceipt:null})
  const f=await fixture(t,{doc,run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert(f.window.document.querySelector('[data-node-id="product-step"]').classList.contains('is-done'))
  assert(f.window.document.querySelector('[data-node-id="market-step"]').classList.contains('is-unknown'))
  assert(!f.window.document.querySelector('[data-node-id="market-step"]').classList.contains('is-done'))
})

test('canvas does not borrow node identity for legacy missing-role status',async t=>{
  const doc=documentFor(1),run=completedRun(doc);delete run.nodes[0].roleId;delete run.nodes[0].agentPreset
  const f=await fixture(t,{doc,prepared:preparedFor(doc,{legacy:true}),run})
  await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/已成功结束/)
  assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-done').length,0)
})

test('canvas does not paint a historical run onto the current definition',async t=>{
  const f=await fixture(t);await history(f)
  assert.notEqual(f.window.document.querySelector('.tl-wf').dataset.stateOwner,'native')
  assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-done').length,0)
})

test('canvas keeps foreign binding status unknown rather than borrowing the current graph',async t=>{
  const run=completedRun(documentFor());run.bindingRevision='8'
  const f=await fixture(t,{run});await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  assert.match(f.panel().textContent,/原生返回格式无法核验/)
  assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-done').length,0)
  assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-unknown').length,2)
})

test('closing native details preserves current graph status and never cancels execution',async t=>{
  const f=await fixture(t);await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  await f.click('关闭原生执行详情')
  assert.equal(f.window.document.querySelector('.tl-wf').dataset.stateOwner,'native')
  assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-done').length,2)
  assert.equal(f.requests.filter(r=>['cancel','decide'].includes(r.action)).length,0)
})

test('opening a node draft revokes graph projection without dispatching a new task',async t=>{
  const f=await fixture(t);await f.click('原生运行…');await f.click('确认并启动真实原生执行');await f.poll()
  const React=load(process.env.TRADELOOM_REACT_LIBRARY),node=f.window.document.querySelector('[data-node-id="product-step"]')
  await React.act(async()=>{node.dispatchEvent(new f.window.MouseEvent('dblclick',{bubbles:true}))})
  assert.notEqual(f.window.document.querySelector('.tl-wf').dataset.stateOwner,'native')
  assert.equal(f.window.document.querySelectorAll('.tl-wf-node.is-done').length,0)
  assert.equal(f.requests.filter(r=>['submit','decide'].includes(r.action)).length,1)
})

function artifactEvidence(node,declarations=[{sourceSessionSeq:12,fileIndex:0,presentCallId:'present-call-1',sourceTurn:2,path:'C:/合成资料/商品说明.md',description:'合成文件声明，不证明文件存在'}]) {
 return {schema:'tradeloom.presented-evidence/v1',range:{childSessionId:node.childId,nativeRunId:node.nativeRunId,startInclusive:10,endExclusive:20},declarations}
}
test('native artifact declarations remain unknown when optional DTO fields are absent',async t=>{
 const f=await fixture(t);await history(f)
 const group=f.window.document.querySelector('[aria-label="节点 product-step 的文件声明"]')
 assert(group);assert.match(group.textContent,/产物信息未知/)
 assert.equal(group.querySelectorAll('a,button,img,iframe,video').length,0)
})
test('native artifact declared empty is distinct from unknown',async t=>{
 const doc=documentFor(),run=completedRun(doc),node=run.nodes[0]
 Object.assign(node,{artifactState:'declared',artifactEvidence:artifactEvidence(node,[])})
 const f=await fixture(t,{doc,run});await history(f)
 const group=f.window.document.querySelector('[aria-label="节点 product-step 的文件声明"]')
 assert.match(group.textContent,/本次执行无文件声明/);assert(!group.textContent.includes('产物信息未知'))
})
test('native artifact card shows literal path and provenance without inventing preview capability',async t=>{
 const doc=documentFor(),run=completedRun(doc),node=run.nodes[0]
 const evidence=artifactEvidence(node);evidence.declarations[0].path='javascript:<img src=x onerror=alert(1)>/商品说明.md'
 Object.assign(node,{artifactState:'declared',artifactEvidence:evidence})
 const f=await fixture(t,{doc,run});await history(f)
 const group=f.window.document.querySelector('[aria-label="节点 product-step 的文件声明"]')
 assert.match(group.textContent,/商品说明.md/);assert(group.textContent.includes(evidence.declarations[0].path))
 assert.match(group.textContent,/仅为执行声明/);assert.match(group.textContent,/12/)
 assert.equal(group.querySelectorAll('a,button,img,iframe,video').length,0)
 assert.equal(f.requests.filter(r=>!['list','get'].includes(r.action)).length,0)
})
for(const malformed of ['foreign-child','foreign-native','invalid-row','not-terminal'])test('native artifact display rejects '+malformed,async t=>{
 const doc=documentFor(),run=completedRun(doc),node=run.nodes[0],evidence=artifactEvidence(node)
 Object.assign(node,{artifactState:'declared',artifactEvidence:evidence})
 if(malformed==='foreign-child')evidence.range.childSessionId='another-child'
 if(malformed==='foreign-native')evidence.range.nativeRunId='another-activation'
 if(malformed==='invalid-row')evidence.declarations[0].path={unsafe:'not text'}
 if(malformed==='not-terminal'){Object.assign(node,{status:'running',settled:false,succeeded:false,terminalReceipt:null});Object.assign(run,{status:'running',settled:false,succeeded:false,terminalReceipt:null})}
 const f=await fixture(t,{doc,run});await history(f)
 const group=f.window.document.querySelector('[aria-label="节点 product-step 的文件声明"]')
 assert.match(group.textContent,/产物信息未知/);assert.equal(group.querySelectorAll('.tl-wf-artifact-card').length,0)
})
test('interrupted native execution can show declarations without claiming successful output',async t=>{
 const doc=documentFor(),run=interruptedRun(doc),node=run.nodes[1]
 Object.assign(node,{artifactState:'declared',artifactEvidence:artifactEvidence(node)})
 const f=await fixture(t,{doc,run});await history(f)
 const group=f.window.document.querySelector('[aria-label="节点 market-step 的文件声明"]')
 assert.match(group.textContent,/文件声明/);assert.match(group.textContent,/商品说明.md/)
 assert.match(f.panel().textContent,/中止记录/);assert(!group.textContent.includes('已成功'))
})
test('native artifact declared empty supports the validator allowed empty sequence range',async t=>{
 const doc=documentFor(),run=completedRun(doc),node=run.nodes[0],evidence=artifactEvidence(node,[])
 evidence.range.endExclusive=evidence.range.startInclusive
 Object.assign(node,{artifactState:'declared',artifactEvidence:evidence})
 const f=await fixture(t,{doc,run});await history(f)
 const group=f.window.document.querySelector('[aria-label="节点 product-step 的文件声明"]')
 assert.match(group.textContent,/本次执行无文件声明/)
})
