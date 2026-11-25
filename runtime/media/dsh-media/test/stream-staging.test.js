import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import { mkdtemp, readFile, readdir, rm, stat, writeFile, rename, symlink } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createStreamStager, writeStagedChunk, MAX_STAGED_DOWNLOAD_BYTES } from '../src/stream-staging.js';
async function setup(t, handler) {
 const directory=await mkdtemp(join(tmpdir(),'stream-stage-'));t.after(()=>rm(directory,{recursive:true,force:true}));
 const requests=[];const sockets=new Set();
 const server=createServer((req,res)=>{requests.push({method:req.method,url:req.url,authorization:req.headers.authorization,acceptEncoding:req.headers['accept-encoding']});Promise.resolve(handler(req,res,directory)).catch(()=>res.destroy());});
 server.on('connection',s=>{sockets.add(s);s.on('close',()=>sockets.delete(s))});server.listen(0,'127.0.0.1');await once(server,'listening');t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r))});
 return {directory,requests,url:`http://127.0.0.1:${server.address().port}/signed?signature=synthetic`,stage:createStreamStager({allowLoopback:true})};
}
test('real chunked GET owns 0600 file and hashes exact bytes, no auth or media claim',async t=>{
 const parts=[Buffer.alloc(16384,1),Buffer.alloc(777,2),Buffer.from('tail')];
 const f=await setup(t,async(_req,res)=>{for(const chunk of parts){res.write(chunk);await new Promise(r=>setTimeout(r,2))}res.end()});
 const r=await f.stage(f.url,{directory:f.directory,maxBytes:20000});assert.equal(r.kind,'private-download');assert.deepEqual(await readFile(r.path),Buffer.concat(parts));assert.equal(r.bytes,17165);assert.equal(r.sha256,createHash('sha256').update(Buffer.concat(parts)).digest('hex'));assert.equal((await stat(r.path)).mode&0o777,0o600);assert.equal(r.mime,undefined);assert.equal(f.requests[0].authorization,undefined);assert.equal(f.requests[0].method,'GET');assert.equal(f.requests[0].acceptEncoding,'identity');
});
test('download file creation failure reports storage and permits a later retry',async t=>{
 const f=await setup(t,(_q,r)=>r.end('saved'));
 const original=fs.open;let failures=0;
 const mocked=t.mock.method(fs,'open',async(path,...args)=>{
  if(String(path).startsWith(join(f.directory,'.media-download-'))){failures++;throw Object.assign(new Error('synthetic disk full'),{code:'ENOSPC'})}
  return original(path,...args);
 });
 syncBuiltinESMExports();
 try {
  await assert.rejects(f.stage(f.url,{directory:f.directory}),{code:'storage'});
  assert.equal(failures,1);assert.equal(f.requests.length,0);assert.deepEqual(await readdir(f.directory),[]);
 } finally {mocked.mock.restore();syncBuiltinESMExports()}
 const receipt=await f.stage(f.url,{directory:f.directory});
 assert.equal(await readFile(receipt.path,'utf8'),'saved');assert.equal(f.requests.length,1);
});
for(const [name,handler,code] of [
 ['declared oversized',(_q,r)=>{r.writeHead(200,{'content-length':'1000'});r.end('x')},'too_large'],
 ['chunked overflow',(_q,r)=>{r.write('abcd');r.end('efgh')},'too_large'],
 ['compressed',(_q,r)=>{r.writeHead(200,{'content-encoding':'gzip'});r.end('x')},'response'],
 ['redirect',(_q,r)=>{r.writeHead(302,{location:'http://127.0.0.1:1/never'});r.end()},'response'],
 ['empty',(_q,r)=>r.end(),'response'],
 ['disconnect',async(_q,r)=>{r.writeHead(200,{'content-length':'4'});r.write('ab');await new Promise(x=>setTimeout(x,5));r.destroy()},'network'],
]) test(`${name}: no receipt, no leftover own file`,async t=>{const f=await setup(t,handler);await assert.rejects(f.stage(f.url,{directory:f.directory,maxBytes:5}),{code});assert.deepEqual(await readdir(f.directory),[]);assert.equal(f.requests.length,1)});
test('abort after first data and timeout reject without late publication',async t=>{
 const ac=new AbortController();let sent;
 const f=await setup(t,async(_q,r)=>{r.write('first');sent();await new Promise(x=>setTimeout(x,30));r.end('late')});
 const started=new Promise(r=>sent=r);const pending=f.stage(f.url,{directory:f.directory,signal:ac.signal});await started;ac.abort();await assert.rejects(pending,{code:'cancelled'});assert.deepEqual(await readdir(f.directory),[]);
 await assert.rejects(f.stage(f.url,{directory:f.directory,timeoutMs:5}),{code:'timeout'});assert.deepEqual(await readdir(f.directory),[]);
});
test('partial write loop hashes only actual written slices and rejects zero progress',async()=>{
 const captured=[];const h=createHash('sha256');await writeStagedChunk({write:async(b,o,n)=>{const k=Math.min(2,n);captured.push(Buffer.from(b.subarray(o,o+k)));return{bytesWritten:k}}},Buffer.from('abcdefg'),h);
 assert.equal(Buffer.concat(captured).toString(),'abcdefg');assert.equal(h.digest('hex'),createHash('sha256').update('abcdefg').digest('hex'));
 await assert.rejects(writeStagedChunk({write:async()=>({bytesWritten:0})},Buffer.from('x'),createHash('sha256')),{code:'storage'});
});
test('foreign replacement at temporary path is never deleted',async t=>{
 let foreign;
 const f=await setup(t,async(_q,r,dir)=>{const file=join(dir,(await readdir(dir))[0]);await rename(file,file+'.owned-orphan');foreign=file;await writeFile(file,'foreign');r.writeHead(500);r.end()});
 await assert.rejects(f.stage(f.url,{directory:f.directory}),{code:'cleanup_failed'});assert.equal(await readFile(foreign,'utf8'),'foreign');assert.equal((await readdir(f.directory)).length,2);
});
test('symlink staging directory rejected before any request',async t=>{
 const f=await setup(t,(_q,r)=>r.end('x'));const link=f.directory+'-link';await symlink(f.directory,link);t.after(()=>rm(link,{force:true}));await assert.rejects(f.stage(f.url,{directory:link}),{code:'permission'});assert.equal(f.requests.length,0);
});
test('mixed DNS answers and hostname-to-loopback rejected, production loopback rejected',async t=>{
 const f=await setup(t,(_q,r)=>r.end('x'));
 for(const addresses of [[{address:'8.8.8.8',family:4},{address:'127.0.0.1',family:4}],[{address:'127.0.0.1',family:4}]]) {
  const stage=createStreamStager({allowLoopback:true,lookup:async()=>addresses});await assert.rejects(stage('https://example.com/signed',{directory:f.directory}),{code:'unsafe_url'});
 }
 await assert.rejects(createStreamStager()(f.url,{directory:f.directory}),{code:'unsafe_url'});assert.deepEqual(await readdir(f.directory),[]);
});
test('ceiling and pre-abort fail before request; no 300MiB sample allocated',async t=>{
 const f=await setup(t,(_q,r)=>r.end('x'));await assert.rejects(f.stage(f.url,{directory:f.directory,maxBytes:MAX_STAGED_DOWNLOAD_BYTES+1}),{code:'invalid_request'});const c=new AbortController();c.abort();await assert.rejects(f.stage(f.url,{directory:f.directory,signal:c.signal}),{code:'cancelled'});assert.equal(f.requests.length,0);
});

test('replaced parent directory fails cleanup rather than touching a foreign child',async t=>{
 let moved, foreign;
 const f=await setup(t,async(_q,r,dir)=>{const name=(await readdir(dir))[0];moved=dir+'-old';await rename(dir,moved);await (await import('node:fs/promises')).mkdir(dir);foreign=join(dir,name);await writeFile(foreign,'foreign-parent');r.end('x')});
 t.after(async()=>{if(moved)await rm(moved,{recursive:true,force:true})});
 await assert.rejects(f.stage(f.url,{directory:f.directory}),{code:'cleanup_failed'});assert.equal(await readFile(foreign,'utf8'),'foreign-parent');
});
test('DNS timeout leaves no file and never progresses to a late network request',async t=>{
 const f=await setup(t,(_q,r)=>r.end('x'));const stage=createStreamStager({lookup:async()=>{await new Promise(r=>setTimeout(r,20));return[{address:'8.8.8.8',family:4}]}});
 await assert.rejects(stage('https://example.com/synthetic',{directory:f.directory,timeoutMs:1}),{code:'timeout'});assert.deepEqual(await readdir(f.directory),[]);assert.equal(f.requests.length,0);
});
