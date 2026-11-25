import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {NativeCore} from '../bridge/dsh-go-bridge/lib/native/core.js';
import {effectiveLimits} from '../bridge/dsh-go-bridge/lib/native/limits.js';
import {createNativeRoutes} from '../bridge/dsh-go-bridge/lib/native/routes.js';
const prefixArg=process.env.DSH_TEST_PREFIX??process.env.DSH_PREFIX;
const PKG='micro-manifest-test';

async function fixture(t){
 const prefix=resolve(prefixArg);
 const {boot}=await import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')));
 t.mock.timers.enable({apis:['Date','setTimeout'],now:Date.now()});
 t.after(()=>t.mock.timers.reset());
 const dir=await mkdtemp(join(tmpdir(),'micro-manifest-owner-'));
 let ctx,core,routes,server,ws;
 const probe={starts:0,cleanups:0,emitters:[]};
 const manifest=(name,version)=>({name,version,type:'module',dshGo:{v:1,capabilities:['micro'],contributes:{micro:[{id:'caption'}]}}});
 const write=async(which,version)=>writeFile(join(dir,which,'package.json'),JSON.stringify(manifest(which==='main'?PKG:'micro-unrelated-test',version)));
 const {mkdir}=await import('node:fs/promises');
 await mkdir(join(dir,'main'));await mkdir(join(dir,'other'));
 await write('main','1.0.0');await write('other','1.0.0');
 await writeFile(join(dir,'main','plugin.mjs'),`
import {readFileSync} from 'node:fs';
export const inject=['dshGo','probe'];
export function apply(ctx){ctx.dshGo.micro('caption',{data(scope,emit){
 ctx.probe.starts++;ctx.probe.emitters.push(emit);
 emit({text:'manifest-'+JSON.parse(readFileSync(new URL('./package.json',import.meta.url),'utf8')).version});
 return()=>{ctx.probe.cleanups++};
}});}
`);
 await writeFile(join(dir,'other','plugin.mjs'),'export function apply(){}');
 const main=join(dir,'main.json');await writeFile(main,JSON.stringify([
  {id:'micro',name:pathToFileURL(join(dir,'main','plugin.mjs')).href},
  {id:'other',name:pathToFileURL(join(dir,'other','plugin.mjs')).href},
 ]));
 let broadcast;const firstChanged=new Promise(r=>broadcast=r);
 t.after(async()=>{ws?.close();routes?.dispose();await ctx?.fiber.dispose();core?.dispose();server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true})});
 ctx=await boot('dsh',main,[],c=>{core=new NativeCore(c,effectiveLimits({}),'test');core.onChanged(broadcast);c.provide('dshGo',core.service);c.provide('probe',probe)});
 await ctx.loader.await();assert(ctx.loader.resolve('include:micro'));assert(ctx.loader.resolve('include:other'));
 routes=createNativeRoutes(core);server=createServer((req,res)=>{const u=new URL(req.url,'http://local');void routes.handle(req,res,u.pathname,u)});server.on('upgrade',(req,s,h)=>routes.upgrade(req,s,h));
 server.listen(0,'127.0.0.1');await once(server,'listening');
 ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/dsh-go/v1/stream`);
 const messages=[],waiters=[];
 ws.addEventListener('message',e=>{const m=JSON.parse(e.data);messages.push(m);for(const w of [...waiters])if(w.p(m)){waiters.splice(waiters.indexOf(w),1);clearTimeout(w.timer);w.resolve(m)}});
 const next=p=>{const m=messages.find(p);if(m)return Promise.resolve(m);return new Promise((resolve,reject)=>{const w={p,resolve,timer:setTimeout(()=>reject(Error('WS response deadline')),3000)};waiters.push(w)})};
 const send=m=>ws.send(JSON.stringify(m));
 await once(ws,'open');send({t:'hello',v:[1],features:['micro']});await next(m=>m.t==='welcome');
 send({t:'micro.sub',sub:'old',pkg:PKG,id:'caption'});const first=await next(m=>m.t==='micro.data'&&m.sub==='old');
 // Advance the real production debounce under Node's fake clock; keep
 // actual Loader, files and sockets. No elapsed-time wait or private state.
 t.mock.timers.tick(300);
 await firstChanged;
 const before=core.plugin(PKG),registration=core.registration(PKG,'micro','caption');
 t.mock.timers.tick(5000);
 return{core,probe,write,messages,next,send,first,before,registration};
}

for(const change of ['main','none','other'])test(`micro cached subscription respects ${change} manifest ownership`,{skip:!prefixArg&&'set DSH_TEST_PREFIX or DSH_PREFIX to a prepared DSH prefix',timeout:5000},async t=>{
 const f=await fixture(t);
 if(change!=='none')await f.write(change,'1.0.10');
 f.send({t:'micro.sub',sub:'new',pkg:PKG,id:'caption'});
 const second=await f.next(m=>m.t==='micro.data'&&m.sub==='new');
 f.send({t:'ping',at:1});await f.next(m=>m.t==='pong'&&m.at===1);
 const after=f.core.plugin(PKG);
 assert.equal(after.uid,f.before.uid,'real Loader identity is unchanged');
 assert.equal(f.core.registration(PKG,'micro','caption'),f.registration,'registration/token was not replaced');
 console.log(JSON.stringify({change,before:{uid:f.before.uid,stamp:f.before.stamp},after:{uid:after.uid,stamp:after.stamp},first:f.first,second,starts:f.probe.starts,cleanups:f.probe.cleanups}));
 if(change==='main'){
  assert.notEqual(after.stamp,f.before.stamp);
  assert.notEqual(second.rev,f.first.rev,'new subscriber cannot receive the previous manifest generation cache');
  assert.equal(second.data.text,'manifest-1.0.10');
  assert.equal(f.probe.starts,2);assert.equal(f.probe.cleanups,1);
  assert.deepEqual(f.messages.filter(m=>m.t==='micro.end'),[{t:'micro.end',sub:'old',reason:'not-found'}]);
  f.probe.emitters[0]({text:'late-old'});
  f.send({t:'ping',at:2});await f.next(m=>m.t==='pong'&&m.at===2);
  assert.equal(f.messages.some(m=>m.t==='micro.data'&&m.data.text==='late-old'),false);
  assert.equal(f.probe.cleanups,1);
 }else{
  assert.equal(after.stamp,f.before.stamp);assert.equal(second.rev,f.first.rev);
  assert.deepEqual(second.data,f.first.data);assert.equal(f.probe.starts,1);assert.equal(f.probe.cleanups,0);
  assert.equal(f.messages.some(m=>m.t==='micro.end'),false);
 }
});
