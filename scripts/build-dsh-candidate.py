#!/usr/bin/env python3
"""Assemble a complete, offline, isolated Windows candidate from a supported recipe.

No installer, application, database or service is run. The explicit external
data directory is written into the new launcher config, never opened or copied.
See docs/DSH-基座升级-runbook.md for the required program-only inputs.
"""
from pathlib import Path
import argparse,hashlib,importlib.util,json,os,shutil,stat,subprocess,sys,zipfile
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[1]

def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value

replay=module('fixed_dsh_replay',R/'scripts/replay-dsh-candidate.py')
writer=module('existing_program_inventory',R/'apps/tradeloom-launcher/scripts/write-candidate-program-zip.py')
sha=lambda data:hashlib.sha256(data).hexdigest()

def file_pin(path):
    size,digest=writer.file_pin(path);return {'bytes':size,'sha256':digest}

def inventory(root):
    replay.ordinary(root);rows=[]
    def visit(directory):
        for item in sorted(directory.iterdir()):
            info=item.lstat()
            if item.is_symlink() or getattr(info,'st_file_attributes',0)&0x400:raise ValueError(f'reparse input: {item}')
            if stat.S_ISDIR(info.st_mode):visit(item)
            elif stat.S_ISREG(info.st_mode):rows.append({'path':item.relative_to(root).as_posix(),**file_pin(item)})
            else:raise ValueError(f'non-ordinary input: {item}')
    visit(root);return rows

def codepoint_tree(rows):
    canonical=''.join(row['path']+'\0'+str(row['bytes'])+'\0'+row['sha256']+'\n' for row in sorted(rows,key=lambda row:row['path']))
    return {'fileCount':len(rows),'bytes':sum(row['bytes'] for row in rows),'sha256':sha(canonical.encode())}

def local_data_path(value):
    # This is a config value only. Do not stat/resolve/read the user's data tree.
    if len(value)<3 or value[0] not in 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz' or value[1]!=':' or value[2] not in '\\/':raise ValueError('data-root must be an explicit local absolute Windows directory')
    return Path(os.path.abspath(value))

def overlaps(a,b):
    a=str(a).rstrip('\\/').casefold();b=str(b).rstrip('\\/').casefold()
    return a==b or a.startswith(b+os.sep) or b.startswith(a+os.sep)

def deployment_metadata(program,recipe,desktop,resources,head,dirty,source_digest,patches):
    validator={key:program['nativeArtifactValidator'][key] for key in ['receiptSha256','nodeRelativePath','nodeSha256']}
    source={'shellMode':'source','appMainSha256':desktop['postimages']['lib/main.js']['sha256'],'lock':{'upstream':{**program['upstream'],'appAsar':recipe['officialInput']['appAsar']},'patches':patches,'nativeArtifactValidator':validator},'assemblyKind':'complete official binary program plus current repository recipes and own resources; not upstream source compilation','vendorVersion':recipe['version'],'vendorCommit':program['upstream']['commit'],'ownSourceHead':head,'ownSourceDirty':dirty,'ownSourceFilesSha256':source_digest}
    return {'schemaVersion':2,'deploymentMode':'packaged','runtime':program['runtime'],'resources':resources,'sourceBuild':source,'candidate':{'status':'isolated full candidate; not installed or accepted','dataRootSelectedExplicitly':True,'dataReadCreatedOrMigrated':False,'installerExecuted':False}}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version',required=True)
    parser.add_argument('--vendor-root',type=Path,required=True)
    parser.add_argument('--python-packages',type=Path,required=True)
    parser.add_argument('--postgresql',type=Path,required=True)
    parser.add_argument('--plugin-seed',type=Path,required=True)
    parser.add_argument('--data-root',required=True)
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--node',default='node')
    parser.add_argument('--compiler',type=Path,default=Path(os.environ.get('WINDIR','C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    args=parser.parse_args()
    if os.name!='nt':raise ValueError('this fixed program recipe targets Windows x64')
    if '/' in args.version or '\\' in args.version or args.version in ['.','..']:raise ValueError('invalid version')
    K=R/'apps/tradeloom-launcher/dsh-upgrades'/args.version
    if not (K/'program-recipe.json').is_file():raise ValueError('unsupported complete-program recipe; review the upstream difference first')
    recipe=replay.load(K/'recipe.json');program_recipe=replay.load(replay.safe(K,recipe['programRecipe']))
    if program_recipe['schemaVersion']!=1 or recipe['version']!=args.version or program_recipe['version']!=args.version:raise ValueError('recipe version mismatch')
    vendor=args.vendor_root.absolute();py=args.python_packages.absolute();pg=args.postgresql.absolute();seed=args.plugin_seed.absolute()
    out=args.output_root.absolute();data_root=local_data_path(args.data_root)
    if out.exists():raise ValueError('output root must not exist; no installed program is overwritten')
    if any(overlaps(out,p) for p in [R,vendor,py,pg,seed,data_root]):raise ValueError('output must be separate from all inputs and external data')
    if any(overlaps(data_root,p) for p in [R,vendor,py,pg,seed]):raise ValueError('external data must be separate from program/source inputs')
    ancestor=out.parent
    while not ancestor.exists():ancestor=ancestor.parent
    replay.ordinary(ancestor)
    for path in [vendor,py,pg,seed,args.compiler]:replay.ordinary(path)
    if py.name!='python-packages' or pg.name!='postgresql':raise ValueError('only named program dependency directories are accepted')
    # Reject an installed/custom tree before enumerating it.
    executable=program_recipe['vendor']['executable']
    if file_pin(replay.safe(vendor,executable))!=program_recipe['vendor']['executablePin']:raise ValueError('official executable preimage mismatch')
    if file_pin(vendor/'resources/app.asar')!=recipe['officialInput']['appAsar']:raise ValueError('official ASAR preimage mismatch')
    vendor_rows=inventory(vendor)
    if codepoint_tree(vendor_rows)!={key:program_recipe['vendor'][key] for key in ['fileCount','bytes','sha256']}:raise ValueError('complete official program tree drift')
    payloads={}
    for key,root in [('pythonDependencies',py),('postgresql',pg)]:
        rows=inventory(root);actual=writer.tree(rows);expected=program_recipe['programResources'][key]
        if actual!={'files':expected['fileCount'],'bytes':expected['bytes'],'sha256':expected['sha256']}:raise ValueError(f'program dependency tree drift: {key}')
        payloads[key]=(root,rows)
    replay.ordinary(seed/'seed-manifest.json')
    seed_bytes=(seed/'seed-manifest.json').read_bytes();seed_meta=program_recipe['pluginSeed']
    if len(seed_bytes)!=seed_meta['manifestBytes'] or sha(seed_bytes)!=seed_meta['manifestSha256']:raise ValueError('sealed program seed manifest drift')
    seed_manifest=json.loads(seed_bytes)
    for field,count in [('files',seed_meta['files']),('appendBundles',seed_meta['appendBundles']),('dependencies',seed_meta['dependencies']),('links',seed_meta['linksDeclaredOnly'])]:
        if len(seed_manifest[field])!=count:raise ValueError(f'seed declaration drift: {field}')
    if '@tradeloom/dsh-business-shell' in seed_manifest['dependencies']:raise ValueError('seed must not overwrite the current business-shell')
    seed_rows=inventory(seed);seed_by={row['path']:row for row in seed_rows}
    if set(seed_by)!={'seed-manifest.json',*[row['path'] for row in seed_manifest['files']]}:raise ValueError('seed contains unlisted program files')
    for row in seed_manifest['files']:
        replay.safe(seed,row['path'])
        if seed_by[row['path']]!={key:row[key] for key in ['path','bytes','sha256']}:raise ValueError(f'seed file drift: {row["path"]}')
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip()
    out.mkdir(parents=True);evidence=out/'evidence';evidence.mkdir();product=out/'program';product.mkdir()
    sources={};source_bytes={};origins={}
    def read_source(relative,target=None):
        path=replay.safe(R,relative);replay.ordinary(path);data=path.read_bytes()
        row=sources.setdefault(relative,{'sourcePath':relative,**replay.pin(data),'targets':[]})
        if replay.pin(data)!={key:row[key] for key in ['bytes','sha256']}:raise ValueError(f'source changed during assembly: {relative}')
        if target is not None and target not in row['targets']:row['targets'].append(target)
        source_bytes[relative]=data;return data
    def run(name,command,cwd=out):
        result=subprocess.run([str(arg) for arg in command],cwd=cwd,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
        (evidence/(name+'.stdout.log')).write_bytes(result.stdout);(evidence/(name+'.stderr.log')).write_bytes(result.stderr)
        replay.write_json(evidence/(name+'.command.json'),{'command':[str(arg) for arg in command],'cwd':str(cwd),'actualExitCode':result.returncode})
        if result.returncode:raise RuntimeError(f'{name} failed; output retained, not installed')
        return result
    def copy(source,target,origin,expected=None):
        destination=replay.safe(product,target)
        if destination.exists():raise ValueError(f'overlapping program source: {target}')
        replay.ordinary(source);destination.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(source,destination)
        actual=file_pin(destination)
        if expected is not None and actual!=expected:raise ValueError(f'program copy drift: {target}')
        origins[target]=origin;return actual
    for path in [Path(__file__).resolve(),R/'apps/tradeloom-launcher/scripts/write-candidate-program-zip.py']:
        read_source(path.relative_to(R).as_posix())
    # The complete source archive includes the reviewed outer acquisition path.
    # Its execution is proven by update-receipt.json, not by mere inclusion here.
    for name in ['entry','signatureScript','applyScript']:read_source(program_recipe['acquisition'][name])
    replay_root=out/'replay'
    run('fixed-replay',[sys.executable,'-B',R/'scripts/replay-dsh-candidate.py','--source',vendor/'resources/app.asar','--unpacked',vendor/'resources/app.asar.unpacked','--output-root',replay_root,'--node',args.node])
    for row in replay.load(replay_root/'source-manifest.json')['sourceFiles']:
        if replay.pin(read_source(row['sourcePath'],row.get('target')))!={key:row[key] for key in ['bytes','sha256']}:raise ValueError('replay source drift')
    for row in vendor_rows:
        relative=row['path']
        if relative=='resources/app.asar':continue
        target='app/'+('织贸助手.exe' if relative==executable else relative)
        copy(replay.safe(vendor,relative),target,{'kind':'official-unchanged','inputRelativePath':relative},{key:row[key] for key in ['bytes','sha256']})
    copy(out/'replay/app.asar','app/resources/app.asar',{'kind':'official-plus-versioned-recipes'},{key:recipe['expectedAsar'][key] for key in ['bytes','sha256']})
    for key,folder in [('pythonDependencies','python-packages'),('postgresql','postgresql')]:
        root,rows=payloads[key]
        for row in rows:copy(replay.safe(root,row['path']),'app/resources/tradeloom/'+folder+'/'+row['path'],{'kind':'pinned-program-dependency','component':key,'inputRelativePath':row['path']},{key:row[key] for key in ['bytes','sha256']})
    for row in seed_rows:copy(replay.safe(seed,row['path']),'app/resources/tradeloom/plugin-seed/'+row['path'],{'kind':'sealed-program-seed','inputRelativePath':row['path']},{key:row[key] for key in ['bytes','sha256']})
    backend=[]
    for relative in program_recipe['backendSources']:
        target='app/resources/tradeloom/backend/'+relative;data=read_source(relative,target)
        copy(replay.safe(R,relative),target,{'kind':'current-repository-source','sourcePath':relative},replay.pin(data));backend.append({'path':relative,**replay.pin(data)})
    shell_root=out/'replay/business-shell';shell_rows=inventory(shell_root)
    for row in shell_rows:copy(replay.safe(shell_root,row['path']),'app/resources/tradeloom/business-shell/'+row['path'],{'kind':'current-business-recipe','sourcePath':recipe['businessShell']['sourceRoot']+'/'+row['path']},{key:row[key] for key in ['bytes','sha256']})
    launcher=program_recipe['launcher'];launcher_root=out/'launcher-source';launcher_root.mkdir()
    original=read_source(launcher['source'],'启动工作台.exe');patch=read_source((K/launcher['patch']).relative_to(R).as_posix(),'启动工作台.exe')
    if replay.pin(original)!=launcher['preimage']:raise ValueError('launcher source preimage drift')
    (launcher_root/'Program.cs').write_bytes(original)
    run('launcher-patch',['git','-c','core.autocrlf=false','-c','core.eol=lf','apply','--whitespace=nowarn',K/launcher['patch']],launcher_root)
    if file_pin(launcher_root/'Program.cs')!=launcher['postimage']:raise ValueError('launcher derived source drift')
    compiler_pin=file_pin(args.compiler)
    run('launcher-compile',[args.compiler,'/nologo','/target:winexe','/platform:x64','/optimize+','/utf8output','/codepage:65001','/reference:System.Web.Extensions.dll','/reference:System.Windows.Forms.dll','/out:'+str(product/'启动工作台.exe'),launcher_root/'Program.cs'])
    origins['启动工作台.exe']={'kind':'compiled-repository-source','sourcePath':launcher['source'],'patch':launcher['patch'],'compiler':compiler_pin}
    config=json.loads(read_source(launcher['configSource'],'launcher.json'));config.update(schemaVersion=2,dataDirectory=str(data_root))
    replay.write_json(product/'launcher.json',config);origins['launcher.json']={'kind':'derived-launcher-config','sourcePath':launcher['configSource'],'dataSelection':'explicit external root, not read or created'}
    marker=product/'app/resources/tradeloom/.tradeloom-bootstrap-owned';marker.write_bytes(b'tradeloom-bootstrap-v1\n');origins[marker.relative_to(product).as_posix()]={'kind':'bootstrap-owned-marker'}
    node=replay.safe(product,'app/'+program_recipe['runtime']['node'])
    if file_pin(node)['sha256']!=program_recipe['runtime']['nodeSha256']:raise ValueError('official runtime Node identity mismatch')
    source_rows=[]
    tracked=set(subprocess.check_output(['git','ls-files','-z'],cwd=R).decode().split('\0'))
    for row in sources.values():row['targets'].sort();row['tracked']=row['sourcePath'] in tracked;source_rows.append(row)
    source_rows.sort(key=lambda row:row['sourcePath']);source_digest=sha(json.dumps(source_rows,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
    backend_tree=writer.tree(backend);shell_tree=writer.tree(shell_rows)
    business=recipe['businessShell']['inventory']
    if shell_tree!={'files':business['fileCount'],'bytes':business['bytes'],'sha256':business['sha256']}:raise ValueError('final business tree mismatch')
    resources={'business':{'root':'resources/tradeloom/backend','fileCount':len(backend),'bytes':backend_tree['bytes'],'sha256':backend_tree['sha256'],'files':backend},'businessShell':{'root':'resources/tradeloom/business-shell','name':'@tradeloom/dsh-business-shell','version':replay.load(shell_root/'package.json')['version'],**business},'primaryRuntime':{key:program_recipe['runtime'][key] for key in ['root','python','version','providedBy']},**program_recipe['programResources']}
    metadata=deployment_metadata(program_recipe,recipe,replay.load(K/'desktop-recipe.json'),resources,head,bool(subprocess.check_output(['git','status','--porcelain'],cwd=R)),source_digest,{p.name:sha(p.read_bytes()) for p in sorted(K.iterdir()) if p.is_file()})
    replay.write_json(product/'app/resources/tradeloom/deployment.json',metadata);origins['app/resources/tradeloom/deployment.json']={'kind':'fresh-complete-deployment-metadata','sourceFilesSha256':source_digest}
    manifest_check="import {validateInstalledManifest} from "+json.dumps((R/'apps/tradeloom-launcher/installed-bootstrap.mjs').as_uri())+";import {readFile} from 'node:fs/promises';validateInstalledManifest(JSON.parse(await readFile(process.argv[1],'utf8')));console.log(JSON.stringify({actualInstalledManifestValid:true,bootstrapStarted:false}));"
    run('installed-manifest-contract',[args.node,'--input-type=module','-e',manifest_check,product/'app/resources/tradeloom/deployment.json'])
    # Reuse the exact original-validator invocation already used by fixed replay.
    import ast
    tree=ast.parse(read_source('scripts/replay-dsh-candidate.py').decode('utf-8-sig'));entry=next(n for n in tree.body if isinstance(n,ast.FunctionDef) and n.name=='main')
    validate=next(n.value.value for n in entry.body if isinstance(n,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='validate' for t in n.targets))
    result=run('installed-business-nativefs',[args.node,'--input-type=module','-e',validate,R/'apps/tradeloom-launcher/installed-bootstrap.mjs',product/'app/resources/tradeloom/business-shell',product/'app/resources/tradeloom/deployment.json'])
    actual=json.loads(result.stdout)
    if {key:actual[key] for key in ['fileCount','bytes','sha256']}!=business:raise ValueError('installed original validator mismatch')
    for relative,data in source_bytes.items():
        if replay.safe(R,relative).read_bytes()!=data:raise ValueError(f'concurrent source change: {relative}')
    if subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip()!=head:raise ValueError('source HEAD changed during assembly')
    asar=module('complete_asar_reader',R/'apps/tradeloom-launcher/scripts/write-n01-origin-candidate.py')
    raw=(product/'app/resources/app.asar').read_bytes();header,offset=asar.parse_asar(raw);logical=[]
    for name,entry in asar.walk_asar_files(header):
        payload=file_pin(replay.safe(product/'app/resources/app.asar.unpacked',name)) if entry.get('unpacked') else replay.pin(raw[offset+int(entry['offset']):offset+int(entry['offset'])+entry['size']])
        logical.append({'entry':name,**payload,'metadata':entry})
    replay.write_json(out/'asar-entry-manifest.json',{'appAsar':file_pin(product/'app/resources/app.asar'),'entries':logical,'provenance':'fixed replay receipts and current source-manifest map every overlaid entry; remaining entries are official preimages'})
    del raw
    source_manifest={'schemaVersion':1,'head':head,'dirty':metadata['sourceBuild']['ownSourceDirty'],'sourceFilesSha256':source_digest,'sourceFiles':source_rows,'derivedLauncher':launcher['postimage'],'compiler':compiler_pin,'upstreamInput':program_recipe['upstream'],'inputTrees':{'vendor':codepoint_tree(vendor_rows),'pythonDependencies':program_recipe['programResources']['pythonDependencies'],'postgresql':program_recipe['programResources']['postgresql'],'programSeedManifest':seed_meta['manifestSha256']}}
    replay.write_json(out/'source-manifest.json',source_manifest)
    rows=inventory(product)
    if {row['path'] for row in rows}!=set(origins):raise ValueError('unaccounted program output')
    if sorted(p.name for p in product.iterdir())!=sorted(program_recipe['output']['programOnlyTopLevel']):raise ValueError('program-only layout drift')
    entries=[{**row,'origin':origins[row['path']]} for row in rows]
    replay.write_json(out/'program-entry-manifest.json',{'schemaVersion':1,'zipRoot':program_recipe['output']['zipRoot'],'files':entries,'tree':writer.tree(rows)})
    archive=out/(program_recipe['output']['zipRoot']+'.zip')
    with zipfile.ZipFile(archive,'x',zipfile.ZIP_DEFLATED,allowZip64=True) as z:
        for row in rows:z.write(replay.safe(product,row['path']),program_recipe['output']['zipRoot']+'/'+row['path'])
    with zipfile.ZipFile(archive) as z:
        if len(z.infolist())!=len(rows):raise ValueError('program ZIP entry count mismatch')
        for row in rows:
            data=z.read(program_recipe['output']['zipRoot']+'/'+row['path'])
            if replay.pin(data)!={key:row[key] for key in ['bytes','sha256']}:raise ValueError('program ZIP readback mismatch')
    with zipfile.ZipFile(out/'current-source.zip','x',zipfile.ZIP_DEFLATED) as z:
        for row in source_rows:z.writestr(row['sourcePath'],source_bytes[row['sourcePath']])
        z.writestr('derived/Program.cs',(launcher_root/'Program.cs').read_bytes())
        z.writestr('source-manifest.json',(out/'source-manifest.json').read_bytes())
    with zipfile.ZipFile(out/'current-source.zip') as z:
        if len(z.infolist())!=len(source_rows)+2:raise ValueError('source ZIP entry count mismatch')
        for row in source_rows:
            if replay.pin(z.read(row['sourcePath']))!={key:row[key] for key in ['bytes','sha256']}:raise ValueError('source ZIP readback mismatch')
        if replay.pin(z.read('derived/Program.cs'))!=launcher['postimage'] or z.read('source-manifest.json')!=(out/'source-manifest.json').read_bytes():raise ValueError('derived source ZIP readback mismatch')
    receipt={'schemaVersion':1,'status':'complete isolated program assembled and byte-read-back; not launched or installed','version':args.version,'programRoot':str(product),'programZip':file_pin(archive),'sourceZip':file_pin(out/'current-source.zip'),'sourceFilesSha256':source_digest,'sourceFiles':len(source_rows),'programEntries':len(rows),'programTree':writer.tree(rows),'appAsar':file_pin(product/'app/resources/app.asar'),'businessShell':business,'compiler':compiler_pin,'dataRootSelection':str(data_root),'dataReadCreatedOrMigrated':False,'installerExecuted':False,'applicationStarted':False,'channelDiscoveryOrDownloadExecuted':False,'acquisitionEntry':program_recipe['acquisition']['entry'],'unsupportedVersionPolicy':'stop before assembly; require a reviewed version recipe; never drop own overlays or run official installer'}
    replay.write_json(out/'build-receipt.json',receipt);print(json.dumps(receipt))

if __name__=='__main__':main()
