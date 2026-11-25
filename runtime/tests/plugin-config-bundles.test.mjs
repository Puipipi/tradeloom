// Real temporary package identities and modeled bundle/Loader services.
// The public rc4 Host test is separate; this suite does not claim actual HMR.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createPluginConfig} from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import {withSources} from './plugin-config-source-fixture.mjs';
const BASE='/dsh-go/v1/plugin-config';
const schema=Object.assign(x=>x,{toJSON:()=>({uid:1,refs:{1:{type:'object',dict:{count:2}},2:{type:'number'}}})});
function fixture(){
 const entry={options:{id:'one',name:'own-plugin',config:{count:1}},fiber:{state:2,runtime:{Config:schema,callback(){}},config:{count:1}}},entries=[entry];
 let writes=0,beforeChange=()=>{};
 const editor={canWrite:()=>true,entries:()=>entries,configuration:()=>entries.map(entry=>({entry,inherited:{},override:entry.options.config})),async edit(entry,change){beforeChange();const next=await change(entry.options.config,{});writes++;entry.options.config=next;entry.fiber.config=next;}};
 const ctx={get:n=>n==='configEditor'?editor:n==='loader'?{entries:()=>entries}:undefined},source=withSources(ctx,entries);editor.documentPath=join(source.root,'patch.yml');writeFileSync(editor.documentPath,'[]\n');
 let response;const api=createPluginConfig(ctx,{send(_r,status,body){response={status,body}},readBody:async req=>Buffer.from(JSON.stringify(req.input))});
 return {entry,entries,editor,ctx,...source,writes:()=>writes,setBeforeChange:fn=>beforeChange=fn,async call(id='one',method='GET',input){response=undefined;await api.handle({method,input,headers:{'content-type':'application/json'}},{},id===null?BASE:BASE+'/'+id);return response;}};
}
const input={revision:'OLD_REVISION',ops:[{op:'set',path:['count'],value:2}]};
async function deny(f,id='one'){
 assert.equal((await f.call(id)).status,403);assert.equal((await f.call(id,'POST',input)).status,403);
 assert.equal((await f.call(id,'POST',null)).status,403);assert.equal(f.writes(),0);
 const row=(await f.call(null)).body.entries.find(e=>e.entryId===id);assert(row&&!row.configurable&&!row.writable);
}
function optional(f){
 const dir=join(f.root,'optional');mkdirSync(dir);writeFileSync(join(dir,'package.json'),JSON.stringify({name:'own-plugin'}));writeFileSync(join(dir,'index.js'),'');
 f.files.set('own-plugin',join(dir,'index.js'));f.packages.set('own-plugin',{name:'own-plugin',dir,manifestPath:join(dir,'package.json')});
 f.service.resolution.entries.push({name:'own-plugin',packageDir:dir,scope:'installation'});
 Object.assign(f.bundle,{name:'official-optional-bundle',official:true,optional:true,installed:false});delete f.bundle.source;
}
test('exact installed bundle instance has the new owner/bundle and can write',async()=>{
 const f=fixture(),before=await f.call();assert.equal(before.status,200);assert.equal(before.body.owner,'installed');assert.equal(before.body.bundle,'fixture-bundle');
 assert.equal((await f.call('one','POST',{...input,revision:before.body.revision})).status,200);assert.equal(f.writes(),1);
});
for(const [name,mutate]of [
 ['disabled',b=>b.enabled=false],['error',b=>b.error={code:'synthetic'}],['missing installed',b=>b.installed=false],
 ['missing source',b=>delete b.source],['empty source',b=>b.source='  '],['wrong source type',b=>b.source={}],
 ['only official',b=>{b.installed=false;b.official=true;}],['only optional',b=>{b.installed=false;b.optional=true;}],
 ['truthy enabled',b=>b.enabled='true'],['truthy installed',b=>b.installed=1],
])test(`bundle qualification denies ${name}`,async()=>{const f=fixture();mutate(f.bundle);await deny(f);});
for(const [name,mutate]of [
 ['missing entryId',f=>delete f.bundle.rows[0].entryId],['wrong entryId',f=>f.bundle.rows[0].entryId='nested:one'],
 ['wrong rowId',f=>f.bundle.rows[0].rowId='other'],['different module',f=>f.bundle.rows[0].moduleName='another'],
 ['nested parent',f=>f.entry.parent.tree.ctx.fiber.entry.id='nested'],['nested actual id',f=>f.entry.id='include:include:one'],
 ['no bundle',f=>f.bundles.pop()],['two owners',f=>f.bundles.push({...f.bundle,name:'second-owner'})],
 ['duplicate declaration',f=>f.bundle.rows.push({...f.bundle.rows[0]})],
])test(`declared instance mapping denies ${name}`,async()=>{const f=fixture();mutate(f);await deny(f);});
test('same module in a separate active overlay cannot borrow bundle membership',async()=>{
 const f=fixture();f.entries.push({id:'include:dsh-app-phone',options:{id:'dsh-app-phone',name:'own-plugin',config:{count:1}},parent:f.entry.parent,fiber:{...f.entry.fiber}});
 await deny(f,'dsh-app-phone');assert.equal((await f.call()).status,200);
 const row=(await f.call(null)).body.entries.find(x=>x.entryId==='dsh-app-phone');assert.equal(row.owner,'overlay');assert.equal(row.bundle,null);
});
test('disabled catalog declaration does not steal one enabled bundle ownership',async()=>{
 const f=fixture();f.bundles.push({...f.bundle,name:'disabled-other',enabled:false});assert.equal((await f.call()).status,200);
});
test('official optional installation module is allowed with its exact row',async()=>{
 const f=fixture();optional(f);const before=await f.call();assert.equal(before.status,200);assert.equal(before.body.owner,'optional');
 assert.equal((await f.call('one','POST',{...input,revision:before.body.revision})).status,200);
});
test('official optional sharing a core canonical module remains denied',async()=>{
 const f=fixture();optional(f);f.files.set('own-plugin',join(f.install,'index.js'));await deny(f);
});
test('unreadable trusted core declarations deny optional entitlement',async()=>{
 const f=fixture();optional(f);f.bundles[0].error={code:'unreadable'};await deny(f);
});
test('official optional may resolve from a verified profile package',async()=>{
 const f=fixture();Object.assign(f.bundle,{official:true,optional:true});assert.equal((await f.call()).status,200);
});
test('installed wrapper can declare non-core installation plugin code',async()=>{
 const f=fixture();optional(f);Object.assign(f.bundle,{official:false,optional:false,installed:true,source:'file:synthetic'});assert.equal((await f.call()).status,200);
});
test('qualification is reread within the awaited edit callback',async()=>{
 const f=fixture(),before=await f.call();f.setBeforeChange(()=>f.bundle.enabled=false);
 assert.equal((await f.call('one','POST',{...input,revision:before.body.revision})).status,403);assert.equal(f.writes(),0);assert.equal(f.entry.options.config.count,1);
});
test('manager replacement during asynchronous read fails closed',async()=>{
 const f=fixture(),old=f.ctx.get;f.manager.listBundles=async()=>{f.ctx.get=n=>n==='pluginManager'?{listBundles:async()=>f.bundles}:old(n);return f.bundles;};
 assert.equal((await f.call()).status,409);assert.equal(f.writes(),0);
});
test('fresh Cordis-shaped proxies with a stable original do not look replaced',async()=>{
 const f=fixture(),old=f.ctx.get,original=Symbol.for('cordis.original');f.ctx.get=n=>{
  const value=old(n);return ['pluginManager','configEditor'].includes(n)?new Proxy(value,{get:(target,key)=>key===original?target:Reflect.get(target,key)}):value;
 };assert.equal((await f.call()).status,200);
});
test('missing manager or asynchronous read errors never grant access',async()=>{
 for(const mode of ['absent','error']){const f=fixture();if(mode==='absent'){const old=f.ctx.get;f.ctx.get=n=>n==='pluginManager'?undefined:old(n);}else f.manager.listBundles=async()=>{throw Error('SYNTHETIC_PRIVATE_ERROR')};
  const out=await f.call();assert.equal(out.status,503);assert(!JSON.stringify(out).includes('SYNTHETIC_PRIVATE_ERROR'));}
});
test('older synchronous editor cannot receive an async callback',async()=>{
 const f=fixture();delete f.editor.dshGoAsyncChange;const before=await f.call();assert.equal(before.status,200);assert.equal(before.body.writable,false);
 assert.equal((await f.call('one','POST',{...input,revision:before.body.revision})).status,503);assert.equal(f.writes(),0);
});
