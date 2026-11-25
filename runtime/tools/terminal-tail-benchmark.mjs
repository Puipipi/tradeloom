import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createFixture } from './terminal-tail-fixture.mjs';
const [prefix,label,scenario]=process.argv.slice(2);
const cap=256*1024;
const cases={tiny:['a'.repeat(64),cap,1000],exact:['a'.repeat(cap),cap,20],medium:['a'.repeat(cap*2),cap,3],large:['a'.repeat(3*1024*1024),cap,3],unicode:['中😀é'.repeat(300000),cap,3],multiline:[Array.from({length:5000},(_,i)=>String(i).padStart(6,'0')+'z'.repeat(58)).join('\n'),cap,20]};
const [text,max,iterations]=cases[scenario];
const request=scenario==='multiline'?{count:10,offset:5}:{count:1};
const selected=scenario==='multiline'?text.split('\n').slice(-15,-5).join('\n'):text;
const encoded=Buffer.from(selected);let start=Math.max(0,encoded.length-max);
while(start<encoded.length&&(encoded[start]&0xc0)===0x80)start++;
const expected=encoded.subarray(start).toString('utf8');
const f=await createFixture(prefix,text,max);
try{
 for(let sample=-3;sample<9;sample++){
  let result;const begin=performance.now();
  for(let i=0;i<iterations;i++)result=f.session.read(request);
  const elapsedMs=(performance.now()-begin)/iterations;
  assert.equal(result.text,expected);assert.equal(result.truncated,encoded.length>max);
  assert.equal(result.totalLines,scenario==='multiline'?5001:2);
  assert.equal(result.lineBegin,request.offset??0);assert.equal(result.lineEnd,(request.offset??0)+(expected?expected.split('\n').length:0));
  if(sample>=0)console.log(JSON.stringify({label,scenario,sample,iterations,inputBytes:Buffer.byteLength(text),maxReadBytes:max,elapsedMs,outputBytes:Buffer.byteLength(result.text)}));
 }
}finally{await f.close();}
