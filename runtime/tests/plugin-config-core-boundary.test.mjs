import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFileSync,mkdirSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createPluginConfig} from '../bridge/dsh-go-bridge/lib/plugin-config.js';
import {withSources} from './plugin-config-source-fixture.mjs';
const base='/dsh-go/v1/plugin-config';
const graph={uid:1,refs:{1:{type:'object',dict:{title:2}},2:{type:'string'}}};
const schema=Object.assign(value=>value,{toJSON:()=>structuredClone(graph)});
function entry(id,name='unit-plugin'){return {options:{id,name,config:{title:'original'}},fiber:{state:2,runtime:{Config:schema,callback(){}},config:{title:'original'}}};}
function fixture(){
 const entries=[entry('plugin')];let edits=0,beforeEdit=()=>{};
 const editor={canWrite:()=>true,entries:()=>entries,configuration:()=>entries.map(entry=>({entry,inherited:{},override:entry.options.config})),async edit(entry,update){edits++;beforeEdit();entry.options.config=await update(entry.options.config,{});entry.fiber.config=entry.options.config;}};
 const ctx={get:name=>name==='loader'?{entries:()=>entries}:name==='configEditor'?editor:undefined};
 const source=withSources(ctx,entries);editor.documentPath=join(source.root,'cordis.patch.yml');writeFileSync(editor.documentPath,'[]\n');
 let answer;
 const api=createPluginConfig(ctx,{send(_res,status,body){answer={status,body}},readBody:async req=>Buffer.from(JSON.stringify(req.input))});
 return {entries,editor,ctx,...source,edits:()=>edits,setBeforeEdit(fn){beforeEdit=fn;},async request(id,method='GET',input){answer=undefined;await api.handle({method,input,headers:{'content-type':'application/json'}}, {},id===undefined?base:base+'/'+encodeURIComponent(id));return answer;}};
}
function makeCore(f,id='renamed-core',name='ordinary-alias'){
 const e=entry(id,name);e.parent=f.entries[0].parent;f.entries.push(e);
 const file=join(f.install,'index.js');writeFileSync(file,'export function apply(){}\n');f.files.set(name,file);f.packages.set(name,{name:'unit-host',dir:f.install,manifestPath:join(f.install,'package.json')});return e;
}
const ops=[{op:'set',path:['title'],value:'changed'}];
async function denied(f,id){
 assert.equal((await f.request(id)).status,403);
 assert.equal((await f.request(id,'POST',null)).status,403);
 for(const operation of [ops,[{op:'unset',path:['title']}],[...ops,{op:'unset',path:['title']}]])assert.equal((await f.request(id,'POST',{revision:'OLD_R4_REVISION',ops:operation})).status,403);
 assert.equal(f.edits(),0);assert((await f.request()).body.entries.filter(e=>e.entryId===id).every(e=>!e.configurable&&!e.writable));
}
test('resolved external owner is public; entry metadata cannot claim another owner',async()=>{
 const f=fixture();Object.assign(f.entries[0].options,{owner:'unit-host',kind:'core',source:'claimed'});
 const list=(await f.request()).body.entries;assert.equal(list.length,1);assert.deepEqual([list[0].kind,list[0].owner,list[0].bundle,list[0].package,list[0].source,list[0].writable],['plugin','installed','fixture-bundle','unit-plugin','installed-bundle',true]);
 const before=await f.request('plugin');const after=await f.request('plugin','POST',{revision:before.body.revision,ops});assert.equal(after.status,200);assert.equal(after.body.value.title,'changed');
});
test('protected actual owner through renamed id and ordinary symlink alias is denied',async()=>{const f=fixture();makeCore(f);await denied(f,'renamed-core');});
test('copied protected package name outside installation is denied',async()=>{const f=fixture(),pkg=f.packages.get('unit-plugin');writeFileSync(pkg.manifestPath,JSON.stringify({name:'unit-host'}));pkg.name='unit-host';await denied(f,'plugin');});
test('subpath resolving inside protected root is denied despite claimed external package',async()=>{const f=fixture();makeCore(f);f.files.set('unit-plugin',join(f.install,'index.js'));await denied(f,'plugin');});
for(const name of ['file:///claimed/core.js','/claimed/core.js','./core.js','#core'])test(`unowned request ${name} remains denied`,async()=>{const f=fixture();makeCore(f);f.entries[0].options.name=name;f.files.set(name,join(f.install,'index.js'));await denied(f,'plugin');});
for(const order of ['before','after'])test(`simple re-export of protected callback denied when wrapper is ${order}`,async()=>{const f=fixture(),core=makeCore(f);f.entries[0].fiber.runtime.callback=core.fiber.runtime.callback;if(order==='after')f.entries.reverse();await denied(f,'plugin');});
test('resolved module outside package root cannot acquire its owner',async()=>{const f=fixture();const other=join(f.root,'another');mkdirSync(other);writeFileSync(join(other,'package.json'),JSON.stringify({name:'another'}));writeFileSync(join(other,'index.js'),'');f.files.set('unit-plugin',join(other,'index.js'));await denied(f,'plugin');});
test('nested package owner mismatch is denied',async()=>{const f=fixture(),pkg=f.packages.get('unit-plugin');const nested=join(pkg.dir,'nested');mkdirSync(nested);writeFileSync(join(nested,'package.json'),JSON.stringify({name:'nested'}));writeFileSync(join(nested,'index.js'),'');f.files.set('unit-plugin',join(nested,'index.js'));await denied(f,'plugin');});
test('canonical symlink target cannot conceal protected module',async()=>{const f=fixture();makeCore(f);const alias=join(f.root,'link.js');symlinkSync(join(f.install,'index.js'),alias);f.files.set('unit-plugin',alias);await denied(f,'plugin');});
test('path sibling with installation prefix is still external',async()=>{const f=fixture(),dir=f.install+'-sibling';mkdirSync(dir);const manifestPath=join(dir,'package.json');writeFileSync(manifestPath,JSON.stringify({name:'unit-plugin'}));const file=join(dir,'index.js');writeFileSync(file,'');f.files.set('unit-plugin',file);f.packages.set('unit-plugin',{name:'unit-plugin',dir,manifestPath});assert.equal((await f.request('plugin')).status,200);});
for(const reason of ['missing-resolution','empty-installation','missing-root','bad-manifest','missing-anchor'])test(`incomplete trust boundary ${reason} denies all candidates`,async()=>{
 const f=fixture();if(reason==='missing-resolution')delete f.service.resolution;if(reason==='empty-installation')f.service.resolution.entries=[];if(reason==='missing-root')f.service.resolution.entries[0].packageDir=join(f.root,'absent');if(reason==='bad-manifest')writeFileSync(join(f.install,'package.json'),'{broken');if(reason==='missing-anchor'){const get=f.ctx.get;f.ctx.get=n=>n==='profileContext'?{}:get(n);}await denied(f,'plugin');
});
test('source is rechecked inside editor callback before any returned mutation',async()=>{
 const f=fixture(),before=await f.request('plugin');makeCore(f);f.setBeforeEdit(()=>f.files.set('unit-plugin',join(f.install,'index.js')));
 assert.equal((await f.request('plugin','POST',{revision:before.body.revision,ops})).status,403);assert.equal(f.edits(),1);assert.equal(f.entries[0].options.config.title,'original');
});
test('same plugin with changed canonical source invalidates prior revision',async()=>{
 const f=fixture(),before=await f.request('plugin'),pkg=f.packages.get('unit-plugin'),next=join(pkg.dir,'next.js');writeFileSync(next,'');f.files.set('unit-plugin',next);
 assert.equal((await f.request('plugin','POST',{revision:before.body.revision,ops})).status,409);assert.equal(f.entries[0].options.config.title,'original');
});
