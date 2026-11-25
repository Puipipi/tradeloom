// Unit fixtures model the package/resolver services with real temporary files.
// They do not claim to exercise the actual Node interception or Host Loader.
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
const temp=mkdtempSync(join(tmpdir(),'plugin-config-source-unit-'));
process.once('exit',()=>rmSync(temp,{recursive:true,force:true}));
let sequence=0;
export function withSources(ctx,entries){
 const root=join(temp,String(++sequence));mkdirSync(root);const install=join(root,'installation');mkdirSync(install);
 writeFileSync(join(install,'package.json'),JSON.stringify({name:'unit-host'}));
 const packages=new Map(),files=new Map();
 writeFileSync(join(install,'index.js'),'export function apply(){}\n');files.set('unit-host',join(install,'index.js'));
 for(const entry of entries){
  const name=entry.options.name;
  if(!packages.has(name)){
   const dir=join(root,'plugin-'+packages.size);mkdirSync(dir);const manifestPath=join(dir,'package.json');writeFileSync(manifestPath,JSON.stringify({name}));
   const file=join(dir,'index.js');writeFileSync(file,'export function apply(){}\n');files.set(name,file);packages.set(name,{name,dir,manifestPath});
  }
  entry.parent??={tree:{ctx:{baseUrl:pathToFileURL(root+'/').href}}};
  entry.id??=`include:${entry.options.id}`;entry.parent.tree.ctx.fiber??={entry:{id:'include'}};
 }
 const get=ctx.get,loader=get('loader'),resolution={entries:[{name:'unit-host',packageDir:install,scope:'installation'}]};
 const editor=get('configEditor');if(editor)editor.dshGoAsyncChange??=true;
 const service={resolution,packageOf:name=>packages.get(name)};
 const bundle={name:'fixture-bundle',enabled:true,installed:true,source:'file:synthetic',official:false,optional:false,rows:entries.map(entry=>({rowId:entry.options.id,entryId:entry.id,moduleName:entry.options.name}))};
 const bundles=[{name:'unit-host',enabled:true,installed:false,official:false,optional:false,rows:[{rowId:'core-defined',moduleName:'unit-host'}]},bundle];
 const manager={listBundles:async()=>bundles};
 const internal={version:'v2',resolveSync(_base,{specifier}){if(!files.has(specifier))throw Error('Missing unit source');return {url:pathToFileURL(files.get(specifier)).href};}};
 ctx.get=name=>name==='pluginManager'?manager:name==='pluginPackages'?service:name==='profileContext'?{installAnchor:join(install,'package.json')}:name==='loader'?{...loader,internal}:get(name);
 return {ctx,root,install,packages,files,service,internal,bundle,bundles,manager};
}
