import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
export async function fixture(prefix,words=8,bytes=96){
 const require=createRequire(join(resolve(prefix),'package.json'));
 const load=name=>import(pathToFileURL(require.resolve('@deepseek-ai/'+name)));
 const [{Context},{SessionStore},{SessionProjectionRegistry},api,{createUserMessage},{AgentRegistry}]=await Promise.all(['cordis','dsh-session','dsh-session-projection','dsh-session-title','dsh-llm','dsh-agent'].map(load));
 const ctx=new Context();await ctx.plugin(SessionStore);await ctx.plugin(SessionProjectionRegistry);await ctx.plugin(AgentRegistry);
 await ctx.plugin(api.SessionTitleService,{fallbackMaxWords:words,fallbackMaxBytes:bytes,maxTitleBytes:Math.max(bytes,120)});
 let serial=0;
 return {api,async title(text){
  const session=ctx.sessions.prepare('title-words-'+(++serial));const leave=ctx.sessions.enter(session);ctx.sessions.announce(session);
  try{
   session.append('user/message',createUserMessage({content:[{type:'text',text}],source:{kind:'user',rpcId:'title-words'}}),{surfaceOp:'append'});
   return await ctx.sessionTitle.refresh(session);
  }finally{await leave();}
 },close:()=>ctx.fiber.dispose()};
}
export async function splitWordsDuring(text,action){
 const original=String.prototype.split;const lengths=[];
 String.prototype.split=function(...args){const result=Reflect.apply(original,this,args);if(String(this)===text&&args[0]===' ')lengths.push(result.length);return result;};
 try{return{result:await action(),lengths};}finally{String.prototype.split=original;}
}
