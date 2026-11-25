// B1 BLOCKED evidence, not a whitelist relaxation. Run with TZ=Asia/Shanghai.
// Uses actual serialized plugin schemas and actual bridge. ConfigEditor/Loader
// are modeled; identity schemas do NOT execute published validation callbacks.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createPluginConfig} from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import {withSources} from './plugin-config-source-fixture.mjs';
const fixtures=fileURLToPath(new URL('../../app/test/plugin_config/fixtures/schemas/',import.meta.url));
const marker='B1_SYNTHETIC_INHERITED_SECRET';
const base='/dsh-go/v1/plugin-config/fixture';
function fixture(graph,{inherited={},user={},resolved,validate=x=>x}={}){
 const raw={...structuredClone(inherited),...structuredClone(user)};
 const schema=Object.assign(validate,{toJSON:()=>structuredClone(graph)});
 const entry={options:{id:'fixture',name:'fixture-plugin',config:raw},fiber:{state:2,runtime:{Config:schema},config:resolved??structuredClone(raw)}};
 let override=structuredClone(user),writes=0,submitted;
 const editor={canWrite:()=>true,entries:()=>[entry],configuration:()=>[{entry,inherited,override}],async edit(_entry,change){
  const next=await change(structuredClone(entry.options.config),structuredClone(inherited));
  // Models the complete-config callback contract documented in the shipped patch.
  submitted=structuredClone(next);override=structuredClone(next);writes++;
  entry.options.config=next;entry.fiber.config=structuredClone(next);
  writeFileSync(editor.documentPath,JSON.stringify(next));
 }};
 const ctx={get:n=>n==='configEditor'?editor:n==='loader'?{entries:()=>[entry]}:undefined};
 const source=withSources(ctx,[entry]);editor.documentPath=join(source.root,'modeled-profile.json');writeFileSync(editor.documentPath,'{}');
 let response;
 const api=createPluginConfig(ctx,{send(_r,status,body){response={status,body}},readBody:async req=>Buffer.from(JSON.stringify(req.input))});
 return {writes:()=>writes,submitted:()=>submitted,async request(method='GET',input){await api.handle({method,input,headers:{'content-type':'application/json'}},{},base);return response;},async post(ops){const before=await this.request();return this.request('POST',{revision:before.body.revision,ops});}};
}
for(const name of readdirSync(fixtures).filter(n=>n.endsWith('.json'))){
 test(`published graph remains readable: ${name}`,async()=>{
  const graph=JSON.parse(readFileSync(join(fixtures,name))).schema;
  const f=fixture(graph);const result=await f.request();assert.equal(result.status,200);assert.equal(f.writes(),0);
 });
}
const graph={uid:0,refs:{0:{type:'object',dict:{count:1,parent:2}},1:{type:'number'},2:{type:'object',dict:{opaque:3}},3:{type:'any',meta:{role:'secret',default:marker,examples:[marker]}}}};
for(const op of ['set','unset'])for(const path of [['parent','opaque'],['parent','opaque','key'],['parent']]){
 test(`existing read-only secret blocks ${op} ${path.join('.')}`,async()=>{
  const f=fixture(graph,{inherited:{count:1,parent:{opaque:{key:marker}}}});
  const result=await f.post([{op,path,...op==='set'?{value:{key:'replacement'}}:{}}]);
  assert.equal(result.status,400);assert.deepEqual(result.body.error.path,path);assert.equal(f.writes(),0);
 });
}
test('BLOCKER: unrelated validated field copies inherited opaque secret despite redaction and path guard',async()=>{
 const f=fixture(graph,{inherited:{count:1,parent:{opaque:{key:marker}}},validate:x=>{assert.equal(typeof x.count,'number');return x;}});
 const before=await f.request();assert.equal(before.status,200);assert(!JSON.stringify(before.body).includes(marker));assert.deepEqual(before.body.user,{});
 const result=await f.post([{op:'set',path:['count'],value:2}]);assert.equal(result.status,200);
 assert.equal(f.writes(),1);assert.deepEqual(f.submitted(),{count:2,parent:{opaque:{key:marker}}});
 assert(!JSON.stringify(result.body).includes(marker),'HTTP redaction does not prevent persistence');
});
test('BLOCKER: unset restores inherited ordinary value into complete user config',async()=>{
 const f=fixture(graph,{inherited:{count:1,parent:{opaque:marker}},user:{count:2}});
 const result=await f.post([{op:'unset',path:['count']}]);assert.equal(result.status,200);assert.equal(f.submitted().count,1);assert.equal(f.submitted().parent.opaque,marker);
});
test('published media graph: writing budget preserves unrelated bundle dshHome in editor output',async()=>{
 const media=JSON.parse(readFileSync(join(fixtures,'ccch1mneyyy-dsh-media-0.2.1.json'))).schema;
 const f=fixture(media,{inherited:{dshHome:'/synthetic/bundle-home',budget:{dailyCny:10},credentials:{slot1:{apiKey:''}}}});
 const result=await f.post([{op:'set',path:['budget','dailyCny'],value:20}]);assert.equal(result.status,200);
 assert.equal(f.submitted().dshHome,'/synthetic/bundle-home');assert.equal(f.submitted().credentials.slot1.apiKey,'');
});
for(const type of ['any','tuple','bitset','is','lazy'])test(`unknown ${type} stays blocked before any editor write`,async()=>{
 const g=structuredClone(graph);g.refs[3]={type,meta:{default:marker}};
 const f=fixture(g,{inherited:{count:1,parent:{opaque:marker}}});
 assert.equal((await f.request()).status,404);assert.equal((await f.request('POST',{revision:'unused',ops:[{op:'set',path:['count'],value:2}]})).status,404);assert.equal(f.writes(),0);
});
for(const reverse of [false,true])test(`secret default/union redaction and path rejection, reverse=${reverse}`,async()=>{
 const g=structuredClone(graph);g.refs[2]={type:'union',list:reverse?[4,3]:[3,4],meta:{default:marker,examples:[marker]}};g.refs[4]={type:'string',meta:{default:marker}};
 const f=fixture(g,{inherited:{count:1},resolved:{count:1,parent:marker}});const before=await f.request();assert.equal(before.status,200);assert(!JSON.stringify(before.body).includes(marker));
 assert(before.body.secrets.some(s=>s.path.join('.')==='parent'&&!s.configured&&!s.writable));
 assert.equal((await f.post([{op:'set',path:['parent'],value:'public'}])).status,400);assert.equal(f.writes(),0);
});
