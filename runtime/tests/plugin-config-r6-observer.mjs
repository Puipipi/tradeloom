// Local test helper. GET observes loaded identity. POST uses only the public
// lifecycle of this fixture Host's connection entry, to test the real guard.
// Persist the disable only in this test's private profile so normal HMR cannot
// remount the service. The orchestrator restores the exact bytes after stop.
import {readFileSync,realpathSync,writeFileSync,renameSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import {ConfigEditor} from '@deepseek-ai/dsh-config-editor';
import {WebServer} from '@deepseek-ai/dsh-host-webserver';
import {parsePatchList} from '@deepseek-ai/dsh-app-boot';
export const name='wave10-r6-observer';
export const inject=['loader','profileContext','configEditor','webServer'];
export async function apply(ctx){
 const bridge=process.env.R6_BRIDGE,bridgeModule=await import(pathToFileURL(join(bridge,'lib/index.js')));
 const sha=file=>createHash('sha256').update(readFileSync(file)).digest('hex');
 ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/r6-observer',handler:async(req,res)=>{
  const connection=ctx.get('connection'),status=connection?.requestRejection(req)??(connection?undefined:503);
  if(status!==undefined){res.writeHead(status);res.end();return;}
  if(req.method==='POST'){
   const e=[...ctx.loader.entries()].find(e=>e.options.id==='connection');
   if(!e?.fiber)throw Error('missing own connection entry');
   const path=ctx.profileContext.patchPath;
   if(path!==join(process.env.DSH_HOME,'profiles/web/cordis.patch.yml'))throw Error('not this fixture profile');
   const patches=parsePatchList('dsh',path,readFileSync(path,'utf8'),'patches');
   writeFileSync(path+'.r6-fixture',JSON.stringify([...patches,{id:'connection',disabled:true}])+'\n',{mode:0o600});renameSync(path+'.r6-fixture',path);
   const fiber=e.fiber;await e.update({disabled:true});await fiber.dispose();
   res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({connectionAbsent:ctx.get('connection')===undefined,entryDisabled:e.disabled,entryState:fiber.state,privateProfileDisabled:true}));return;
  }
  const bridgeEntry=[...ctx.loader.entries()].find(e=>e.options.id==='dsh-go-bridge');
  const moduleFiles=Object.fromEntries(['@deepseek-ai/dsh-app-boot','@deepseek-ai/dsh-config-editor','@deepseek-ai/dsh-host-webserver'].map(name=>{
   const file=realpathSync(fileURLToPath(import.meta.resolve(name)));return [name,{file,sha256:sha(file)}];
  }));
  const media=[...ctx.loader.entries()].find(e=>e.options.id==='dsh-media');
  const answer={pid:process.pid,profileInstallAnchor:ctx.profileContext.installAnchor,moduleFiles,
   guardKind:typeof ctx.webServer.dshGoRouteRejection==='function'?'patched':'bridge-fallback',
   actualEditorPrototype:Object.getPrototypeOf(ctx.configEditor)===ConfigEditor.prototype,
   actualWebServerPrototype:Object.getPrototypeOf(ctx.webServer)===WebServer.prototype,
   actualBridgeCallback:bridgeEntry?.fiber?.runtime?.callback===bridgeModule.apply,
   bridgeFiles:Object.fromEntries(['lib/index.js','lib/plugin-config.js','lib/config-source.js'].map(file=>[file,sha(join(bridge,file))])),
   mediaState:media?.fiber?.state??null,mediaConfigHash:sha(join(process.env.R6_MEDIA,'src/config.js'))};
  res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(answer));
 }}));
}
