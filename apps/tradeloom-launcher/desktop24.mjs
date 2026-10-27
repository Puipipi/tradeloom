import {readFile} from 'node:fs/promises'
import {spawn,spawnSync} from 'node:child_process'
import path from 'node:path'
import net from 'node:net'
import {fileURLToPath} from 'node:url'
import {assertStartReady} from './desktop24-guard.mjs'
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..'), workspace=path.dirname(repo), base=path.join(workspace,'workspace/runtime/tradeloom-harness'),data=path.join(base,'local-dev/desktop24-first-usable-20261027'),runtime=path.join(base,'releases/0.2.1-rc.3-tradeloom-desktop-24'),bundle=path.join(repo,'integrations/dsh/desktop24-ui-bundle'),lock=path.join(repo,'integrations/dsh/prospective/desktop24-exit/patches.prospective.lock.json'),cli=path.join(repo,'apps/tradeloom-launcher/cli.mjs')
const action=process.argv[2];if(!['start','stop'].includes(action)||process.argv.length!==3)throw Error('用法：node desktop24.mjs start|stop')
if(action==='stop'){const child=spawn(process.execPath,[cli,'stop','--data-root',data],{cwd:repo,stdio:'inherit',windowsHide:false});const result=await new Promise(resolve=>{child.once('error',e=>resolve({code:null,error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}))});process.exitCode=result.code??1;}
else {
 const occupied=await new Promise(resolve=>{const s=net.createConnection({host:'127.0.0.1',port:3090});s.once('connect',()=>{s.destroy();resolve(true)});s.once('error',()=>resolve(false));s.setTimeout(1000,()=>{s.destroy();resolve(true)})});await assertStartReady({occupied:async()=>occupied,lock,bundle})
 const password=(await readFile(path.join(process.env.LOCALAPPDATA,'TradeLoom/postgres/password'),'utf8')).replace(/[\r\n]+$/,'');if(!password)throw Error('Database credential unavailable')
 const network=spawnSync('powershell.exe',['-NoProfile','-File',path.join(repo,'apps/tradeloom-launcher/network-candidates.ps1')],{encoding:'utf8',windowsHide:true});if(network.status!==0)throw Error('Official network candidates unavailable');const parsed=JSON.parse(network.stdout.trim()),candidates=Array.isArray(parsed)?parsed:[parsed];if(candidates.length!==1||!candidates[0]?.addresses?.[0]?.address)throw Error('Expected one official network candidate');const host=candidates[0].addresses[0].address,payload=Buffer.from(JSON.stringify(candidates),'utf8').toString('base64')
 const args=[cli,'start','--mode','desktop','--runtime',runtime,'--data-root',data,'--desktop-build-lock',lock,'--bundle-source',bundle,'--host',host,'--candidates',payload];const env={};for(const key of ['PATH','SystemRoot','WINDIR','LOCALAPPDATA','APPDATA','USERPROFILE','TEMP','TMP','COMSPEC','PATHEXT'])if(process.env[key]!==undefined)env[key]=process.env[key];env.TRADELOOM_DB_PASSWORD=password;const child=spawn(process.execPath,args,{cwd:repo,env,stdio:'inherit',windowsHide:false});const result=await new Promise(resolve=>{child.once('error',e=>resolve({code:null,error:e.code}));child.once('close',(code,signal)=>resolve({code,signal}))});process.exitCode=result.code??1
}
