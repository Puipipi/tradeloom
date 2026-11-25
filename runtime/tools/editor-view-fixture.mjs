import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
export const notice='<response clipped><NOTE>To save on context only part of this file has been shown to you. You should retry this tool after you have searched inside the file with `grep -n` in order to find the line numbers of what you are looking for.</NOTE>';
export function expectedView(path,text,cap,range){
 const all=text.split('\n');let selected=all;let start=1;
 let prompt=`Here's the content of ${path} with line numbers (which has a total of ${all.length} lines)`;
 if(range!==undefined){start=range[0];selected=range[1]===-1?all.slice(start-1):all.slice(start-1,range[1]);prompt+=` with view_range=[${start}, ${range[1]}]`;}
 const full=prompt+':\n'+selected.map((line,i)=>`${String(start+i).padStart(6,' ')}  ${line}`).join('\n')+'\n';
 if(full.length<=cap)return full;
 let end=cap;const last=full.charCodeAt(end-1);if(last>=0xd800&&last<=0xdbff)end--;
 return full.slice(0,end)+notice;
}
export async function fixture(prefix,cap=16000){
 const require=createRequire(join(resolve(prefix),'package.json'));
 const load=async name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
 const [{Context},{SystemPrompt},{ToolRuntime},{LocalFileSystem},api,native]=await Promise.all(['cordis','dsh-system-prompt','dsh-tools','dsh-fs-local','dsh-tool-str-replace-editor','dsh-tool-executor-native'].map(load));
 const root=await mkdtemp(join(tmpdir(),'dsh-view-format-'));const path=join(root,'file.txt');
 const ctx=new Context();await ctx.plugin(SystemPrompt,{});await ctx.plugin(ToolRuntime,{});await ctx.plugin(native);await ctx.plugin(LocalFileSystem,{cwd:root});
 await ctx.plugin({inject:['tools','fs'],apply(scope){api.apply(scope,{maxOutputChars:cap});}});
 let observations=0;ctx.on('fs/observed',()=>{observations++;});
 return {ctx,path,cap,get observations(){return observations;},reset:text=>writeFile(path,text,'utf8'),
  async view(range){const batch=await ctx.tools.execute({calls:[{id:'view-fixture',name:'str_replace_editor',arguments:JSON.stringify({command:'view',path,...(range===undefined?{}:{view_range:range})})}],signal:new AbortController().signal});return batch.results[0].result;},
  close:async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});},
 };
}
export async function numberedDuring(action){
 const original=String.prototype.padStart;let calls=0;
 String.prototype.padStart=function(...args){if(args[0]===6&&args[1]===' ')calls++;return Reflect.apply(original,this,args);};
 try{return{result:await action(),calls};}finally{String.prototype.padStart=original;}
}
