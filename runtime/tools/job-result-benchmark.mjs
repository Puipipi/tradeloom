import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {load,fixture} from './job-result-fixture.mjs';
const [prefix,label,scenario,baseline]=process.argv.slice(2);
const cases={
 'output-tiny':['output',{text:'a'.repeat(64)},1000],
 'output-large':['output',{text:'a'.repeat(131072)},80],
 'output-unicode':['output',{text:'中'.repeat(32768)},80],
 'output-over':['output',{text:'a'.repeat(1048576)},8],
 'output-unlimited':['output',{text:'a'.repeat(131072),cap:null},80],
 'notice-tiny':['notice',{label:'a'.repeat(64)},500],
 'notice-large':['notice',{label:'中'.repeat(32768)},50],
 'notice-over':['notice',{label:'中'.repeat(400000),cap:256},3],
 'notice-unlimited':['notice',{label:'中'.repeat(32768),cap:null},50],
 'notice-min':['notice',{label:'long label',cap:1},500],
};
const [phase,options,iterations]=cases[scenario];
const expectedFixture=fixture(await load(baseline),options);
const select=f=>{const {message}=f.notice();f.messages.length=0;return{content:message.content,source:message.source};};
const expected=phase==='output'?await expectedFixture.output():select(expectedFixture);
const f=fixture(await load(prefix),options);
for(let sample=-3;sample<9;sample++){
 let result;const begin=performance.now();
 if(phase==='output'){for(let i=0;i<iterations;i++)result=await f.output();}
 else{for(let i=0;i<iterations;i++)result=select(f);}
 const elapsedMs=(performance.now()-begin)/iterations;
 assert.deepEqual(result,expected);
 if(sample>=0)console.log(JSON.stringify({label,scenario,sample,iterations,elapsedMs,textBytes:Buffer.byteLength(options.text??options.label),cap:options.cap===null?null:options.cap??262144}));
}
