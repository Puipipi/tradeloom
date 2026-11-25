// Actual rc4 Schemastery and production bridge, modeled services, no Host/network.
// DSH_PREFIX=/fixed/prefix node runtime/tests/secret-callback-schema.test.mjs
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPluginConfig} from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import {withSources} from './plugin-config-source-fixture.mjs';
import {makeCases,makeHostSchema,INPUT,SOURCE,ERROR,POST} from './secret-callback-cases.mjs';
const {default:z}=await import(pathToFileURL(join(resolve(process.env.DSH_PREFIX),'node_modules/@deepseek-ai/schemastery/lib/index.mjs')));

async function model(schema,raw){
 let current=structuredClone(raw);
 const entry={options:{id:'callback-fixture',name:'callback-fixture',config:current},fiber:{state:2,runtime:{Config:schema,callback(){}},config:schema(structuredClone(current))}};
 const editor={canWrite:()=>true,entries:()=>[entry],configuration:()=>[{entry,inherited:current,override:current}],documentPath:'/nonexistent-own-callback-fixture'};
 editor.edit=async(_entry,change)=>{current=await change(structuredClone(current),structuredClone(current));entry.options.config=current;entry.fiber.config=schema(structuredClone(current));};
 const ctx={get:key=>key==='configEditor'?editor:key==='loader'?{entries:()=>[entry]}:undefined};withSources(ctx,[entry]);
 let answer;const api=createPluginConfig(ctx,{send(_res,status,body){answer={status,body};},readBody:async req=>Buffer.from(JSON.stringify(req.input))});
 const request=async(method,input)=>{await api.handle({method,input,headers:{'content-type':'application/json'},resume(){}},{},'/dsh-go/v1/plugin-config/callback-fixture');return answer;};
 return {request,entry,editor};
}
for(const scenario of makeCases(z))test(scenario.name+' source is redacted only in secret context',async()=>{
 const graph=scenario.schema.toJSON(),value=scenario.schema(structuredClone(scenario.raw));
 const callbacks=Object.values(scenario.schema.toJSON().refs).filter(n=>Object.hasOwn(n,'callback'));
 assert(callbacks.length>0);
 const {request}=await model(scenario.schema,scenario.raw);
 const {status,body}=await request('GET');assert.equal(status,200);
 const serialized=JSON.stringify(body);
 for(const marker of scenario.hidden)assert(!serialized.includes(marker),'sensitive marker survived: '+marker);
 for(const marker of scenario.publicMarkers)assert(serialized.includes(marker),'ordinary callback was removed: '+marker);
 assert.deepEqual(scenario.schema.toJSON(),graph,'original Schema serialization mutated');
 assert.deepEqual(scenario.schema(structuredClone(scenario.raw)),value,'validator behavior changed');
 assert.deepEqual(Object.keys(body.schema.refs).sort(),Object.keys(graph.refs).sort());
 if(!scenario.hidden.length)assert.deepEqual(body.schema,graph,'ordinary graph must be unchanged');
 if(scenario.name==='direct')assert(Object.values(body.schema.refs).some(n=>n.meta?.role==='secret'&&n.meta?.description==='Secret boundary'&&n.meta?.group==='credentials'));
 if(scenario.name==='boundary_any')assert(Object.values(body.schema.refs).some(n=>n.type==='any'&&n.meta?.role==='secret'&&n.meta?.i18n?.zh==='秘密槽'));
});

test('same Config keeps source redacted after raw secret A becomes B',async()=>{
 const schema=z.object({token:z.transform(z.string(),value=>{if(value==='')throw Error('SYNTH_CB_R1_SOURCE_VALUE_CHANGE');return value;}).role('secret')});
 const first=await model(schema,{token:INPUT+'A'}),second=await model(schema,{token:INPUT+'B'});
 const a=await first.request('GET'),b=await second.request('GET');
 assert.equal(a.status,200);assert.equal(b.status,200);assert.deepEqual(a.body.schema,b.body.schema);
 for(const body of [a.body,b.body])assert(!JSON.stringify(body).includes(INPUT)&&!JSON.stringify(body).includes(SOURCE));
 assert.throws(()=>schema({token:''}),/SYNTH_CB_R1_SOURCE_VALUE_CHANGE/,'server validator still executes original callback');
});
test('ordinary update works while secret set unset and mixed operations remain rejected',async()=>{
 const {Config,raw}=makeHostSchema(z),{request,entry}=await model(Config,raw);
 const first=await request('GET');assert.equal(first.status,200);
 const changed=await request('POST',{revision:first.body.revision,ops:[{op:'set',path:['count'],value:2}]});
 assert.equal(changed.status,200);assert.equal(changed.body.value.count,2);
 for(const ops of [[{op:'set',path:['direct'],value:POST}],[{op:'unset',path:['direct']}],[{op:'set',path:['count'],value:9},{op:'set',path:['ancestor'],value:{token:POST}}]]){
  const response=await request('POST',{revision:changed.body.revision,ops});assert.equal(response.status,400);
  assert(!JSON.stringify(response.body).includes(POST));assert.equal(entry.options.config.count,2);
 }
 const failed=await request('POST',{revision:changed.body.revision,ops:[{op:'set',path:['count'],value:13}]});
 assert.equal(failed.status,422);assert(!JSON.stringify(failed.body).includes(ERROR));assert.equal(entry.options.config.count,2);
 const next=await request('GET');assert.equal(next.status,200);assert(!JSON.stringify(next.body).includes(INPUT)&&!JSON.stringify(next.body).includes(SOURCE));
});
