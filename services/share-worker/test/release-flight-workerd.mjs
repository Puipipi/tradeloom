import {createRequire} from 'node:module';
const require=createRequire(new URL('../package.json',import.meta.url));
const {build}=require('esbuild'); const {Miniflare}=require('miniflare');
const entry=new URL('../src/index.ts',import.meta.url).pathname;
const contents=`import worker from ${JSON.stringify(entry)};
let requests=0, reads=0;
const wrappers=new WeakMap();
export default {async fetch(req,env,ctx){
const path=new URL(req.url).pathname;
if(path==='/__test/count')return Response.json({requests,reads});
requests++;
const bucket=env.BUCKET;
let delegated=wrappers.get(bucket);
if(!delegated){delegated={get:async key=>{reads++;return bucket.get(key);}};wrappers.set(bucket,delegated);}
return worker.fetch(req,{...env,BUCKET:delegated},ctx);
}};`;
const bundle=await build({stdin:{contents,resolveDir:new URL('../',import.meta.url).pathname},bundle:true,format:'esm',platform:'browser',write:false});
const mf=new Miniflare({telemetry:{enabled:false},cf:false,workers:[{config:{name:'local',compatibilityDate:'2026-10-01',manifest:{mainModule:'index.js',modules:{'index.js':{type:'esm',contents:bundle.outputFiles[0].text}}},env:{BUCKET:{type:'r2',name:'synthetic'},DOWNLOAD_ACCESS:{type:'text',value:'public'}}}}]});
try {
const bucket=await mf.getR2Bucket('BUCKET','local');
await bucket.put('beta/update.json',JSON.stringify({schema:1,version:'1.0.1+123',routes:['global'],assets:{arm64:{name:'dsh-go-1.0.1-arm64.apk',size:10,sha256:'ab'.repeat(32)}}}));
const base=await mf.ready;
const requests=Array.from({length:20},()=>fetch(new URL('/download',base)).then(async r=>({status:r.status,valid:(await r.text()).includes('1.0.1')})));
const responses=await Promise.all(requests);
const after=await(await fetch(new URL('/__test/count',base))).json();
console.log(JSON.stringify({after,responses}));
if(responses.some(r=>r.status!==200||!r.valid))throw Error('invalid public route response');
if(after.reads!==1)throw Error(`expected one shared R2 read, got ${after.reads}`);
} finally {await mf.dispose();}
