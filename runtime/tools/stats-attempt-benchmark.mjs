// Actual registered stats projection with real admitted compact streams.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
const [prefix,label,scenario]=process.argv.slice(2);
const require=createRequire(resolve(prefix,'package.json'));
const {apply}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-stats')));
const {Session}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')));
const {AssistantStreamAccumulator}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
let def;apply({sessionProjections:{register(value){def=value;}}});
function stream(n,kind){const a=new AssistantStreamAccumulator();for(let i=0;i<n;i++)a.push({time:i,chunk:kind==='usage'?{type:'usage',usage:{outputTokens:0}}:{type:'text-delta',index:0,text:kind==='token'?'x':''}});a.push({time:n,chunk:{type:'finish',reason:{kind:'error',failure:{code:'NETWORK_ERROR',message:'retry'}}}});return a.snapshot();}
const known=scenario.startsWith('known'), mismatch=scenario==='mismatch';
const n=scenario==='known-tiny'||scenario==='unknown-token'?1:4096;
const kind=scenario==='known-usage'?'usage':scenario==='known-tiny'||scenario==='unknown-token'?'token':'empty';
const s=Session.create('stats-attempt-benchmark');let state=def.apply(def.init(),s.append('step/start',{turn:1,step:1}));
if(known||mismatch)state=def.apply(state,s.append('assistant/attempt',{turn:1,step:1,stream:stream(1,'token')}));
const event=s.append('assistant/attempt',{turn:1,step:mismatch?2:1,stream:stream(n,kind)});
const before=JSON.stringify(state),eventBefore=JSON.stringify(event);
const unchanged=known||mismatch||scenario==='unknown-empty';
const batch=n===1?100000:2000;
for(let sample=-3;sample<9;sample++){
 let matches=0,last;
 const start=performance.now();
 for(let i=0;i<batch;i++){last=def.apply(state,event);if(last===state)matches++;}
 const elapsedMs=performance.now()-start;
 assert.equal(matches,unchanged?batch:0);assert.equal(last.openStep.firstTokenTime,scenario==='unknown-empty'?null:0);
 assert.equal(JSON.stringify(state),before);assert.equal(JSON.stringify(event),eventBefore);def.stateSchema.parse(last);
 if(sample>=0)console.log(JSON.stringify({label,scenario,phase:'apply',members:n,records:event.data.stream.length,sample,batch,elapsedMs,usPerOperation:elapsedMs*1000/batch}));
}
