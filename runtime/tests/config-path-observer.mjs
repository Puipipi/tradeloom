import {readFile} from 'node:fs/promises';
import {redactSecrets} from '__PREFIX__/node_modules/@deepseek-ai/dsh-settings/lib/index.js';
export const name='wave10-config-observer';
export const inject=['configEditor','settings','webServer'];
function plain(v){
 if(v&&typeof v.get==='function')return plain(v.get());
 if(Array.isArray(v))return v.map(plain);
 if(v&&typeof v==='object')return Object.fromEntries(Object.entries(v).map(([k,x])=>[k,plain(x)]));
 return v;
}
export function apply(ctx){
 async function snapshot(){
  const rows=ctx.configEditor.configuration();
  const row=rows.find(r=>r.entry.options.id==='wave10-config-fixture');
  const e=row?.entry, schema=e?.fiber?.runtime?.Config;
  const patch=await readFile(ctx.configEditor.documentPath,'utf8');
  return {
   profilePatch:ctx.configEditor.documentPath,
   schema: schema?.toJSON(), fullValue:schema?redactSecrets(schema,plain(e.fiber.config)).value:null,
   liveView:ctx.settings.describe({redactSecrets:true}).find(r=>r.ns==='wave10-config-fixture'),
   uid:e?.fiber?.uid, state:e?.fiber?.state,
   persistedContainsFakeSecret:patch.includes('wave10-fixture-secret-not-real'),
   ordinaryPersisted:patch.includes('ordinary-new'),failPersisted:/fail: true/.test(patch),
   activeConfigEntries:rows.map(r=>({id:r.entry.options.id,package:r.entry.options.name,hasSchema:!!r.entry.fiber?.runtime?.Config,active:r.entry.fiber?.state===2})),
   history:globalThis[Symbol.for('wave10.config.history')]??[]
  };
 }
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/wave10-config-probe',handler:async(req,res)=>{
  try{
   if(req.method==='POST'){
    let body='';for await(const chunk of req)body+=chunk;
    const {changes}=JSON.parse(body);
    const row=ctx.configEditor.entries().find(e=>e.options.id==='wave10-config-fixture');
    await ctx.configEditor.edit(row,raw=>({...raw,...changes}));
   }
   const out=await snapshot();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(out));
  }catch(error){res.writeHead(409,{'content-type':'application/json'});res.end(JSON.stringify({error:error.message,snapshot:await snapshot()}));}
 }}));
}
