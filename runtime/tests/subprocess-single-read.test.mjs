import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
const base=join(resolve(process.env.DSH_PREFIX),'node_modules/@deepseek-ai');
const load=name=>import(pathToFileURL(join(base,name,'lib/index.js')));
const {OutputCollector}=await import(pathToFileURL(join(base,'dsh-subprocess-local/lib/output.js')));
function measured(read){const original=Buffer.concat;let calls=0,bytes=0;const lists=[];
 Buffer.concat=function(list,...rest){calls++;bytes+=list.reduce((n,b)=>n+b.length,0);lists.push(list.map(b=>b.length));return Reflect.apply(original,this,[list,...rest]);};
 try{return {value:read(),calls,bytes,lists};}finally{Buffer.concat=original;}}
for(const text of ['a'.repeat(64000),'中🙂é'])test(`one retained chunk avoids copy: ${text.length} code units`,()=>{
 const c=new OutputCollector(64000,'stdout');c.push(Buffer.from(text));
 const r=measured(()=>c.readFrom(0));assert.deepEqual(r.value,{text,nextOffset:Buffer.byteLength(text),lossy:false});assert.equal(r.calls,0);assert.equal(r.bytes,0);
 c.seal();assert.equal(measured(()=>c.readFrom(0)).calls,0);assert.equal(c.readFrom(0).text,text);
});
test('zero/multiple chunks, later bytes and snapshots retain existing ownership',()=>{
 const c=new OutputCollector(64,'stdout');assert.deepEqual(c.readFrom(0),{text:'',nextOffset:0,lossy:false});
 c.push(Buffer.from('a'));const snapshot=c.snapshot();snapshot.bytes[0]=0x7a;assert.equal(c.readFrom(0).text,'a');
 c.push(Buffer.from('中'));const r=measured(()=>c.readFrom(0));assert.equal(r.value.text,'a中');assert.equal(r.calls,1);assert.equal(r.bytes,4);
 assert.equal(c.readFrom(1).text,'中');c.seal();assert.equal(c.finalize().text,'a中');assert.equal(snapshot.bytes.toString(),'z');
});
test('small tail, pending prefix and EOF remain repeatable across independent cursors',()=>{
 for(const cap of [1,2,3,64]){
  const c=new OutputCollector(cap,'stdout');c.push(Buffer.from([0x61,0xf0,0x90,0x80]));
  const r=measured(()=>c.readFrom(0));assert.equal(r.calls,0);assert.equal(r.value.lossy,cap<4);
  assert.deepEqual(c.readFrom(0),r.value);assert.equal(c.readFrom(4).text,'');assert.deepEqual(c.readFrom(0),r.value);
  c.seal();assert.equal(c.readFrom(0).text,c.snapshot().bytes.toString('utf8'));assert.equal(c.readFrom(0).nextOffset,4);assert.equal(c.readFrom(0).lossy,cap<4);
 }
});
test('single truncated chunk preserves full spill bytes and independent snapshot',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'single-read-spill-'));let c;
 try{c=new OutputCollector(2,'stdout',{maxBytes:128,dir,onFailure:error=>{throw error;}});c.push(Buffer.from('abcdef'));
  const r=measured(()=>c.readFrom(0));assert.equal(r.value.text,'ef');assert.equal(r.value.lossy,true);assert.equal(r.calls,0);assert(r.value.spillPath);
  const snapshot=c.snapshot();snapshot.bytes.fill(0);assert.equal(c.readFrom(0).text,'ef');c.seal();assert.equal(c.finalize().text,'ef');assert.equal(await readFile(r.value.spillPath,'utf8'),'abcdef');
 }finally{c?.seal();await rm(dir,{recursive:true,force:true});}
});
test('ordinary actual Node stdout stays exact; observed pipe chunking is diagnostic',async t=>{
 const {Context}=await load('cordis'),{LocalSubprocessRuntime}=await load('dsh-subprocess-local');const ctx=new Context();
 try{await ctx.plugin(LocalSubprocessRuntime);
  for(const size of [64000,65536,1048576]){
   const child=ctx.subprocess.spawn({argv:[process.execPath,'-e',`process.stdout.write(Buffer.alloc(${size},0x61))`],cwd:process.cwd(),env:{},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:64000},stderr:'ignore'}});
   assert.equal((await child.done).exitCode,0);const r=measured(()=>child.collected.stdout.readFrom(0));
   assert.deepEqual(r.value,{text:'a'.repeat(64000),nextOffset:size,lossy:size>64000});assert(r.calls<=1);
   t.diagnostic(JSON.stringify({actualNodeBytes:size,concatCalls:r.calls,concatInputBytes:r.bytes,concatLists:r.lists}));
  }
 }finally{await ctx.fiber.dispose();}
});
