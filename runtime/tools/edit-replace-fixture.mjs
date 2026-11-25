import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
export async function fixture(prefix) {
  const require=createRequire(join(resolve(prefix),'package.json'));
  const {Context}=await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')));
  const {LocalFileSystem}=await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-fs-local')));
  const root=await mkdtemp(join(tmpdir(),'dsh-edit-count-'));
  const ctx=new Context();
  await ctx.plugin(LocalFileSystem,{cwd:root});
  const fs=ctx.fs;
  const target=await fs.resolve('file.txt');
  return {fs,target,
    reset: text=>writeFile(target.targetKey,text,'utf8'),
    read: ()=>readFile(target.targetKey,'utf8'),
    close: async()=>{await ctx.fiber.dispose();await rm(root,{recursive:true,force:true});},
  };
}
export async function observedEdit(f,edit,expected) {
  const original=String.prototype.indexOf;let calls=0;
  String.prototype.indexOf=function(needle,...args){
    if(needle===edit.oldString) calls++;
    return Reflect.apply(original,this,[needle,...args]);
  };
  try {return {result:await f.fs.editText(f.target,edit,expected),calls};}
  finally {String.prototype.indexOf=original;}
}
