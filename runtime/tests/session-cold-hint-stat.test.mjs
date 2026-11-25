import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const prefixArg=process.env.DSH_TEST_PREFIX??process.env.DSH_PREFIX;
test('public AppBoot cold list stats only reusable hints before observing', {skip:!prefixArg&&'prepared DSH prefix required'}, async t=>{
const prefix=resolve(prefixArg),root=await fs.mkdtemp(join(tmpdir(),'cold-list-'));
const priorHome=process.env.DSH_HOME,priorTelemetry=process.env.DSH_TELEMETRY_DISABLED;
process.env.DSH_HOME=root;process.env.DSH_TELEMETRY_DISABLED='1';
const load=n=>import(pathToFileURL(join(prefix,'node_modules/@deepseek-ai',n,'lib/index.js')));
let ctx,writer;
try{
 const [{Context},{Session},jsonl,{boot,loadOverlayPatches}]=await Promise.all(['cordis','dsh-session','dsh-session-persistence-jsonl','dsh-app-boot'].map(load));
 writer=new Context();await jsonl.apply(writer,{root:join(root,'sessions'),compression:'zstd'});
 const source=[];
 for(let i=0;i<3;i++){const cwd=join(root,`project-${i}`);await fs.mkdir(cwd);const id=`import-${i}`,s=Session.create(id,undefined,{...Session.create(id).header,cwd});const h=await writer.sessionPersistence.create(s.header);s.append('turn/start',{turn:1});s.append('turn/end',{turn:1,reason:{kind:'completed'}});await h.append(s.snapshotEvents());await h.close();source.push(s)}
 await writer.fiber.dispose();writer=undefined;
 const {provideCmdline}=await load('dsh-cmdline');
 const main=join(root,'main.json');await fs.writeFile(main,'[]');
 const patches=['dsh-base','dsh-web-app'].flatMap(n=>loadOverlayPatches('dsh',join(prefix,'node_modules/@deepseek-ai',n,'cordis.patch.yml')));
 for(const id of ['session-title-llm','session-telemetry-otel','desktop-product-telemetry','web-runtime','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web'])patches.push({id,disabled:true});
 ctx=await boot('dsh',main,patches,c=>provideCmdline(c,{args:['--host','127.0.0.1','--port','0','--no-open'],exit:code=>{throw new Error(`unexpected CLI exit ${code}`)}}),pathToFileURL(join(prefix,'node_modules','dsh','package.json')).href);
 assert(ctx.sessionController);assert(ctx.sessionProjectionCache);
 const persistence=ctx.sessionPersistence,stat=persistence.stat.bind(persistence),calls=[];
 persistence.stat=async(...args)=>{calls.push({id:args[0],stack:new Error().stack});return stat(...args)};
 async function listed(){
  calls.length=0;const result=await ctx.sessionController.list({});
  assert.deepEqual(result.items.map(x=>x.sessionId).sort(),source.map(x=>x.id).sort());
  for(const row of result.items){assert.equal(row.running,false);assert.equal(row.agentAvailable,false);assert.equal(row.formatStatus,'current');assert.equal(typeof row.projections.values.sessionListMetadata.blank,'boolean')}
  return result;
 }
 await t.test('imported current logs without checkpoints use one query stat per session',async()=>{
  for(const s of source)assert.equal(ctx.sessionProjectionCache.cachedSnapshot(s.header),undefined);
  await listed();t.diagnostic(JSON.stringify({phase:'first',stats:calls.length,calls}));
  assert.equal(calls.length,source.length,'no hint exists to justify a separate API preflight stat');
  assert(calls.every(c=>c.stack.includes('SessionObservationReader.statSource')));
 });
 await t.test('unchanged warm hints still revalidate revisions',async()=>{
  await listed();assert.equal(calls.length,source.length);
  assert(calls.every(c=>c.stack.includes('ApiSessionList.summarizeCold')));
 });
 await t.test('real appended title changes revision and invalidates the warm hint',async()=>{
  const s=source[0],handle=await persistence.open(s.id,'write');
  try{s.append('session/title',{title:'Updated imported title',messageSeqs:[],source:{kind:'user'}});await handle.append(s.snapshotEvents().slice(-1));}finally{await handle.close()}
  const result=await listed();assert.equal(result.items.find(x=>x.sessionId===s.id).projections.values.title,'Updated imported title');
  assert.equal(calls.length,source.length+1,'the changed hint retains preflight and query-owned stat');
 });
 await t.test('durable complete checkpoints avoid cold-log stat',async()=>{
  for(const s of source){await ctx.sessionProjectionCache.write(s);assert.ok(ctx.sessionProjectionCache.cachedSnapshot(s.header).values.sessionListMetadata)}
  const result=await listed();assert.equal(calls.length,0);
  assert.equal(result.items.find(x=>x.sessionId===source[0].id).projections.values.title,'Updated imported title');
 });

}finally{await ctx?.fiber.dispose();await writer?.fiber.dispose();await fs.rm(root,{recursive:true,force:true});if(priorHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=priorHome;if(priorTelemetry===undefined)delete process.env.DSH_TELEMETRY_DISABLED;else process.env.DSH_TELEMETRY_DISABLED=priorTelemetry;}
});
