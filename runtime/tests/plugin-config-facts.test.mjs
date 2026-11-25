// Real installed schemas, modeled editor/source services; HTTP Host evidence is separate.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPluginConfig,pluginConfigUnavailable} from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import {withSources} from './plugin-config-source-fixture.mjs';
const {default:z}=await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),'node_modules/@deepseek-ai/schemastery/lib/index.mjs')));
const BASE='/dsh-go/v1/plugin-config',SAMPLE='SYNTHETIC_R6_PRIVATE_DEFAULT';
function fixture(schema,raw={},extra={}){
 const entry={options:{id:'fixture',name:'fixture-package',config:raw},fiber:{state:2,runtime:{Config:schema,callback(){}},config:schema(raw)}};
 let writable=true,edits=0;
 const editor={canWrite:()=>writable,entries:()=>[entry],configuration:()=>[{entry,inherited:{},override:entry.options.config}],async edit(_entry,change){edits++;const next=await change(entry.options.config,{});entry.fiber.config=schema(next);entry.options.config=next;}};
 const ctx={get:key=>key==='configEditor'?editor:key==='loader'?{entries:()=>[entry]}:undefined};
 const source=withSources(ctx,[entry]);editor.documentPath=join(source.root,'profile.yml');writeFileSync(editor.documentPath,'[]\n');
 let response;const api=createPluginConfig(ctx,{send(_r,status,body){response={status,body}},readBody:async req=>Buffer.from(JSON.stringify(req.input))});
 return {entry,editor,source,setWritable:value=>writable=value,edits:()=>edits,async request(method='GET',input,id='fixture'){
  response=undefined;await api.handle({method,input,headers:{'content-type':'application/json'}}, {},id===null?BASE:BASE+'/'+id);return response;
 },...extra};
}
async function view(schema,raw){const f=fixture(schema,raw),r=await f.request();assert.equal(r.status,200);assert(!JSON.stringify(r.body).includes(SAMPLE));return r.body;}
const facts=body=>Object.fromEntries(body.secrets.map(s=>[s.path.join('.'),s.configured]));

test('Cordis effectiveConfig supplies defaults while raw input alone supplies secret facts',async()=>{
 const schema=z.object({title:z.string().default('running default'),rows:z.array(z.object({secret:z.string().role('secret').default(SAMPLE)})).default([{}])});
 const f=fixture(schema);f.entry.fiber.config={};
 Object.defineProperty(f.entry.fiber,'effectiveConfig',{get:()=>schema({})});
 const out=await f.request();assert.equal(out.status,200);assert.equal(out.body.value.title,'running default');
 assert.deepEqual(facts(out.body),{'rows.0.secret':false});assert(!JSON.stringify(out.body).includes(SAMPLE));
});
test('present undefined effectiveConfig never falls back to raw config',async()=>{
 const f=fixture(z.object({title:z.string()}),{title:'raw is not running'});
 Object.defineProperty(f.entry.fiber,'effectiveConfig',{get:()=>undefined});
 const out=await f.request();assert.equal(out.status,200);assert(!('title'in out.body.value));
});
test('labels use top-level bundle metadata, preserving localization and hiding diagnostics',async()=>{
 const f=fixture(z.object({count:z.number().default(1)}));f.source.bundle.meta={title:{en:'Own plugin',zh:'自造插件'},error:SAMPLE};f.source.bundle.rows[0].meta={title:'DO_NOT_PREFER_ROW_TITLE'};f.source.service.metaOf=()=>({title:'DO_NOT_PREFER_MODULE_TITLE'});
 assert.deepEqual((await f.request('GET',undefined,null)).body.entries[0].label,{en:'Own plugin',zh:'自造插件'});
 f.source.bundle.meta={title:'Plugin title'};assert.equal((await f.request('GET',undefined,null)).body.entries[0].label,'Plugin title');
 f.source.bundle.meta={error:SAMPLE};const out=await f.request('GET',undefined,null);assert.equal(out.body.entries[0].label,'fixture');assert(!JSON.stringify(out).includes(SAMPLE));
});
test('raw absent/null/empty are not configured; explicit false/zero/equal-default are',async()=>{
 const field=()=>z.any().role('secret').default(SAMPLE);
 const body=await view(z.object({absent:field(),nil:field(),empty:field(),bool:field(),zero:field(),same:field()}),{nil:null,empty:'',bool:false,zero:0,same:SAMPLE});
 assert.deepEqual(facts(body),{absent:false,nil:false,empty:false,bool:true,zero:true,same:true});assert(body.secrets.every(x=>x.writable===false&&!('credentialRef'in x)));
});
test('default objects and arrays retain false facts at visible secret paths',async()=>{
 const body=await view(z.object({optional:z.object({secret:z.string().role('secret'),ref:z.string().role('credential-ref').default('UNBOUND_REF')}),parent:z.object({secret:z.string().role('secret').default(SAMPLE)}).default({}),rows:z.array(z.object({secret:z.string().role('secret').default(SAMPLE)})).default([{}])}),{});
 assert.deepEqual(facts(body),{'optional.secret':false,'parent.secret':false,'rows.0.secret':false});
});
for(const kind of ['union','intersect'])for(const reverse of [false,true])test(`${kind} shared facts follow concrete raw paths, reverse=${reverse}`,async()=>{
 const secret=z.string().role('secret').default(SAMPLE),left=z.object({first:secret,second:secret}),right=z.object({visible:z.string().default('ok')});
 const body=await view(z.object({branch:z[kind](reverse?[right,left]:[left,right]).default({})}),{branch:{first:SAMPLE}});
 assert.deepEqual(facts(body),{'branch.first':true,'branch.second':false});
});
test('arrays and dictionaries keep concrete keys and ignore missing default leaves',async()=>{
 const secret=z.string().role('secret').default(SAMPLE),schema=z.object({rows:z.array(z.object({secret})),dict:z.dict(z.object({secret}))});
 const body=await view(schema,{rows:[{secret:SAMPLE},{}],dict:{first:{secret:SAMPLE},second:{}}});assert.deepEqual(facts(body),{'rows.0.secret':true,'rows.1.secret':false,'dict.first.secret':true,'dict.second.secret':false});
});
test('transform ancestor cannot establish output-position origin; its own secret boundary can',async()=>{
 const inner=z.object({secret:z.string().role('secret')});const schema=z.object({mapped:z.transform(inner,x=>({secret:SAMPLE})),boundary:z.transform(z.any(),x=>x,true).role('secret')});
 const body=await view(schema,{mapped:{secret:SAMPLE},boundary:SAMPLE});assert.deepEqual(facts(body),{'mapped.secret':false,boundary:true});
});
test('raw expressions and loose schema locations stay unconfigured',async()=>{
 const schema=z.object({secret:z.any().role('secret'),loose:z.string().role('secret').loose().default(SAMPLE)});
 const body=await view(schema,{secret:{__jsExpr:'SYNTHETIC_EXPRESSION'},loose:12});assert.deepEqual(facts(body),{secret:false,loose:false});
});
test('shared secret path with uncertain transform is conservative in both branch orders',async()=>{
 for(const reverse of [false,true]){const plain=z.object({secret:z.string().role('secret')}),wrapped=z.transform(plain,x=>x);const body=await view(z.object({value:z.intersect(reverse?[wrapped,plain]:[plain,wrapped])}),{value:{secret:SAMPLE}});assert.equal(facts(body)['value.secret'],false);}
});
test('M0-shaped empty sentinel is false for default and explicit raw input',async()=>{
 const sentinel=z.transform(z.any(),value=>{if(value!=='')throw Error('only empty');return value;}).default('').role('secret');
 for(const raw of [{},{slot:{apiKey:''}}]){const body=await view(z.object({slot:z.object({apiKey:sentinel}).default({})}),raw);assert.equal(facts(body)['slot.apiKey'],false);}
});
for(const [name,field,input]of [
 ['empty object with only schema defaults',z.object({token:z.string().default(SAMPLE)}).role('secret'),{}],
 ['empty array',z.array(z.string()).role('secret'),[]],
 ['unknown key with only schema-default payload',z.object({token:z.string().default(SAMPLE)}).role('secret'),{unused:'public'}],
 ['explicit nonempty structured secret remains unknown',z.any().role('secret'),{token:SAMPLE}],
 ['nonfinite input remains unknown',z.any().role('secret'),Infinity],
])test(`structured/unknown secret boundary is not configured: ${name}`,async()=>{
 const body=await view(z.object({secret:field}),{secret:input});assert.deepEqual(facts(body),{secret:false});
});
test('invalid config returns safe operation path and a display message',async()=>{
 const f=fixture(z.object({count:z.number().default(1)}));const before=await f.request();const out=await f.request('POST',{revision:before.body.revision,ops:[{op:'set',path:['count'],value:SAMPLE}]});
 assert.equal(out.status,422);assert.equal(out.body.error.code,'invalid-config');assert.deepEqual(out.body.error.path,['count']);assert.notEqual(out.body.error.message,out.body.error.code);assert(!JSON.stringify(out).includes(SAMPLE));
});
test('invalid operation path is present only for bounded accepted string segments',async()=>{
 const f=fixture(z.object({secret:z.string().role('secret'),count:z.number().default(1)})),before=await f.request();
 const out=await f.request('POST',{revision:before.body.revision,ops:[{op:'set',path:['secret'],value:SAMPLE}]});assert.equal(out.status,400);assert.deepEqual(out.body.error.path,['secret']);assert(!JSON.stringify(out).includes(SAMPLE));
 const unsafe=await f.request('POST',{revision:before.body.revision,ops:[{op:'set',path:['__proto__'],value:1}]});assert.equal(unsafe.status,400);assert(!('path'in unsafe.body.error));
});
for(const errorPath of [[SAMPLE],[Symbol('private')],['count',SAMPLE]])test(`custom validation details are never forwarded: ${typeof errorPath[0]} ${errorPath.length}`,async()=>{
 const schema=z.object({count:z.transform(z.number(),x=>{if(x===2)throw new z.ValidationError(SAMPLE,{path:errorPath});return x;}).default(1)});
 const f=fixture(schema),before=await f.request(),out=await f.request('POST',{revision:before.body.revision,ops:[{op:'set',path:['count'],value:2}]});assert.equal(out.status,422);assert(!JSON.stringify(out).includes(SAMPLE));if(errorPath[0]==='count')assert.deepEqual(out.body.error.path,['count']);else assert(!('path'in out.body.error));
});
test('missing or false canWrite is read-only and rejects before edits',async()=>{
 const f=fixture(z.object({count:z.number().default(1)}));f.setWritable(false);const before=await f.request();assert.equal(before.body.writable,false);assert.equal((await f.request('GET',undefined,null)).body.entries[0].writable,false);
 const out=await f.request('POST',{revision:before.body.revision,ops:[{op:'set',path:['count'],value:2}]});assert.equal(out.status,409);assert.equal(out.body.error.code,'overridden');assert.equal(f.edits(),0);
 delete f.editor.canWrite;assert.equal((await f.request()).body.writable,false);
});
for(const seam of ['configuration','edit'])test(`foreign ${seam} error cannot forge public code/status/path`,async()=>{
 const f=fixture(z.object({count:z.number().default(1)})),before=await f.request();
 f.editor[seam]=()=>{throw Object.assign(new Error(SAMPLE),{code:'invalid-config',status:422,path:[SAMPLE]});};
 const out=seam==='configuration'?await f.request():await f.request('POST',{revision:before.body.revision,ops:[{op:'set',path:['count'],value:2}]});
 assert.equal(out.status,seam==='configuration'?503:409);assert(!('path'in out.body.error));assert(!JSON.stringify(out).includes(SAMPLE));
});
test('405 is JSON-shaped and service-unavailable applies only to exact config prefix',async()=>{
 const f=fixture(z.object({}));for(const id of [null,'fixture']){const out=await f.request('DELETE',undefined,id);assert.equal(out.status,405);assert.equal(out.body.v,1);assert.equal(out.body.error.code,'invalid-operation');assert.notEqual(out.body.error.message,out.body.error.code);}
 assert.equal(pluginConfigUnavailable({url:BASE+'/fixture?x=1'}).error.code,'host-unavailable');assert.equal(pluginConfigUnavailable({url:BASE+'-other'}),undefined);
});
