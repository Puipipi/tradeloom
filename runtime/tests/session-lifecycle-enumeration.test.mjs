import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import {tmpdir} from 'node:os';
import {join,resolve,sep} from 'node:path';
import {pathToFileURL} from 'node:url';
const prefix=process.env.DSH_TEST_PREFIX??process.env.DSH_PREFIX;
const options={skip:!prefix&&'prepared DSH prefix required'};
async function api(){
 const load=n=>import(pathToFileURL(resolve(prefix,'node_modules/@deepseek-ai',n,'lib/index.js')));
 const [{Context},{Session},jsonl]=await Promise.all(['cordis','dsh-session','dsh-session-persistence-jsonl'].map(load));
 return{Context,Session,jsonl};
}
async function fixture(t){
 const {Context,Session,jsonl}=await api();
 const root=await fs.mkdtemp(join(tmpdir(),'lifecycle-enumeration-')),cwd=join(root,'workspace'),store=join(root,'sessions');
 await fs.mkdir(cwd);const contexts=[];
 t.after(async()=>{for(const ctx of contexts.reverse())await ctx.fiber.dispose();await fs.rm(root,{recursive:true,force:true})});
 async function context(){const ctx=new Context();contexts.push(ctx);await jsonl.apply(ctx,{root:store,compression:'zstd'});return ctx}
 const writer=await context(),ids=['.ordinary','.retired-valid',...Array.from({length:10},(_,i)=>`session-${i}`)],files=new Map();
 for(const id of ids){
  const session=Session.create(id,undefined,{...Session.create(id).header,cwd});
  const h=await writer.sessionPersistence.create(session.header);
  session.append('turn/start',{turn:1});session.append('turn/end',{turn:1,reason:{kind:'completed'}});
  await h.append(session.snapshotEvents());await h.close();
  files.set(id,(await writer.sessionPersistence.stat(id)).location.path);
 }
 await writer.fiber.dispose();contexts.splice(contexts.indexOf(writer),1);
 return{store,control:join(store,'.dsh-go-lifecycle'),ids,files,context};
}
test('public list preserves sessions without enumerating the reserved lifecycle tree',options,async t=>{
 const f=await fixture(t),ctx=await f.context();
 assert((await fs.readdir(f.control)).length>0,'actual writer/mutation control artifacts exist');
 const visited=[],original=fs.readdir;
 const mock=t.mock.method(fs,'readdir',async function(path,...args){
  if(typeof path==='string'&&(path===f.control||path.startsWith(f.control+sep)))visited.push(path.slice(f.store.length));
  return Reflect.apply(original,this,[path,...args]);
 });
 syncBuiltinESMExports();
 try{
  const ids=(await ctx.sessionPersistence.list()).map(row=>row.header.id).sort();
  assert.deepEqual(ids,[...f.ids].sort());
  t.diagnostic(JSON.stringify({sessions:ids.length,lifecycleEnumerationReads:visited.length,visited}));
  assert.equal(visited.length,0,'owned lifecycle directories are control state, not session-generation candidates');
 }finally{mock.mock.restore();syncBuiltinESMExports()}
});
test('a real deletion marker still hides an owned leftover log and rejects ID reuse',options,async t=>{
 const f=await fixture(t),ctx=await f.context(),id='session-0',file=f.files.get(id),saved=await fs.readFile(file);
 await ctx.sessionPersistence.dshGoDeletion.delete(id,{validate:async()=>{},dispose:async()=>{},inspectTasks:async()=>false,cleanup:async()=>{}});
 assert.equal(ctx.sessionPersistence.dshGoDeletion.deleted(id),true);
 // Model a leftover original artifact after the durable deletion marker, not a forged marker.
 await fs.writeFile(file,saved);
 const ids=(await ctx.sessionPersistence.list()).map(row=>row.header.id).sort();
 assert.deepEqual(ids,f.ids.filter(value=>value!==id).sort());
 const {Session}=await api();
 await assert.rejects(ctx.sessionPersistence.create(Session.create(id).header),error=>error.name==='SessionPersistenceNotFoundError');
 assert.deepEqual(await fs.readFile(file),saved);
});
test('writer identity and artifact ownership still exclude a second real context',options,async t=>{
 const f=await fixture(t),owner=await f.context(),contender=await f.context();
 const handle=await owner.sessionPersistence.open('session-0','write');
 try{
  await assert.rejects(contender.sessionPersistence.open('session-0','write'),error=>error.name==='SessionAlreadyOwnedError');
 }finally{await handle.close()}
 const next=await contender.sessionPersistence.open('session-0','write');await next.close();
});
