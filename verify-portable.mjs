import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const stage=path.dirname(fileURLToPath(import.meta.url));
const out=path.join(stage,'TradeLoom-desktop16-portable-win-x64');
const backup=process.env.DESKTOP16_BACKUP;
if(!backup)throw new Error('Set DESKTOP16_BACKUP.');
const machineHome=(process.env.DESKTOP16_SOURCE??'').replaceAll('\\','/').match(/^([A-Z]:\/Users\/[^/]+)/i)?.[1];
if(!machineHome)throw new Error('Set DESKTOP16_SOURCE to identify this build machine path for scanning.');
const hash=p=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const paths=[],links=[],sensitiveNames=[],suspectText=[],localPaths=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,e.name),r=path.relative(out,p).replaceAll('\\','/');if(e.isSymbolicLink()){links.push(r);continue;}if(e.isDirectory())walk(p);else if(e.isFile())paths.push({path:r,bytes:fs.statSync(p).size});}}
walk(out);
for(const f of paths){
  const name=path.basename(f.path);
  if(/^\.env(?:\.|$)|^(?:credentials|auth|session|cookies)\.(?:json|sqlite|db)$|^(?:id_rsa|id_ed25519)$|^\.npmrc$/i.test(name))sensitiveNames.push(f.path);
  if(f.bytes>8*1024*1024||!(/\.(?:js|cjs|mjs|json|yaml|yml|md|txt|xml|ini|cfg|ps1|cmd|bat|py|sh)$/i.test(name)))continue;
  const text=fs.readFileSync(path.join(out,f.path),'utf8');
  if(text.replace(/\\+/g,'/').toLowerCase().includes(machineHome.toLowerCase()))localPaths.push(f.path);
  if(/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\r?\n(?:[A-Za-z0-9+/=]{40,}\r?\n)+-----END|\b(?:sk-proj-|sk-ant-api03-)[A-Za-z0-9_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{30,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/.test(text))suspectText.push(f.path);
}
const shell=JSON.parse(fs.readFileSync(path.join(backup,'A-deployed-desktop16-shell/shell-bundle-manifest.json'),'utf8'));
const shellChecked=shell.sourceFiles.map(f=>{const p=path.join(out,'node_modules/@tradeloom/dsh-business-shell',f.path);if(hash(p)!==f.sha256)throw new Error('Shell mismatch '+f.path);return f.path;});
const engine=JSON.parse(fs.readFileSync(path.join(backup,'D-electron44-engine/engine-source-manifest.json'),'utf8'));
for(const f of engine.files)if(hash(path.join(out,'engine',f.path))!==f.sha256)throw new Error('Engine mismatch '+f.path);
const historical=JSON.parse(fs.readFileSync(path.join(backup,'B-deployed-desktop16-evidence/receipts/desktop-build-receipt.json'),'utf8'));
const mainHash=hash(path.join(out,'app/lib/main.js'));
const hostHash=hash(path.join(out,'node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js'));
if(mainHash!==historical.compiledFiles['apps/desktop/lib/main.js']||hostHash!==historical.compiledFiles['apps/desktop-host/lib/index.js'])throw new Error('Compiled historical receipt mismatch');
const sorted=shell.sourceFiles.map(f=>f.path).sort();
const digest=crypto.createHash('sha256');for(const f of sorted){digest.update(f);digest.update('\0');digest.update(fs.readFileSync(path.join(out,'node_modules/@tradeloom/dsh-business-shell',f)));}
const shellTreeHash=digest.digest('hex');if(shellTreeHash!==shell.copiedTreeHash)throw new Error('Shell aggregate mismatch');
const report={files:paths.length,bytes:paths.reduce((n,f)=>n+f.bytes,0),links,sensitiveNames,suspectText,localPaths,shellFilesVerified:shellChecked.length,shellTreeHash,engineFilesVerified:engine.files.length,mainHash,hostHash,compiledVerifiedAgainstHistoricalReceipt:true,scanScope:'text extensions <=8MiB plus all names; no values echoed',guiStarted:false};
fs.writeFileSync(path.join(stage,'preflight-verification.json'),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report));
if(links.length||sensitiveNames.length||suspectText.length||localPaths.length)process.exitCode=2;
