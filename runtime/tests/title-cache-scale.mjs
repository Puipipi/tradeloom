import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!process.argv[2]) throw new Error('usage: node title-cache-scale.mjs <patched-prefix> [result.json]');
const prefix=resolve(process.argv[2]), output=process.argv[3] ? resolve(process.argv[3]) : undefined;
const pkg=join(prefix,'node_modules/@deepseek-ai');
const apiFile=join(pkg,'dsh-api-session-controller/lib/b9-measure-'+process.pid+'.mjs');
const cacheFile=join(pkg,'dsh-session-projection-cache/lib/b9-measure-'+process.pid+'.mjs');
const {Context}=await import(pathToFileURL(join(pkg,'cordis/lib/index.js')));
const owner=new Context();
const temporary=[];
const result={node:process.version,platform:process.platform,arch:process.arch,timezone:process.env.TZ,count:500,warmups:1,samples:5,
  scope:'Real ApiSessionList, SessionProjectionCache read methods, DomainFacility and JsonStorageBackend. Service lifecycle, projection-view registry and session log persistence are fixture boundaries; not a running Host or phone benchmark.',groups:[]};
try {
  await writeFile(apiFile,(await readFile(join(pkg,'dsh-api-session-controller/lib/index.js'),'utf8'))+'\nexport { ApiSessionList as B9SessionList };\n');
  await writeFile(cacheFile,(await readFile(join(pkg,'dsh-session-projection-cache/lib/index.js'),'utf8'))+'\nexport { SessionProjectionCache as B9ProjectionCache, projectionCacheDomainSpec as B9ProjectionSpec };\n');
  const {B9SessionList}=await import(pathToFileURL(apiFile));
  const {B9ProjectionCache,B9ProjectionSpec}=await import(pathToFileURL(cacheFile));
  const {DomainFacility}=await import(pathToFileURL(join(pkg,'dsh-storage-domain/lib/index.js')));
  const {JsonStorageBackend}=await import(pathToFileURL(join(pkg,'dsh-storage-json/lib/index.js')));
  for (const mode of ['metadata','fallback']) {
    const disk=await mkdtemp(join(tmpdir(),'dsh-b9-cold-'));temporary.push(disk);
    const directory=join(disk,'session_projcache/sessions');await mkdir(directory,{recursive:true});
    const ids=Array.from({length:500},(_,i)=>'s'+String(i).padStart(4,'0'));
    const headers=new Map(ids.map((id,i)=>[id,{id,version:4,createdAt:1000+i,cwd:'/synthetic-b9',isSeeded:false}]));
    const revisions=new Map(ids.map(id=>[id,'r1']));
    const metadata={blank:true,lastPromptAt:null};
    const title=id=>'Title '+id;
    const document=id=>{
      const header=headers.get(id);
      const rows={title:{ver:1,seq:0,val:title(id)}};
      if(mode==='metadata')rows.sessionListMetadata={ver:1,seq:0,val:metadata};
      return {version:7,record:{identity:{formatVersion:4,createdAt:header.createdAt,cwd:header.cwd,isSeeded:false,inheritedEventCount:0},rows}};
    };
    for (const id of ids)await writeFile(join(directory,id+'.json'),JSON.stringify(document(id)));
    let counts={readRecord:0,recordSchemaParses:0,statRecord:0,persistenceStat:0,observeSession:0,disposeObservation:0,checkpointWrites:0};
    let records=ids.map(id=>({header:headers.get(id),formatStatus:'current'}));
    const counters=()=>({...counts});
    const diff=(before)=>Object.fromEntries(Object.entries(counts).map(([k,v])=>[k,v-before[k]]));
    const schema=B9ProjectionSpec.tables.sessions.valueSchema;
    const originalParse=schema.safeParse;
    schema.safeParse=(...args)=>{counts.recordSchemaParses++;return originalParse(...args);};
    const jsonBackend=new JsonStorageBackend(disk);
    let cache, beforeObserve;
    const persistence={identity:{},stat:async(id)=>{counts.persistenceStat++;return {revision:revisions.get(id),header:headers.get(id)};}};
    const ctx={
      fiber:owner.fiber,
      emit(){},inject(){},logger:{warn(message){throw new Error(message);},error(message){throw new Error(message);}},
      storage:{backend:{get:()=>({kv:{open:async descriptor=>{
        const unit=await jsonBackend.kv.open(descriptor);
        const read=unit.readRecord.bind(unit);
        unit.readRecord=async(...args)=>{counts.readRecord++;return read(...args);};
        const stat=unit.statRecord.bind(unit);unit.statRecord=async(...args)=>{counts.statRecord++;return stat(...args);};
        const put=unit.putRecord.bind(unit);
        unit.putRecord=async(...args)=>{counts.checkpointWrites++;return put(...args);};
        return unit;
      }}})}},
      sessions:new Map(),agents:new Map(),
      // Fixtures are valid version-1 title/metadata values. This boundary does not test projection registry hydration.
      sessionProjections:{register(){},summaryKeys(){return ["title","sessionListMetadata"]},viewCheckpoint(rows,keys){
        return Object.fromEntries(Object.entries(rows).filter(([key,row])=>row.ver===1&&(!keys||keys.includes(key))).map(([key,row])=>[key,row.val]));
      }},
      get(name){return name==='sessionProjectionCache'?cache:name==='sessionPersistence'?persistence:undefined;},
      sessionQuery:{
        listSessions:async()=>records,
        observeSession:async(id)=>{
          counts.observeSession++;
          await beforeObserve?.(id);
          return {revision:revisions.get(id),header:headers.get(id),projections:{asOfSeq:0,values:{title:'Observed '+id+' '+revisions.get(id),sessionListMetadata:metadata}},[Symbol.dispose](){counts.disposeObservation++;}};
        }
      }
    };
    const facility=new DomainFacility(ctx,{backend:'json'});
    const domain=await facility.open(B9ProjectionSpec);
    cache=Object.create(B9ProjectionCache.prototype);
    Object.defineProperty(cache,'ctx',{value:ctx});
    cache.table=domain.table('sessions');
    const list=new B9SessionList(ctx,10);
    async function sample(label){
      const before=counters(),start=performance.now();
      const rows=await list.list();
      const elapsed=performance.now()-start;
      assert.equal(rows.length,records.length);
      for(const row of rows){
        assert.equal(row.blank,true);assert.equal(row.running,false);assert.equal(row.agentAvailable,false);
        const expected=mode==='metadata'?(row.sessionId===ids[0]&&label==='external-rename'?'Other '+ids[0]:title(row.sessionId)):'Observed '+row.sessionId+' '+revisions.get(row.sessionId);
        assert.equal(row.projections.values.title,expected);
      }
      const changes=diff(before);
      assert.equal(changes.checkpointWrites,0,'listing must not rewrite checkpoints');
      assert.equal(changes.observeSession,changes.disposeObservation);
      const first=label==='warmup', changed=label==='external-rename', shrunk=label==='shrink-to-one';
      const expectedRead=first ? 500 : changed ? 1 : 0;
      const expectedObserve=mode==='metadata' ? 0 : first ? 500 : label==='one-revision-changed' ? 1 : 0;
      assert.equal(changes.readRecord,expectedRead,`${label}: read only changed JSON`);
      assert.equal(changes.recordSchemaParses,expectedRead,`${label}: parse only changed JSON`);
      assert.equal(changes.statRecord,shrunk ? 1 : 500,`${label}: one stat per cold record`);
      // A cold record with no reusable hint is stat'ed by observeSession itself, so the first list adds none.
      assert.equal(changes.persistenceStat,mode==='fallback' && !first ? records.length : 0);
      assert.equal(changes.observeSession,expectedObserve,`${label}: reuse unchanged log revisions`);
      assert.equal(list.coldHints.size,mode==='fallback' ? records.length : 0);
      const row={label,elapsedMs:elapsed,...changes,retainedHints:list.coldHints.size,rowCount:rows.length,rowsSha256:createHash('sha256').update(JSON.stringify(rows)).digest('hex')};
      console.log(JSON.stringify({mode,...row}));return row;
    }
    const group={mode,setupCounts:counters(),rows:[]};
    group.rows.push(await sample('warmup'));
    for(let i=0;i<5;i++)group.rows.push(await sample('sample-'+i));
    if(mode==='metadata'){
      const doc=document(ids[0]);doc.record.rows.title.val='Other '+ids[0];
      await writeFile(join(directory,ids[0]+'.replacement'),JSON.stringify(doc));
      await rename(join(directory,ids[0]+'.replacement'),join(directory,ids[0]+'.json'));
      group.rows.push(await sample('external-rename'));
    }else{
      revisions.set(ids[0],'r2');group.rows.push(await sample('one-revision-changed'));
      records=records.slice(0,1);group.rows.push(await sample('shrink-to-one'));
      // Two real list calls overlap. The older observation must not refill the newer map.
      let enter, release, paused=false;
      const entered=new Promise(resolve=>{enter=resolve;});
      const gate=new Promise(resolve=>{release=resolve;});
      beforeObserve=async(id)=>{if(id===ids[1]&&!paused){paused=true;enter();await gate;}};
      records=ids.slice(0,2).map(id=>({header:headers.get(id),formatStatus:'current'}));
      revisions.set(ids[1],'r3');
      const older=list.list();await entered;const olderMap=list.coldHints;
      records=records.slice(0,1);const newer=await list.list();const currentMap=list.coldHints;
      assert.equal(newer.length,1);assert.equal(currentMap.size,1);assert.notEqual(olderMap,currentMap);
      release();const olderRows=await older;
      assert.equal(olderRows.length,2);assert.equal(olderMap.size,2);
      assert.equal(list.coldHints,currentMap);assert.deepEqual([...currentMap.keys()],[ids[0]]);
      group.overlap={olderRows:olderRows.length,currentRows:newer.length,olderHints:olderMap.size,currentHints:currentMap.size};
      console.log('PASS overlapping list: late older observation stays in its own cold-hint map');
    }
    result.groups.push(group);
    await domain.close();schema.safeParse=originalParse;
  }
  if(output){await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(result,null,2)+'\n');}
  console.log('PASS 500 cold sessions: changed-record reads, revision reuse, visible-set bound and no write-back');
} finally {
  await owner.fiber.dispose();
  await rm(apiFile,{force:true});await rm(cacheFile,{force:true});
  for(const path of temporary)await rm(path,{recursive:true,force:true});
}
