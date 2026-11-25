import {test} from 'node:test';
import assert from 'node:assert/strict';
import {load,fixture,encodedDuring} from '../tools/job-result-fixture.mjs';
const api=await load(process.env.DSH_PREFIX);
for(const [name,text] of [['ASCII','a'.repeat(131072)],['BMP','中'.repeat(32768)],['emoji','😀'.repeat(24576)]]){
 test(`actual job_output execute/render/finalizer avoids length-only ${name} encoding`,async t=>{
  const f=fixture(api,{text});const r=await encodedDuring(()=>f.output());
  assert.deepEqual(r.value,[{type:'text',text:text+'\n[status: completed]'}]);t.diagnostic(JSON.stringify({calls:r.calls,bytes:r.bytes}));assert.equal(r.calls,0);assert.equal(r.bytes,0);
 });
}
test('settled notice preserves rc.1 bounded labels and avoids length-only encoding',async t=>{
 const label='中'.repeat(32768);const f=fixture(api,{label});const r=await encodedDuring(()=>f.notice());
 assert.equal(r.value.message.content[0].text,`background job task-0123456789abcdef (task: ${'中'.repeat(119)}…) finished [status: completed]. No new output.`);
 assert.equal(r.value.message.source.form,'notice');assert.equal(r.value.message.source.summary.length,120);assert.equal(r.value.mode,'inject');t.diagnostic(JSON.stringify({calls:r.calls,bytes:r.bytes}));assert.equal(r.calls,0);
});
test('undefined budget is encoding-free and lossy channel/spill prose remains complete',async()=>{
 const f=fixture(api,{cap:null,lossy:true,spillPaths:['/fixture/full.out','/fixture/full.err'],channels:[{channel:'stdout',text:'out'},{channel:'stderr',text:'err'},{channel:'log',text:'hidden'}]});
 const r=await encodedDuring(()=>f.output());assert.equal(r.calls,0);assert.equal(r.value[0].text,'out\n[stderr]\nerr\n[some output was dropped from memory; full output: /fixture/full.out, /fixture/full.err]\n[status: completed]');
 assert.equal((await encodedDuring(()=>f.notice())).calls,0);
});
test('exact byte boundary retains ASCII BMP pair isolated surrogate and BOM',()=>{
 for(const unit of ['a','中','😀','\ud800','\udc00','\ufeff']){
  const exact='x'.repeat(64-Buffer.byteLength(unit))+unit;const f=fixture(api,{cap:64});
  assert.deepEqual(f.final([{type:'text',text:exact}]),[{type:'text',text:exact}]);
  const marker='\n[result truncated]';const bytes=Buffer.from(exact+'z');let start=bytes.length-(64-Buffer.byteLength(marker));while((bytes[start]&0xc0)===0x80)start++;
  assert.equal(f.final([{type:'text',text:exact+'z'}])[0].text,bytes.subarray(start).toString('utf8')+marker);
 }
});
test('actual UTF8 tail truncation keeps status and only necessary retention encoding',async t=>{
 const f=fixture(api,{text:'😀'.repeat(40),cap:100});const r=await encodedDuring(()=>f.output());
 assert.equal(r.value[0].text,'😀'.repeat(15)+'\n[output truncated]\n[status: completed]');t.diagnostic(JSON.stringify({calls:r.calls,bytes:r.bytes}));
 const tiny=await fixture(api,{text:'long output',cap:1}).output();assert.equal(tiny[0].text,']');
 const already=(await fixture(api,{text:'x'.repeat(100)+'\n[output truncated]',cap:50}).output())[0].text;assert.equal(already.match(/\[output truncated\]/g).length,1);assert(Buffer.byteLength(already)<=50);assert.equal(r.calls,1);assert.equal(r.bytes,160);
});
test('notice omission compact recovery and minimum-budget branches remain exact',()=>{
 const fixed='background job task-0123456789abcdef\n[notice truncated]\nDone; job_output.';assert.equal(fixture(api,{cap:Buffer.byteLength(fixed),label:'label'.repeat(30)}).notice().message.content[0].text,fixed);
 for(const [cap,expected] of [[100,'background job task-0123456789abcdef (task: labellabellabellabe\n[notice truncated]\nDone; job_output.'],[65,'background job task-0123456789abcdef\nDone; job_output.'],[45,'background job ended; use job_list for id.'],[1,'j']]){
  const f=fixture(api,{cap,label:'label'.repeat(30)});assert.equal(f.notice().message.content[0].text,expected);
 }
});
test('notice ownership delivery skip controls and non-single-text finalizer remain unchanged',()=>{
 const f=fixture(api,{delivery:'wakeup'});f.owner.status='idle';assert.equal(f.notice().mode,'followup');
 const count=f.messages.length;f.notice({awaited:true});f.notice({cause:'teardown'});f.notice({type:'removed'});assert.equal(f.messages.length,count);
 for(const content of [[],[{type:'image',url:'fixture'}],[{type:'text',text:'a'},{type:'text',text:'b'}]])assert.equal(f.final(content),undefined);
 assert.deepEqual(f.final([{type:'text',text:'failure 😀'}],{name:'job_kill'}),[{type:'text',text:'failure 😀'}]);
});
