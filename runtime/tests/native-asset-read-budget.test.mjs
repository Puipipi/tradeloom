import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NativeCore} from '../bridge/dsh-go-bridge/lib/native/core.js';
import {createNativeRoutes} from '../bridge/dsh-go-bridge/lib/native/routes.js';
import {effectiveLimits} from '../bridge/dsh-go-bridge/lib/native/limits.js';
const LIMIT=1048576;
async function fixture(t){
 const dir=await fs.mkdtemp(join(tmpdir(),'native-asset-read-budget-'));
 await fs.mkdir(join(dir,'assets'));
 await fs.writeFile(join(dir,'package.json'),JSON.stringify({name:'asset-budget-test',version:'1.0.0',dshGo:{v:1,assets:'./assets',contributes:{panels:[{id:'panel',title:'Panel',view:'view.json'}]}}}));
 await fs.writeFile(join(dir,'index.js'),'');await fs.writeFile(join(dir,'view.json'),'{"type":"text","text":"ok"}');
 const file=join(dir,'assets','changing.png');await fs.writeFile(file,Buffer.alloc(64));
 const entry={options:{name:pathToFileURL(join(dir,'index.js')).href},parent:{tree:{ctx:{baseUrl:pathToFileURL(dir+'/').href}}},fiber:{uid:7}};
 const core=new NativeCore({get:name=>name==='loader'?{entries:()=>[entry]}:undefined,logger:{warn(){}}},effectiveLimits({}),'test');
 const routes=createNativeRoutes(core),server=createServer((req,res)=>{const u=new URL(req.url,'http://local');routes.handle(req,res,u.pathname,u)});
 server.listen(0,'127.0.0.1');await once(server,'listening');
 t.after(async()=>{routes.dispose();core.dispose();server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true})});
 const request=async(method='GET',path='changing.png',headers={})=>{
  const r=await fetch(`http://127.0.0.1:${server.address().port}/dsh-go/v1/assets/asset-budget-test/${path}`,{method,headers});
  return {status:r.status,bytes:Buffer.from(await r.arrayBuffer()),length:r.headers.get('content-length'),etag:r.headers.get('etag')};
 };
 return{file,request};
}
// I/O scheduling fence only. At this boundary the unchanged production route
// has completed its real stat/path checks. Grow the same real file, then call
// Node's original readFile. No fake Stat/Buffer, loader flags, sleeps or hook.
function growAtRead(t,file,size){
 const read=fs.readFile;let calls=0;
 const mocked=t.mock.method(fs,'readFile',async function(path,...args){
  if(path===file){calls++;assert.equal((await fs.stat(file)).size,64);await fs.writeFile(file,Buffer.alloc(size))}
  return Reflect.apply(read,this,[path,...args]);
 });
 syncBuiltinESMExports();
 t.after(()=>{mocked.mock.restore();syncBuiltinESMExports()});
 return()=>calls;
}
for(const method of ['GET','HEAD'])test(`${method} rejects asset growth beyond 1 MiB after stat`,async t=>{
 const f=await fixture(t),calls=growAtRead(t,f.file,LIMIT+1),r=await f.request(method);
 assert.equal(calls(),1);
 console.log(JSON.stringify({case:'oversize-growth',method,status:r.status,bytes:r.bytes.length,contentLength:r.length,readCalls:calls()}));
 assert.equal(r.status,404,'stat size must not authorize a larger actual asset response');
 if(method==='GET')assert.equal(JSON.parse(r.bytes).error.code,'not-found');
 else assert.equal(r.bytes.length,0);
});
for(const method of ['GET','HEAD'])test(`${method} permits exact-limit growth and retains path rejection`,async t=>{
 const f=await fixture(t),calls=growAtRead(t,f.file,LIMIT);
 const rejected=await f.request(method,'%2e%2e%2fpackage.json');
 assert.equal(rejected.status,404);assert.equal(calls(),0);
 const r=await f.request(method);assert.equal(calls(),1);assert.equal(r.status,200);
 assert.equal(r.bytes.length,method==='GET'?LIMIT:0);assert.equal(r.length,String(LIMIT));
 console.log(JSON.stringify({case:'exact-limit-growth',method,status:r.status,bytes:r.bytes.length,contentLength:r.length,rejectedPath:rejected.status}));
});
test('stable asset ETag still returns bodyless 304 without a read',async t=>{
 const f=await fixture(t),first=await f.request();assert.equal(first.status,200);assert.equal(first.bytes.length,64);
 const calls=growAtRead(t,f.file,LIMIT+1);
 const r=await f.request('GET','changing.png',{'if-none-match':first.etag});
 assert.equal(r.status,304);assert.equal(r.bytes.length,0);assert.equal(calls(),0);
});
for(const method of ['GET','HEAD'])test(`${method} reads the validated canonical asset path`,async t=>{
 const f=await fixture(t);
 await fs.symlink('changing.png',join(dirname(f.file),'alias.png'));
 const canonical=await fs.realpath(f.file),read=fs.readFile,paths=[];
 const mocked=t.mock.method(fs,'readFile',async function(path,...args){
  paths.push(path);
  return Reflect.apply(read,this,[path,...args]);
 });
 syncBuiltinESMExports();
 t.after(()=>{mocked.mock.restore();syncBuiltinESMExports()});
 const r=await f.request(method,'alias.png');
 assert.equal(r.status,200);
 assert.equal(r.bytes.length,method==='GET'?64:0);
 assert.equal(r.length,'64');
 assert.deepEqual(paths,[canonical]);
});
