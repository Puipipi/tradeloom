import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import { mkdtemp, mkdir, realpath, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
import { createNativeArtifactHandler, NATIVE_ARTIFACT_COLLECTION, NATIVE_ARTIFACT_FILE } from '../workflow-native-artifact-http.js'
const runId='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
function fixture(root) {
 const doc={version:1,id:'workflow',title:'Workflow',confirmed:true,nodes:[{id:'task',kind:'agent',agent:'product',title:'Task'}],edges:[]}
 const {document,definitionRevision}=createConfirmedWorkflowDefinition(doc), start={childSessionId:'child',nativeRunId:'native',startInclusive:10}
 const declaration={sourceSessionSeq:10,fileIndex:0,presentCallId:'call',sourceTurn:1,path:'file.txt'}, evidence={schema:'tradeloom.presented-evidence/v1',range:{...start,endExclusive:11},declarations:[declaration]}
 const node={status:'done',attempt:1,requestId:'request',toolCallId:'tool',childId:'child',nativeRunId:'native',artifactRangeStart:start,artifactSource:'deliverables/presented',artifactEvidence:evidence,artifacts:[declaration]}
 const run={id:runId,workflowId:'workflow',document,definitionRevision,bindingRevision:'1',sessionId:'parent',parentAgentId:'parent',executionMode:'native_dsh',journalSchema:'tradeloom.native-run-journal/v1',status:'done',revision:2,nodes:{task:node},events:[]}
 run.events.push({source:'subagent/end',type:'node-terminal',status:'done',stopReason:'completed',workflowRunId:runId,nodeId:'task',attempt:1,requestId:'request',toolCallId:'tool',childId:'child',nativeRunId:'native',parentAgentId:'parent',sessionId:'parent',bindingRevision:'1',definitionRevision,artifactSource:'deliverables/presented',artifactEvidence:structuredClone(evidence),artifacts:[structuredClone(declaration)]})
 const parent={id:'parent',session:{id:'parent'}}, fs={processPathFromHostPath:p=>p,resolve:async p=>({path:await realpath(p)}),processPath:t=>t.path}
 const stat=async()=>({absolutePath:path.join(root,'file.txt'),version:'v1',bytes:5})
 const services={fs,directoryPicker:{capability:()=>({kind:'native',pick:async()=>root})},workspaceFiles:{stat,readBytes:async()=>({...await stat(),offset:0,data:new Uint8Array(await readFile(path.join(root,'file.txt'))),eof:true})},sessionQuery:{readEvent:async()=>({session:{id:'child',cwd:root},target:{seq:10,type:'deliverables/presented',data:{turn:1,callId:'call',files:[{path:'file.txt'}]}}})}}
 const ctx={connection:{requestRejection:()=>undefined},get:name=>services[name]}, access={center:async()=>parent,tool:async()=>structuredClone(run)}
 return {ctx,access,run,services,parent}
}
async function call(bridge,url,method='GET',value) {
 const req=Readable.from(value ? [Buffer.from(JSON.stringify(value))] : []);req.url=url;req.method=method;req.complete=true
 class Res extends EventEmitter {constructor(){super();this.headers={};this.writableEnded=false}setHeader(k,v){this.headers[k]=v}end(v){this.data=v;this.writableEnded=true}}
 const res=new Res();await bridge.handle(req,res);return res
}
const input={runId,nodeId:'task',attempt:1,sourceSessionSeq:10,fileIndex:0}
const version={id,runId,nodeId:'task',attempt:1,name:'file.txt',mimeType:'text/plain',byteSize:5,sha256:'2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',source:{sessionId:'child',seq:10,index:0,callId:'call',turn:1},availability:'ready',previewSupported:true}
test('one-shot native directory grant sends only verified bytes and no private paths to UI',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root);let request, confirmation
 const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async value=>{confirmation=value;return 'allowed-once'},backend:async (...args)=>{request=args;return {status:201,data:Buffer.from(JSON.stringify(version)),headers:{}}}})
 const res=await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input);assert.equal(res.statusCode,200);assert.match(request[2].toString(),/hello/);assert.equal(String(res.data).includes(root),false);assert.doesNotMatch(String(res.data),/rootScope|native-bridge/);assert.equal(JSON.parse(res.data).version.source.sessionId,'child');assert.equal(confirmation.presentCallId,'call');assert.equal(confirmation.sourceTurn,1);assert.equal(Object.isFrozen(confirmation),true)
 bridge.dispose()
})
test('list, wrong owner and unavailable services fail closed without leaking inputs',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root), bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>({status:200,data:Buffer.from(JSON.stringify({runId,items:[version],nextOffset:null})),headers:{}})})
 const list=await call(bridge,`${NATIVE_ARTIFACT_COLLECTION}?runId=${runId}`);assert.equal(list.statusCode,200);assert.match(JSON.parse(list.data).items[0].downloadUrl,/^\/tradeloom\//)
 f.run.parentAgentId='other';assert.equal((await call(bridge,`${NATIVE_ARTIFACT_COLLECTION}?runId=${runId}`)).statusCode,503)
 f.run.parentAgentId='parent';delete f.services.directoryPicker;assert.equal((await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)).statusCode,503)
 bridge.dispose()
})
test('link escape, changing event and disposal do not dispatch backend',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));const outside=path.join(root,'outside');await mkdir(outside);await writeFile(path.join(outside,'target'),'hello');await symlink(path.join(outside,'target'),path.join(root,'file.txt'),'file')
 const f=fixture(root);let calls=0;const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>{calls++;throw Error('should not dispatch')}})
 assert.equal((await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)).statusCode,503);assert.equal(calls,0)
 bridge.dispose();assert.equal((await call(bridge,`${NATIVE_ARTIFACT_FILE}?runId=${runId}&id=${id}&action=download`)).statusCode,503)
})
test('changed event, native chooser cancellation and changed file version never submit',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 for(const mode of ['event','cancel','version','owner','mapping']) {
  const f=fixture(root);let calls=0
  if(mode==='event')f.services.sessionQuery.readEvent=async()=>({session:{id:'child',cwd:root},target:{seq:10,type:'deliverables/presented',data:{turn:1,callId:'other',files:[{path:'file.txt'}]}}})
  if(mode==='cancel')f.services.directoryPicker.capability=()=>({kind:'native',pick:async()=>null})
  if(mode==='version')f.services.workspaceFiles.readBytes=async()=>({absolutePath:path.join(root,'file.txt'),version:'changed',bytes:5,offset:0,eof:true,data:new TextEncoder().encode('hello')})
  if(mode==='owner'){let count=0;f.access.center=async()=>++count>2?{id:'new',session:{id:'new'}}:f.parent}
  if(mode==='mapping')f.services.fs.processPathFromHostPath=()=>undefined
  const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>{calls++;throw Error('private detail')}})
  const response=await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)
  assert.equal(response.statusCode,503,mode);assert.equal(calls,0,mode);assert.doesNotMatch(String(response.data),/private detail|rootScope/);bridge.dispose()
 }
})
test('safe bytes are served only after owner recheck and unsafe preview is refused',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root);const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>({status:200,headers:{'content-type':'image/png'},data:Buffer.from('hello')})})
 const url=`${NATIVE_ARTIFACT_FILE}?runId=${runId}&id=${id}&action=preview`
 const response=await call(bridge,url);assert.equal(response.statusCode,200);assert.equal(response.headers['cache-control'],'no-store');assert.equal(response.headers['x-content-type-options'],'nosniff');assert.equal(response.data.toString(),'hello');bridge.dispose()
 const blocked=createNativeArtifactHandler({...f.ctx,connection:{requestRejection:()=>401}},{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>{throw Error('private')}})
 assert.equal((await call(blocked,url)).statusCode,401);blocked.dispose()
})
test('event replacement during chooser and changed source after backend are never accepted',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 for(const when of ['chooser','backend']) {
  const f=fixture(root);let reads=0,calls=0
  f.services.sessionQuery.readEvent=async()=>({session:{id:'child',cwd:root},target:{seq:10,type:'deliverables/presented',data:{turn:1,callId:++reads>(when==='chooser'?1:3)?'changed':'call',files:[{path:'file.txt'}]}}})
  const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>{calls++;return {status:201,data:Buffer.from(JSON.stringify(version)),headers:{}}}})
  const result=await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input);assert.equal(result.statusCode,503,when);if(when==='chooser')assert.equal(calls,0);bridge.dispose()
 }
})
test('backend metadata from another source or incorrect content hash is not returned',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 for(const bad of [{...version,sha256:'0'.repeat(64)},{...version,source:{...version.source,sessionId:'other'}}]) {
  const f=fixture(root), bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>({status:201,data:Buffer.from(JSON.stringify(bad)),headers:{}})})
  assert.equal((await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)).statusCode,503);bridge.dispose()
 }
})
test('directory selection alone never grants reading or backend import',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root);let reads=0,sends=0;const original=f.services.workspaceFiles.readBytes;f.services.workspaceFiles.readBytes=async(...args)=>{reads++;return original(...args)}
 const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,backend:async()=>{sends++;return {status:201,data:Buffer.from(JSON.stringify(version)),headers:{}}}})
 const response=await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)
 assert.equal(response.statusCode,503);assert.equal(reads,0);assert.equal(sends,0);bridge.dispose()
})
test('one-shot confirmation denial and ownership changes prevent reads',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 for(const mode of ['denied','cancelled','owner','source']) {
  const f=fixture(root);let reads=0,sends=0;const original=f.services.workspaceFiles.readBytes;f.services.workspaceFiles.readBytes=async(...args)=>{reads++;return original(...args)}
  const consent=async()=>{if(mode==='owner')f.run.parentAgentId='other';if(mode==='source')f.services.sessionQuery.readEvent=async()=>({session:{id:'child',cwd:root},target:{seq:10,type:'deliverables/presented',data:{turn:1,callId:'changed',files:[{path:'file.txt'}]}}});return mode==='denied'?'denied':mode==='cancelled'?null:'allowed-once'}
  const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:consent,backend:async()=>{sends++;throw Error('private')}})
  const response=await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input);assert.equal(response.statusCode,503,mode);assert.equal(reads,0,mode);assert.equal(sends,0,mode);bridge.dispose()
 }
})
test('optional stat size is accepted when actual bounded bytes and versions match',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root);f.services.workspaceFiles.stat=async()=>({absolutePath:path.join(root,'file.txt'),version:'v1'});f.services.workspaceFiles.readBytes=async()=>({absolutePath:path.join(root,'file.txt'),version:'v1',offset:0,data:new TextEncoder().encode('hello'),eof:true})
 const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>({status:201,data:Buffer.from(JSON.stringify(version)),headers:{}})})
 assert.equal((await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)).statusCode,200);bridge.dispose()
})
test('invalid pagination and boolean confirmation never authorize',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root);let reads=0;const original=f.services.workspaceFiles.readBytes;f.services.workspaceFiles.readBytes=async(...args)=>{reads++;return original(...args)}
 const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=>true,backend:async()=>({status:200,data:Buffer.from(JSON.stringify({runId,items:[version],nextOffset:-1})),headers:{}})})
 assert.equal((await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)).statusCode,503);assert.equal(reads,0)
 assert.equal((await call(bridge,`${NATIVE_ARTIFACT_COLLECTION}?runId=${runId}`)).statusCode,503);bridge.dispose()
})
test('disposal aborts pending chooser before any read or backend',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 const f=fixture(root);let started;const pending=new Promise(resolve=>{started=resolve});let reads=0,sends=0
 f.services.directoryPicker.capability=()=>({kind:'native',pick:async signal=>{started();return await new Promise(resolve=>signal.addEventListener('abort',()=>resolve(null),{once:true}))}})
 f.services.workspaceFiles.readBytes=async()=>{reads++;throw Error('private')}
 const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>{sends++;throw Error('private')}})
 const result=call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input);await pending;bridge.dispose();await result;assert.equal(reads,0);assert.equal(sends,0)
})

test('wrong session or event sequence is rejected before file reads and import',async t=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'artifact-host-'));t.after(()=>rm(root,{recursive:true,force:true}));await writeFile(path.join(root,'file.txt'),'hello')
 for(const mode of ['session','sequence']) {
  const f=fixture(root);let reads=0,sends=0
  f.services.sessionQuery.readEvent=async()=>({session:{id:mode==='session'?'other':'child',cwd:root},target:{seq:mode==='sequence'?11:10,type:'deliverables/presented',data:{turn:1,callId:'call',files:[{path:'file.txt'}]}}})
  f.services.workspaceFiles.readBytes=async()=>{reads++;throw Error('unexpected')}
  const bridge=createNativeArtifactHandler(f.ctx,{access:f.access,authorizeImport:async()=> 'allowed-once',backend:async()=>{sends++;throw Error('unexpected')}})
  assert.equal((await call(bridge,NATIVE_ARTIFACT_COLLECTION,'POST',input)).statusCode,503);assert.equal(reads,0);assert.equal(sends,0);bridge.dispose()
 }
})
