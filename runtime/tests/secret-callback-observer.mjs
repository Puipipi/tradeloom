// Fixture-only observer: normal connection guard, no handler/service replacement.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {ConfigEditor} from '@deepseek-ai/dsh-config-editor';
import {PluginManager} from '@deepseek-ai/dsh-plugin-manager';
export const name='wave10-secret-callback-observer';
export const inject=['loader','configEditor','pluginManager','webServer'];
export async function apply(ctx){
 const bridge=process.env.CALLBACK_BRIDGE,fixture=await import(pathToFileURL(process.env.CALLBACK_FIXTURE));
 const bridgeModule=await import(pathToFileURL(join(bridge,'lib/index.js')));
 const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/callback-observer',handler:async(req,res)=>{
  const connection=ctx.get('connection'),status=connection?.requestRejection(req)??(connection?undefined:503);
  if(status!==undefined){res.writeHead(status);res.end();return;}
  const entries=[...ctx.loader.entries()],entry=entries.find(e=>e.options.id==='callbacks');
  const graph=entry.fiber.runtime.Config.toJSON(),source=JSON.stringify(graph);
  const body={pid:process.pid,actualEditorPrototype:Object.getPrototypeOf(ctx.configEditor)===ConfigEditor.prototype,
   actualManagerPrototype:Object.getPrototypeOf(ctx.pluginManager)===PluginManager.prototype,
   actualConfigIdentity:entry.fiber.runtime.Config===fixture.Config,
   actualBridgeCallback:entries.find(e=>e.options.id==='dsh-go-bridge')?.fiber.runtime.callback===bridgeModule.apply,
   asyncChange:ctx.configEditor.dshGoAsyncChange===true,
   sourceGraphSHA256:sha(source),sourceCallbackNodes:Object.values(graph.refs).filter(n=>Object.hasOwn(n,'callback')).length,
   sourceCanaryOccurrences:(source.match(/SYNTH_CB_R1_SOURCE_/g)??[]).length,
   entry:{id:entry.id,localId:entry.options.id,state:entry.fiber.state,count:entry.options.config.count},
   bridgeFiles:Object.fromEntries(['lib/index.js','lib/plugin-config.js','lib/config-source.js'].map(file=>[file,sha(readFileSync(join(bridge,file)))])),
   moduleFiles:Object.fromEntries(['@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-plugin-manager','@deepseek-ai/dsh-app-boot','@deepseek-ai/dsh-host-webserver','@deepseek-ai/schemastery'].map(name=>{const file=fileURLToPath(import.meta.resolve(name));return[name,{file,sha256:sha(readFileSync(file))}];})),
   bundle:(await ctx.pluginManager.listBundles()).find(b=>b.name==='wave10-secret-callback-bundle')};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(body));
 }}));
}
