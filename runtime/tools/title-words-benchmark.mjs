import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {fixture} from './title-words-fixture.mjs';
const [prefix,label,name]=process.argv.slice(2);
const cases={
 tiny:{text:'hello there',want:'hello there',words:8,bytes:96,n:20},
 many:{text:'alpha beta gamma delta '.repeat(10000),want:'alpha beta gamma delta alpha beta gamma delta',words:8,bytes:96,n:4},
 large:{text:'alpha beta gamma delta '.repeat(100000),want:'alpha beta gamma delta alpha beta gamma delta',words:8,bytes:96,n:2},
 unicode:{text:'中文 🙂 é test\r\n'.repeat(20000),want:'中文 🙂 é test 中文 🙂 é test',words:8,bytes:96,n:3},
 oneword:{text:'x'.repeat(1024*1024),want:'x'.repeat(96),words:8,bytes:96,n:3},
 uncapped:{text:'alpha beta gamma delta '.repeat(1000),want:'alpha beta gamma delta '.repeat(1000).trim(),words:5000,bytes:100000,n:5},
 hugecap:{text:'alpha beta gamma delta '.repeat(1000),want:'alpha beta gamma delta '.repeat(1000).trim(),words:0x100000000,bytes:100000,n:5},
};
const c=cases[name];if(!c)throw Error(name);const f=await fixture(prefix,c.words,c.bytes);let sink=0;
try{
 async function once(){const begin=performance.now();const result=await f.title(c.text);const ms=performance.now()-begin;assert.equal(result.title,c.want);assert.equal(result.source.kind,'fallback');assert.deepEqual(result.messageSeqs,[0]);sink+=result.title.length;return ms;}
 for(let i=0;i<c.n;i++)await once();
 for(let sample=0;sample<9;sample++){let ms=0;for(let i=0;i<c.n;i++)ms+=await once();console.log(JSON.stringify({label,case:name,sample,iterations:c.n,us:ms*1000/c.n,inputBytes:Buffer.byteLength(c.text),words:c.words,cap:c.bytes,sink}));}
}finally{await f.close();}
