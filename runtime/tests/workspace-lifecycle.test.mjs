// DSH_PREFIX: isolated original-lock modules with repository runtime pins applied.
// Use actual Cordis plugin disposal; only backend storage-unit I/O is controlled.
import test from 'node:test';
import assert from 'node:assert/strict';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const prefix=resolve(process.env.DSH_PREFIX);
const load=n=>import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai',n,'lib/index.js')));
const {Context}=await load('cordis');
const {DomainFacility}=await load('dsh-storage-domain');
const {WorkspaceRegistry}=await load('dsh-workspace');
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function fixture(t,{hold=false,failOpen=false}={}) {
  const ctx=new Context();const entered=gate(),release=gate();let opens=0,closes=0;
  const medium={global:null,tables:{workspaces:{}}};
  ctx.provide('sessionPersistence',{list:async()=>[]});
  ctx.provide('storage',{backend:{get:()=>({kv:{open:async()=>{
    opens++; if(failOpen){failOpen=false;throw Object.assign(new Error('controlled open EIO'),{code:'EIO'});}
    return {loadAll:async()=>{if(hold){hold=false;entered.resolve();await release.promise;}return structuredClone(medium);},
      close:async()=>{closes++;},setGlobal:async v=>{medium.global=structuredClone(v);},
      putRecord:async(table,id,v)=>{medium.tables[table][id]=structuredClone(v);},deleteRecord:async(table,id)=>{delete medium.tables[table][id];}};
  }}})}});
  const facility=new DomainFacility(ctx,{backend:'controlled'});ctx.provide('storageDomain',facility);
  const plugins=[];const start=()=>{const p=ctx.plugin(WorkspaceRegistry);plugins.push(p);return p;};
  t.after(async()=>{release.resolve();for(const p of plugins)await p.dispose();await facility.closeAll();await ctx.fiber.dispose();});
  return {ctx,facility,entered,release,start,get opens(){return opens;},get closes(){return closes;}};
}
test('normal WorkspaceRegistry plugin closes its owned domain and can reopen',async t=>{
 const f=fixture(t);const first=f.start();await first.await();assert.ok(f.facility.get('workspace'));
 await first.dispose();assert.equal(f.closes,1);assert.equal(f.facility.get('workspace'),undefined);
 const second=f.start();await second.await();await second.dispose();assert.equal(f.closes,2);
});
test('disposing a real plugin during load closes the late domain and allows same plugin restart',async t=>{
 const f=fixture(t,{hold:true});const first=f.start();await f.entered.promise;
 const stopping=first.dispose();f.release.resolve();await stopping;
 const beforeRestart={closed:f.closes,retained:!!f.facility.get('workspace')};
 const second=f.start();let restartError;try{await second.await();}catch(e){restartError=e;}
 assert.deepEqual({ ...beforeRestart,restartCode:restartError?.code },{closed:1,retained:false,restartCode:undefined});
 await second.dispose();assert.equal(f.closes,2);
});
test('failure before acquiring a unit leaves no domain and a new plugin can retry',async t=>{
 const f=fixture(t,{failOpen:true});const first=f.start();await assert.rejects(first.await(),e=>e.code==='EIO');await first.dispose();
 assert.equal(f.closes,0);assert.equal(f.facility.get('workspace'),undefined);
 const second=f.start();await second.await();await second.dispose();assert.equal(f.closes,1);assert.equal(f.opens,2);
});
