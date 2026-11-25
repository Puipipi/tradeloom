import test from 'node:test';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {resolve,join} from 'node:path';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const base=join(resolve(process.env.DSH_PREFIX),'node_modules/@deepseek-ai');
const load=name=>import(pathToFileURL(join(base,name,'lib/index.js')));
const {OutputCollector}=await import(pathToFileURL(join(base,'dsh-subprocess-local/lib/output.js')));
function measured(read){
 const original=Buffer.concat;let calls=0,bytes=0;
 Buffer.concat=function(list,...rest){calls++;bytes+=list.reduce((n,b)=>n+b.length,0);return Reflect.apply(original,this,[list,...rest]);};
 try{return {value:read(),get calls(){return calls;},get bytes(){return bytes;}};}finally{Buffer.concat=original;}
}
for(const jobs of [1,10])test(`public Jobs: ${jobs} running sources, 20 empty polls avoid copying default 64000-byte tails`,async t=>{
 const {Context}=await load('cordis'),{LocalJobRegistry}=await load('dsh-jobs-local');
 const ctx=new Context();await ctx.plugin(LocalJobRegistry,{pumpPollMs:150,maxConcurrentJobsPerOwner:10});ctx.jobs.attachController('idle-read-test');
 const done=Promise.withResolvers(),ids=[],collectors=[];let reads=0,calls=0,bytes=0,notify;
 t.mock.timers.enable({apis:['setTimeout']});
 try{
  for(let i=0;i<jobs;i++){
   const c=new OutputCollector(64000,'stdout');c.push(Buffer.alloc(64000,0x61));collectors.push(c);
   ids.push(ctx.jobs.start({kind:'idle',label:'finite public source',output:[{channel:'stdout',read(from){
    const r=measured(()=>c.readFrom(from));calls+=r.calls;bytes+=r.bytes;reads++;notify?.();return r.value;
   }}],run:()=>({done:done.promise,cancel:()=>done.resolve({status:'killed'})})}));
  }
  assert.equal(reads,jobs);reads=0;calls=0;bytes=0;
  for(let poll=0;poll<20;poll++){
   const tick=Promise.withResolvers(),target=(poll+1)*jobs;notify=()=>{if(reads>=target)tick.resolve();};
   t.mock.timers.tick(150);await tick.promise;
  }
  notify=undefined;t.diagnostic(JSON.stringify({jobs,pollsPerJob:20,tailBytes:64000,reads,concatCalls:calls,concatInputBytes:bytes}));
  assert.equal(reads,jobs*20);
  for(const id of ids){assert.equal(ctx.jobs.read(id).chunks.map(c=>c.text).join(''),'a'.repeat(64000));assert.equal(ctx.jobs.get(id).status,'running');}
  for(const c of collectors)c.seal();done.resolve({status:'completed'});for(const id of ids)await ctx.jobs.wait(id,1000);
  assert.equal(calls,0);assert.equal(bytes,0);
 }finally{notify=undefined;done.resolve({status:'completed'});t.mock.timers.reset();await ctx.fiber.dispose();}
});
test('raw total zero and consumed live/sealed outputs preserve empty shape without concat',()=>{
 const c=new OutputCollector(64000,'stdout');
 for(const total of [0,3]){
  if(total)c.push(Buffer.from('abc'));
  const r=measured(()=>c.readFrom(total));assert.deepEqual(r.value,{text:'',nextOffset:total,lossy:false});assert.equal(r.calls,0);assert.equal(r.bytes,0);
 }
 c.seal();assert.deepEqual(measured(()=>c.readFrom(3)),{value:{text:'',nextOffset:3,lossy:false},calls:0,bytes:0});
});
test('new bytes and independent cursors still deliver exact text',()=>{
 const c=new OutputCollector(64000,'stdout');c.push(Buffer.from('a'));assert.equal(c.readFrom(0).text,'a');assert.equal(c.readFrom(1).text,'');
 c.push(Buffer.from('中'));assert.deepEqual(c.readFrom(1),{text:'中',nextOffset:4,lossy:false});assert.equal(c.readFrom(0).text,'a中');c.seal();assert.equal(c.finalize().text,'a中');
});
test('raw-end observation does not consume pending UTF8 or a small-cap undelivered gap',()=>{
 for(const cap of [1,2,3,64]){
  const c=new OutputCollector(cap,'stdout');c.push(Buffer.from([0x61,0xf0,0x90,0x80]));
  const before=c.readFrom(0),snapshot=c.snapshot();
  assert.deepEqual(measured(()=>c.readFrom(4)),{value:{text:'',nextOffset:4,lossy:false},calls:0,bytes:0});
  assert.deepEqual(c.readFrom(0),before);assert.deepEqual(c.snapshot(),snapshot);
  c.seal();const expected=c.snapshot().bytes.toString('utf8');assert.equal(c.readFrom(0).text,expected);assert.equal(c.readFrom(0).lossy,cap<4);
 }
 // With 636, the previous-cursor read is deferred; without it, historical decoding is retained.
 // The fast path is required to leave that existing policy and both readers untouched.
});
test('consumed spilled output keeps the same spillPath before and after seal',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'subprocess-idle-spill-'));let c;
 try{
  c=new OutputCollector(2,'stdout',{maxBytes:128,dir,onFailure:error=>{throw error;}});c.push(Buffer.from('abcdef'));
  const first=c.readFrom(0);assert.equal(first.text,'ef');assert.equal(first.lossy,true);assert(first.spillPath);
  for(const sealed of [false,true]){
   if(sealed)c.seal();const r=measured(()=>c.readFrom(6));assert.deepEqual(r.value,{text:'',nextOffset:6,lossy:false,spillPath:first.spillPath});assert.equal(r.calls,0);assert.equal(r.bytes,0);
  }
  assert.equal(await readFile(first.spillPath,'utf8'),'abcdef');
 }finally{c?.seal();await rm(dir,{recursive:true,force:true});}
});
