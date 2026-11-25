import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture,observedEdit} from '../tools/edit-replace-fixture.mjs';
const prefix=process.env.DSH_TEST_PREFIX ?? process.env.DSH_PREFIX;
async function withFile(fn){const f=await fixture(prefix);try{await fn(f);}finally{await f.close();}}
test('replace-all eliminates old indexOf traversal through real editText',()=>withFile(async f=>{
  const text='needle::'.repeat(1000);await f.reset(text);
  const {result,calls}=await observedEdit(f,{oldString:'needle',newString:'replacement',replaceAll:true});
  assert.equal(result.before,text);assert.equal(result.after,'replacement::'.repeat(1000));
  assert.equal(await f.read(),result.after);console.log(JSON.stringify({case:'many',indexOfCalls:calls}));
  assert.equal(calls,0);
}));
test('literal non-overlap boundaries Unicode CRLF and dollar text',()=>withFile(async f=>{
  for(const [text,oldString,newString,expected] of [
    ['aaaa','aa','$&','$&$&'],['aaaa','aaa','x','xa'],
    ['needleXXneedle','needle','$`', '$`XX$`'],
    ['中🙂中🙂','中🙂','é','éé'],['a\r\nb\r\na\r\nb','a\r\nb','x\r\ny','x\r\ny\r\nx\r\ny'],
    ['needle','needle','',''],
  ]){await f.reset(text);const result=await f.fs.editText(f.target,{oldString,newString,replaceAll:true});
    assert.equal(await f.read(),expected);assert.equal(result.after,expected.replaceAll('\r\n','\n'));}
}));
test('false single match retains original traversal',()=>withFile(async f=>{
  await f.reset('prefix needle suffix');
  const {result,calls}=await observedEdit(f,{oldString:'needle',newString:'ok',replaceAll:false});
  assert.equal(calls,2);assert.equal(result.after,'prefix ok suffix');
}));
test('false ambiguity and zero-match preserve exact errors and bytes',()=>withFile(async f=>{
  for(const [text,oldString,replaceAll,code,message] of [
    ['needle needle needle','needle',false,'FS_AMBIGUOUS_EDIT','old_string matched 3 times'],
    ['unchanged','needle',true,'FS_EDIT_NOT_FOUND','old_string was not found'],
    ['','needle',true,'FS_EDIT_NOT_FOUND','old_string was not found'],
    ['unchanged','',true,'FS_EDIT_NOT_FOUND','old_string must be a non-empty string'],
  ]){await f.reset(text);await assert.rejects(f.fs.editText(f.target,{oldString,newString:'x',replaceAll}),e=>e.code===code&&e.message.includes(message));assert.equal(await f.read(),text);}
}));
test('stale version refuses before literal matching and publication',()=>withFile(async f=>{
  await f.reset('needle');const info=await f.fs.stat(f.target);await f.reset('longer needle');
  await assert.rejects(f.fs.editText(f.target,{oldString:'needle',newString:'x',replaceAll:true},{version:info.version}),{code:'FS_STALE_VERSION'});
  assert.equal(await f.read(),'longer needle');
}));
