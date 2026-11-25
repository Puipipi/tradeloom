// Canonical module ownership, combined with the current listBundles authority.
// The installation map anchors core bundle declarations; ADDENDUM4 permits
// optional plugins from that same installation or a verified profile update.
// No client/entry metadata can grant ownership or bypass the core boundary.
import {readFileSync,realpathSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const inside=(root,file)=>{const path=relative(root,file);return path===''||path!=='..'&&!path.startsWith('..'+sep)&&!isAbsolute(path);};
const unknown=()=>({kind:'unknown',owner:null,source:'unverified',proof:null});
function boundary(ctx){
 const entries=ctx.get('pluginPackages')?.resolution?.entries;
 if(!Array.isArray(entries))throw Error('No runtime source boundary');
 const selected=entries.filter(x=>x.scope==='installation');
 if(!selected.length)throw Error('No installation packages');
 const names=new Set(),roots=new Set(),packages=new Map();
 for(const row of selected){
  if(typeof row.name!=='string'||!row.name||typeof row.packageDir!=='string')throw Error('Incomplete installation package');
  const root=realpathSync(row.packageDir),manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  if(manifest.name!==row.name)throw Error('Installation ownership mismatch');
  if(packages.has(row.name)&&packages.get(row.name)!==root)throw Error('Ambiguous installation package');
  names.add(row.name);roots.add(root);packages.set(row.name,root);
 }
 const anchor=realpathSync(ctx.get('profileContext')?.installAnchor),manifest=JSON.parse(readFileSync(anchor,'utf8'));
 if(!names.has(manifest.name)||!roots.has(dirname(anchor)))throw Error('Installation anchor is not protected');
 return {names,roots:[...roots],packages};
}
function resolveFile(loader,name,base){
 const internal=loader?.internal;
 if(!internal||typeof internal.resolveSync!=='function')throw Error('No active Node resolver');
 const result=internal.version==='v2'?internal.resolveSync(base,{specifier:name,attributes:{}}):internal.resolveSync(name,base,{});
 return realpathSync(fileURLToPath(result.url));
}
function nearestPackage(file){
 for(let dir=dirname(file);;dir=dirname(dir)){
  try{
   const manifest=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
   if(typeof manifest.name!=='string'||!manifest.name)throw Error('Unnamed package');
   return {dir,name:manifest.name};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(dirname(dir)===dir)throw Error('No owning package');
 }
}
function sourceOf(ctx,entry,protectedSource){
 try{
  const name=entry.options?.name,base=entry.parent?.tree?.ctx?.baseUrl;
  if(typeof name!=='string'||typeof base!=='string')return unknown();
  const file=resolveFile(ctx.get('loader'),name,base),actual=nearestPackage(file);
  const core=()=>({kind:'protected',owner:actual.name,source:'host-installation',proof:[actual.name,actual.dir,file]});
  if(protectedSource.names.has(actual.name)||protectedSource.roots.some(root=>inside(root,file)||inside(root,actual.dir)))return core();
  // packageOf accepts bare requests only. Missing ownership (including direct
  // paths, file: and #imports) never becomes evidence of an external plugin.
  const pkg=ctx.get('pluginPackages').packageOf(name,base);
  if(!pkg||typeof pkg.name!=='string'||!pkg.name)return unknown();
  const root=realpathSync(pkg.dir),manifestPath=realpathSync(pkg.manifestPath);
  if(protectedSource.names.has(pkg.name)||protectedSource.roots.some(dir=>inside(dir,root)))return core();
  if(root!==actual.dir||pkg.name!==actual.name||manifestPath!==join(root,'package.json')||!inside(root,file))return unknown();
  return {kind:'plugin',owner:actual.name,source:'external-package',proof:[actual.name,root,file]};
 }catch{return unknown();}
}
const bundleKind=b=>b?.official===true&&b.optional===true?'optional':b?.installed===true&&typeof b.source==='string'&&b.source.trim().length>0?'installed':'core';
// listBundles is the authority for entitlement; canonical resolution remains an
// additional conservative source check. Metadata supplied by an entry/client
// never grants a bundle or changes this relationship.
export function bundleEntrySources(ctx,entries,bundles){
 const empty=entry=>({kind:'overlay',owner:'overlay',package:null,bundle:null,source:'unverified',allowed:false,proof:null});
 if(!Array.isArray(bundles))return entries.map(empty);
 let protectedSource;
 try{protectedSource=boundary(ctx);}catch{return entries.map(empty);}
 const sources=entries.map(entry=>sourceOf(ctx,entry,protectedSource));
 const declarations=new Map(),coreNames=new Set(),coreRoots=new Set(),coreFiles=new Set();
 let complete=true;
 for(const b of bundles){
  if(typeof b?.name!=='string'||!Array.isArray(b.rows)){complete=false;continue;}
  for(const row of b.rows){
   if(typeof row?.rowId!=='string'||typeof row.moduleName!=='string'){complete=false;continue;}
   const list=declarations.get(row.rowId)??[];list.push({bundle:b,row});declarations.set(row.rowId,list);
  }
  // A core module remains protected when an optional bundle declares another
  // instance. Resolve trusted installation declarations even if the original
  // core instance is disabled, renamed by an overlay, or currently unloaded.
  if(bundleKind(b)!=='core'||!protectedSource.packages.has(b.name))continue;
  if(b.error!=null){complete=false;continue;}
  const base=pathToFileURL(join(protectedSource.packages.get(b.name),'package.json')).href;
  for(const row of b.rows){
   const origin=sourceOf(ctx,{options:{name:row.moduleName},parent:{tree:{ctx:{baseUrl:base}}}},protectedSource);
   if(origin.kind==='unknown'){complete=false;continue;}
   coreNames.add(origin.owner);coreRoots.add(origin.proof[1]);coreFiles.add(origin.proof[2]);
  }
 }
 const isCore=source=>source.proof&&(coreNames.has(source.owner)||coreRoots.has(source.proof[1])||coreFiles.has(source.proof[2]));
 const owned=(entry,source)=>{
  try{
   if(!source.proof)return false;
   const pkg=ctx.get('pluginPackages').packageOf(entry.options.name,entry.parent.tree.ctx.baseUrl);
   return pkg?.name===source.owner&&realpathSync(pkg.dir)===source.proof[1]&&realpathSync(pkg.manifestPath)===join(source.proof[1],'package.json')&&inside(source.proof[1],source.proof[2]);
  }catch{return false;}
 };
 // Cordis shares runtimes by callback. This recognizes simple re-exports of
 // observed core/unknown callbacks, not arbitrary third-party wrapper code.
 const coreCallbacks=new Set(entries.flatMap((entry,i)=>(isCore(sources[i])||sources[i].kind==='unknown')&&entry.fiber?.runtime?.callback?[entry.fiber.runtime.callback]:[]));
 return entries.map((entry,index)=>{
  const source=sources[index],declared=declarations.get(entry.options.id)??[];
  // Disabled catalog bundles do not contribute a composition layer. They may
  // describe the same potential row as the one enabled bundle that owns it.
  const active=declared.filter(x=>x.bundle.enabled===true),matches=active.length?active:declared;
  const result={...empty(entry),package:source.owner};
  if(matches.length!==1)return {...result,owner:matches.some(x=>bundleKind(x.bundle)==='core')?'core':'overlay',kind:matches.some(x=>bundleKind(x.bundle)==='core')?'core':'overlay'};
  const {bundle,row}=matches[0],owner=bundleKind(bundle);
  const base={...result,owner,kind:owner==='core'?'core':'plugin',bundle:bundle.name,label:bundle.meta?.title};
  // The same bare module in a separately inserted overlay is not a declared
  // plugin instance. Do not strip prefixes or authorize by package membership.
  if(entry.parent?.tree?.ctx?.fiber?.entry?.id!=='include'||entry.id!==`include:${entry.options.id}`||row.entryId!==entry.id||row.rowId!==entry.options.id||row.moduleName!==entry.options.name)return {...result};
  if(owner==='core'||bundle.enabled!==true||bundle.error!=null)return base;
  // Eligible optional packages may resolve from a profile update. Location
  // alone grants nothing and must not revoke otherwise proved entitlement.
  // The canonical core declaration set, not all installation packages, is the
  // additional protected boundary under ADDENDUM4.
  const proven=complete&&coreNames.size>0&&owned(entry,source);
  if(!proven||isCore(source)||coreCallbacks.has(entry.fiber?.runtime?.callback))return base;
  return {...base,kind:'plugin',source:owner==='optional'?'official-optional-bundle':'installed-bundle',allowed:true,
   proof:[source.proof,owner,bundle.name,bundle.official,bundle.optional,bundle.installed,bundle.source??null,row.rowId,row.entryId,row.moduleName]};
 });
}
