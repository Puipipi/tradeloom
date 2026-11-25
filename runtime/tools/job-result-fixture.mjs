import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
export async function load(prefix){const require=createRequire(resolve(prefix,'package.json'));return import(pathToFileURL(require.resolve('@deepseek-ai/dsh-tool-jobs')));}
export function fixture(api,{text='',cap=262144,label='label',kind='task',id=kind+'-0123456789abcdef',lossy=false,channels,spillPaths=[],delivery='quiet'}={}){
 const tools=new Map();const hooks=new Map();const messages=[];let listener;let mode;
 let offset=lossy?100:0;const chunks=(channels??(text?[{text,channel:'stdout'}]:[])).map(chunk=>{const out={...chunk,at:offset};offset+=Buffer.byteLength(chunk.text);return out;});
 const job={id,kind,label,owner:'fixture-owner',status:'completed',startedAt:1,finishedAt:2,output:{total:offset,earliest:lossy?100:0,spillPaths},...(cap===null?{}:{outputLimitBytes:cap})};
 const owner={id:'fixture-owner',status:'busy',inject(message){mode='inject';messages.push(message);},followup(message){mode='followup';messages.push(message);}};
 const read={job,chunks,lossy};
 const ctx={tools:{register(tool){tools.set(tool.name,tool);}},on(name,callback){hooks.set(name,callback);},systemPrompt:{section(){},getSectionOrder(){return 0;}},get(name){return name==='agents'?{get:id=>id===owner.id?owner:undefined}:undefined;},jobs:{attachController(){},events:{subscribe(_filter,fn){listener=fn;}},list(){return[job];},read(id){if(id!==job.id)throw new Error('fixture unknown id');return read;},async kill(){return'already-finished';}}};
 api.apply(ctx,{completionDelivery:delivery});
 const args={job_id:id};const exec={name:'job_output',arguments:args,agent:owner};
 return {job,owner,tools,messages,hooks,
  async output(){const tool=tools.get('job_output');await hooks.get('tools/pre-execute')(exec,()=>{});const value=await tool.execute(args,exec);const content=tool.output.render(args,value);return tool.finalizeContent(exec,{content,value,isError:false})??content;},
  final(content,{name='job_output',isError=true}={}){return tools.get(name).finalizeContent({name,arguments:args,agent:owner},{content,isError});},
  notice(extra={}){listener({type:'settled',job,awaited:false,cause:'producer',...extra});const message=messages.at(-1);return{message,mode};},
 };
}
export async function encodedDuring(action){const original=TextEncoder.prototype.encode;let calls=0,bytes=0;TextEncoder.prototype.encode=function(...args){const out=Reflect.apply(original,this,args);calls++;bytes+=out.byteLength;return out;};try{return{value:await action(),calls,bytes};}finally{TextEncoder.prototype.encode=original;}}
