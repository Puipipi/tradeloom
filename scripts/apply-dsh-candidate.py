#!/usr/bin/env python3
"""Replace one stopped, explicitly identified TradeLoom program at the same path.

Only app/ and the wrapper executable are payload. launcher.json bytes and every
data directory remain untouched. Backups are kept outside the program root.
"""
from pathlib import Path
import argparse,ast,hashlib,importlib.util,json,os,shutil,subprocess,sys
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('complete_program',R/'scripts/build-dsh-candidate.py')
build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
WRAPPER='启动工作台.exe'
RUNTIME_LOG='启动工作台.log'

def pin(path):return build.file_pin(path)
def load(path):
    build.replay.ordinary(path);return build.replay.load(path)
def save(path,value):
    temporary=path.with_suffix('.next.json')
    build.replay.ordinary(path.parent)
    if temporary.exists() or temporary.is_symlink():build.replay.ordinary(temporary)
    temporary.write_text(json.dumps(value,ensure_ascii=True,indent=2)+'\n',encoding='utf-8')
    os.replace(temporary,path)

def manifest(path,expected_sha):
    build.replay.ordinary(path)
    if pin(path)['sha256']!=expected_sha:raise ValueError('reviewed manifest SHA256 mismatch')
    value=load(path);rows=value['files'];seen=set()
    if value['schemaVersion']!=1:raise ValueError('unsupported program manifest')
    for row in rows:
        relative=row['path'];build.replay.safe(Path('.'),relative)
        if relative not in ['launcher.json',WRAPPER] and not relative.startswith('app/'):raise ValueError('manifest contains a non-program entry')
        if relative.casefold() in seen:raise ValueError('duplicate program path')
        seen.add(relative.casefold())
    if not {'launcher.json',WRAPPER,'app/resources/tradeloom/deployment.json'}<=seen:raise ValueError('incomplete program manifest')
    return value

def app_rows(value):return [{**row,'path':row['path'][4:]} for row in value['files'] if row['path'].startswith('app/')]
def verify_app(root,rows):
    actual={row['path']:{k:row[k] for k in ['bytes','sha256']} for row in build.inventory(root)}
    expected={row['path']:{k:row[k] for k in ['bytes','sha256']} for row in rows}
    if actual!=expected:raise ValueError('program app payload/collection differs from reviewed manifest')

def config_identity(target):
    raw=(target/'launcher.json').read_bytes();config=json.loads(raw)
    if set(config)!={'schemaVersion','dataDirectory','hostPort','djangoPort','postgresPort'} or type(config['schemaVersion']) is not int or (config['hostPort'],config['djangoPort'],config['postgresPort'])!=(3088,3090,55432):raise ValueError('unrecognized TradeLoom launcher config')
    if config['schemaVersion']==1 and config['dataDirectory']=='data-ui-r2':data=target/'data-ui-r2'
    elif config['schemaVersion']==2:
        data=build.local_data_path(config['dataDirectory'])
        if build.overlaps(data,target):raise ValueError('schema2 data must remain external')
    else:raise ValueError('unsupported launcher schema/data selection')
    return raw,data

def recognized(target):
    build.replay.ordinary(target);build.replay.ordinary(target/'launcher.json')
    raw,data=config_identity(target)
    marker=target/'app/resources/tradeloom/.tradeloom-bootstrap-owned'
    build.replay.ordinary(marker)
    if marker.read_bytes()!=b'tradeloom-bootstrap-v1\n':raise ValueError('target is not an identified TradeLoom program')
    metadata=load(target/'app/resources/tradeloom/deployment.json')
    if metadata.get('deploymentMode')!='packaged' or metadata.get('schemaVersion')!=2:raise ValueError('target lacks TradeLoom packaged identity')
    return raw,data

def owned_processes(roots):
    script=r'''$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop;$roots=ConvertFrom-Json -InputObject $env:TRADELOOM_UPDATE_ROOTS;$rows=@(Get-CimInstance Win32_Process -Filter $env:TRADELOOM_UPDATE_QUERY|Where-Object {$p=$_.ExecutablePath;$p -and @($roots|Where-Object {$p.StartsWith($_+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)}).Count -gt 0}|Select-Object ProcessId,ParentProcessId,ExecutablePath,CreationDate);ConvertTo-Json -InputObject $rows -Compress'''
    def wql(root):
        prefix=str(root)+os.sep
        prefix=''.join({'[':'[[]',']':'[]]','%':'[%]','_':'[_]'}.get(c,c) for c in prefix)
        return "ExecutablePath LIKE '"+prefix.replace('\\','\\\\').replace("'","\\'")+"%'"
    env={**os.environ,'TRADELOOM_UPDATE_ROOTS':json.dumps([str(root) for root in roots]),'TRADELOOM_UPDATE_QUERY':' OR '.join(wql(root) for root in roots)}
    result=subprocess.run(['powershell.exe','-NoProfile','-Command',script],env=env,capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:raise RuntimeError('owned-process inspection failed; refusing update')
    return json.loads(result.stdout.decode('utf-8-sig'))

def stopped(target,work):
    if owned_processes([target,work]):raise ValueError('target/backup program is in use; close normally, no forced stop')

def _checkpoint(name):pass  # Tests interrupt these exact real filesystem boundaries.

def _move(source,destination,target,work):
    allowed={target/'app',target/WRAPPER,target/RUNTIME_LOG,work/'before-app',work/'staged-app',work/'failed-app',work/'before-launcher.exe',work/'staged-launcher.exe',work/'failed-launcher.exe',work/'before-runtime-launcher.log'}
    if source not in allowed or destination not in allowed:raise ValueError('non-program move refused')
    build.replay.ordinary(source);build.replay.ordinary(destination.parent)
    if destination.exists():raise ValueError('recovery destination already exists; retain evidence')
    os.replace(source,destination)

def _restore(target,work,state):
    stopped(target,work)
    if pin(target/'launcher.json')!=state['config']:raise ValueError('launcher config changed concurrently; no overwrite')
    before=load(work/'before-entry-manifest.json')
    if (work/'before-app').exists():
        verify_app(work/'before-app',app_rows(before))
        if (target/'app').exists():_move(target/'app',work/'failed-app',target,work)
        _move(work/'before-app',target/'app',target,work)
    if (work/'before-launcher.exe').exists():
        if pin(work/'before-launcher.exe')!=state['wrapperBefore']:raise ValueError('wrapper backup drift')
        if (target/WRAPPER).exists():_move(target/WRAPPER,work/'failed-launcher.exe',target,work)
        _move(work/'before-launcher.exe',target/WRAPPER,target,work)
    if (work/'before-runtime-launcher.log').exists():
        if pin(work/'before-runtime-launcher.log')!=state['runtimeLogBefore']:raise ValueError('runtime log backup drift')
        _move(work/'before-runtime-launcher.log',target/RUNTIME_LOG,target,work)
    verify_app(target/'app',app_rows(before))
    if pin(target/WRAPPER)!=state['wrapperBefore']:raise ValueError('restored wrapper mismatch')
    restored={**before,'files':[{**row,**state['config'],'origin':{'kind':'preserved-target-launcher-config'}} if row['path']=='launcher.json' else row for row in before['files']]}
    restored['tree']=build.writer.tree(restored['files']);save(work/'restored-entry-manifest.json',restored)
    state['phase']='restored';save(work/'state.json',state)

def _install(target,work,state):
    stopped(target,work)
    if pin(target/'launcher.json')!=state['config']:raise ValueError('launcher config changed concurrently')
    _move(target/'app',work/'before-app',target,work);_checkpoint('app-backed-up')
    state['phase']='app-backed-up';save(work/'state.json',state)
    _move(work/'staged-app',target/'app',target,work);_checkpoint('app-installed')
    state['phase']='app-installed';save(work/'state.json',state)
    _move(target/WRAPPER,work/'before-launcher.exe',target,work);_checkpoint('wrapper-backed-up')
    state['phase']='wrapper-backed-up';save(work/'state.json',state)
    _move(work/'staged-launcher.exe',target/WRAPPER,target,work);_checkpoint('wrapper-installed')
    state['phase']='wrapper-installed';save(work/'state.json',state)
    if state.get('runtimeLogBefore'):
        if pin(target/RUNTIME_LOG)!=state['runtimeLogBefore']:raise ValueError('runtime log changed concurrently')
        _move(target/RUNTIME_LOG,work/'before-runtime-launcher.log',target,work);_checkpoint('runtime-log-preserved')
        state['phase']='runtime-log-preserved';save(work/'state.json',state)
    released=load(work/'candidate-entry-manifest.json');verify_app(target/'app',app_rows(released))
    if pin(target/WRAPPER)!=state['wrapperAfter'] or pin(target/'launcher.json')!=state['config']:raise ValueError('installed wrapper/config mismatch')
    # Candidate config is deliberately NOT installed or declared byte-identical.
    effective={**released,'files':[{**row,**state['config'],'origin':{'kind':'preserved-target-launcher-config'}} if row['path']=='launcher.json' else row for row in released['files']]}
    effective['tree']=build.writer.tree(effective['files'])
    save(work/'installed-entry-manifest.json',effective)
    state['phase']='complete';save(work/'state.json',state)

def install_prepared(target,work,state):
    try:_install(target,work,state)
    except Exception:
        _restore(target,work,state);raise

def validate_candidate(root,value,node):
    actual=build.inventory(root)
    if {v['path']:{k:v[k] for k in ['bytes','sha256']} for v in actual}!={v['path']:{k:v[k] for k in ['bytes','sha256']} for v in value['files']}:raise ValueError('complete candidate differs from reviewed manifest')
    if build.writer.tree(actual)!=value['tree']:raise ValueError('candidate complete tree mismatch')
    metadata=load(root/'app/resources/tradeloom/deployment.json');version=metadata['sourceBuild']['vendorVersion']
    registry=load(R/'dsh-base.manifest.json')['base']['upgrade']['recipes']
    if version not in registry:raise ValueError('unsupported candidate version')
    recipe_path=build.replay.safe(R,registry[version]);recipe=load(recipe_path)
    if not recipe.get('programRecipe'):raise ValueError('candidate version lacks reviewed complete recipe')
    if pin(root/'app/resources/app.asar')!={k:recipe['expectedAsar'][k] for k in ['bytes','sha256']}:raise ValueError('candidate ASAR differs from reviewed recipe')
    check="import {validateInstalledManifest} from "+json.dumps((R/'apps/tradeloom-launcher/installed-bootstrap.mjs').as_uri())+";import{readFile}from'node:fs/promises';validateInstalledManifest(JSON.parse(await readFile(process.argv[1],'utf8')));"
    result=subprocess.run([node,'--input-type=module','-e',check,str(root/'app/resources/tradeloom/deployment.json')],capture_output=True)
    if result.returncode:raise ValueError('original installed-manifest validator rejected candidate')
    tree=ast.parse((R/'scripts/replay-dsh-candidate.py').read_text(encoding='utf-8-sig'));entry=next(v for v in tree.body if isinstance(v,ast.FunctionDef) and v.name=='main')
    validate=next(v.value.value for v in entry.body if isinstance(v,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='validate' for t in v.targets))
    result=subprocess.run([node,'--input-type=module','-e',validate,str(R/'apps/tradeloom-launcher/installed-bootstrap.mjs'),str(root/'app/resources/tradeloom/business-shell'),str(root/'app/resources/tradeloom/deployment.json')],capture_output=True)
    if result.returncode:raise ValueError('original native-fs business validator rejected candidate')
    inventory=json.loads(result.stdout)
    if {k:inventory[k] for k in ['fileCount','bytes','sha256']}!=recipe['businessShell']['inventory']:raise ValueError('candidate business inventory differs from recipe')

def main():
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=['apply','recover','rollback'])
    parser.add_argument('--target',type=Path,required=True);parser.add_argument('--work-root',type=Path,required=True)
    for name in ['candidate-root','candidate-manifest','target-manifest']:parser.add_argument('--'+name,type=Path)
    parser.add_argument('--candidate-manifest-sha256');parser.add_argument('--target-manifest-sha256');parser.add_argument('--node',default='node')
    args=parser.parse_args();target=Path(os.path.abspath(args.target));work=Path(os.path.abspath(args.work_root))
    if os.name!='nt':raise ValueError('same-path application requires Windows; no alternative ownership backend')
    if target.anchor.casefold()!=work.anchor.casefold() or build.overlaps(target,work):raise ValueError('program backup work must be separate on the same volume')
    if args.operation!='apply':
        build.replay.ordinary(work);build.replay.ordinary(target);state=load(work/'state.json')
        if state['target']!=str(target) or state['work']!=str(work):raise ValueError('recovery target/work identity mismatch')
        if args.operation=='recover' and state['phase'] in ['complete','restored']:raise ValueError('no interrupted operation; use explicit rollback for a completed update')
        _restore(target,work,state);print(json.dumps({'status':'restored','target':str(target)}));return
    if any(v is None for v in [args.candidate_root,args.candidate_manifest,args.target_manifest,args.candidate_manifest_sha256,args.target_manifest_sha256]):raise ValueError('apply requires reviewed candidate/target manifests and their SHA256 pins')
    candidate=Path(os.path.abspath(args.candidate_root))
    if work.exists() or build.overlaps(candidate,target) or build.overlaps(candidate,work):raise ValueError('candidate/target/work must be separate; work must be new')
    config,data=recognized(target)
    if build.overlaps(work,data) or build.overlaps(candidate,data):raise ValueError('staging cannot overlap preserved data')
    released=manifest(args.candidate_manifest,args.candidate_manifest_sha256);before=manifest(args.target_manifest,args.target_manifest_sha256)
    validate_candidate(candidate,released,args.node);verify_app(target/'app',app_rows(before))
    wrapper_before=next(row for row in before['files'] if row['path']==WRAPPER)
    if pin(target/WRAPPER)!={k:wrapper_before[k] for k in ['bytes','sha256']}:raise ValueError('target wrapper differs from reviewed baseline')
    stopped(target,work);ancestor=work.parent
    while not ancestor.exists():ancestor=ancestor.parent
    build.replay.ordinary(ancestor);work.mkdir(parents=True)
    save(work/'candidate-entry-manifest.json',released);save(work/'before-entry-manifest.json',before)
    (work/'before-launcher.json').write_bytes(config)
    shutil.copytree(candidate/'app',work/'staged-app');shutil.copyfile(candidate/WRAPPER,work/'staged-launcher.exe')
    verify_app(work/'staged-app',app_rows(released));wrapper_after=next(row for row in released['files'] if row['path']==WRAPPER)
    if pin(work/'staged-launcher.exe')!={k:wrapper_after[k] for k in ['bytes','sha256']}:raise ValueError('staged wrapper mismatch')
    runtime_log=pin(target/RUNTIME_LOG) if json.loads(config)['schemaVersion']==2 and (target/RUNTIME_LOG).exists() else None
    state={'schemaVersion':1,'target':str(target),'work':str(work),'phase':'prepared','config':build.replay.pin(config),'wrapperBefore':pin(target/WRAPPER),'wrapperAfter':pin(work/'staged-launcher.exe'),'runtimeLogBefore':runtime_log,'dataSelectionPreserved':True,'dataReadCopiedOrMigrated':False}
    save(work/'state.json',state)
    install_prepared(target,work,state)
    print(json.dumps({'status':'same-path program updated','target':str(target),'work':str(work),'configPreserved':state['config'],'wrapper':state['wrapperAfter'],'phase':state['phase']}))

if __name__=='__main__':main()
