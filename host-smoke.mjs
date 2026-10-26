import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
const stage=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(stage,'TradeLoom-desktop16-portable-win-x64');
const data=process.argv[2];if(!data)throw new Error('Specify the isolated verification data directory.');
const primary=path.join(root,'runtime/primary-runtime');
const profile=path.join(data,'dsh-home/profiles/desktop');
const env={};for(const k of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','OS'])if(process.env[k])env[k]=process.env[k];
env.PATH=[path.join(primary,'dependencies/node/bin'),path.join(root,'app/scripts/node-bin'),path.join(env.SystemRoot??'C:/Windows','System32')].join(path.delimiter);
Object.assign(env,{ELECTRON_RUN_AS_NODE:'1',DSH_HOME:path.join(data,'dsh-home'),DSH_AGENTS_HOME:path.join(data,'agents-home'),TRADELOOM_DSH_APP_HOME:path.join(data,'dsh-home'),TRADELOOM_DSH_BIND_HOST:'127.0.0.1',TRADELOOM_DSH_BIND_PORT:'0',DSH_DESKTOP_PRIMARY_RUNTIME_DIR:primary,LOCALAPPDATA:path.join(data,'local-app-data'),APPDATA:path.join(data,'roaming-app-data'),TEMP:path.join(data,'temp'),TMP:path.join(data,'temp')});
const log=fs.openSync(path.join(data,'logs','host-smoke.log'),'a');
const child=fork(path.join(root,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),[root,profile,primary,path.join(primary,'dependencies/pnpm/bin/pnpm.mjs'),path.join(root,'app/scripts/node-bin')],{execPath:path.join(root,'engine/electron.exe'),execArgv:['--expose-internals'],env,cwd:path.join(data,'workspace'),windowsHide:true,stdio:['ignore',log,log,'ipc']});fs.closeSync(log);
let ready=false;
const timer=setTimeout(()=>{child.kill();console.error('Host ready timeout; inspect verification-only log.');process.exitCode=2;},30000);
child.on('message',async m=>{if(m.type==='ready'){
  ready=true;const injectionText=JSON.stringify(m.injections);const url=new URL(m.url);
  const receipt={status:'host-ready',pid:child.pid,origin:url.origin,shellInjections:injectionText.includes('@tradeloom/dsh-business-shell'),injectionCount:m.injections.length,readyKeys:Object.keys(m)};
  fs.writeFileSync(path.join(data,'logs/host-smoke-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  fs.writeFileSync(path.join(data,'logs/injections.private.json'),JSON.stringify(m.injections,null,2)+'\n');
  const first=await fetch(m.url,{redirect:'manual'});const cookie=first.headers.getSetCookie().map(x=>x.split(';')[0]).join('; ');
  const scenes=await fetch(url.origin+'/tradeloom/scenes',{headers:{cookie}});const sceneBody=await scenes.json();
  receipt.scenesRouteStatus=scenes.status;receipt.sceneIds=sceneBody.scenes?.map(s=>s.id);receipt.roleIds=sceneBody.roles?.map(r=>r.id);
  receipt.routes=[];
  const boot=m.injections.find(x=>x.name==='__DSH_BOOT__')?.value;
  const shellEntry=boot?.entries?.find(x=>x.id==='@tradeloom/dsh-business-shell');
  const chunks=shellEntry?['client.scenes.js','client.dockview.js','client.workflow.js','client.mobile-qr.js'].map(file=>'/plugins/@tradeloom/dsh-business-shell/'+file+'?rev='+shellEntry.rev):[];
  for(const route of ['/', '/tradeloom/scene-layouts','/tradeloom/dock-layouts','/tradeloom/profile',...['center','product','market','quote','delivery','user-profile'].flatMap(role=>['/tradeloom/agent-capabilities?role='+role,'/tradeloom/agent-configuration?role='+role]),...m.injections.filter(x=>x.src).map(x=>x.src),...chunks]){
    const response=await fetch(new URL(route,url.origin),{headers:{cookie}});const body=await response.text();
    receipt.routes.push({route,status:response.status,contentType:response.headers.get('content-type'),bytes:Buffer.byteLength(body)});
  }
  fs.writeFileSync(path.join(data,'logs/host-smoke-receipt.json'),JSON.stringify(receipt,null,2)+'\n');
  console.log(JSON.stringify({status:receipt.status,origin:receipt.origin,shellInjections:receipt.shellInjections,scenesRouteStatus:scenes.status,checkedRoutes:receipt.routes.length,non200:receipt.routes.filter(r=>r.status!==200),sceneIds:receipt.sceneIds,roleIds:receipt.roleIds}));if(scenes.status!==200||!receipt.shellInjections||receipt.routes.some(r=>r.status!==200))process.exitCode=2;child.send({type:'shutdown'});
}});
child.on('exit',(code)=>{clearTimeout(timer);if(!ready||code!==0){console.error('Host smoke exited '+code);process.exitCode=2;}});
