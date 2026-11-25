import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const require = createRequire(resolve(process.env.DSH_PREFIX, 'package.json'));
const { apply } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session-stats')));
const { Session } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-session')));
const { AssistantStreamAccumulator, createAssistantMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')));
let definition;
apply({ sessionProjections: { register(value) { definition = value; } } });
function stream(texts, start = 10) {
  const a = new AssistantStreamAccumulator();
  for (let i=0;i<texts.length;i++) a.push({time:start+i,chunk:{type:'text-delta',index:0,text:texts[i]}});
  a.push({time:start+texts.length,chunk:{type:'usage',usage:{outputTokens:0}}});
  a.push({time:start+texts.length+1,chunk:{type:'finish',reason:{kind:'error',failure:{code:'NETWORK_ERROR',message:'retry'}}}});
  return a.snapshot();
}
function prepare(first = ['first'], next = Array(64).fill('')) {
  const s = Session.create('stats-attempt');
  const start = s.append('step/start',{turn:1,step:1});
  let state = definition.apply(definition.init(),start);
  if (first !== null) state = definition.apply(state,s.append('assistant/attempt',{turn:1,step:1,stream:stream(first,0)}));
  const event = s.append('assistant/attempt',{turn:1,step:1,stream:stream(next)});
  return {s,state,event};
}
function visits(stream,action) {
  const original=Array.prototype[Symbol.iterator];let records=0;
  Array.prototype[Symbol.iterator]=function(){
    const iterator=Reflect.apply(original,this,[]);
    if(this!==stream)return iterator;
    return {next(){const r=iterator.next();if(!r.done)records++;return r;},[Symbol.iterator](){return this;}};
  };
  try{return {value:action(),records};}finally{Array.prototype[Symbol.iterator]=original;}
}
test('already known token skips later accepted attempt stream and returns identical state',()=>{
  const {state,event}=prepare(); const before=JSON.stringify(state);
  assert.equal(state.openStep.firstTokenTime,0);
  const r=visits(event.data.stream,()=>definition.apply(state,event));
  assert.equal(r.value,state);assert.equal(JSON.stringify(state),before);
  assert.equal(r.records,0,'old stream record visits removed, not total CPU instructions');
});
test('unknown first token still scans packed empty members and uses exact first time',()=>{
  const {state,event}=prepare(null,['','','token']);
  const r=visits(event.data.stream,()=>definition.apply(state,event));
  assert.equal(r.records,1);assert.equal(r.value.openStep.firstTokenTime,12);
  assert.equal(state.openStep.firstTokenTime,null);
});
test('empty packed and usage-only attempts keep unknown token and original state',()=>{
  for(const values of [[],['','','']]){
    const {state,event}=prepare(null,values);
    const r=visits(event.data.stream,()=>definition.apply(state,event));
    assert.equal(r.value,state);assert.equal(r.records,values.length?3:2);
  }
});
test('wrong turn or step and no open step do not inspect the stream',()=>{
  const {s,state}=prepare();
  for(const [turn,step] of [[2,1],[1,2]]){
    const event=s.append('assistant/attempt',{turn,step,stream:stream(['x'])});
    const r=visits(event.data.stream,()=>definition.apply(state,event));
    assert.equal(r.records,0);assert.equal(r.value,state);
  }
  const event=s.append('assistant/attempt',{turn:1,step:1,stream:stream(['x'])});
  const initial=definition.init();assert.equal(definition.apply(initial,event),initial);
});
test('later attempts cannot replace first token; final wire totals remain exact',t=>{
  t.mock.timers.enable({apis:['Date'],now:100});
  const s=Session.create('stats-totals');let state=definition.apply(definition.init(),s.append('step/start',{turn:1,step:1}));
  for(const time of [110,130,150])state=definition.apply(state,s.append('assistant/attempt',{turn:1,step:1,stream:stream(['token'],time)}));
  t.mock.timers.tick(100);
  state=definition.apply(state,s.append('assistant/message',{turn:1,step:1,message:createAssistantMessage({source:{provider:'p',model:'m'},content:[{type:'text',text:'done'}]}),usage:{outputTokens:4},stream:stream(['done'],180)},{surfaceOp:'append'}));
  state=definition.apply(state,s.append('step/end',{turn:1,step:1}));
  assert.deepEqual(definition.wire.view(state),{turns:1,steps:1,llmMs:100,toolMs:0,ttftMs:10,ttftSteps:1,decodeMs:90,decodeTokens:4});
});
test('new step clears the token and replay of admitted snapshot matches live fold',()=>{
  const {s,state,event}=prepare();let live=definition.apply(state,event);
  live=definition.apply(live,s.append('step/end',{turn:1,step:1}));
  live=definition.apply(live,s.append('step/start',{turn:1,step:2}));assert.equal(live.openStep.firstTokenTime,null);
  live=definition.apply(live,s.append('assistant/attempt',{turn:1,step:2,stream:stream(['new'],30)}));
  const restored=Session.fromRestore(s.id,JSON.parse(JSON.stringify(s.snapshotEvents())),JSON.parse(JSON.stringify(s.header)),0,'detached');
  let replay=definition.init();for(const e of restored.snapshotEvents())replay=definition.apply(replay,e);
  assert.deepEqual(replay,live);assert.equal(replay.openStep.firstTokenTime,30);
});
