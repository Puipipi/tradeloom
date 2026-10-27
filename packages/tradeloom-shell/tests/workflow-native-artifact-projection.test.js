import test from 'node:test'
import assert from 'node:assert/strict'
import { projectNativeWorkflowRun } from '../workflow-native-ui.js'
import { createConfirmedWorkflowDefinition } from '../workflow-definition.js'
const document = {version:1,id:'workflow',title:'Workflow',confirmed:true,nodes:[{id:'task',kind:'agent',agent:'product',title:'Task',instruction:'Task'}],edges:[]}
const {definitionRevision}=createConfirmedWorkflowDefinition(document)
const start={childSessionId:'child',nativeRunId:'native',startInclusive:10}
const declaration=(i=0,path='report.md')=>({sourceSessionSeq:10+i,fileIndex:0,presentCallId:`call-${i}`,sourceTurn:1,path})
function fixture(declarations=[declaration()], stopReason='completed') {
 const status=stopReason==='completed'?'done':stopReason==='aborted'?'interrupted':'failed'
 const evidence={schema:'tradeloom.presented-evidence/v1',range:{...start,endExclusive:100},declarations}
 const node={status,attempt:1,attemptState:'terminal',requestId:'request',toolCallId:'tool',childId:'child',nativeRunId:'native',output:'',artifactRangeStart:{...start},artifactSource:'deliverables/presented',artifactEvidence:structuredClone(evidence),artifacts:structuredClone(declarations)}
 const run={id:'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',workflowId:'workflow',document,definitionRevision,bindingRevision:'1',sessionId:'session',parentAgentId:'parent',executionMode:'native_dsh',journalSchema:'tradeloom.native-run-journal/v1',status,revision:2,nodes:{task:node},events:[]}
 run.events.push({source:'subagent/end',type:status==='done'?'node-terminal':status==='interrupted'?'node-interrupted':'node-error',stopReason,status,workflowRunId:run.id,nodeId:'task',attempt:1,requestId:'request',toolCallId:'tool',childId:'child',nativeRunId:'native',sessionId:'session',parentAgentId:'parent',bindingRevision:'1',definitionRevision,sequence:1,artifactSource:'deliverables/presented',artifactEvidence:structuredClone(evidence),artifacts:structuredClone(declarations)})
 return run
}
const node = r => projectNativeWorkflowRun(r).nodes[0]
const unknown = r => {const p=node(r);assert.equal(p.artifactState,'unknown');assert.equal(p.artifactEvidence,null)}
function update(r,fn){fn(r.nodes.task.artifactEvidence);fn(r.events[0].artifactEvidence);r.nodes.task.artifacts=structuredClone(r.nodes.task.artifactEvidence.declarations);r.events[0].artifacts=structuredClone(r.events[0].artifactEvidence.declarations)}
test('valid declarations including verified empty and deep copy',()=>{for(const a of [[declaration()],[]]){const r=fixture(a),before=structuredClone(r);const p=node(r);assert.equal(p.artifactState,'declared');assert.deepEqual(p.artifactEvidence.declarations,a);p.artifactEvidence.range.childSessionId='changed';assert.deepEqual(r,before)}})
test('missing, mismatched, untrusted evidence and outputs remain unknown',()=>{for(const change of [r=>delete r.nodes.task.artifactEvidence,r=>delete r.events[0].artifactEvidence,r=>r.nodes.task.artifactSource='unknown',r=>r.events[0].artifactSource='unknown',r=>r.events[0].artifacts[0].path='other',r=>r.nodes.task.artifacts=[],r=>r.events[0].artifactEvidence.declarations[0].path='other',r=>r.nodes.task.artifactRangeStart.startInclusive=11,r=>r.nodes.task.output='C:/fake/file.md [x](file:///x)']){const r=fixture();if(change.toString().includes('output')){delete r.nodes.task.artifactEvidence;delete r.events[0].artifactEvidence}change(r);unknown(r)}})
test('identity and activation binding never borrow an old terminal',()=>{for(const key of ['workflowRunId','nodeId','attempt','requestId','toolCallId','childId','nativeRunId','parentAgentId','sessionId','bindingRevision','definitionRevision']){const r=fixture();r.events[0][key]=key==='attempt'?2:'stale';unknown(r)}const r=fixture();r.nodes.task.attempt=2;unknown(r)})
test('nonterminal and blocked do not declare',()=>{const r=fixture();r.nodes.task.status='running';unknown(r);r.nodes.task.status='skipped';r.nodes.task.attempt=0;r.nodes.task.childId=r.nodes.task.toolCallId=r.nodes.task.nativeRunId=null;r.nodes.task.blockedBy=['other'];unknown(r)})
test('range, coordinates, count and UTF-8 byte limits use real validator',()=>{let r=fixture(Array.from({length:64},(_,i)=>declaration(i)));assert.equal(node(r).artifactState,'declared');r=fixture(Array.from({length:65},(_,i)=>declaration(i)));unknown(r);r=fixture();update(r,e=>e.declarations[0].sourceSessionSeq=e.range.endExclusive);unknown(r);r=fixture([declaration(),declaration()]);unknown(r);const large=Array.from({length:22},(_,i)=>({...declaration(i,'界'.repeat(1365)),description:'界'.repeat(666)}));r=fixture(large);assert.ok(Buffer.byteLength(JSON.stringify(r.nodes.task.artifactEvidence))>128*1024);unknown(r);const within=large.slice(0,21);r=fixture(within);assert.ok(Buffer.byteLength(JSON.stringify(r.nodes.task.artifactEvidence))<=128*1024);assert.equal(node(r).artifactState,'declared')})
test('failed and interrupted terminals retain declarations but do not succeed',()=>{for(const reason of ['failed','aborted']){const p=node(fixture([declaration()],reason));assert.equal(p.artifactState,'declared');assert.equal(p.succeeded,false)}})

test('128 KiB exact evidence boundary is accepted and one byte over rejected',()=>{
 const entries=Array.from({length:22},(_,i)=>({...declaration(i,'x'.repeat(4096)),description:'y'.repeat(1900)}))
 let r=fixture(entries); let bytes=Buffer.byteLength(JSON.stringify(r.nodes.task.artifactEvidence))
 let trim=bytes-128*1024; assert.ok(trim>0); for (const item of entries) { const cut=Math.min(trim,item.description.length); item.description=item.description.slice(cut); trim-=cut }; assert.equal(trim,0)
 r=fixture(entries); assert.equal(Buffer.byteLength(JSON.stringify(r.nodes.task.artifactEvidence)),128*1024); assert.equal(node(r).artifactState,'declared')
 entries.at(-1).description+='y'; r=fixture(entries); assert.equal(Buffer.byteLength(JSON.stringify(r.nodes.task.artifactEvidence)),128*1024+1); unknown(r)
})
