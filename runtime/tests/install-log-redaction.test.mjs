// DSH_PREFIX points to an installed rc4 prefix with the pinned runtime patches applied.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const prefix=resolve(process.env.DSH_PREFIX);
const {PluginManager,parseInstallSpec}=await import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js')));
const marker='SYNTHETIC_USERINFO_ONLY';
const cases=[
 ['registry','@scope/plugin@1.2.3','@scope/plugin@1.2.3'],
 ['git https',`git+https://user:${marker}@example.invalid/team/plugin.git`,'git+https://example.invalid/team/plugin.git'],
 ['http',`http://user:${marker}@example.invalid/a`,'http://example.invalid/a'],
 ['registry option',`--registry=https://user:${marker}@example.invalid/`,'--registry=https://example.invalid/'],
 ['alias',`alias@git+https://user:${marker}@example.invalid/a`,'alias@git+https://example.invalid/a'],
 ['encoded userinfo',`HTTPS://u%40x:${marker}%40x@example.invalid/a`,'HTTPS://example.invalid/a'],
 ['username token',`https://${marker}@example.invalid/a`,'https://example.invalid/a'],
 ['path at sign','https://example.invalid/user@revision','https://example.invalid/user@revision'],
 ['query at sign','https://example.invalid?mail=user@other','https://example.invalid?mail=user@other'],
 ['fragment at sign','https://example.invalid#user@other','https://example.invalid#user@other'],
];
async function run(arg,mode='silent') {
 const dir=await mkdtemp(join(tmpdir(),'install-log-redaction-')); const events=[];
 try {
  await writeFile(join(dir,'package.json'),JSON.stringify({name:'test-profile',version:'1.0.0',dependencies:{},dsh:{profile:{bundles:[]}}}));
  const fake=join(dir,'fake.mjs');
  await writeFile(fake,`import {writeFileSync,writeSync} from 'node:fs';writeFileSync(${JSON.stringify(join(dir,'argv.json'))},JSON.stringify(process.argv.slice(2)));${mode==='output'?"writeSync(1,'stdout fixture');writeSync(2,'stderr fixture');":''}await new Promise(r=>setTimeout(r,100));process.exit(${mode==='nonzero'?2:0});`);
  if(mode==='error') await writeFile(join(dir,'package.json'),'{invalid json');
  const manager={profile:{dir,name:'test',home:dir,cwd:dir,installAnchor:join(prefix,'package.json'),packageManager:{command:mode==='error'?join(dir,'missing-command'):process.execPath,args:[fake]}},abort:new AbortController(),ownerContext:{emit:(name,data)=>events.push({name,data})},outputBytes:4096,idleTimeoutMs:3000,inspectTimeoutMs:100,packageOperations:new Set()};
  const args=['add',arg]; let result,error;
  try {result=await PluginManager.prototype.runPnpm.call(manager,args,undefined,'test');}catch(e){error=e;}
  assert.deepEqual(args,['add',arg]); assert.equal(manager.packageOperations.size,0);
  const received=mode==='error'?undefined:JSON.parse(await readFile(join(dir,'argv.json'),'utf8'));
  if(received) assert(received.includes(arg),'child must receive original execution argument');
  assert(events.length>0); assert(events.every(e=>e.name==='plugin-manager/install-log'));
  assert(events.every(e=>!JSON.stringify(e.data.argv).includes(marker)),'userinfo in event argv');
  return {events,result,error};
 }finally {await rm(dir,{recursive:true,force:true});}
}
for(const [label,arg,expected] of cases)test(label,async()=>{
 const {events,result}=await run(arg); assert.equal(result.exitCode,0);
 assert(events.every(e=>JSON.stringify(e.data.argv)===JSON.stringify(['pnpm','add',expected])));
 assert.equal(events.at(-1).data.text,''); assert.equal(events.at(-1).data.exitCode,0);
});
test('legal install spec',()=>assert.equal(parseInstallSpec(cases[1][1]).kind,'git'));
test('stdout stderr and final chunks',async()=>{const {events}=await run(cases[1][1],'output');assert(events.some(e=>e.data.text.includes('stdout fixture')));assert(events.some(e=>e.data.stream==='stderr'));assert.equal(events.at(-1).data.exitCode,0);});
test('nonzero completion',async()=>{const {events,result}=await run(cases[1][1],'nonzero');assert.equal(result.exitCode,2);assert.equal(events.at(-1).data.exitCode,2);});
test('profile exception chunk',async()=>{const {events,error}=await run(cases[1][1],'error');assert(error);assert.equal(events.at(-1).data.exitCode,null);assert.equal(events.at(-1).data.stream,'stderr');});
