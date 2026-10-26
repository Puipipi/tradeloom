import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const stage=path.dirname(fileURLToPath(import.meta.url));
const source=process.env.DESKTOP16_SOURCE;
const backup=process.env.DESKTOP16_BACKUP;
if(!source||!backup) throw new Error('Set DESKTOP16_SOURCE and DESKTOP16_BACKUP to audited desktop16 inputs.');
const out=path.join(stage,'TradeLoom-desktop16-portable-win-x64');
if(fs.existsSync(out)) throw new Error('Output already exists; preserve it and choose a fresh stage.');
const inv=JSON.parse(fs.readFileSync(path.join(stage,'dependency-inventory.json'),'utf8'));
const nodes=new Map(inv.packages.map(p=>[p.source,p]));
const graph=new Map();
for(const e of inv.edges){if(!graph.has(e.from))graph.set(e.from,[]);graph.get(e.from).push(e);}
const counts=new Map();
for(const e of inv.edges)counts.set(e.to,(counts.get(e.to)??0)+1);
const roots=new Map();
for(const p of inv.packages){const old=roots.get(p.name);if(!old||(counts.get(p.source)??0)>(counts.get(old)??0))roots.set(p.name,p.source);}
const modules=path.join(out,'dsh','node_modules');
fs.mkdirSync(modules,{recursive:true});
const placements=new Map(),queue=[];
let copiedBytes=0,copiedFiles=0;
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
function copy(src,dst,filter=()=>true){
  const st=fs.lstatSync(src);
  if(st.isSymbolicLink()) throw new Error('Refuse source link '+src);
  if(!filter(src,st))return;
  if(st.isDirectory()){fs.mkdirSync(dst,{recursive:true});for(const name of fs.readdirSync(src))copy(path.join(src,name),path.join(dst,name),filter);}
  else if(st.isFile()){fs.mkdirSync(path.dirname(dst),{recursive:true});fs.copyFileSync(src,dst);copiedBytes+=st.size;copiedFiles++;}
}
function copyPackage(rel,dst){
  const src=path.join(source,rel),m=JSON.parse(fs.readFileSync(path.join(src,'package.json'),'utf8'));
  const workspace=!rel.startsWith('node_modules/');
  const deny=(p,st)=>{
    const r=path.relative(src,p),parts=r.split(path.sep),name=path.basename(p);
    if(parts.some(x=>['node_modules','.git','.cache','tests','test','__tests__','fixtures'].includes(x)))return false;
    if(name.startsWith('.env')||/\.(?:tsbuildinfo|map)$/i.test(name))return false;
    if(/\.d\.[cm]?ts$/i.test(name))return false;
    if(workspace && parts[0]==='src')return false;
    return true;
  };
  fs.mkdirSync(dst,{recursive:true});
  if(workspace && Array.isArray(m.files)){
    const entries=new Set(['package.json',...fs.readdirSync(src).filter(n=>/^(?:licen[cs]e|copying|notice|readme)/i.test(n))]);
    for(const item of m.files){
      if(item.startsWith('!'))continue;
      if(fs.existsSync(path.join(src,item)))entries.add(item);
      else for(const match of fs.globSync(item,{cwd:src}))entries.add(match);
    }
    for(const item of entries)copy(path.join(src,item),path.join(dst,item),deny);
  }else copy(src,dst,deny);
}
function place(rel,dst){
  if(placements.has(dst)){if(placements.get(dst)!==rel)throw new Error('Placement collision');return;}
  placements.set(dst,rel);copyPackage(rel,dst);queue.push(dst);
}
for(const [name,rel]of roots)if(name!=='@deepseek-ai/dsh-desktop')place(rel,path.join(modules,name));
function resolvePlacement(from,name){for(let d=from;;d=path.dirname(d)){const at=path.join(d,'node_modules',name);if(placements.has(at))return at;if(d===out||path.dirname(d)===d)return null;}}
for(let i=0;i<queue.length;i++){
  const dst=queue[i],rel=placements.get(dst);
  for(const e of graph.get(rel)??[]){const existing=resolvePlacement(dst,e.name);if(!existing||placements.get(existing)!==e.to)place(e.to,path.join(dst,'node_modules',e.name));}
  if(i%100===0) console.log('materialized '+i+'/'+queue.length);
}
for(const [dst,rel] of placements)for(const e of graph.get(rel)??[]){const found=resolvePlacement(dst,e.name);if(!found||placements.get(found)!==e.to)throw new Error('Resolution mismatch '+rel+' '+e.name);}
const app=path.join(out,'app');fs.mkdirSync(app,{recursive:true});
for(const rel of ['lib','renderer','resources','scripts/node-bin'])copy(path.join(source,'apps/desktop',rel),path.join(app,rel),(p,st)=>!p.endsWith('.tsbuildinfo')&&!p.endsWith('.map'));
copy(path.join(source,'apps/desktop/package.json'),path.join(app,'package.json'));
const shell=path.join(backup,'A-deployed-desktop16-shell/frontend-binding-bundle');
copy(shell,path.join(modules,'@tradeloom/dsh-business-shell'));
copy(path.join(source,'apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime'),path.join(out,'runtime/primary-runtime'));
copy(path.join(source,'apps/desktop/.desktop-build/targets/win-x64/runtime/office-skills'),path.join(out,'runtime/office-skills'));
// Electron archive is the independently preserved engine, not the live dependency tree.
execFileSync('python',['-X','utf8','-c','import zipfile,sys; z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; z.extractall(sys.argv[2])',path.join(backup,'D-electron44-engine/electron-44.7.0-dist.zip'),path.join(out,'engine')],{stdio:'inherit'});
const release={schemaVersion:1,version:'0.2.1-rc.3',hostProtocolVersion:4,nodeVersion:'24.21.0',pnpmVersion:'11.28.5'};
const sharedPackages=[...roots].filter(([name])=>name!=='@deepseek-ai/dsh-desktop').map(([name,rel])=>({name,version:nodes.get(rel).version,path:'node_modules/'+name})).sort((a,b)=>a.name.localeCompare(b.name));
sharedPackages.push({name:'@tradeloom/dsh-business-shell',version:'0.1.0',path:'node_modules/@tradeloom/dsh-business-shell'});
fs.writeFileSync(path.join(out,'dsh/desktop-runtime.json'),JSON.stringify({schemaVersion:1,release,platform:'win32',arch:'x64',sharedPackages,files:[]},null,2)+'\n');
fs.writeFileSync(path.join(out,'dsh/package.json'),JSON.stringify({name:'@tradeloom/desktop16-portable-runtime',private:true,version:release.version,type:'module'},null,2)+'\n');
// Package-local resolution for the fixed main bundle uses the same ordinary dependency payload.
// A parent node_modules directory is sufficient for Node resolution without duplicating the closure.
fs.renameSync(modules,path.join(out,'node_modules'));
// dsh itself resolves above to the parent, but its runtime descriptor records relative package paths.
// Keep dsh as the Node resolution root by moving metadata beside the actual modules instead.
for(const f of ['desktop-runtime.json','package.json'])fs.renameSync(path.join(out,'dsh',f),path.join(out,f));
fs.rmdirSync(path.join(out,'dsh'));
const descriptor=JSON.parse(fs.readFileSync(path.join(out,'desktop-runtime.json'),'utf8'));
const licenseDir=path.join(out,'licenses');fs.mkdirSync(licenseDir,{recursive:true});
for(const f of ['LICENSE','THIRD_PARTY_NOTICES.md'])copy(path.join(source,f),path.join(licenseDir,f));
fs.writeFileSync(path.join(licenseDir,'npm-dependencies.json'),JSON.stringify(inv.packages.map(({name,version,license})=>({name,version,license})),null,2)+'\n');
const mainHash=hash(path.join(app,'lib/main.js')),hostHash=hash(path.join(out,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'));
const backupMain=hash(path.join(backup,'B-deployed-desktop16-evidence/compiled/apps/desktop/lib/main.js'));
const backupHost=hash(path.join(backup,'B-deployed-desktop16-evidence/compiled/apps/desktop-host/lib/index.js'));
if(mainHash!==backupMain||hostHash!==backupHost)throw new Error('Compiled baseline mismatch');
const identity={product:'TradeLoom desktop16 portable',platform:'win32-x64',sourceCommit:'1f81c047fc48fa190a683e469daa699857e9afe8',shellDigest:'ea6a7e30985d360099d39af9ca9035d718bf46d1681ff0bd7f05f10e0ccf2eca',electron:'44.7.0',engineDigest:'142d28396b3abe2ead4238c85c2c96c7718135eb0bc083956dc198a51277e3fa',mainHash,hostHash,release,kind:'unsigned-unpackaged-portable',businessServicesIncluded:false};
fs.writeFileSync(path.join(out,'build-identity.json'),JSON.stringify(identity,null,2)+'\n');
const shellManifest=JSON.parse(fs.readFileSync(path.join(backup,'A-deployed-desktop16-shell/shell-bundle-manifest.json'),'utf8'));
fs.writeFileSync(path.join(out,'shell-manifest.json'),JSON.stringify({schemaVersion:1,treeHash:shellManifest.copiedTreeHash,files:shellManifest.sourceFiles},null,2)+'\n');
if(fs.existsSync(path.join(stage,'templates')))copy(path.join(stage,'templates'),out);
fs.writeFileSync(path.join(stage,'materialization-receipt.json'),JSON.stringify({identity,packageIdentities:inv.packages.length,physicalPackagePlacements:placements.size,missingRequired:inv.summary.missingRequired,copiedFiles,copiedBytes,resolutionEdgesVerified:inv.edges.length,compiledMatchesBackup:true,method:'production dependency closure from existing audited desktop16, no compilation or install scripts executed'},null,2)+'\n');
console.log(JSON.stringify({out,packages:placements.size,copiedFiles,copiedBytes,mainHash,hostHash}));
