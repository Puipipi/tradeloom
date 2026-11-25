// Test-only, normal connection guard. Uses public HMR runExclusive as a gate;
// the private operations Promise is observed only, never replaced.
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {ConfigEditor} from '@deepseek-ai/dsh-config-editor';
import {PluginManager} from '@deepseek-ai/dsh-plugin-manager';
export const name='wave10-r7-observer';
export const inject=['loader','profileContext','configEditor','pluginManager','webServer'];
export async function apply(ctx){
 const bridge=process.env.R7_BRIDGE,bridgeModule=await import(pathToFileURL(join(bridge,'lib/index.js')));
 const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
 let release,task,baseline,held=false;
 ctx.effect(()=>()=>release?.());
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/r7-observer',handler:async(req,res)=>{
  const connection=ctx.get('connection'),status=connection?.requestRejection(req)??(connection?undefined:503);
  if(status!==undefined){res.writeHead(status);res.end();return;}
  const answer=value=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
  if(req.method==='POST'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const input=JSON.parse(Buffer.concat(chunks));
   if(input.action==='hold'){
    if(held)throw Error('already held');const hmr=ctx.get('hmr');if(!hmr)throw Error('no HMR');
    let ready;const started=new Promise(resolve=>ready=resolve),gate=new Promise(resolve=>release=resolve);
    task=hmr.runExclusive(async()=>{held=true;ready();await gate;held=false;});await started;baseline=hmr.operations;
    answer({held,api:'hmr.runExclusive',observation:'operations reference only'});return;
   }
   if(input.action==='release'){release?.();await task;answer({held});return;}
   if(input.action==='sync-edit'){
    const entry=[...ctx.loader.entries()].find(e=>e.options.id==='normal');
    await ctx.configEditor.edit(entry,raw=>({...raw,count:4}));answer({synchronousCallbackApplied:entry.options.config.count===4});return;
   }
   if(input.action==='dispose-during-change'){
    const entry=[...ctx.loader.entries()].find(e=>e.options.id==='normal'),before=sha(ctx.configEditor.documentPath);let rejected=false;
    try{await ctx.configEditor.edit(entry,async raw=>{await entry.fiber.dispose();return {...raw,count:12};});}catch{rejected=true;}
    answer({rejected,profileUnchanged:sha(ctx.configEditor.documentPath)===before,state:entry.fiber?.state??null});return;
   }
   throw Error('unknown fixture action');
  }
  const entries=[...ctx.loader.entries()];
  let optionalSource=null;
  const optionalEntry=entries.find(e=>e.options.id==='api-speech-to-text');
  if(optionalEntry){
   const internal=ctx.loader.internal,base=optionalEntry.parent.tree.ctx.baseUrl,name=optionalEntry.options.name;
   const resource=internal.version==='v2'?internal.resolveSync(base,{specifier:name,attributes:{}}):internal.resolveSync(name,base,{});
   const file=fileURLToPath(resource.url),module=await import(resource.url),callback=module.default??module.apply;
   optionalSource={file,sha256:sha(file),actualCallback:optionalEntry.fiber?.runtime?.callback===callback,actualServicePrototype:Object.getPrototypeOf(ctx.get('speechController'))===callback.prototype};
  }
  const moduleFiles=Object.fromEntries(['@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-plugin-manager','@deepseek-ai/dsh-app-boot','@deepseek-ai/dsh-host-webserver'].map(name=>{const file=fileURLToPath(import.meta.resolve(name));return [name,{file,sha256:sha(file)}];}));
  answer({pid:process.pid,moduleFiles,actualEditorPrototype:Object.getPrototypeOf(ctx.configEditor)===ConfigEditor.prototype,
   actualManagerPrototype:Object.getPrototypeOf(ctx.pluginManager)===PluginManager.prototype,asyncChange:ctx.configEditor.dshGoAsyncChange===true,
   actualBridgeCallback:entries.find(e=>e.options.id==='dsh-go-bridge')?.fiber?.runtime?.callback===bridgeModule.apply,
   sameManagerReference:ctx.get('pluginManager')===ctx.get('pluginManager'),sameEditorReference:ctx.get('configEditor')===ctx.get('configEditor'),
   sameManagerOriginal:ctx.get('pluginManager')[Symbol.for('cordis.original')]===ctx.get('pluginManager')[Symbol.for('cordis.original')],sameEditorOriginal:ctx.get('configEditor')[Symbol.for('cordis.original')]===ctx.get('configEditor')[Symbol.for('cordis.original')],
   bridgeFiles:Object.fromEntries(['lib/index.js','lib/plugin-config.js','lib/config-source.js'].map(file=>[file,sha(join(bridge,file))])),
   held,queued:held&&ctx.get('hmr').operations!==baseline,optionalSource,
   bundles:await ctx.pluginManager.listBundles(),entries:entries.map(e=>({id:e.id,localId:e.options.id,name:e.options.name,parent:e.parent.tree.ctx.fiber.entry?.id,disabled:e.disabled,state:e.fiber?.state??null,uid:e.fiber?.uid??null})),
   speech:ctx.get('speechToText')?.snapshot()??null});
 }}));
}
