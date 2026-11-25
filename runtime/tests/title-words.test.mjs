import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,splitWordsDuring} from '../tools/title-words-fixture.mjs';
const prefix=process.env.DSH_TEST_PREFIX??process.env.DSH_PREFIX;
async function run(fn,words=8,bytes=96){const f=await fixture(prefix,words,bytes);try{await fn(f);}finally{await f.close();}}
test('real first-human fallback limits materialized split words',()=>run(async f=>{
 const text=Array.from({length:10000},(_,i)=>'word'+i).join(' ');
 const {result,lengths}=await splitWordsDuring(text,()=>f.title(text));
 assert.equal(result.title,'word0 word1 word2 word3 word4 word5 word6 word7');assert.equal(result.source.kind,'fallback');assert.deepEqual(result.messageSeqs,[0]);
 console.log(JSON.stringify({case:'real-fallback',splitLengths:lengths}));assert(lengths.length>0);assert(lengths.every(n=>n<=8));
}));
test('empty and whitespace-only human messages have no fallback',()=>run(async f=>{for(const text of ['', ' \n\r\t ', '\u001b[31m\u001b[0m\u200e'])assert.equal(await f.title(text),undefined);}));
test('small exact and excess word counts retain public output',()=>run(async f=>{for(const [text,n,want] of [['one',1,'one'],['one two',2,'one two'],['one two three',2,'one two'],['',1,'']])assert.equal(f.api.fallbackSessionTitle(text,n,96),want);}));
test('whole-input cleaning keeps CRLF controls and Unicode behavior',()=>run(async f=>{
 const text=' \u001b]0;ignored\u0007中文\t🙂\r\né\u200e four five \u001b[31m six\u001b[0m';
 assert.equal(f.api.fallbackSessionTitle(text,4,96),'中文 🙂 é four');
 assert.equal((await f.title(text)).title,'中文 🙂 é four five six');
 assert.equal(f.api.fallbackSessionTitle('🙂 next',1,3),'');assert.equal(f.api.fallbackSessionTitle('🙂 next',1,4),'🙂');
 assert.equal(f.api.fallbackSessionTitle('\ud800 tail',1,3),'\ud800');
}));
test('legal word limits beyond uint32 do not wrap',()=>run(async f=>{for(const n of [0xffffffff,0x100000000,0x100000001,Number.MAX_SAFE_INTEGER,Number.MAX_VALUE])assert.equal(f.api.fallbackSessionTitle('one two three',n,96),'one two three');}));
test('public parameter failures preserve validation order',()=>run(async f=>{
 for(const n of [0,-1,1.5,NaN,Infinity])assert.throws(()=>f.api.fallbackSessionTitle(null,n,0),/maxWords must be a positive integer/);
 assert.throws(()=>f.api.fallbackSessionTitle(null,1,0),TypeError);
 assert.throws(()=>f.api.fallbackSessionTitle('valid text',1,0),/maxBytes must be a positive integer/);
}));
