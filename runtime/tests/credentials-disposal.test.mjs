import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';import {tmpdir} from 'node:os';import {join} from 'node:path';import {pathToFileURL,fileURLToPath} from 'node:url';import {spawn} from 'node:child_process';
const p=process.env.DSH_PREFIX;
const {Context}=await import(pathToFileURL(`${p}/node_modules/@deepseek-ai/cordis/lib/index.js`));
const {LocalCredentialProvider,parseCredentialsDocument}=await import(pathToFileURL(`${p}/node_modules/@deepseek-ai/dsh-credentials-local/lib/index.js`));
const gate=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
for (const mode of ['set','modifyRecord','deleteRecord']) for (const dispose of [false,true]) test(`${mode}: ${dispose ? 'disposed' : 'active'} provider preserves a different process writer key`,async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'credential266-'));const path=join(root,'synthetic.yaml');const ctx=new Context();const plugin=ctx.plugin(LocalCredentialProvider,{path,watch:false});await plugin.await();await ctx.credentials.set('SYNTHETIC_SEED','synthetic-seed');
 const provider=ctx.credentials;await provider.modifyRecord('synthetic/item',async()=>({kind:'api-key',key:'synthetic-old'}));const entered=gate(),release=gate();const mkdir=fs.mkdir;let paused=false;
 t.mock.method(fs,'mkdir',async(...args)=>{const result=await mkdir(...args);if(!paused&&args[0]===root){paused=true;entered.resolve();await release.promise;}return result;});syncBuiltinESMExports();
 t.after(async()=>{release.resolve();t.mock.restoreAll();syncBuiltinESMExports();await plugin.dispose();await ctx.fiber.dispose();await fs.rm(root,{recursive:true,force:true});});
 let mutations=0;const write=mode==='set' ? provider.set('SYNTHETIC_A','synthetic-a') : mode==='deleteRecord' ? provider.deleteRecord('synthetic/item') : provider.modifyRecord('synthetic/item',async()=>{mutations++;return {kind:'api-key',key:'synthetic-new'};});const outcome=write.then(()=>({ok:true}),error=>({ok:false,error}));await entered.promise;
 const stopping=dispose ? plugin.dispose() : Promise.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(provider.closed,dispose);
 const child=spawn(process.execPath,[fileURLToPath(new URL('./credential-writer-fixture.mjs',import.meta.url)),path],{env:process.env,stdio:['ignore','pipe','pipe']});let errors='';child.stderr.on('data',b=>errors+=b);await new Promise((res,rej)=>{child.once('error',rej);child.once('exit',code=>code===0?res():rej(new Error(`writer exit ${code}: ${errors}`)));});
 assert.equal(parseCredentialsDocument(await fs.readFile(path,'utf8'),path).refs.get('SYNTHETIC_B'),'synthetic-b');release.resolve();const result=await outcome;await stopping;await assert.rejects(fs.stat(`${path}.lock`),e=>e.code==='ENOENT');
 const final=parseCredentialsDocument(await fs.readFile(path,'utf8'),path);assert.equal(final.refs.get('SYNTHETIC_B'),'synthetic-b',`writer B must survive accepted A operation; A fulfilled=${result.ok}`);
 assert.equal(result.ok,!dispose);if(dispose)assert.match(result.error.message,/disposed/);if(mode==='modifyRecord')assert.equal(mutations,dispose?0:1);
 const old=final.records.get('synthetic/item');if(dispose)assert.equal(old.key,'synthetic-old');else if(mode==='deleteRecord')assert.equal(old,undefined);
});
test('an already admitted record mutation keeps its held lock and drains on disposal',async t=>{
 const root=await fs.mkdtemp(join(tmpdir(),'credential266-drain-'));const path=join(root,'synthetic.yaml');const ctx=new Context();const plugin=ctx.plugin(LocalCredentialProvider,{path,watch:false});await plugin.await();const provider=ctx.credentials;const entered=gate(),release=gate();
 t.after(async()=>{release.resolve();await plugin.dispose();await ctx.fiber.dispose();await fs.rm(root,{recursive:true,force:true});});
 const writing=provider.modifyRecord('synthetic/item',async()=>{entered.resolve();await release.promise;return {kind:'api-key',key:'synthetic-accepted'};});await entered.promise;
 let stopped=false;const stopping=plugin.dispose().then(()=>stopped=true);await new Promise(resolve=>setImmediate(resolve));assert.equal(stopped,false);assert.equal(provider.closed,true);
 release.resolve();await writing;await stopping;assert.equal(parseCredentialsDocument(await fs.readFile(path,'utf8'),path).records.get('synthetic/item').key,'synthetic-accepted');
});
