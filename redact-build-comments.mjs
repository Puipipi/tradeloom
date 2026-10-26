import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const stage=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(stage,'TradeLoom-desktop16-portable-win-x64');
const inventory=JSON.parse(fs.readFileSync(path.join(stage,'preflight-verification.json'),'utf8'));
const changes=[],remaining=[];
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const local=/(?:[A-Z]:[\\/]+Users[\\/]+[^\\/\s"']+|[A-Z]:\\\\Users\\\\[^\\\s"']+)/i;
for(const rel of inventory.localPaths){
  const p=path.join(root,rel);if(!fs.existsSync(p))continue;
  const before=fs.readFileSync(p,'utf8');
  let removed=0;
  const after=before.split(/(?<=\n)/).filter(line=>{if(local.test(line)&&/^\s*\/\/#region\b/.test(line)){removed++;return false;}return true;}).join('');
  if(local.test(after)){remaining.push(rel);continue;}
  if(removed){fs.writeFileSync(p,after);changes.push({path:rel,removedCommentLines:removed,before:hash(before),after:hash(after)});}
}
fs.writeFileSync(path.join(stage,'comment-redaction-receipt.json'),JSON.stringify({scope:'Only complete //#region build comment lines containing development machine path. No executable statements changed.',changes,remaining},null,2)+'\n');
console.log(JSON.stringify({changedFiles:changes.length,removedCommentLines:changes.reduce((n,c)=>n+c.removedCommentLines,0),remaining}));
if(remaining.length)process.exitCode=2;
