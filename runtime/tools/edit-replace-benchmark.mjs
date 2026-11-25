import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fixture} from './edit-replace-fixture.mjs';
const [prefix,label,name]=process.argv.slice(2);
const cases={
  tiny:{text:'a needle b',needle:'needle',replacement:'ok',all:true,n:12},
  many:{text:'needle::'.repeat(8192),needle:'needle',replacement:'value',all:true,n:8},
  large:{text:'needle::'.repeat(262144),needle:'needle',replacement:'value',all:true,n:2},
  unicode:{text:'中🙂é::'.repeat(32768),needle:'中🙂é',replacement:'新🙂',all:true,n:4},
  single:{text:'a'.repeat(65536)+'needle',needle:'needle',replacement:'value',all:false,n:8},
  ambiguous:{text:'needle::'.repeat(8192),needle:'needle',replacement:'value',all:false,n:8,error:'FS_AMBIGUOUS_EDIT'},
  missing:{text:'a'.repeat(65536),needle:'needle',replacement:'value',all:true,n:8,error:'FS_EDIT_NOT_FOUND'},
};
const c=cases[name];if(!c)throw Error(name);
const f=await fixture(prefix);let sink=0;
const expected=c.text.replaceAll(c.needle,c.replacement);
async function once(){
  await f.reset(c.text);
  const start=performance.now();
  let result,error;
  try{result=await f.fs.editText(f.target,{oldString:c.needle,newString:c.replacement,replaceAll:c.all});}
  catch(e){error=e;}
  const elapsed=performance.now()-start;
  if(c.error){assert.equal(error?.code,c.error);assert.equal(await f.read(),c.text);sink++;}
  else{assert.ifError(error);assert.equal(result.before,c.text);assert.equal(result.after,expected);assert.equal(await f.read(),expected);sink+=result.after.length;}
  return elapsed;
}
try{
  for(let i=0;i<c.n;i++)await once();
  for(let sample=0;sample<9;sample++){
    let ms=0;for(let i=0;i<c.n;i++)ms+=await once();
    console.log(JSON.stringify({label,case:name,sample,iterations:c.n,us:ms*1000/c.n,inputBytes:Buffer.byteLength(c.text),sink}));
  }
}finally{await f.close();}
