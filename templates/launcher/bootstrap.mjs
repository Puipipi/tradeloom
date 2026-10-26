import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {spawn,execFileSync} from 'node:child_process';
import crypto from 'node:crypto';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args=process.argv.slice(2);
const check=args.includes('--check');
const rootFlag=args.indexOf('--data-root');
let data;
let electronData;
const primary=path.join(root,'runtime','primary-runtime');
const node=path.join(primary,'dependencies','node','bin','node.exe');
const electron=path.join(root,'engine','electron.exe');
const pnpm=path.join(primary,'dependencies','pnpm','bin','pnpm.mjs');
const app=path.join(root,'app');
let profile;
const identity=JSON.parse(fs.readFileSync(path.join(root,'build-identity.json'),'utf8'));
const shellManifest=JSON.parse(fs.readFileSync(path.join(root,'shell-manifest.json'),'utf8'));
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function assertFile(p){if(!fs.existsSync(p)||!fs.lstatSync(p).isFile())throw new Error('解压内容不完整，缺少文件：'+path.relative(root,p));}
function verifyShell(directory){
  const tree=crypto.createHash('sha256');
  for(const f of [...shellManifest.files].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)){
    const p=path.join(directory,f.path);assertFile(p);
    if(fs.lstatSync(p).isSymbolicLink()||hash(p)!==f.sha256)throw new Error('工作台壳文件校验失败：'+f.path+'；请保留现有资料并使用新的 --data-root。');
    tree.update(f.path.replaceAll('\\','/')).update('\0').update(fs.readFileSync(p));
  }
  if(tree.digest('hex')!==identity.shellDigest)throw new Error('工作台壳整体校验失败。');
}
function cleanEnvironment(){
  // Allow system location/UI variables only. Never inherit development paths, tokens or profile roots.
  const env={};
  for(const key of ['SystemRoot','WINDIR','COMSPEC','TEMP','TMP','USERPROFILE','HOMEDRIVE','HOMEPATH','LOCALAPPDATA','APPDATA','PROGRAMDATA','OS','PROCESSOR_ARCHITECTURE','NUMBER_OF_PROCESSORS','LANG'])if(process.env[key])env[key]=process.env[key];
  const windows=env.SystemRoot??'C:\\Windows';
  env.PATH=[path.dirname(node),path.join(root,'app','scripts','node-bin'),path.join(windows,'System32'),windows,path.join(windows,'System32','Wbem')].join(path.delimiter);
  Object.assign(env,{
    LOCALAPPDATA:path.join(data,'local-app-data'),APPDATA:path.join(data,'roaming-app-data'),
    XDG_CACHE_HOME:path.join(data,'xdg','cache'),XDG_CONFIG_HOME:path.join(data,'xdg','config'),XDG_DATA_HOME:path.join(data,'xdg','data'),
    DSH_HOME:path.join(data,'dsh-home'),DSH_AGENTS_HOME:path.join(data,'agents-home'),
    TRADELOOM_DSH_APP_HOME:path.join(data,'dsh-home'),
    TRADELOOM_MANAGED_DESKTOP:'1',TRADELOOM_EXTERNAL_SUPERVISOR:'1',
    DSH_DESKTOP_DSH_DIR:root,DSH_DESKTOP_PNPM_ENTRY:pnpm,DSH_DESKTOP_PRIMARY_RUNTIME_DIR:primary,
    DSH_DESKTOP_USER_DATA_DIR:electronData,DSH_DESKTOP_OPEN_DEVTOOLS:'0',
    TRADELOOM_DSH_BIND_HOST:'127.0.0.1',TRADELOOM_DSH_BIND_PORT:'0',TRADELOOM_DJANGO_PORT:'3090',
    DSH_DESKTOP_DIAGNOSTIC_FILE:path.join(data,'logs','desktop-diagnostic.json'),
  });
  return env;
}
async function prepare(){
  for(const p of [node,electron,pnpm,path.join(app,'lib/main.js'),path.join(root,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'),path.join(root,'desktop-runtime.json')])assertFile(p);
  if(hash(path.join(app,'lib/main.js'))!==identity.mainHash)throw new Error('desktop16 main.js 校验失败');
  if(hash(path.join(root,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'))!==identity.hostHash)throw new Error('desktop16 host 校验失败');
  verifyShell(path.join(root,'node_modules/@tradeloom/dsh-business-shell'));
  if(data===root||data.startsWith(root+path.sep))throw new Error('数据目录必须在软件目录之外，以保持分发包干净。');
  fs.mkdirSync(path.join(data,'logs'),{recursive:true});
  fs.mkdirSync(path.join(data,'workspace'),{recursive:true});
  fs.mkdirSync(path.join(data,'local-app-data'),{recursive:true});
  fs.mkdirSync(path.join(data,'roaming-app-data'),{recursive:true});
  fs.mkdirSync(path.join(data,'temp'),{recursive:true});
  const marker=path.join(data,'tradeloom-portable-data.json');
  const owned={schemaVersion:1,product:'tradeloom-desktop16-portable',sourceCommit:identity.sourceCommit,shellDigest:identity.shellDigest};
  if(fs.existsSync(marker)){
    if(JSON.stringify(JSON.parse(fs.readFileSync(marker,'utf8')))!==JSON.stringify(owned))throw new Error('数据目录归属或版本不匹配，请使用新的 --data-root。');
  }else{
    if(fs.existsSync(profile))throw new Error('数据目录已有未归属本便携版的 profile，请使用新的 --data-root。');
    fs.writeFileSync(marker,JSON.stringify(owned,null,2)+'\n',{flag:'wx'});
  }
  for(const [rel,name,content] of [
    ['agents-home','.tradeloom-agents-owned','tradeloom-agents-home-v1\n'],
    ['workspace','.tradeloom-workspace-owned','tradeloom-workspace-v1\n'],
    ['logs','.tradeloom-logs-owned','tradeloom-logs-v1\n'],
    ...['local-app-data','roaming-app-data','xdg/cache','xdg/config','xdg/data'].map(rel=>[rel,'.tradeloom-fallback-owned','tradeloom-fallback-v1\n']),
  ]){
    const dir=path.join(data,rel);fs.mkdirSync(dir,{recursive:true});
    const p=path.join(dir,name);
    if(fs.existsSync(p)){if(!fs.lstatSync(p).isFile()||fs.readFileSync(p,'utf8')!==content)throw new Error('数据目录的 ownership marker 不匹配：'+rel);}
    else fs.writeFileSync(p,content,{flag:'wx'});
  }
  const env=cleanEnvironment();
  env.TEMP=path.join(data,'temp');env.TMP=path.join(data,'temp');
  const actualMainData=path.join(env.LOCALAPPDATA,'TradeLoom','desktop','user-data');
  if(actualMainData!==electronData||!actualMainData.startsWith(data+path.sep))throw new Error('Electron 数据隔离检查失败。');
  const versions=JSON.parse(execFileSync(electron,['-p','JSON.stringify(process.versions)'],{env:{...env,ELECTRON_RUN_AS_NODE:'1'},encoding:'utf8',windowsHide:true}));
  if(versions.electron!=='44.7.0'||versions.node!=='24.21.0')throw new Error('内置 Electron/Node 版本与 desktop16 不匹配。');
  const probe=path.join(data,'.write-test');fs.writeFileSync(probe,'ok',{flag:'w'});fs.unlinkSync(probe);
  // Use the official initializer; it leaves existing user settings intact.
  const {initProfile}=await import(pathToFileURL(path.join(root,'node_modules/@deepseek-ai/dsh-app-boot/lib/index.js')).href);
  const homeMarker=path.join(env.DSH_HOME,'.tradeloom-owned');
  fs.mkdirSync(env.DSH_HOME,{recursive:true});
  if(fs.existsSync(homeMarker)){
    if(fs.readFileSync(homeMarker,'utf8')!=='tradeloom-dsh-apphome-v1\n')throw new Error('DSH_HOME ownership marker 不匹配，请使用新的 --data-root。');
  }else fs.writeFileSync(homeMarker,'tradeloom-dsh-apphome-v1\n',{flag:'wx'});
  initProfile(profile,['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@tradeloom/dsh-business-shell']);
  // Mirror official prepare-profile: external bundle discovery also anchors at the profile.
  const profileShell=path.join(profile,'node_modules','@tradeloom','dsh-business-shell');
  if(!fs.existsSync(profileShell)){
    fs.mkdirSync(path.dirname(profileShell),{recursive:true});
    fs.cpSync(path.join(root,'node_modules/@tradeloom/dsh-business-shell'),profileShell,{recursive:true,errorOnExist:true,force:false});
  }
  verifyShell(profileShell);
  const manifest=JSON.parse(fs.readFileSync(path.join(profile,'package.json'),'utf8'));
  if(JSON.stringify(manifest.dsh?.profile?.bundles)!==JSON.stringify(['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@tradeloom/dsh-business-shell']))throw new Error('数据根已有不兼容 profile，请用 --data-root 选择新目录。');
  return {env,versions};
}
try{
  if(rootFlag>=0&&(!args[rootFlag+1]||args[rootFlag+1].startsWith('--')))throw new Error('--data-root 后必须提供数据目录路径。');
  data=path.resolve(rootFlag>=0?args[rootFlag+1]:path.join(process.env.LOCALAPPDATA??path.join(process.env.USERPROFILE??root,'AppData','Local'),'TradeLoom','desktop16-portable'));
  profile=path.join(data,'dsh-home','profiles','desktop');
  electronData=path.join(data,'local-app-data','TradeLoom','desktop','user-data');
  const {env,versions}=await prepare();
  const officeDlls=['msvcp140.dll','msvcp140_1.dll','msvcp140_2.dll','vcruntime140.dll','vcruntime140_1.dll'];
  const missingOfficeDlls=officeDlls.filter(name=>!fs.existsSync(path.join(env.SystemRoot??'C:\\Windows','System32',name)));
  const optionalOffice={status:missingOfficeDlls.length?'optional-office-runtime-missing':'system-office-runtime-detected',bundledMSVCP:false,missingSystemDLLs:missingOfficeDlls};
  console.log('TradeLoom desktop16：包内运行环境与独立 profile 预检通过。');
  console.log('数据目录：'+data);
  if(check){console.log(JSON.stringify({status:'preflight-passed',electron:versions.electron,node:versions.node,profileBundles:['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@tradeloom/dsh-business-shell'],electronUserData:electronData,businessServicesIncluded:false,optionalOffice}));}
  else{
    const log=fs.openSync(path.join(data,'logs','desktop.log'),'a');
    const child=spawn(electron,['--user-data-dir='+electronData,app],{cwd:path.join(data,'workspace'),env,windowsHide:false,stdio:['ignore',log,log]});
    fs.writeFileSync(path.join(data,'logs','portable-launch.json'),JSON.stringify({pid:child.pid,executable:electron,startedAt:new Date().toISOString(),dataRoot:data,electronUserData:electronData,dshHome:env.DSH_HOME,bindHost:env.TRADELOOM_DSH_BIND_HOST,bindPort:env.TRADELOOM_DSH_BIND_PORT,identity},null,2)+'\n');
    fs.closeSync(log);
    child.on('error',error=>{console.error('桌面启动失败：'+error.message);process.exitCode=1;});
    child.on('exit',(code,signal)=>{if(code!==0){console.error('桌面退出：'+String(code??signal)+'；请查看 '+path.join(data,'logs','desktop.log'));process.exitCode=code??1;}});
  }
}catch(error){console.error('TradeLoom 启动检查失败：'+error.message);process.exitCode=2;}
