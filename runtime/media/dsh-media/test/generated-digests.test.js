import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareImageStore } from '../src/storage.js';
import { queryGeneratedDigest, verifyGeneratedDigest } from '../src/generated-digests.js';
const rid='m_01234567-89ab-4cde-8012-3456789abcde',date='2026-10-28',sessionId='digest-session';
const data=Buffer.from([1,2,3,4]);
async function fixture(t, hook=()=>{}) {
 const root=await mkdtemp(join(tmpdir(),'media-digest-'));t.after(()=>rm(root,{recursive:true,force:true}));const cwd=join(root,'work'),state=join(root,'state');await mkdir(cwd);
 const policy={cwd,workspaceRoot:cwd,mode:'workspace-write'};
 const indexPath=join(state,'works',date,rid+'.json');
 const store=await prepareImageStore({authorizeWorkspace:async()=>{await hook(indexPath);return policy},hostStateDir:state,rid,date});
 return {cwd,state,indexPath,store,makeMeta:path=>({v:1,rid,kind:'image',status:'done',items:[{path,mime:'image/png',width:1,height:1,bytes:data.length}],request:{n:1},prompt:'fixture'})};
}
async function files(path){let list;try{list=await readdir(path,{withFileTypes:true})}catch(e){if(e.code==='ENOENT')return[];throw e}return(await Promise.all(list.map(e=>e.isDirectory()?files(join(path,e.name)):[join(path,e.name)]))).flat();}
test('same owned snapshot is written and digested despite caller mutation after stage call',async t=>{
 const f=await fixture(t);const mutable=Buffer.from(data);const pending=f.store.stage(mutable,'png');mutable.fill(9);const path=await pending;
 const meta=f.makeMeta(path);await f.store.commit(meta,{sessionId,createdAt:date});const record=JSON.parse(await readFile(f.indexPath));
 assert.deepEqual(await readFile(path),data);assert.deepEqual(record.contentDigests,[{bytes:4,sha256:createHash('sha256').update(data).digest('hex')}]);
 assert.deepEqual(record.media,meta);const selector={sessionId,rid,path};assert.equal(queryGeneratedDigest(record,selector).status,'available');assert.equal(verifyGeneratedDigest(record,selector,await readFile(path)).status,'match');
 await writeFile(path,Buffer.from([4,3,2,1]));assert.equal(verifyGeneratedDigest(record,selector,await readFile(path)).status,'mismatch');
 assert.equal(verifyGeneratedDigest(record,{...selector,sessionId:'other'},data).status,'unknown');
 assert.equal(verifyGeneratedDigest(record,{...selector,path:path+'-other'},data).status,'unknown');
});
test('old and malformed private records stay unknown, never mutate/backfill',()=>{
 const path='/synthetic/work.png';const original={schemaVersion:1,rid,sessionId,media:{v:1,rid,kind:'image',status:'done',items:[{path,bytes:4}]}};const selector={sessionId,rid,path};
 for(const contentDigests of [undefined,[],[{bytes:4,sha256:'bad'}],[{bytes:3,sha256:'0'.repeat(64)}],[{bytes:4,sha256:'A'.repeat(64)}]]) {
  const record={...original,...contentDigests===undefined?{}:{contentDigests}};const before=JSON.stringify(record);assert.equal(queryGeneratedDigest(record,selector).status,'unknown');assert.equal(verifyGeneratedDigest(record,selector,data).status,'unknown');assert.equal(JSON.stringify(record),before);
 }
});
test('digest pairing checks every item and rejects duplicate or missing index entries',()=>{
 const path='/synthetic/work.png',digest={bytes:4,sha256:createHash('sha256').update(data).digest('hex')};
 const index={schemaVersion:1,rid,sessionId,media:{v:1,rid,kind:'image',status:'done',items:[{path,bytes:4},{path,bytes:4}]},contentDigests:[digest,digest]};
 assert.equal(queryGeneratedDigest(index,{sessionId,rid,path}).status,'unknown');index.media.items[1].path+='.other';index.contentDigests.pop();assert.equal(queryGeneratedDigest(index,{sessionId,rid,path}).status,'unknown');
});
test('failed original publication leaves no private digest record',async t=>{
 const f=await fixture(t);const path=await f.store.stage(data,'png');await writeFile(path,'foreign');await assert.rejects(f.store.commit(f.makeMeta(path),{sessionId,createdAt:date}));assert.equal(await f.store.abort(),true);assert.deepEqual(await files(f.state),[]);assert.equal(await readFile(path,'utf8'),'foreign');
});
test('failed index publication preserves foreign index but removes staged digest/original',async t=>{
 const f=await fixture(t);const path=await f.store.stage(data,'png');await writeFile(f.indexPath,'foreign');await assert.rejects(f.store.commit(f.makeMeta(path),{sessionId,createdAt:date}));assert.equal(await f.store.abort(),true);assert.deepEqual(await files(f.cwd),[]);assert.equal(await readFile(f.indexPath,'utf8'),'foreign');
});
test('revocation after index publication rolls digest record and original back together',async t=>{
 let published=false;const f=await fixture(t,async index=>{try{await readFile(index);published=true;throw Error('revoked')}catch(e){if(e.code!=='ENOENT')throw e}});const path=await f.store.stage(data,'png');await assert.rejects(f.store.commit(f.makeMeta(path),{sessionId,createdAt:date}));assert.equal(published,true);assert.equal(await f.store.abort(),true);assert.deepEqual(await files(f.state),[]);assert.deepEqual(await files(f.cwd),[]);
});
