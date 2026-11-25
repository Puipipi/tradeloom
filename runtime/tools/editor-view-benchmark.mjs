import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fixture,expectedView} from './editor-view-fixture.mjs';
const [prefix,label,name]=process.argv.slice(2);
const row='abcdefghijklmnopqrstuvwxyz0123456789-0123456789\n';
const cases={
 tiny:{text:'abc\nxyz',cap:16000,n:16},
 many:{text:row.repeat(10000),cap:16000,n:6},
 large:{text:row.repeat(100000),cap:16000,n:2},
 unicode:{text:'中文🙂é hello world\n'.repeat(50000),cap:16000,n:4},
 range:{text:row.repeat(100000),cap:16000,n:3,range:[90000,90010]},
 longline:{text:'a'.repeat(3*1024*1024),cap:16000,n:3},
 uncapped:{text:row.repeat(10000),cap:2000000,n:4},
};
const c=cases[name];if(!c)throw Error(name);
const f=await fixture(prefix,c.cap);let sink=0;
try{
 await f.reset(c.text);
 // Keep only an independent expected output string, not an oracle-owned full view.
 const expected=Buffer.from(expectedView(f.path,c.text,c.cap,c.range),'utf16le').toString('utf16le');
 async function once(){const start=performance.now();const result=await f.view(c.range);const elapsed=performance.now()-start;assert.equal(result.isError,false);assert.equal(result.value,expected);assert.equal(result.content[0].text,expected);sink+=result.value.length;return elapsed;}
 for(let i=0;i<c.n;i++)await once();
 for(let sample=0;sample<9;sample++){let ms=0;for(let i=0;i<c.n;i++)ms+=await once();console.log(JSON.stringify({label,case:name,sample,iterations:c.n,us:ms*1000/c.n,inputBytes:Buffer.byteLength(c.text),cap:c.cap,sink}));}
 assert.equal(f.observations,10*c.n);
}finally{await f.close();}
