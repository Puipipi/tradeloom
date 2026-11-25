// DSH_PREFIX=/absolute/prepared-prefix node --test runtime/tests/subprocess-spill-short.test.mjs
import test from 'node:test';import assert from 'node:assert/strict';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {fileURLToPath} from 'node:url';
const execute=promisify(execFile),fixture=fileURLToPath(new URL('./fixtures/subprocess-spill-short-child.mjs',import.meta.url));
// A small environment: the engine writes it into a launch file, which has to fit under the limit.
const python='import resource,os,sys; limit=int(sys.argv[1]); resource.setrlimit(resource.RLIMIT_FSIZE,(limit,limit)); os.execv(sys.argv[2],sys.argv[2:])';
for(const mode of ['single','prior'])for(const limit of [1024,32768])test(`actual subprocess spill ${mode}; RLIMIT_FSIZE ${limit}`,{skip:process.platform!=='linux'},async t=>{
 const {stdout,stderr}=await execute('python3',['-c',python,String(limit),process.execPath,fixture,mode],{env:{PATH:process.env.PATH,DSH_PREFIX:process.env.DSH_PREFIX},timeout:10000,maxBuffer:1024*1024});const result=JSON.parse(stdout);t.diagnostic(JSON.stringify(result));
 assert.equal(result.first.outcome.exitCode,0);assert.equal(result.first.total,mode==='single'?8192:8832);assert.equal(result.first.text,'a'.repeat(mode==='single'?64:1024));
 if(limit===1024){assert(result.writes.some(w=>w.written>0&&w.written<w.requested),'actual kernel short write observed');assert.equal((result.intermediate??result.first).spillPath,undefined,'incomplete spill cannot be advertised while active or after exit');assert.equal(result.first.spillPath,undefined);assert.equal(result.firstFiles.length,1,'failure disables spill retries for subsequent bytes');assert(result.firstFiles.every(f=>f.size===null),'unpublished partial spill discarded');assert(result.writes.some(w=>w.error==='EFBIG'));assert.equal(result.reports.length,1,'one failure report through real Cordis exporter');assert.equal(result.reports[0].code,'EFBIG');}
 else{assert.equal(result.first.spillBytes,result.first.total);assert.equal(result.first.completeContentMatches,true);assert.equal(result.reports.length,0);}
 assert.equal(result.recovery.outcome.exitCode,0);assert.equal(result.recovery.spillBytes,128);assert.equal(result.recovery.fullText,'r'.repeat(128));
});
