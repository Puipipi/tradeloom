import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,expectedView,numberedDuring,notice} from '../tools/editor-view-fixture.mjs';
const prefix=process.env.DSH_TEST_PREFIX??process.env.DSH_PREFIX;
async function use(cap,body){const f=await fixture(prefix,cap);try{await body(f);}finally{await f.close();}}
function check(result,expected){assert.equal(result.isError,false);assert.equal(result.content[0].text,expected);assert.equal(result.value,expected);}
test('large view stops numbering after exact retained prefix',()=>use(16000,async f=>{
 const text='hello row\n'.repeat(10000);await f.reset(text);const expected=expectedView(f.path,text,f.cap);
 const {result,calls}=await numberedDuring(()=>f.view());check(result,expected);assert.equal(f.observations,1);
 console.log(JSON.stringify({lines:10001,padStartCalls:calls}));assert.ok(calls<1000);
}));
test('empty trailing-newline CRLF and Unicode file text stay exact',()=>use(16000,async f=>{
 for(const text of ['', 'a\n','a\r\nb\r\n','中🙂é\nnext']){await f.reset(text);check(await f.view(),expectedView(f.path,text,f.cap));}
}));
test('small and explicit ranges keep numbering and total-line header',()=>use(16000,async f=>{
 const text='a\nb\nc\n';await f.reset(text);
 for(const range of [undefined,[2,3],[3,-1]]){const expected=expectedView(f.path,text,f.cap,range);const {result,calls}=await numberedDuring(()=>f.view(range));check(result,expected);assert.equal(calls,range===undefined?4:2);}
}));
test('clipping UTF16 boundaries header-only and long first lines match exact oracle',async()=>{
 for(const cap of [1,110,120,128,129,130,256])await use(cap,async f=>{
  for(const text of ['中🙂é'.repeat(300),'a'.repeat(5000)+'\nlast','x\n'.repeat(100)]){await f.reset(text);check(await f.view(),expectedView(f.path,text,cap));}
 });
});
test('exact cap and cap one short distinguish clipping marker',async()=>{
 await use(16000,async base=>{
  const text='abc\nxyz';const full=expectedView(base.path,text,16000);
  // Temporary paths have equal length, so the same output cap hits the same boundary.
  for(const cap of [full.length,full.length-1,full.indexOf('     1'),full.indexOf('     2')])await use(cap,async f=>{
   assert.equal(f.path.length,base.path.length);await f.reset(text);const expected=expectedView(f.path,text,cap);check(await f.view(),expected);
   assert.equal(expected.endsWith(notice),cap<full.length);
  });
 });
});
test('invalid view range still errors even when the header alone exceeds cap',()=>use(1,async f=>{
 await f.reset('a\nb');
 for(const range of [[0,1],[1,3],[2,1],[1]]){const result=await f.view(range);assert.equal(result.isError,true);assert.match(result.content[0].text,/view_range/);}
}));

test('cuts inside and after a valid surrogate pair preserve original UTF16 rule',async()=>{
 await use(16000,async base=>{
  const text='A🙂B'.repeat(100);const full=expectedView(base.path,text,16000);const emoji=full.indexOf('🙂');
  for(const cap of [emoji+1,emoji+2])await use(cap,async f=>{
   assert.equal(f.path.length,base.path.length);await f.reset(text);
   const expected=expectedView(f.path,text,cap);check(await f.view(),expected);
   const kept=expected.slice(0,-notice.length);assert.equal(/[\uD800-\uDBFF]$/.test(kept),false);
  });
 });
});
