import {readFileSync,writeFileSync,appendFileSync,mkdirSync,existsSync,symlinkSync,openSync,fsyncSync,closeSync,renameSync} from 'node:fs';
import {join,basename} from 'node:path';
const root=process.env.FIXTURE_CONTROL_ROOT,mode=process.env.FIXTURE_MODE,generation=process.env.FIXTURE_GENERATION;
const args=process.argv.slice(2),dir=process.cwd();
const atomic=(path,text)=>{const tmp=path+'.fixture-'+process.pid;const fd=openSync(tmp,'w',0o600);try{writeFileSync(fd,text);fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);};
const record=(name,data)=>atomic(join(root,name),JSON.stringify(data)+'\n');
const stat=readFileSync('/proc/self/stat','utf8');const startTicks=Number(stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]);
appendFileSync(join(root,'commands.jsonl'),JSON.stringify({pid:process.pid,ppid:process.ppid,startTicks,generation,args,cwd:dir})+'\n');
const waitFor=async path=>{while(!existsSync(path))await new Promise(r=>setTimeout(r,20));};
if(args[0]==='config'&&args[1]==='get'&&args[2]==='registry'){
 console.log('https://registry.fixture.invalid/');process.exit(0);
}
if(args[0]!=='add')throw Error('fixture refuses unexpected command');
const spec=args[1].replace(/^(?:file|link):/,'');const manifest=JSON.parse(readFileSync(join(spec,'package.json'),'utf8'));
mkdirSync(join(dir,'node_modules'),{recursive:true});
const target=join(dir,'node_modules',manifest.name);if(!existsSync(target))symlinkSync(spec,target,'dir');
function mutate(stage){
 const profile=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
 profile.dependencies={...profile.dependencies,[manifest.name]:'file:'+spec};
 profile.wave10FixtureStage=stage;
 atomic(join(dir,'package.json'),JSON.stringify(profile,null,2)+'\n');
 atomic(join(dir,'pnpm-lock.yaml'),"lockfileVersion: '9.0'\n# synthetic package-manager fixture "+stage+"\n");
 record('written-'+generation+'-'+stage+'.json',{pid:process.pid,ppid:process.ppid,stage,name:manifest.name});
}
mutate(generation==='original'?'phase1':'successor');
if(mode==='failure'||generation==='successor'){
 console.error('synthetic package manager failure after complete writes');process.exit(17);
}
if(mode!=='hold')throw Error('unknown mode');
record('old-pm-ready.json',{pid:process.pid,ppid:process.ppid,stage:'phase1'});
await waitFor(join(root,'write-phase2'));mutate('phase2');
record('old-pm-phase2-ack.json',{pid:process.pid,ppid:process.ppid,stage:'phase2',noFurtherProfileWrites:true});
await waitFor(join(root,'release-old-pm'));record('old-pm-released.json',{pid:process.pid});process.exit(0);
