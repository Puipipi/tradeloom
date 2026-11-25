// DSH_PREFIX=/absolute/prepared-prefix node --test runtime/tests/subprocess-zero-tail.test.mjs
import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {once} from 'node:events';
const prefix=resolve(process.env.DSH_PREFIX);
const load=n=>import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai',n,'lib/index.js')));
const {Context}=await load('cordis'),{LocalSubprocessRuntime}=await load('dsh-subprocess-local');
const {OutputCollector}=await import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai/dsh-subprocess-local/lib/output.js')));
function expectRead(reader,total,spillPath){
 for(const fromByte of [0,total,total+7])assert.deepEqual(reader.readFrom(fromByte),{text:'',nextOffset:total,lossy:fromByte<total,...spillPath?{spillPath}:{}});
}
for(const spillLimit of [undefined,64,2])test(`public Node zero-tail active/continued/done; spill ${spillLimit??'off'}`,{timeout:10000},async()=>{
 const ctx=new Context(),dir=await mkdtemp(join(tmpdir(),'zero-tail-'));let socket;const paths=new Set();
 const ready=Promise.withResolvers(),server=createServer(s=>{socket=s;s.once('data',()=>ready.resolve());});
 try{
  await ctx.plugin(LocalSubprocessRuntime);server.listen(0,'127.0.0.1');await once(server,'listening');
  const script=`const net=require('node:net');const s=net.connect(${server.address().port},'127.0.0.1',()=>s.write('ready'));s.on('data',b=>{if(b.toString()==='end'){s.end();return;}process.stdout.write(b,()=>s.write('written'));});`;
  const child=ctx.subprocess.spawn({argv:[process.execPath,'-e',script],cwd:dir,env:{},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:0,...spillLimit===undefined?{}:{spill:{maxBytes:spillLimit}}},stderr:'ignore'}});
  await ready.promise;const reader=child.collected.stdout;expectRead(reader,0);
  for(const [chunk,total]of [['abc',3],['中🙂',10]]){
   const ack=once(socket,'data');socket.write(chunk);await ack;
   // Let the real stdout pipe handler run; no synthetic delay or private callback.
   while(reader.snapshot().totalBytes<total)await new Promise(setImmediate);
   assert.equal(reader.snapshot().bytes.length,0);const path=reader.readFrom(0).spillPath;if(path)paths.add(path);
   assert.equal(!!path,spillLimit===64);expectRead(reader,total,path);
  }
  socket.write('end');assert.equal((await child.done).exitCode,0);
  const final=reader.readFrom(0);expectRead(reader,10,final.spillPath);if(final.spillPath)assert.equal(await readFile(final.spillPath,'utf8'),'abc中🙂');
 }finally{socket?.destroy();await new Promise(r=>server.close(r));await ctx.fiber.dispose();for(const path of paths)await rm(path,{force:true});await rm(dir,{recursive:true,force:true});}
});

test('collector zero-tail initial, active, sealed and subsequent bytes retain original cursor shape',()=>{
 const c=new OutputCollector(0,'stdout');expectRead(c,0);c.push(Buffer.from('abc'));expectRead(c,3);c.seal();expectRead(c,3);c.push(Buffer.from('d'));expectRead(c,4);
});
