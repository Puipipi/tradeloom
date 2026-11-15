import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { mkdir,mkdtemp,writeFile,readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createWorkflowNativeCommandAttribution } from '../workflow-native-command-attribution.js'
import { createWorkflowNativeUiGate } from '../workflow-native-ui-gate.js'
import { createStateStore,HOME_MARKER,HOME_MARKER_VALUE } from '../state.js'
import { ROLE_PRESETS } from '../roles.js'

const artifact=process.env.TL_NATIVE_SDK_ARTIFACT
const runtime=process.env.TL_NATIVE_SDK_RUNTIME
const enabled={skip:!(artifact&&runtime)}
const load=runtime&&createRequire(pathToFileURL(join(runtime,'package.json')))
const records={kind:'actual known public runtime and actual R UI gate/command attribution; controlled admission only, no Host/GUI/model/network',loaded:false,cases:{}}
async function record(name,value){records.cases[name]=value;await writeFile(join(artifact,'observations.json'),JSON.stringify(records,null,2)+'\n')}
let Context,SessionStore,AgentRegistry,SessionProjectionRegistry,SystemPrompt,AgentLoop,ToolsService,native,commands
try { if(!enabled.skip) {
 const version=load('./package.json').version;assert.ok(['0.2.1-rc.3','0.2.2-rc.2'].includes(version));records.runtime=version
 ;({Context}=load('@deepseek-ai/cordis'));({SessionStore}=load('@deepseek-ai/dsh-session'));({AgentRegistry}=load('@deepseek-ai/dsh-agent'));({SessionProjectionRegistry}=load('@deepseek-ai/dsh-session-projection'));({SystemPrompt}=load('@deepseek-ai/dsh-system-prompt'));({AgentLoop}=load('@deepseek-ai/dsh-agent-loop'));const toolModule=load('@deepseek-ai/dsh-tools');ToolsService=version==='0.2.1-rc.3'?toolModule.ToolRuntime:toolModule.ToolsService;if(version==='0.2.2-rc.2')native=load('@deepseek-ai/dsh-tool-executor-native');commands=load('@deepseek-ai/dsh-commands');records.loaded=true
 await writeFile(join(artifact,'load.json'),JSON.stringify({loaded:true,actualRuntime:load('./package.json').version,registryIsOwnedByType:typeof AgentRegistry.prototype.isOwnedBy},null,2)+'\n')
}
} catch(error) {
 await writeFile(join(artifact,'load.json'),JSON.stringify({loaded:false,name:error.name,code:error.code,message:error.message,stack:error.stack},null,2)+'\n');throw error
}

async function fixture(t,mode){
 await mkdir(join(artifact,'home'),{recursive:true});const home=await mkdtemp(join(artifact,'home',mode+'-'));await writeFile(join(home,HOME_MARKER),HOME_MARKER_VALUE)
 const stateStore=await createStateStore({env:{...process.env,DSH_HOME:home,TRADELOOM_DSH_APP_HOME:home}})
 const ctx=new Context();ctx.provide('llm',{async prepareCall(){throw new Error('isolated fixture must not request a model')}})
 await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);await ctx.plugin(SystemPrompt);await ctx.plugin(ToolsService);if(native)await ctx.plugin(native);await ctx.plugin(commands.default);await ctx.plugin(AgentLoop,{agents:[],maxParallelToolCalls:1})
 const agents=ctx.get('agents'),tools=ctx.get('tools');const parent=await ctx.get('agentLoop').create(mode+'-parent',{}, {agentPreset:ROLE_PRESETS.center})
 assert.equal(agents.get(parent.id),parent);assert.equal(parent.session.header.agentPreset,ROLE_PRESETS.center)
 const gate=createWorkflowNativeUiGate(ctx),attribution=createWorkflowNativeCommandAttribution(ctx,{uiGate:gate,createStateStore:async()=>stateStore})
 t.after(async()=>{attribution.dispose();gate.dispose();await ctx.fiber.dispose()})
 let lease,body,invocations=0,taskEntries=0;const runId='run-'+mode,identity={runId,source:'controlled native admission'},controller=new AbortController(),signal=controller.signal,isCurrent=()=>true,abortTask=()=>{}
 const output={schema:{type:'object',properties:{ok:{type:'boolean'}},required:['ok'],additionalProperties:false},render:()=>[]}
 tools.register({name:'tradeloom_wf_native_submit',description:'Controlled actual admission consumer',parameters:{type:'object',properties:{},additionalProperties:false},output,execute:async(_args,exec)=>{invocations++;lease=await attribution.bindTask(exec,{runId,identity});return {ok:true}}})
 tools.register({name:'subagent',description:'Isolated actual factory producer in a real native tools body',parameters:{type:'object',properties:{},additionalProperties:false},output,execute:async(_args,exec)=>{taskEntries++;return await body(exec)}})
 const intent=attribution.prepareTask({agent:parent,runId,identity,isCurrent,abortTask})
 const admission={agent:parent,runId,identity,name:'tradeloom_wf_native_submit',callId:'admit-'+mode,arguments:{},signal,isCurrent,abortTask,taskLease:intent}
 const accepted=await gate.withPending(admission,()=>attribution.executeCommand(admission));await record('admission-'+mode,{accepted,invocations,leaseCreated:Boolean(lease),contract:{batch:typeof tools.selectExecutor==='function',single:typeof tools.prepareExecution==='function'&&typeof tools.completeScheduledExecution==='function'}});assert.equal(accepted.isError,false);assert.ok(lease);assert.equal(invocations,1)
 const task=async fn=>{body=fn;return attribution.executeTask(lease,{agent:parent,name:'subagent',callId:'task-'+mode,arguments:{},signal})}
 const createChild=async(exec,id)=>{const handle=await exec.agent.ctx.get('agents').create({sessionId:id,meta:{parentSession:exec.agent.id},agentOptions:{}});assert.equal(agents.get(id),handle.agent);return handle}
 return {ctx,agents,parent,attribution,stateStore,task,createChild,signal,controller,get taskEntries(){return taskEntries}}
}

const attributionSource=await readFile(new URL('../workflow-native-command-attribution.js',import.meta.url),'utf8')
function helper(tools){
 const canonical=attributionSource.slice(attributionSource.indexOf('const rejected'),attributionSource.indexOf('const fingerprint'))
 const start=attributionSource.indexOf('  async function executeOne('),end=attributionSource.indexOf('\n  const matching',start)
 assert.ok(start>=0&&end>start)
 const contractStart=attributionSource.indexOf('  const batchExecution ='),contractEnd=attributionSource.indexOf('\n  const frames',contractStart)
 return runInNewContext(`${canonical}\n${attributionSource.slice(contractStart,contractEnd)}\n${attributionSource.slice(start,end)}\nexecuteOne`,{tools,Error,Object,Array,JSON,Number,Map})
}
test('result fence unit preserves receiver input identities and the exact single ToolResult including contexts and conclusion',async()=>{
 const result={isError:false,content:[],additionalContexts:[{fixture:'retained context'}],concludesTurn:true},agent={},signal=new AbortController().signal,toolSet={};let captured
 const tools={selectExecutor(){},async execute(input){assert.equal(this,tools);captured=input;return {results:[{callId:'unit-call',result}],additionalContexts:result.additionalContexts,concluded:true}}}
 assert.equal(await helper(tools)({agent,signal,toolSet,callId:'unit-call',name:'unit',arguments:{b:2,a:1}}),result)
 assert.equal(captured.agent,agent);assert.equal(captured.signal,signal);assert.equal(captured.toolSet,toolSet);assert.deepEqual(JSON.parse(captured.calls[0].arguments),{a:1,b:2});assert.equal(captured.calls[0].id,'unit-call');assert.equal(captured.calls[0].name,'unit')
})
for(const [label,results] of [['missing',undefined],['empty',[]],['multiple',[{callId:'unit-call',result:{isError:false,content:[]}},{callId:'unit-call',result:{isError:false,content:[]}}]],['wrong-id',[{callId:'other',result:{isError:false,content:[]}}]],['missing-result',[{callId:'unit-call'}]]])test(`result fence unit rejects ${label} without inventing success`,async()=>{await assert.rejects(helper({selectExecutor(){},execute:async()=>({results})})({agent:{},signal:new AbortController().signal,callId:'unit-call',name:'unit',arguments:{}}),/did not match/)})
test('result fence unit preserves thrown error and its partial settlement by identity',async()=>{const partial={results:[{callId:'earlier',result:{isError:false,content:[]}}]},error=Object.assign(new Error('actual boundary throws'),{partial});await assert.rejects(helper({selectExecutor(){},execute:async()=>{throw error}})({agent:{},signal:new AbortController().signal,callId:'unit-call',name:'unit',arguments:{}}),caught=>caught===error&&caught.partial===partial)})
test('result fence unit rejects non JSON arguments before calling tools',async()=>{let calls=0;const execute=helper({selectExecutor(){},execute:async()=>{calls++;throw new Error('must not dispatch')}});for(const args of [{n:NaN},{v:undefined},{fn(){}}])await assert.rejects(execute({agent:{},signal:new AbortController().signal,callId:'unit-call',name:'unit',arguments:args}),{code:'native_task_origin_required'});assert.equal(calls,0)})
test('result fence unit rejects unknown and ambiguous contracts without execution',()=>{let calls=0;for(const methods of [{},{selectExecutor(){},prepareExecution(){},completeScheduledExecution(){}}])assert.throws(()=>helper({...methods,execute(){calls++}}),/unsupported or ambiguous/);assert.equal(calls,0)})
test('result fence unit keeps the explicit legacy single contract receiver input and result object',async()=>{const result={isError:false,content:[],additionalContexts:[{fixture:'kept'}],concludesTurn:true},input={agent:{},signal:new AbortController().signal,callId:'single',name:'single',arguments:{value:1}};const tools={prepareExecution(){},completeScheduledExecution(){},async execute(value){assert.equal(this,tools);assert.equal(value,input);return result}};assert.equal(await helper(tools)(input),result)})

test('input adaptation reaches actual Command native admission bindTask and executeTask body with exact identities',enabled,async t=>{
 const f=await fixture(t,'input-body');let seen
 const result=await f.task(async exec=>{seen={agent:exec.agent===f.parent,signal:exec.signal===f.signal,callId:exec.callId,name:exec.name,args:exec.arguments};return {ok:true}})
 await record('input-body',{seen,result,taskEntries:f.taskEntries});assert.equal(result.isError,false);assert.equal(f.taskEntries,1);assert.deepEqual(seen,{agent:true,signal:true,callId:'task-input-body',name:'subagent',args:{}})
})
test('input adaptation retains actual structured denial info without invoking the task body',enabled,async t=>{
 const f=await fixture(t,'input-denial');f.ctx.on('tools/pre-execute',(exec,next)=>exec.name==='subagent'?{kind:'deny',reason:'isolated actual denial',info:{name:'ApprovalError',code:'APPROVAL_REJECTED'}}:next(),{global:true})
 const result=await f.task(async()=>{throw new Error('denied body must not run')});await record('input-denial',{result,taskEntries:f.taskEntries});assert.equal(result.isError,true);assert.equal(result.error.message,'isolated actual denial');assert.equal(result.error.info.name,'ApprovalError');assert.equal(result.error.info.code,'APPROVAL_REJECTED');assert.equal(f.taskEntries,0)
})
test('input adaptation retains actual cancellation before dispatch with no task body',enabled,async t=>{
 const f=await fixture(t,'input-cancel-before');f.ctx.on('tools/pre-execute',(exec,next)=>{if(exec.name==='subagent')f.controller.abort(new Error('controlled before dispatch'));return next()},{global:true})
 const result=await f.task(async()=>{throw new Error('cancelled body must not run')});await record('input-cancel-before',{result,taskEntries:f.taskEntries});assert.equal(result.isError,true);assert.equal(result.error.info.code,'ABORTED_BEFORE_DISPATCH');assert.equal(f.taskEntries,0)
})
test('input adaptation drains actual started body and preserves cancellation identity',enabled,async t=>{
 const f=await fixture(t,'input-cancel-body'),started=Promise.withResolvers(),go=Promise.withResolvers();let ended=false
 const pending=f.task(async exec=>{started.resolve();await go.promise;ended=true;exec.signal.throwIfAborted();return {ok:true}})
 await started.promise;f.controller.abort(new Error('controlled active cancellation'));go.resolve();const result=await pending;await record('input-cancel-body',{result,ended,taskEntries:f.taskEntries});assert.equal(ended,true);assert.equal(f.taskEntries,1);assert.equal(result.isError,true);assert.equal(result.error.info.code,'ABORTED');assert.match(result.error.message,/controlled active cancellation/)
})
test('input adaptation retains actual tool conclusion on the single result',enabled,async t=>{const f=await fixture(t,'input-conclude');const result=await f.task(async exec=>{exec.concludeTurn();return {ok:true}});await record('input-conclude',{result,taskEntries:f.taskEntries});assert.equal(result.isError,false);assert.equal(result.concludesTurn,true);assert.equal(f.taskEntries,1)})

test('owner boundary actual rc2 factory child in the real native task frame retains trusted parent scopes',enabled,async t=>{
 const f=await fixture(t,'valid');let inside,error,scopes,child
 const result=await f.task(async exec=>{
  const handle=await f.createChild(exec,'valid-child');child=handle.agent
  inside={exactParent:exec.agent===f.parent,exactChild:f.agents.get(child.id)===child,parentSession:child.session.header.parentSession,registryIsOwnedByType:typeof f.agents.isOwnedBy,producer:'exec.agent.ctx.agents.create -> actual AgentLoopFactory.createAgent'}
  try {scopes=f.attribution.scopesForChild(exec.agent,child.id)}catch(cause){error={name:cause.name,message:cause.message,stack:cause.stack};throw cause}
  return {ok:true}
 })
 await record('valid',{loaded:records.loaded,taskEntries:f.taskEntries,inside,error,scopes,result})
 assert.equal(f.taskEntries,1);assert.ok(inside.exactParent&&inside.exactChild);assert.equal(result.isError,false,'actual native tool must grant scopes to its genuinely created live child');assert.ok(scopes?.length)
})
test('owner boundary actual rc2 live factory child outside a native task frame acquires no scopes',enabled,async t=>{
 const f=await fixture(t,'no-frame');const h=await f.agents.create({sessionId:'outside-child',meta:{parentSession:f.parent.id},agentOptions:{}})
 const scopes=f.attribution.scopesForChild(f.parent,h.agent.id);await record('no-frame',{scopes:scopes??null,childLive:f.agents.get(h.agent.id)===h.agent});assert.equal(scopes,undefined)
})
test('owner boundary actual rc2 native task frame rejects a different live parent',enabled,async t=>{
 const f=await fixture(t,'wrong-parent'),other=await f.agents.create({sessionId:'other-live-parent',meta:{agentPreset:ROLE_PRESETS.center},agentOptions:{}});let scopes
 const result=await f.task(async exec=>{const child=await f.createChild(exec,'wrong-parent-child');scopes=f.attribution.scopesForChild(other.agent,child.agent.id);return {ok:true}})
 await record('wrong-parent',{scopes,result,taskEntries:f.taskEntries});assert.equal(result.isError,false);assert.deepEqual(scopes,[])
})
test('owner boundary actual rc2 native task frame rejects a disposed factory child',enabled,async t=>{
 const f=await fixture(t,'stale-child');let scopes,childAbsent
 const result=await f.task(async exec=>{const child=await f.createChild(exec,'stale-factory-child');await child.dispose();childAbsent=f.agents.get(child.agent.id)===undefined;scopes=f.attribution.scopesForChild(exec.agent,child.agent.id);return {ok:true}})
 await record('stale-child',{scopes,childAbsent,result,taskEntries:f.taskEntries});assert.ok(childAbsent);assert.equal(result.isError,false);assert.deepEqual(scopes,[])
})
