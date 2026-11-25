import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {readFile,stat,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createServer} from 'node:net';
import {once} from 'node:events';
process.on('SIGXFSZ',()=>{});
const writes=[],paths=[];const originalWrite=fs.writeSync,originalOpen=fs.openSync;
// Pure observers: preserve real syscall arguments, results, and exceptions.
fs.writeSync=function(fd,data,...rest){const requested=typeof data==='string'?Buffer.byteLength(data):rest[1]??data.byteLength;try{const written=Reflect.apply(originalWrite,this,[fd,data,...rest]);writes.push({requested,written});return written;}catch(error){writes.push({requested,error:error.code});throw error;}};
fs.openSync=function(path,...rest){const fd=Reflect.apply(originalOpen,this,[path,...rest]);if(String(path).includes('/dsh-subprocess-')&&String(path).endsWith('-stdout.log'))paths.push(String(path));return fd;};syncBuiltinESMExports();
const prefix=resolve(process.env.DSH_PREFIX),load=n=>import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai',n,'lib/index.js')));
const {Context}=await load('cordis'),{LocalSubprocessRuntime}=await load('dsh-subprocess-local');const ctx=new Context();const reports=[];ctx.logger.exporter({export(message){if(message.type==='error'&&String(message.args[0]).includes('could not write the complete stdout stream'))reports.push({message:String(message.args[0]),code:message.args[1]?.code});}});const mode=process.argv[2];let socket,server;
async function launch(text,cap){const child=ctx.subprocess.spawn({argv:[process.execPath,'-e',`process.stdout.write(${JSON.stringify(text)})`],cwd:process.cwd(),env:{},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:cap,spill:{maxBytes:16384}},stderr:'ignore'}});return {child,outcome:await child.done};}
async function describe(child,outcome){const read=child.collected.stdout.readFrom(0);return {outcome,text:read.text,total:child.collected.stdout.snapshot().totalBytes,spillPath:read.spillPath,spillBytes:read.spillPath?(await stat(read.spillPath)).size:null};}
try{
 await ctx.plugin(LocalSubprocessRuntime);let first,intermediate;
 if(mode==='prior'){
  const ready=Promise.withResolvers();server=createServer(s=>{socket=s;s.once('data',()=>ready.resolve());});server.listen(0,'127.0.0.1');await once(server,'listening');
  const script=`const net=require('node:net');process.stdout.write('p'.repeat(512),()=>{const s=net.connect(${server.address().port},'127.0.0.1',()=>s.write('ready'));s.once('data',()=>process.stdout.write('a'.repeat(8192),()=>{s.write('second');s.once('data',()=>process.stdout.write('a'.repeat(128),()=>s.end()));}));});`;
  const child=ctx.subprocess.spawn({argv:[process.execPath,'-e',script],cwd:process.cwd(),env:{},graceMs:1000,stdio:{stdin:'ignore',stdout:{maxBytes:1024,spill:{maxBytes:16384}},stderr:'ignore'}});await ready.promise;while(child.collected.stdout.snapshot().totalBytes<512)await new Promise(setImmediate);const second=once(socket,'data');socket.write('continue');await second;while(child.collected.stdout.snapshot().totalBytes<8704)await new Promise(setImmediate);intermediate=await describe(child,null);socket.write('finish');first=await describe(child,await child.done);
 }else{const v=await launch('a'.repeat(8192),64);first=await describe(v.child,v.outcome);}
 if(first.spillPath)first.completeContentMatches=(await readFile(first.spillPath,'utf8'))===(mode==='single'?'a'.repeat(8192):'p'.repeat(512)+'a'.repeat(8320));const firstPaths=[...paths];const firstFiles=await Promise.all(firstPaths.map(async path=>({path,size:await stat(path).then(s=>s.size,()=>null)})));
 const v=await launch('r'.repeat(128),64);const recovery=await describe(v.child,v.outcome);recovery.fullText=recovery.spillPath?await readFile(recovery.spillPath,'utf8'):null;
 console.log(JSON.stringify({mode,first,intermediate,firstFiles,writes,reports,recovery}));
}finally{socket?.destroy();if(server)await new Promise(r=>server.close(r));await ctx.fiber.dispose();for(const path of paths)await rm(path,{force:true});fs.writeSync=originalWrite;fs.openSync=originalOpen;syncBuiltinESMExports();}
