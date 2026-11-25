import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFixture } from '../tools/terminal-tail-fixture.mjs';
const prefix = process.env.DSH_PREFIX;
test('actual backend read avoids expanding the full long line to a character array', async () => {
  const text='x'.repeat(300000); const f=await createFixture(prefix,text,32);
  const original=Array.from;let calls=0;let result;
  try {
    Array.from=function(value,...args){if(value===text)calls++;return Reflect.apply(original,this,[value,...args]);};
    result=f.session.read({count:1});
  } finally {Array.from=original;await f.close();}
  assert.deepEqual(result,{text:'x'.repeat(32),totalLines:2,lineBegin:0,lineEnd:1,truncated:true});
  assert.equal(calls,0,'old whole-string Array.from calls, not all scanning work');
});
test('below and exactly at byte budget keep complete ASCII text', async () => {
  for(const max of [6,7]){const f=await createFixture(prefix,'abcdef',max);try{assert.equal(f.session.read({count:1}).text,'abcdef');assert.equal(f.session.read({count:1}).truncated,false);}finally{await f.close();}}
});
test('UTF8 two three and four byte suffixes remain whole on both budget sides', async () => {
  for(const [text,max,expected] of [['xé',2,'é'],['xé',1,''],['x中',3,'中'],['x中',2,''],['x😀',4,'😀'],['x😀',3,''],['xé中😀',7,'中😀'],['xé中😀',8,'中😀']]){
    const f=await createFixture(prefix,text,max);try{const r=f.session.read({count:1});assert.equal(r.text,expected);assert.equal(r.truncated,true);assert.equal(r.lineEnd,expected?1:0);}finally{await f.close();}
  }
});
test('line offset count and newline boundaries preserve public reply metadata', async () => {
  const f=await createFixture(prefix,'abc\ndef\nghi',5);try{
    assert.deepEqual(f.session.read({offset:1,count:2}),{text:'c\ndef',totalLines:4,lineBegin:1,lineEnd:3,truncated:true});
    assert.deepEqual(f.session.read({offset:8,count:2}),{text:'',totalLines:4,lineBegin:8,lineEnd:8,truncated:false});
  }finally{await f.close();}
});
test('terminal decoder replacement and valid surrogate pair output remain exact', async () => {
  const f=await createFixture(prefix,'x\ud800😀',7);try{assert.equal(f.session.read({count:1}).text,'\ufffd😀');}finally{await f.close();}
});
test('invalid public read bounds remain errors', async () => {
  const f=await createFixture(prefix,'abcdef',4);try{
    for(const offset of [-1,0.5,NaN])assert.throws(()=>f.session.read({offset}),/non-negative safe integer/);
    for(const count of [0,-1,0.5])assert.throws(()=>f.session.read({count}),/positive safe integer/);
  }finally{await f.close();}
});
