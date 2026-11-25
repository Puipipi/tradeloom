import test from 'node:test';
import assert from 'node:assert/strict';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {createServer} from 'node:net';
import {once} from 'node:events';
const base=join(resolve(process.env.DSH_PREFIX),'node_modules/@deepseek-ai');
const load=n=>import(pathToFileURL(join(base,n,'lib/index.js')));
const {OutputCollector}=await import(pathToFileURL(join(base,'dsh-subprocess-local/lib/output.js')));
for(const text of ['é','中','😀'])for(let split=1;split<Buffer.byteLength(text);split++)test(`live ${text} split ${split} preserves two independent byte cursors`,()=>{
 const c=new OutputCollector(64,'stdout'),bytes=Buffer.from(text);c.push(Buffer.concat([Buffer.from('a'),bytes.subarray(0,split)]));
 const first=c.readFrom(0);assert.equal(first.text,'a');assert.equal(first.nextOffset,1);
 for(let i=0;i<3;i++)assert.deepEqual(c.readFrom(1),{text:'',nextOffset:1,lossy:false});
 assert.equal(c.readFrom(0).text,'a');c.push(bytes.subarray(split));
 assert.equal(c.readFrom(first.nextOffset).text,text);assert.equal(c.readFrom(0).text,'a'+text);
 assert.equal(c.readFrom(1).nextOffset,1+bytes.length);
});
for(const bytes of [[0xc2],[0xe0,0xa0],[0xed,0x9f],[0xf0,0x90,0x80],[0xf4,0x8f,0xbf]])test(`EOF flushes ${bytes.join(',')} without a spill descriptor`,()=>{
 const c=new OutputCollector(64,'stderr');c.push(Buffer.from(bytes));assert.equal(c.readFrom(0).text,'');c.seal();
 assert.equal(c.readFrom(0).text,Buffer.from(bytes).toString('utf8'));assert.equal(c.readFrom(0).nextOffset,bytes.length);assert.equal(c.finalize().text,c.readFrom(0).text);
});
for(const bytes of [[0xc0],[0xc1],[0xf5],[0xff],[0xe0,0x9f],[0xed,0xa0],[0xf0,0x8f],[0xf4,0x90],[0x80],[0xe2,0x41]])test(`already invalid UTF8 remains immediate ${bytes.join(',')}`,()=>{
 const c=new OutputCollector(64,'stdout');c.push(Buffer.from(bytes));const r=c.readFrom(0);assert.equal(r.text,Buffer.from(bytes).toString('utf8'));assert.equal(r.nextOffset,bytes.length);
});
test('mid-codepoint cursor, tail head truncation and pending eviction retain raw semantics',()=>{
 const c=new OutputCollector(2,'stdout');c.push(Buffer.from([0xe4,0xb8]));assert.equal(c.readFrom(1).text,'�');
 c.push(Buffer.from([0xad]));assert.deepEqual(c.readFrom(0),{text:'��',nextOffset:3,lossy:true});
 const d=new OutputCollector(3,'stdout');d.push(Buffer.from([0xe4]));assert.equal(d.readFrom(0).nextOffset,0);d.push(Buffer.from('abcd'));
 assert.deepEqual(d.readFrom(0),{text:'bcd',nextOffset:5,lossy:true});
});
test('spill and snapshot preserve exact bytes while live text defers a tail',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'utf8-spill-'));
 try{const c=new OutputCollector(4,'stdout',{maxBytes:128,dir,onFailure:e=>{throw e;}});c.push(Buffer.from('abcdef'));c.push(Buffer.from([0xe4,0xb8]));
 const r=c.readFrom(0);assert.equal(r.lossy,true);assert.equal(r.text,'ef');assert.equal(r.nextOffset,6);
 assert.deepEqual(c.snapshot().bytes,Buffer.from([0x65,0x66,0xe4,0xb8]));c.seal();assert.equal(c.readFrom(6).text,'�');
 assert.deepEqual(await readFile(r.spillPath),Buffer.from([0x61,0x62,0x63,0x64,0x65,0x66,0xe4,0xb8]));
 }finally{await rm(dir,{recursive:true,force:true});}
});

for(const finish of ['continue','cancel','cancel-lossy'])test(`actual Node process and Jobs pump ${finish}: no pending-tail spin and final drain`,async t=>{
 const {Context}=await load('cordis'),{LocalSubprocessRuntime}=await load('dsh-subprocess-local'),{LocalJobRegistry}=await load('dsh-jobs-local');
 const ctx=new Context(),dir=await mkdtemp(join(tmpdir(),'utf8-process-'));let socket;
 const ready=Promise.withResolvers();const server=createServer(s=>{socket=s;s.once('data',()=>ready.resolve());});
 let nativeSet=globalThis.setTimeout,nativeClear=globalThis.clearTimeout;
 const timers=new Map();let timerCount=0;
 try{
  await ctx.plugin(LocalSubprocessRuntime);await ctx.plugin(LocalJobRegistry,{pumpPollMs:37});ctx.jobs.attachController();
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const script=`const n=require('node:net');const b=Buffer.from('中'),first=Buffer.concat([Buffer.from(${JSON.stringify(finish==='cancel-lossy'?'abc':'')}),b.subarray(0,1)]);process.stdout.write(first,()=>process.stderr.write(first,()=>{const s=n.connect(${server.address().port},'127.0.0.1',()=>s.write('ready'));s.once('data',()=>{process.stdout.write(b.subarray(1));process.stderr.write(b.subarray(1));s.end();});}));`;
  const child=ctx.subprocess.spawn({argv:[process.execPath,'-e',script],cwd:dir,env:{},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:finish==='cancel-lossy'?1:64},stderr:{maxBytes:finish==='cancel-lossy'?1:64}}});
  await ready.promise;
  // Control only the exact Jobs poll deadline; process lifecycle timers pass through.
  globalThis.setTimeout=(fn,ms,...args)=>{if(ms!==37)return nativeSet(fn,ms,...args);const token={};timers.set(token,()=>fn(...args));timerCount++;return token;};
  globalThis.clearTimeout=token=>{if(timers.delete(token))return;nativeClear(token);};
  let reads=0;
  const id=ctx.jobs.start({kind:'utf8',label:'synthetic Node',output:['stdout','stderr'].map(channel=>({channel,read(from){reads++;return child.collected[channel].readFrom(from);}})),run(){return{cancel(){child.terminate();},done:child.done.then(result=>({status:result.signal?'killed':'completed'}))};}});
  assert.equal(reads,2);assert.equal(ctx.jobs.read(id).chunks.length,0);assert.equal(timers.size,1);
  const [token,advance]=timers.entries().next().value;timers.delete(token);advance();await Promise.resolve();await Promise.resolve();
  assert.equal(reads,4);assert.equal(timerCount,2);assert.equal(timers.size,1);assert.equal(ctx.jobs.read(id).chunks.length,0);
  if(finish!=='continue')ctx.jobs.kill(id);else socket.write('continue');
  const done=await ctx.jobs.wait(id,1000);assert.equal(done.status,finish!=='continue'?'killed':'completed');
  assert.equal(timers.size,0);
  const chunks=ctx.jobs.read(id).chunks;for(const channel of ['stdout','stderr'])assert.equal(chunks.filter(c=>c.channel===channel).map(c=>c.text).join(''),finish!=='continue'?'�':'中');
  if(finish==='cancel-lossy')for(const chunk of chunks)assert.equal(chunk.gapBefore,true,'empty pending reads preserve the lost-head gap until final text');
  assert.equal(reads,6,'two scheduled rounds and one completion drain only');
  assert.equal(child.collected.stdout.readFrom(0).nextOffset,finish==='cancel-lossy'?4:finish==='cancel'?1:3);
 }finally{globalThis.setTimeout=nativeSet;globalThis.clearTimeout=nativeClear;socket?.destroy();await new Promise(r=>server.close(r));await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true});}
});


test('public BashExecutor readOutput joins a split UTF8 character exactly once',async()=>{
 const {Context}=await load('cordis'),{LocalSubprocessRuntime}=await load('dsh-subprocess-local'),{LocalBashExecutor}=await load('dsh-bash-local');
 const ctx=new Context(),dir=await mkdtemp(join(tmpdir(),'bash-utf8-'));let socket;
 const ready=Promise.withResolvers(),server=createServer(s=>{socket=s;s.once('data',()=>ready.resolve());});
 try{
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const file=join(dir,'child.cjs');
  await writeFile(file,`const net=require('node:net');const b=Buffer.from('中');process.stdout.write(b.subarray(0,1),()=>{const s=net.connect(${server.address().port},'127.0.0.1',()=>s.write('ready'));s.once('data',()=>{process.stdout.write(b.subarray(1));s.end();});});`);
  await ctx.plugin(LocalSubprocessRuntime);await ctx.plugin(LocalBashExecutor,{cwd:dir});
  // Test-owned paths contain only these literal shell-safe characters.
  assert.match(process.execPath,/^[a-zA-Z0-9_./-]+$/);assert.match(file,/^[a-zA-Z0-9_./-]+$/);
  const handle=await ctx.shell.execute(ctx.shell.resolve({command:process.execPath+' '+file,onExpiry:'none'}));
  await ready.promise;const first=handle.readOutput();assert.deepEqual(first,{delta:'',lossy:false});
  socket.write('continue');const result=await handle.result();const second=handle.readOutput();
  assert.equal(first.delta+second.delta,'中');assert.equal(result.stdout.text,'中');assert.equal(result.exitCode,0);assert.equal(handle.readOutput().delta,'');
 }finally{socket?.destroy();await new Promise(r=>server.close(r));await ctx.fiber.dispose();await rm(dir,{recursive:true,force:true});}
});

test('empty lossy pending read retains the old cursor until EOF delivers its gap',()=>{
 const c=new OutputCollector(1,'stdout');c.push(Buffer.from([0x61,0x62,0x63,0xe4]));
 const first=c.readFrom(0);assert.deepEqual(first,{text:'',nextOffset:0,lossy:true});
 assert.deepEqual(c.readFrom(first.nextOffset),first);c.seal();
 assert.deepEqual(c.readFrom(first.nextOffset),{text:'�',nextOffset:4,lossy:true});
});
