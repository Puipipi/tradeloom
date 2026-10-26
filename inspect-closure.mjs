import fs from 'node:fs';
import path from 'node:path';
const runtime = process.env.DESKTOP16_SOURCE;
if(!runtime)throw new Error('Set DESKTOP16_SOURCE to the audited desktop16 runtime.');
const seen = new Map(), missing = [], edges = [];
function locate(from, name) {
  for(let d=from;;d=path.dirname(d)) {
    const p=path.join(d,'node_modules',name,'package.json');
    if(fs.existsSync(p)) return fs.realpathSync(path.dirname(p));
    if(path.dirname(d)===d) return null;
  }
}
function visit(input) {
  const dir=fs.realpathSync(input);
  if(seen.has(dir)) return;
  const m=JSON.parse(fs.readFileSync(path.join(dir,'package.json'),'utf8'));
  const record={name:m.name,version:m.version,source:path.relative(runtime,dir).replaceAll('\\','/'),license:m.license??null,files:m.files??null,dependencies:[]};
  seen.set(dir,record);
  const deps={...m.dependencies,...m.peerDependencies,...m.optionalDependencies};
  for(const [name,specifier] of Object.entries(deps)) {
    const optional=!!m.optionalDependencies?.[name] || !!m.peerDependenciesMeta?.[name]?.optional;
    const target=locate(dir,name);
    if(!target){missing.push({from:m.name,name,specifier,optional});continue;}
    record.dependencies.push(name);
    edges.push({from:record.source,name,to:path.relative(runtime,target).replaceAll('\\','/')});
    visit(target);
  }
}
for(const rel of ['apps/cli','apps/desktop-host','apps/desktop']) visit(path.join(runtime,rel));
const packages=[...seen.values()].sort((a,b)=>a.name.localeCompare(b.name));
const report={runtime,roots:['apps/cli','apps/desktop-host','apps/desktop'],packages,edges,missing,summary:{packages:packages.length,missingRequired:missing.filter(x=>!x.optional).length,missingOptional:missing.filter(x=>x.optional).length}};
fs.writeFileSync(new URL('./dependency-inventory.json',import.meta.url),JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report.summary));
console.log(JSON.stringify(missing));
