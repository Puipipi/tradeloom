import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {pathToFileURL} from 'node:url';
const prefix=resolve(process.argv[2]);
const boot=await import(pathToFileURL(prefix+'/node_modules/@deepseek-ai/dsh-app-boot/lib/index.js'));
const root=await mkdtemp('/tmp/config-path-');
try {
 const file=join(root,'配置 with space','profile.patch.yml');
 const cases=['/tmp/插件 with space.mjs','./插件 with space.mjs','../插件 with space.mjs',pathToFileURL('/tmp/插件 with space.mjs').href,'plain-plugin','@scope/plugin','cordis:include'];
 for(const name of cases){
  const raw=[{insert:[{id:'target',name,config:{live:'old'}}]}];
  const source=JSON.stringify(raw);
  const loaded=boot.parsePatchList('test',file,source,'patches');
  const entry=boot.composeEntries([loaded]).find(x=>x.id==='target');
  raw.push({id:'target',name:entry.name,config:{live:'new'}});
  const proposed=boot.parsePatchList('test',file,JSON.stringify(raw),'patches');
  assert.equal(boot.composeEntries([proposed]).find(x=>x.id==='target').config.live,'new');
  assert.equal(proposed.at(-1).name,entry.name);
  const overlay=[{id:'target',name:entry.name,config:{live:'locked'}}];
  assert.equal(boot.composeEntries([proposed,overlay]).find(x=>x.id==='target').config.live,'locked');
  console.log('PASS insert + edit + overriding layer: '+name);
 }
 const group=boot.parsePatchList('test',file,JSON.stringify([{insert:[{id:'group',name:'cordis:group',group:true,config:[{id:'nested',name:'../嵌套 with space.mjs',config:{}},{id:'deeper',group:true,config:[{id:'deep',name:'./deep.mjs'}]}]}]}]),'patches');
 assert.equal(group[0].insert[0].config[0].name,pathToFileURL(resolve(root,'嵌套 with space.mjs')).href);
 assert.equal(group[0].insert[0].config[1].config[0].name,pathToFileURL(resolve(root,'配置 with space/deep.mjs')).href);
 const assertions=boot.parsePatchList('test',file,JSON.stringify([{id:'target',name:'./literal.mjs',config:{}}]),'patches');assert.equal(assertions[0].name,'./literal.mjs');
 const expr=boot.parsePatchList('test',file,'- id: target\n  disabled: !!js foo.bar\n','patches');assert.ok(expr[0].disabled);
 for(const text of ['{}','- null','- [a,b]'])assert.throws(()=>boot.parsePatchList('test',file,text,'patches'));
 console.log('PASS nested groups, literal assertion names, !!js and malformed input rejection');
} finally {await rm(root,{recursive:true,force:true});}
