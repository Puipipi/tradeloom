// Real NativeCore/routes, public registrations and WebSocket frames. Only Loader identity is a fixture.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {pathToFileURL} from 'node:url';
import {NativeCore} from '../bridge/dsh-go-bridge/lib/native/core.js';
import {effectiveLimits} from '../bridge/dsh-go-bridge/lib/native/limits.js';
import {createNativeRoutes} from '../bridge/dsh-go-bridge/lib/native/routes.js';

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'dsh-micro-generation-'));
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'micro-generation-test',version:'1.0.0',dshGo:{v:1,capabilities:['micro'],contributes:{micro:[{id:'caption'},{id:'other'}]}}}));
  await writeFile(join(dir,'index.js'),'');
  const entry={options:{name:pathToFileURL(join(dir,'index.js')).href},parent:{tree:{ctx:{baseUrl:pathToFileURL(dir+'/').href}}},fiber:{uid:7}};
  const disposers=[];
  const core=new NativeCore({get:n=>n==='loader'?{entries:()=>[entry]}:undefined,logger:{warn(){}}},effectiveLimits({}),'test');
  const routes=createNativeRoutes(core);
  const service=Object.assign(Object.create(core.service),{ctx:{fiber:{entry},effect(fn){const d=fn();disposers.push(d);return d;}}});
  const server=createServer((req,res)=>{const u=new URL(req.url,'http://local');void routes.handle(req,res,u.pathname,u)});
  server.on('upgrade',(req,s,h)=>routes.upgrade(req,s,h));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const ws=new WebSocket(`ws://127.0.0.1:${server.address().port}/dsh-go/v1/stream`);
  const events=[],queued=[],waiters=[];
  ws.addEventListener('message',e=>{
    const m=JSON.parse(e.data);events.push(m);
    const i=waiters.findIndex(w=>w.p(m));
    if(i<0)queued.push(m);else{const [w]=waiters.splice(i,1);clearTimeout(w.timer);w.resolve(m);}
  });
  const next=p=>{
    const i=queued.findIndex(p);if(i>=0)return Promise.resolve(queued.splice(i,1)[0]);
    return new Promise((resolve,reject)=>{const w={p,resolve,timer:setTimeout(()=>reject(Error('WS response deadline')),2000)};waiters.push(w)});
  };
  await once(ws,'open');ws.send(JSON.stringify({t:'hello',v:[1],features:['micro']}));await next(m=>m.t==='welcome');
  let fenceId=0;
  const send=m=>ws.send(JSON.stringify(m));
  const subscribe=sub=>send({t:'micro.sub',sub,pkg:'micro-generation-test',id:'caption'});
  const fence=async()=>{const at=++fenceId;send({t:'ping',at});await next(m=>m.t==='pong'&&m.at===at)};
  t.after(async()=>{
    t.mock.timers.reset();for(const w of waiters)clearTimeout(w.timer);
    ws.close();routes.dispose();core.dispose();for(const d of disposers.reverse())d();
    server.closeAllConnections();await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});
  });
  return {core,service,events,next,send,subscribe,fence};
}

for(const mode of ['replace','dispose','replace-invalid']) {
  test(`micro rejects late producer after ${mode} and can subscribe replacement`,async t=>{
    const f=await fixture(t);let entered,release,cleanups=0;
    const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
    const remove=f.service.micro('caption',{async data(scope,emit){
      entered();await gate;emit(mode==='replace-invalid'?{tree:{forbidden:true}}:{text:'old'});
      return()=>{cleanups++};
    }});
    f.subscribe('old');await started;
    if(mode==='dispose')remove();else f.service.micro('caption',{data(scope,emit){emit({text:'new'})}});
    release();
    const ended=await f.next(m=>m.t==='micro.end'&&m.sub==='old');assert.equal(ended.reason,'not-found');
    await f.fence();
    assert.deepEqual(f.events.filter(m=>m.t==='micro.data'&&m.sub==='old'),[]);
    assert.equal(f.core.health.get('micro-generation-test')?.consecutive??0,0,'retired invalid emit must not penalize replacement');
    assert.equal(cleanups,1);
    if(mode==='dispose')f.service.micro('caption',{data(scope,emit){emit({text:'new'})}});
    f.subscribe('new');assert.equal((await f.next(m=>m.t==='micro.data'&&m.sub==='new')).data.text,'new');
    assert.equal(cleanups,1);
  });
}

test('micro queued value cannot flush after replacement before deferred sweep',async t=>{
  const f=await fixture(t);let emit,cleanups=0;
  let wall=Date.now(),mono=0;
  t.mock.method(Date,'now',()=>wall);
  t.mock.method(performance,'now',()=>mono);
  f.service.micro('caption',{data(scope,publish){emit=publish;publish({text:'first'});return()=>{cleanups++};}});
  f.subscribe('m');await f.next(m=>m.t==='micro.data');
  // Freeze both producer clocks, not the WebSocket: queue within 100ms, replace,
  // and drive its actual production timeout before setImmediate can sweep.
  t.mock.timers.enable({apis:['setTimeout'],now:0});
  emit({text:'queued old'});
  f.service.micro('caption',{data(scope,publish){publish({text:'new'});}});
  wall+=100;mono+=100;
  t.mock.timers.tick(100);
  t.mock.timers.reset();
  t.mock.restoreAll();
  await f.next(m=>m.t==='micro.end');await f.fence();
  assert.deepEqual(f.events.filter(m=>m.t==='micro.data').map(m=>m.data.text),['first']);
  assert.equal(cleanups,1);
});

test('unrelated registration preserves a current micro producer and last unsubscribe cancels once',async t=>{
  const f=await fixture(t);let entered,release,emit,cleanups=0;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>release=r);
  f.service.micro('caption',{async data(scope,publish){emit=publish;entered();await gate;publish({text:'current'});return()=>{cleanups++};}});
  f.subscribe('m');await started;
  f.service.micro('other',{data(){}});release();
  assert.equal((await f.next(m=>m.t==='micro.data')).data.text,'current');await f.fence();
  assert.equal(f.events.filter(m=>m.t==='micro.end').length,0);assert.equal(cleanups,0);
  f.send({t:'micro.unsub',sub:'m'});await f.fence();assert.equal(cleanups,1);
  emit({text:'after unsubscribe'});await f.fence();
  assert.deepEqual(f.events.filter(m=>m.t==='micro.data').map(m=>m.data.text),['current']);assert.equal(cleanups,1);
});
