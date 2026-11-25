import assert from 'node:assert/strict';
import timers from 'node:timers/promises';
import {syncBuiltinESMExports} from 'node:module';
let lockRetries=0;
const originalDelay=timers.setTimeout;
// Test clock: only the companion's 20 ms lock retry. Real locks and other timers remain intact.
timers.setTimeout=function(ms,...args){if(ms===20 && new Error().stack.includes('/dsh-go-deletion.mjs:')){lockRetries++;return Promise.resolve(args[0]);}return originalDelay.call(this,ms,...args);};
syncBuiltinESMExports();
export const name='schedule-run-cancel-probe';
export const inject=['schedule','agents','sessions','sessionController'];
export function apply(ctx){process.once('message',async msg=>{
 if(msg?.kind!=='run-probe')return;
 const steps=[];
 try{
  const created=await ctx.sessionController.create({sessionId:'synthetic-schedule-run-cancel',cwd:process.cwd()});
  const agent=ctx.agents.get(created.sessionId);assert.ok(agent);await ctx.sessions.flush(agent.session);
  const delivered=[];
  let abortOnDelivery;
  ctx.on('session/event',(session,event)=>{
   if(session!==agent.session || event.type!=='agent/inbox/spliced')return;
   for(const message of event.data.inserted)if(message.source?.kind==='schedule' && message.content?.some(block=>block.type==='text' && block.text.includes('SYNTHETIC_RUN_CANCEL'))){
    delivered.push(message.id);abortOnDelivery?.();
   }
  });
  const make=()=>ctx.schedule.remoteCreate({title:'Synthetic future task',prompt:'SYNTHETIC_RUN_CANCEL',timing:{kind:'after',after_seconds:86400},target:{kind:'session',sessionId:agent.id}},new AbortController().signal);
  const history=task=>ctx.schedule.history({id:task.id,limit:10});
  const early=await make(),earlyCancel=new AbortController(),earlyReason=new Error('already cancelled');earlyCancel.abort(earlyReason);
  await assert.rejects(ctx.schedule.run({id:early.id},earlyCancel.signal),error=>error===earlyReason);
  assert.equal((await history(early)).records.length,0);assert.equal(delivered.length,0);steps.push({case:'already-aborted',history:0,deliveries:0});
  const task=await make(),entered=Promise.withResolvers(),release=Promise.withResolvers();
  const detach=ctx.on('schedule/resolve-agent',async(id,next)=>{if(id===agent.id){entered.resolve();await release.promise;}return next();});
  const controller=new AbortController(),reason=new Error('ordinary run cancellation');
  const pending=ctx.schedule.run({id:task.id},controller.signal).then(value=>({value}),error=>({error}));
  await Promise.race([entered.promise,pending.then(()=>{throw new Error('run ended before public activation gate');})]);
  controller.abort(reason);release.resolve();const outcome=await pending;detach();
  const cancelledHistory=await history(task);
  steps.push({case:'cancel-during-activation',sameReason:outcome.error===reason,history:cancelledHistory.records.length,deliveries:delivered.length});
  assert.equal(outcome.error,reason);assert.equal(cancelledHistory.records.length,0);assert.equal(delivered.length,0);
  const normal=await ctx.schedule.run({id:task.id},new AbortController().signal);
  assert.equal(normal.scheduledAt,task.scheduledAt);assert.equal((await history(task)).records.length,1);assert.equal(delivered.length,1);
  const duplicate=await ctx.schedule.run({id:task.id},new AbortController().signal);assert.equal(duplicate.code,'schedule_execution_pending');
  steps.push({case:'normal-after-cancel',history:1,deliveries:1,duplicate:duplicate.code,scheduledAtUnchanged:true});
  const late=await make(),lateCancel=new AbortController();abortOnDelivery=()=>lateCancel.abort(new Error('after actual inbox enqueue'));
  const accepted=await ctx.schedule.run({id:late.id},lateCancel.signal);abortOnDelivery=undefined;
  assert.equal(lateCancel.signal.aborted,true);assert.equal(accepted.id,late.id);assert.equal((await history(late)).records.length,1);assert.equal(delivered.length,2);
  steps.push({case:'cancel-after-inbox-enqueue',history:1,deliveries:2,runAccepted:true});
  process.send?.({kind:'schedule-run-cancel-result',passed:true,steps,lockRetries});
 }catch(error){process.send?.({kind:'schedule-run-cancel-result',passed:false,error:{message:error.message,stack:error.stack},steps,lockRetries});}
});}
