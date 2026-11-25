// Read-only fixture: no controller calls, no configuration mutation, no tool execution.
import {readFileSync,realpathSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
export const name='r5-core-observer';
export const inject=['loader','pluginPackages','profileContext','webServer','connection'];
export function apply(ctx){
 const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/r5-core-observer',handler:async(req,res)=>{
  const reject=ctx.connection.requestRejection(req);if(reject){res.writeHead(reject.status);res.end();return;}
  const entries=[...ctx.loader.entries()];
  const values=entries.map(e=>{
   let owner=null,file=null;
   try{const base=e.parent.tree.ctx.baseUrl;const pkg=ctx.pluginPackages.packageOf(e.options.name,base);owner=pkg?.name??null;const l=ctx.loader.internal;file=realpathSync(fileURLToPath((l.version==='v2'?l.resolveSync(base,{specifier:e.options.name,attributes:{}}):l.resolveSync(e.options.name,base,{})).url));}catch{}
   return {id:e.options.id,name:e.options.name,state:e.fiber?.state??null,owner,file};
  });
  const bridge=process.env.CORE_FIXTURE_BRIDGE;
  const answer={pid:process.pid,installationCount:ctx.pluginPackages.resolution.entries.filter(x=>x.scope==='installation').length,
   bridgeFiles:Object.fromEntries(['lib/index.js','lib/plugin-config.js',...(process.env.CORE_FIXTURE_STAGE!=='r4'?['lib/config-source.js']:[])].map(x=>[x,sha(join(bridge,x))])),entries:values};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));
 }}));
}
