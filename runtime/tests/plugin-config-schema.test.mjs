// Real rc4 Schemastery graphs, actual bridge GET; no network or credentials.
// TZ=Asia/Shanghai DSH_PREFIX=/path/to/rc4 node runtime/tests/plugin-config-schema.test.mjs
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPluginConfig} from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import {withSources} from './plugin-config-source-fixture.mjs';
const {default:z}=await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),'node_modules/@deepseek-ai/schemastery/lib/index.mjs')));
const marker='SCHEMA_SYNTHETIC_SECRET';
async function responseFor(schema,raw){
 const entry={options:{id:'test',name:'test-plugin',config:raw},fiber:{state:2,uid:7,runtime:{Config:schema},config:schema(raw)}};
 const editor={canWrite:()=>true,entries:()=>[entry],configuration:()=>[{entry,inherited:raw,override:raw}]};
 const ctx={get:n=>n==='configEditor'?editor:n==='loader'?{entries:()=>[entry]}:undefined};
 withSources(ctx,[entry]);
 let response;const api=createPluginConfig(ctx,{send(_r,status,body){response={status,body}},readBody(){throw Error('unused')}});
 await api.handle({method:'GET'}, {}, '/dsh-go/v1/plugin-config/test');return response;
}
async function read(schema,raw){const response=await responseFor(schema,raw);assert.equal(response.status,200);return response.body;
}
function visible(){return z.string().default('VISIBLE_DEFAULT').description('Visible description').extra('group','display').extra('i18n',{zh:'可见字段',en:'Visible field'}).extra('examples',['ordinary example']);}
function ordinary(){return z.object({secret:z.const(marker).default(marker).extra('examples',[marker]).description('Secret slot'),visible:visible()}).default({secret:marker,visible:'VISIBLE_DEFAULT'}).extra('example',{secret:marker,visible:'EXAMPLE_VISIBLE'}).extra('extra',{sample:marker}).description('Ordinary branch').extra('group','network').extra('i18n',{zh:'配置',en:'Config'});}
function hidden(){return z.object({secret:z.string().role('secret'),visible:z.string()});}
function assertClean(body){
 assert(!JSON.stringify(body).includes(marker),'schema metadata or values contain a synthetic secret');
 const refs=Object.values(body.schema.refs);
 assert(refs.some(n=>n.meta?.default==='VISIBLE_DEFAULT'),'ordinary default retained');
 assert(refs.some(n=>n.meta?.description==='Visible description'&&n.meta?.group==='display'&&n.meta?.i18n?.zh==='可见字段'),'ordinary display metadata retained');
 assert(refs.some(n=>n.meta?.examples?.includes('ordinary example')),'ordinary examples retained');
}
for(const kind of ['union','intersect'])for(const shape of ['object','array'])for(const wrapped of [false,true]){
 test(`${kind} ${shape} ${wrapped?'transform':'direct'} cross-branch metadata`,async()=>{
  let a=ordinary(),b=hidden(),value={secret:marker,visible:'ok'};
  if(shape==='array'){a=z.array(a).default([value]).extra('examples',[[value]]).extra('example',[value]);b=z.array(b);value=[value];}
  if(wrapped){a=z.transform(a,x=>x).default(value).extra('examples',[value]);b=z.transform(b,x=>x);}
  const field=z[kind]([a,b]).default(value).extra('examples',[value]);
  const body=await read(z.object({rows:field}),{rows:value});assertClean(body);
  const direct=Object.values(body.schema.refs).find(n=>n.meta?.description==='Ordinary branch');
  assert(direct?.meta?.group==='network'&&direct.meta.i18n.en==='Config');
  assert.deepEqual(direct.meta.example,{visible:'EXAMPLE_VISIBLE'});
 });
}
test('shared ref metadata collects secret context without discarding ordinary sibling defaults',async()=>{
 const shared=ordinary();const schema=z.object({sensitive:z.union([shared,hidden()]),ordinary:shared});
 const body=await read(schema,{sensitive:{secret:marker,visible:'ok'},ordinary:{secret:marker,visible:'ok'}});
 // Ordinary alias intentionally declares a const equal to the synthetic marker; its
 // runtime value is not a secret declaration. Only metadata is shared across contexts.
 assert(!JSON.stringify(body.schema).includes(marker));
 assert(Object.values(body.schema.refs).some(n=>n.meta?.default==='VISIBLE_DEFAULT'));
 assert.deepEqual(body.value.sensitive,{visible:'ok'});
});
test('scalar const and examples hidden by secret sibling',async()=>{
 const scalar=z.const(marker).default(marker).extra('example',marker).extra('examples',[marker]).extra('enum',[marker]).extra('pattern',marker);
 const body=await read(z.object({secret:z.union([scalar,z.string().role('secret')]),visible:visible()}),{secret:marker,visible:'ok'});
 assertClean(body);assert.deepEqual(body.value,{visible:'ok'});
});
test('unrelated ordinary metadata is preserved exactly',async()=>{
 const node=visible().extra('extra',{widget:'safe-widget'}).extra('custom',{harmless:'metadata'});
 const schema=z.object({value:node});const body=await read(schema,{value:'ok'});
 const original=schema.toJSON();assert.deepEqual(body.schema,original);
});

test('object const branch preserves ordinary default members after sibling secret masking',async()=>{
 const value={secret:marker,visible:'CONST_VISIBLE'};
 const ordinary=z.const(value).default(value).extra('example',value).extra('examples',[value]);
 const schema=z.object({rows:z.union([ordinary,hidden()]),visible:visible()});
 const body=await read(schema,{rows:value,visible:'ok'});assertClean(body);
 const constant=Object.values(body.schema.refs).find(n=>n.type==='const'&&n.value?.visible==='CONST_VISIBLE');
 assert.deepEqual(constant.value,{visible:'CONST_VISIBLE'});assert.deepEqual(constant.meta.default,{visible:'CONST_VISIBLE'});assert.deepEqual(constant.meta.examples,[{visible:'CONST_VISIBLE'}]);
 assert.deepEqual(body.value.rows,{visible:'CONST_VISIBLE'});
});

for(const kind of ['union','intersect'])for(const key of ['secret','0','*']){
 test(`${kind} dict shared element receives fixed object key ${key}`,async()=>{
  const ordinary=z.dict(z.string().default(marker).extra('examples',[marker]));
  const hidden=z.object({[key]:z.string().role('secret')});
  const body=await read(z.object({rows:z[kind]([ordinary,hidden]),visible:visible()}),{rows:{[key]:marker,other:'ok'},visible:'ok'});
  assertClean(body);assert.deepEqual(body.value.rows,{other:'ok'});
 });
}
for(const kind of ['union','intersect'])test(`${kind} nested dict object/array metadata propagation`,async()=>{
 const inner=z.object({secret:z.string().default(marker).extra('example',marker),visible:visible()}).default({secret:marker,visible:'INNER_VISIBLE'});
 const ordinary=z.dict(z.array(inner).default([{secret:marker,visible:'INNER_VISIBLE'}]));
 const hidden=z.object({fixed:z.array(z.object({secret:z.string().role('secret'),visible:z.string()}))});
 const body=await read(z.object({rows:z[kind]([ordinary,hidden])}),{rows:{fixed:[{secret:marker,visible:'ok'}]}});
 assertClean(body);assert.deepEqual(body.value.rows,{fixed:[{visible:'ok'}]});
 assert(Object.values(body.schema.refs).some(n=>n.meta?.default?.visible==='INNER_VISIBLE'),'ordinary member of shared default retained');
});
test('canonical index context reaches array shared metadata but preserves other positions',async()=>{
 const ordinary=z.array(z.string().default(marker)).default([marker,'VISIBLE_ARRAY']);
 const hidden=z.object({'0':z.string().role('secret')});
 const body=await read(z.object({rows:z.union([ordinary,hidden]),visible:visible()}),{rows:[marker,'VISIBLE_ARRAY'],visible:'ok'});
 assertClean(body);assert.deepEqual(body.value.rows,[null,'VISIBLE_ARRAY']);
 assert(Object.values(body.schema.refs).some(n=>JSON.stringify(n.meta?.default)==='[null,"VISIBLE_ARRAY"]'));
});
for(const key of ['01','-1','1e0','4294967295','*'])test(`non-index object key ${key} does not mask array elements or defaults`,async()=>{
 const ordinary=z.array(z.string().default('VISIBLE_ARRAY')).default(['VISIBLE_ARRAY']);
 const hidden=z.object({[key]:z.string().role('secret').default(marker)});
 const body=await read(z.object({rows:z.union([ordinary,hidden]),visible:visible()}),{rows:['VISIBLE_ARRAY'],visible:'ok'});
 assertClean(body);assert.deepEqual(body.value.rows,['VISIBLE_ARRAY']);
 assert(Object.values(body.schema.refs).some(n=>JSON.stringify(n.meta?.default)==='["VISIBLE_ARRAY"]'));
});
test('dictionary wildcard does not mask array elements',async()=>{
 const ordinary=z.array(z.string().default('VISIBLE_ARRAY')).default(['VISIBLE_ARRAY']);
 const hidden=z.dict(z.string().role('secret').default(marker));
 const body=await read(z.object({rows:z.union([ordinary,hidden]),visible:visible()}),{rows:['VISIBLE_ARRAY'],visible:'ok'});
 assertClean(body);assert.deepEqual(body.value.rows,['VISIBLE_ARRAY']);
 assert(Object.values(body.schema.refs).some(n=>n.meta?.default==='VISIBLE_ARRAY'));
});
test('array wildcard does not mask dictionary numeric or literal-star keys',async()=>{
 const ordinary=z.dict(z.string().default('VISIBLE_DICT')).default({'0':'VISIBLE_DICT','*':'LITERAL_STAR'});
 const hidden=z.array(z.string().role('secret').default(marker));
 const body=await read(z.object({rows:z.union([ordinary,hidden]),visible:visible()}),{rows:{'0':'VISIBLE_DICT','*':'LITERAL_STAR'},visible:'ok'});
 assertClean(body);assert.deepEqual(body.value.rows,{'0':'VISIBLE_DICT','*':'LITERAL_STAR'});
 assert(Object.values(body.schema.refs).some(n=>n.meta?.default==='VISIBLE_DICT'));
});
test('literal-star object property is not a dictionary wildcard',async()=>{
 const ordinary=z.object({'*':z.string(),other:visible()});
 const hidden=z.object({'*':z.string().role('secret')});
 const body=await read(z.object({rows:z.union([ordinary,hidden])}),{rows:{'*':marker,other:'ok'}});
 assertClean(body);assert.deepEqual(body.value.rows,{other:'ok'});
});

// R4: traversal must retain secret context per path, not merely per shared uid.
test('secret transform(any) accepts real M0 shape and hides payload samples',async()=>{
 const any=z.any().description(marker).default(marker).extra('const',marker).extra('example',marker).extra('examples',[marker]).extra('extra',{sample:marker});
 const secret=z.transform(any,x=>x,true).role('secret').default(marker).extra('const',marker).extra('example',marker).extra('examples',[marker]).extra('extra',{sample:marker}).description('Secret slot');
 const body=await read(z.object({secret,visible:visible()}),{secret:marker,visible:'ok'});assertClean(body);
 assert(Object.values(body.schema.refs).some(n=>n.meta?.description==='Secret slot'));
 assert.deepEqual(body.value,{visible:'ok'});assert(body.secrets.some(s=>s.path.join('.')==='secret'&&!s.writable));
});
test('secret any boundary preserves role and display metadata while hiding payload samples',async()=>{
 const secret=z.any().role('secret').description('Secret slot').extra('group','credentials').extra('i18n',{zh:'密钥'})
  .default(marker).extra('const',marker).extra('example',marker).extra('examples',[marker]).extra('extra',{sample:marker});
 const body=await read(z.object({secret,visible:visible()}),{secret:marker,visible:'ok'});assertClean(body);
 const node=Object.values(body.schema.refs).find(n=>n.type==='any');
 assert.deepEqual(node.meta,{role:'secret',description:'Secret slot',group:'credentials',i18n:{zh:'密钥'}});
 assert.deepEqual(body.value,{visible:'ok'});assert(body.secrets.some(s=>s.path.join('.')==='secret'&&!s.writable));
});
for(const secretFirst of [true,false])test(`shared any with ordinary alias rejects, secretFirst=${secretFirst}`,async()=>{
 const any=z.any(),hidden=z.transform(any,x=>x,true).role('secret');
 const schema=z.object(secretFirst?{secret:hidden,ordinary:any}:{ordinary:any,secret:hidden});
 const response=await responseFor(schema,{secret:'private',ordinary:'public'});assert.equal(response.status,404);assert.equal(response.body.error.code,'entry-unavailable');
});
test('ordinary any remains unsupported',async()=>{assert.equal((await responseFor(z.object({ordinary:z.any()}),{ordinary:'public'})).status,404)});
test('unknown type below secret remains unsupported',async()=>{const schema=z.object({secret:z.transform(z.never(),x=>x,true).role('secret')});const g=schema.toJSON();const fake={toJSON:()=>g};assert.equal((await responseFor(Object.assign(x=>x,fake),{})).status,404)});

for(const malformed of ['cycle','unsafe-key'])test(`secret subtree keeps ${malformed} rejection`,async()=>{
 const graph={uid:0,refs:{0:{type:'object',dict:{secret:1},meta:{}},1:{type:'transform',inner:2,meta:{role:'secret'}},2:malformed==='cycle'?{type:'transform',inner:1,meta:{}}:{type:'object',dict:{constructor:3},meta:{}},3:{type:'any',meta:{}}}};
 const schema=Object.assign(x=>x,{toJSON:()=>graph});assert.equal((await responseFor(schema,{})).status,404);
});

test('detail limits real rc4 Schemastery root serialization to its requested entry', async t => {
 const counts=Array(200).fill(0);
 const entries=counts.map((_,i)=>{
  const schema=z.object({visible:z.string()});
  const serialize=schema.toJSON;
  Object.defineProperty(schema,'toJSON',{value:function(){counts[i]++;return serialize.call(this);},configurable:true});
  const config={visible:`value-${i}`};
  return {options:{id:`item-${i}`,name:'test-plugin',config},fiber:{state:2,runtime:{Config:schema},config:schema(config)}};
 });
 const editor={canWrite:()=>true,entries:()=>entries,configuration:()=>entries.map(entry=>({entry,inherited:entry.options.config,override:entry.options.config}))};
 const ctx={get:n=>n==='configEditor'?editor:n==='loader'?{entries:()=>entries}:undefined};
 withSources(ctx,entries);
 let response;
 const api=createPluginConfig(ctx,{send(_r,status,body){response={status,body}},readBody(){throw Error('unused');}});
 await api.handle({method:'GET'},{},'/dsh-go/v1/plugin-config/item-123');
 assert.equal(response.status,200);assert.deepEqual(response.body.value,{visible:'value-123'});
 assert.equal(globalThis.__schemastery_refs__,undefined,'real serializer releases its temporary graph state');
 t.diagnostic(`real rc4 detail entries=200 rootSerializations=${counts.reduce((a,b)=>a+b,0)}`);
 assert.deepEqual(counts,counts.map((_,i)=>i===123?1:0));
});
