#!/usr/bin/env python3
"""Replace one stopped, explicitly identified TradeLoom program at the same path.

Only app/ and the wrapper executable are payload. launcher.json bytes and every
data directory remain untouched. Backups are kept outside the program root.
"""
from pathlib import Path
from contextlib import contextmanager
import argparse,ast,hashlib,importlib.util,json,os,shutil,subprocess,sys,uuid
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('complete_program',R/'scripts/build-dsh-candidate.py')
build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
WRAPPER='启动工作台.exe'
RUNTIME_LOG='启动工作台.log'
CLI_NODE='node'

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

def activation_process_identity(pid):
    if type(pid) is not int or pid<1:raise ValueError('invalid activation process identity')
    script="$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop;$p=Get-CimInstance Win32_Process -Filter 'ProcessId="+str(pid)+"';if($null -eq $p){[Console]::Out.Write('null')}else{[Console]::Out.Write((@{pid=[int]$p.ProcessId;exe=$p.ExecutablePath;creation=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress))}"
    result=subprocess.run(['powershell.exe','-NoProfile','-NonInteractive','-Command',script],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
    if result.returncode:raise RuntimeError('activation process identity inspection failed')
    return json.loads(result.stdout.decode('utf-8-sig'))

def adopt_cli_lease(path,work,state):
    # The existing lock remains present throughout takeover. Windows' byte lock
    # only serializes this same-journal recovery, never authorizes a new target.
    import msvcrt
    with path.open('r+b') as handle:
        msvcrt.locking(handle.fileno(),msvcrt.LK_NBLCK,1)
        try:
            lock=json.loads(handle.read().decode('utf-8'));fresh=load(work/'state.json')
            if set(lock)!={'schemaVersion','target','token','expectedRevision','ownerPid'} or lock.get('schemaVersion')!=1 or lock.get('target')!=state['target'] or lock.get('token')!=state['activationToken'] or fresh.get('activationToken')!=state['activationToken'] or fresh.get('target')!=state['target'] or fresh.get('work')!=str(work):raise ValueError('activation journal changed during recovery')
            owner=fresh.get('activationLeaseOwner',{})
            previous=next((item for item in [owner,owner.get('previous',{})] if item.get('pid')==lock.get('ownerPid')),None)
            if owner.get('kind')!='cli' or not previous:raise ValueError('activation lock owner differs from its journal')
            current=activation_process_identity(previous['pid'])
            if current and all(current.get(key)==previous.get(key) for key in ['pid','exe','creation']):raise ValueError('original activation CLI is still active; recovery refused')
            identity=activation_process_identity(os.getpid())
            if not identity:raise ValueError('recovery CLI identity unavailable')
            # The previous identity makes the single boundary between these two
            # writes recoverable: either old or new PID is an exact known owner.
            fresh['activationLeaseOwner']={'kind':'cli',**identity,'previous':{key:previous[key] for key in ['pid','exe','creation']}}
            save(work/'state.json',fresh)
            lock['ownerPid']=identity['pid'];encoded=(json.dumps(lock)+'\n').encode()
            handle.seek(0);handle.write(encoded);handle.truncate();handle.flush();os.fsync(handle.fileno())
            state.clear();state.update(fresh)
        finally:
            handle.seek(0);msvcrt.locking(handle.fileno(),msvcrt.LK_UNLCK,1)

@contextmanager
def transaction_lease(target,work,state,provided_token=None):
    """One activation writer; a worker's existing opaque lease stays worker-owned.

    A hard interruption deliberately leaves its lock and journal. recover with
    that journal's explicit --activation-token is the only way to continue that
    lock; no age/PID guess deletes another writer's lock.
    """
    path=activation_path(target,'lock');owned=False
    if provided_token:
        if state.get('activationToken')!=provided_token:raise ValueError('activation journal token mismatch')
        activation_guard(target,provided_token)
        previous=state.get('activationLeaseOwner')
        if previous and previous.get('kind')=='cli':
            adopt_cli_lease(path,work,state)
            owned=True
    else:
        token=state.get('activationToken') or str(uuid.uuid4())
        identity=activation_process_identity(os.getpid())
        if not identity:raise ValueError('activation CLI identity unavailable')
        state['activationToken']=token;state['activationLeaseOwner']={'kind':'cli',**identity}
        save(work/'state.json',state)
        with path.open('x',encoding='utf-8') as handle:
            json.dump({'schemaVersion':1,'target':str(target),'token':token,'expectedRevision':state.get('activationBefore'),'ownerPid':os.getpid()},handle)
        owned=True
    succeeded=False
    try:yield;succeeded=True
    finally:
        if owned and state.get('phase') in ['complete','restored']:
            try:
                activation_guard(target,state['activationToken'])
                expected=state.get('activationAfter') if state['phase']=='complete' else state.get('activationRestored')
                if not expected or activation_revision(target)!=expected:raise ValueError('activation changed before owned lease release')
                path.unlink()
            except Exception:
                # Keep the lock and the original operation failure when another
                # payload/revision makes safe cleanup unprovable.
                if succeeded:raise

def engine_entries(root):
    root=build.io_path(root)
    build.replay.ordinary(root);rows=[]
    def visit(directory):
        for item in sorted(directory.iterdir()):
            build.replay.ordinary(item);relative=item.relative_to(root).as_posix()
            if item.is_dir():rows.append({'path':relative,'type':'directory'});visit(item)
            elif item.is_file():rows.append({'path':relative,'type':'file','size':item.stat().st_size,'sha256':pin(item)['sha256']})
            else:raise ValueError('engine payload contains a non-program object')
    visit(root);return sorted(rows,key=lambda row:row['path'].encode('utf-16-be','surrogatepass'))

def engine_digest(root):
    return engine_entries_digest(engine_entries(root))

def engine_entries_digest(entries):
    return hashlib.sha256(json.dumps(entries,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()

def prepare_engine_payload_contract(target,work,state):
    if 'enginePayloads' in state:return
    if state.get('phase')!='prepared' or (work/'before-app').exists():raise ValueError('legacy interrupted journal has no complete directory contract; use its preserved matching CLI, no inferred directory baseline')
    before=engine_entries(target/'app');after=engine_entries(work/'staged-app')
    verify_app(target/'app',app_rows(load(work/'before-entry-manifest.json')))
    verify_app(work/'staged-app',app_rows(load(work/'candidate-entry-manifest.json')))
    revision=activation_revision(target,before)
    if state.get('activationBefore') is not None and revision!=state['activationBefore']:raise ValueError('activation changed before complete payload capture')
    state['activationBefore']=revision;state['enginePayloads']={}
    for kind,entries in [('before',before),('after',after)]:
        document={'schemaVersion':1,'entries':entries,'digest':engine_entries_digest(entries)}
        path=work/(kind+'-engine-inventory.json');save(path,document)
        state['enginePayloads'][kind]={'file':pin(path),'digest':document['digest']}
    save(work/'state.json',state)

def engine_payload_contract(work,state):
    if set(state.get('enginePayloads',{}))!={'before','after'}:raise ValueError('complete engine payload contract missing')
    result={}
    for kind in ['before','after']:
        path=work/(kind+'-engine-inventory.json');record=state['enginePayloads'][kind]
        if set(record)!={'file','digest'} or pin(path)!=record['file']:raise ValueError('complete engine inventory receipt changed')
        document=load(path)
        if set(document)!={'schemaVersion','entries','digest'} or document['schemaVersion']!=1 or engine_entries_digest(document['entries'])!=document['digest'] or document['digest']!=record['digest']:raise ValueError('complete engine inventory digest mismatch')
        result[kind]=document
    return result

def activation_path(target,suffix):return target.parent/('.'+target.name+'-engine-activation.'+suffix)

def activation_revision(target,entries=None):
    payload=engine_digest(target/'app') if entries is None else engine_entries_digest(entries);path=activation_path(target,'json')
    if not path.exists():return 'initial:'+payload
    record=load(path)
    if set(record)!={'schemaVersion','target','revision','payload','operation'} or record['schemaVersion']!=1 or record['target']!=str(target) or record['payload']!=payload:raise ValueError('external engine generation changed outside its activation owner')
    return record['revision']

def activation_guard(target,token):
    path=activation_path(target,'lock')
    if not path.exists():
        if token:raise ValueError('engine activation lease disappeared')
        return
    record=load(path)
    if not token or set(record)!={'schemaVersion','target','token','expectedRevision','ownerPid'} or record['schemaVersion']!=1 or record['target']!=str(target) or record['token']!=token:raise ValueError('another engine activation owns this program')

def record_activation(target,work):
    record={'schemaVersion':1,'target':str(target),'revision':str(uuid.uuid4()),'payload':engine_digest(target/'app'),'operation':str(work)}
    save(activation_path(target,'json'),record);return record

def _checkpoint(name):pass  # Tests interrupt these exact real filesystem boundaries.

def _move(source,destination,target,work):
    allowed={target/'app',target/WRAPPER,target/RUNTIME_LOG,work/'before-app',work/'staged-app',work/'failed-app',work/'before-launcher.exe',work/'staged-launcher.exe',work/'failed-launcher.exe',work/'before-runtime-launcher.log'}
    if source not in allowed or destination not in allowed:raise ValueError('non-program move refused')
    build.replay.ordinary(source);build.replay.ordinary(destination.parent)
    if destination.exists():raise ValueError('recovery destination already exists; retain evidence')
    os.replace(source,destination)

def _restore(target,work,state):
    stopped(target,work)
    activation_guard(target,state.get('activationToken'))
    if pin(target/'launcher.json')!=state['config']:raise ValueError('launcher config changed concurrently; no overwrite')
    before=load(work/'before-entry-manifest.json')
    contracts=engine_payload_contract(work,state)
    # Recovery accepts only the exact before/installed payload from THIS
    # transaction. A third-party activation cannot be rolled back by an old job.
    if (target/'app').exists():
        actual=engine_entries(target/'app')
        allowed=[contracts[kind]['entries'] for kind in ['before','after']]
        if actual not in allowed:raise ValueError('target app belongs to another generation; recovery refused')
    else:
        install_gap=state['phase'] in ['prepared','app-backed-up'] and (work/'staged-app').is_dir() and engine_entries(work/'staged-app')==contracts['after']['entries']
        restore_gap=(work/'failed-app').is_dir() and engine_entries(work/'failed-app') in [contracts[kind]['entries'] for kind in ['before','after']]
        if not (work/'before-app').is_dir() or not (install_gap or restore_gap):raise ValueError('missing target app is not an owned rename recovery boundary')
    if (target/WRAPPER).exists() and pin(target/WRAPPER) not in [state['wrapperBefore'],state['wrapperAfter']]:raise ValueError('target wrapper belongs to another generation; recovery refused')
    active=activation_path(target,'json')
    if active.exists():
        record=load(active)
        if set(record)!={'schemaVersion','target','revision','payload','operation'} or record['schemaVersion']!=1 or record['target']!=str(target) or record['payload'] not in [contracts[kind]['digest'] for kind in ['before','after']]:raise ValueError('another complete engine payload owns the program; recovery refused')
        if record['revision']!=state.get('activationBefore') and record.get('operation')!=str(work):raise ValueError('another activation revision owns the program; recovery refused')
    elif state.get('activationAfter') or state.get('activationRestored') or state.get('activationBefore')!='initial:'+contracts['before']['digest']:raise ValueError('engine activation receipt disappeared; recovery refused')
    if (work/'before-app').exists():
        verify_app(work/'before-app',app_rows(before))
        if engine_entries(work/'before-app')!=contracts['before']['entries']:raise ValueError('complete backup directory inventory changed')
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
    if engine_entries(target/'app')!=contracts['before']['entries']:raise ValueError('restored complete payload mismatch')
    if pin(target/WRAPPER)!=state['wrapperBefore']:raise ValueError('restored wrapper mismatch')
    restored={**before,'files':[{**row,**state['config'],'origin':{'kind':'preserved-target-launcher-config'}} if row['path']=='launcher.json' else row for row in before['files']]}
    restored['tree']=build.writer.tree(restored['files'],node=CLI_NODE);save(work/'restored-entry-manifest.json',restored)
    state['activationRestored']=record_activation(target,work)['revision']
    state['phase']='restored';save(work/'state.json',state)

def _install(target,work,state):
    stopped(target,work)
    activation_guard(target,state.get('activationToken'))
    if state.get('activationBefore') is not None and activation_revision(target)!=state['activationBefore']:raise ValueError('engine activation revision changed before replacement')
    if pin(target/'launcher.json')!=state['config']:raise ValueError('launcher config changed concurrently')
    contracts=engine_payload_contract(work,state)
    if engine_entries(target/'app')!=contracts['before']['entries'] or engine_entries(work/'staged-app')!=contracts['after']['entries']:raise ValueError('complete engine payload changed before replacement')
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
    if engine_entries(target/'app')!=contracts['after']['entries']:raise ValueError('installed complete engine payload mismatch')
    # Candidate config is deliberately NOT installed or declared byte-identical.
    effective={**released,'files':[{**row,**state['config'],'origin':{'kind':'preserved-target-launcher-config'}} if row['path']=='launcher.json' else row for row in released['files']]}
    effective['tree']=build.writer.tree(effective['files'],node=CLI_NODE)
    save(work/'installed-entry-manifest.json',effective)
    state['activationAfter']=record_activation(target,work)['revision']
    state['phase']='complete';save(work/'state.json',state)

def install_prepared(target,work,state):
    stopped(target,work)
    prepare_engine_payload_contract(target,work,state)
    with transaction_lease(target,work,state,state.get('activationToken')):
        try:_install(target,work,state)
        except Exception:
            _restore(target,work,state);raise

def validate_candidate(root,value,node,snapshot=None):
    actual=build.inventory(root)
    if {v['path']:{k:v[k] for k in ['bytes','sha256']} for v in actual}!={v['path']:{k:v[k] for k in ['bytes','sha256']} for v in value['files']}:raise ValueError('complete candidate differs from reviewed manifest')
    if build.writer.tree(actual,node=node)!=value['tree']:raise ValueError('candidate complete tree mismatch')
    metadata=load(root/'app/resources/tradeloom/deployment.json');version=metadata['sourceBuild']['vendorVersion']
    registry=load(R/'dsh-base.manifest.json')['base']['upgrade']['recipes']
    if version not in registry:raise ValueError('unsupported candidate version')
    recipe_path=build.replay.safe(R,registry[version]);recipe=load(recipe_path)
    if not recipe.get('programRecipe'):raise ValueError('candidate version lacks reviewed complete recipe')
    if snapshot is None:
        if pin(root/'app/resources/app.asar')!={k:recipe['expectedAsar'][k] for k in ['bytes','sha256']}:raise ValueError('candidate ASAR differs from reviewed recipe')
    elif engine_entries(root/'app')!=snapshot['entries'] or snapshot['runtimeVersion']!=version:raise ValueError('snapshot complete engine tree/version differs from its owned receipt')
    check="import{pathToFileURL}from'node:url';import{readFile}from'node:fs/promises';const{validateInstalledManifest}=await import(pathToFileURL(process.argv[1]).href);validateInstalledManifest(JSON.parse(await readFile(process.argv[2],'utf8')));"
    result=subprocess.run([node,'--input-type=module','-e',check,str(R/'apps/tradeloom-launcher/installed-bootstrap.mjs'),str(root/'app/resources/tradeloom/deployment.json')],capture_output=True)
    if result.returncode:raise ValueError('original installed-manifest validator rejected candidate')
    tree=ast.parse((R/'scripts/replay-dsh-candidate.py').read_text(encoding='utf-8-sig'));entry=next(v for v in tree.body if isinstance(v,ast.FunctionDef) and v.name=='main')
    validate=next(v.value.value for v in entry.body if isinstance(v,ast.Assign) and any(isinstance(t,ast.Name) and t.id=='validate' for t in v.targets))
    result=subprocess.run([node,'--input-type=module','-e',validate,str(R/'apps/tradeloom-launcher/installed-bootstrap.mjs'),str(root/'app/resources/tradeloom/business-shell'),str(root/'app/resources/tradeloom/deployment.json')],capture_output=True)
    if result.returncode:raise ValueError('original native-fs business validator rejected candidate')
    inventory=json.loads(result.stdout)
    expected=recipe['businessShell']['inventory'] if snapshot is None else {k:metadata['resources']['businessShell'][k] for k in ['fileCount','bytes','sha256']}
    if {k:inventory[k] for k in ['fileCount','bytes','sha256']}!=expected:raise ValueError('candidate business inventory differs from its verified recipe/snapshot')

def snapshot_receipt(args,target,released):
    if not args.engine_snapshot_receipt:return None
    receipt=load(args.engine_snapshot_receipt)
    if pin(args.engine_snapshot_receipt)['sha256']!=args.engine_snapshot_sha256 or set(receipt)!={'schemaVersion','scope','target','token','snapshot','candidateManifest','expectedRevision'}:raise ValueError('owned snapshot receipt identity mismatch')
    if receipt['schemaVersion']!=1 or receipt['scope']!='tradeloom-engine-payload/v1' or receipt['target']!=str(target) or receipt['token']!=args.activation_token or receipt['expectedRevision']!=args.expected_engine_revision:raise ValueError('snapshot target/lease/revision mismatch')
    if receipt['candidateManifest']!=pin(args.candidate_manifest):raise ValueError('snapshot candidate manifest changed')
    snapshot=receipt['snapshot'];keys={'snapshotId','createdAt','kind','generationId','runtimeVersion','scope','activationRevision','entryCount','fileCount','directoryCount','totalBytes','checksum','entries'}
    if set(snapshot)!=keys or snapshot['scope']!=receipt['scope'] or snapshot['kind'] not in ['generation','pre-restore-backup'] or not isinstance(snapshot['entries'],list):raise ValueError('unsupported engine snapshot schema')
    entries=snapshot['entries'];seen=set()
    for row in entries:
        build.replay.safe(Path('.'),row['path'])
        if row['path'].casefold() in seen or row.get('type') not in ['file','directory']:raise ValueError('invalid snapshot payload entry')
        seen.add(row['path'].casefold())
        if set(row)!=({'path','type','size','sha256'} if row['type']=='file' else {'path','type'}):raise ValueError('unknown snapshot payload field')
        if row['type']=='file' and (type(row['size']) is not int or row['size']<0 or not isinstance(row['sha256'],str) or len(row['sha256'])!=64 or any(c not in '0123456789abcdef' for c in row['sha256'])):raise ValueError('invalid snapshot payload pin')
    payload={'formatVersion':1,**{k:v for k,v in snapshot.items() if k!='checksum'}}
    digest=lambda value:hashlib.sha256(json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode()).hexdigest()
    if digest(payload)!=snapshot['checksum'] or digest(entries)!=snapshot['generationId'] or entries!=sorted(entries,key=lambda row:row['path'].encode('utf-16-be','surrogatepass')) or snapshot['entryCount']!=len(entries) or snapshot['fileCount']!=sum(row['type']=='file' for row in entries) or snapshot['directoryCount']!=sum(row['type']=='directory' for row in entries) or snapshot['totalBytes']!=sum(row.get('size',0) for row in entries):raise ValueError('snapshot checksum/inventory mismatch')
    return snapshot

def main():
    global CLI_NODE
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('operation',choices=['apply','recover','rollback'])
    parser.add_argument('--target',type=Path,required=True);parser.add_argument('--work-root',type=Path,required=True)
    for name in ['candidate-root','candidate-manifest','target-manifest']:parser.add_argument('--'+name,type=Path)
    parser.add_argument('--candidate-manifest-sha256');parser.add_argument('--target-manifest-sha256');parser.add_argument('--node',default='node')
    parser.add_argument('--engine-snapshot-receipt',type=Path);parser.add_argument('--engine-snapshot-sha256');parser.add_argument('--expected-engine-revision');parser.add_argument('--activation-token')
    args=parser.parse_args();target=Path(os.path.abspath(args.target));work=Path(os.path.abspath(args.work_root))
    CLI_NODE=args.node
    if os.name!='nt':raise ValueError('same-path application requires Windows; no alternative ownership backend')
    if target.anchor.casefold()!=work.anchor.casefold() or build.overlaps(target,work):raise ValueError('program backup work must be separate on the same volume')
    activation_guard(target,args.activation_token)
    if args.operation!='apply':
        build.replay.ordinary(work);build.replay.ordinary(target);state=load(work/'state.json')
        if state['target']!=str(target) or state['work']!=str(work):raise ValueError('recovery target/work identity mismatch')
        if args.operation=='recover' and state['phase'] in ['complete','restored']:raise ValueError('no interrupted operation; use explicit rollback for a completed update')
        with transaction_lease(target,work,state,args.activation_token):_restore(target,work,state)
        print(json.dumps({'status':'restored','target':str(target)}));return
    if any(v is None for v in [args.candidate_root,args.candidate_manifest,args.target_manifest,args.candidate_manifest_sha256,args.target_manifest_sha256]):raise ValueError('apply requires reviewed candidate/target manifests and their SHA256 pins')
    candidate=Path(os.path.abspath(args.candidate_root))
    if work.exists() or build.overlaps(candidate,target) or build.overlaps(candidate,work):raise ValueError('candidate/target/work must be separate; work must be new')
    config,data=recognized(target)
    if build.overlaps(work,data) or build.overlaps(candidate,data):raise ValueError('staging cannot overlap preserved data')
    if bool(args.engine_snapshot_receipt)!=bool(args.engine_snapshot_sha256) or bool(args.engine_snapshot_receipt)!=bool(args.expected_engine_revision) or args.engine_snapshot_receipt and not args.activation_token:raise ValueError('snapshot recovery requires its complete owned lease/receipt/revision')
    released=manifest(args.candidate_manifest,args.candidate_manifest_sha256);before=manifest(args.target_manifest,args.target_manifest_sha256)
    snapshot=snapshot_receipt(args,target,released)
    activation_before=activation_revision(target)
    if args.expected_engine_revision and activation_before!=args.expected_engine_revision:raise ValueError('stale engine recovery confirmation')
    validate_candidate(candidate,released,args.node,snapshot);verify_app(target/'app',app_rows(before))
    wrapper_before=next(row for row in before['files'] if row['path']==WRAPPER)
    if pin(target/WRAPPER)!={k:wrapper_before[k] for k in ['bytes','sha256']}:raise ValueError('target wrapper differs from reviewed baseline')
    stopped(target,work);ancestor=work.parent
    while not ancestor.exists():ancestor=ancestor.parent
    build.replay.ordinary(ancestor);work.mkdir(parents=True)
    save(work/'candidate-entry-manifest.json',released);save(work/'before-entry-manifest.json',before)
    (work/'before-launcher.json').write_bytes(config)
    shutil.copytree(build.io_path(candidate/'app'),build.io_path(work/'staged-app'));shutil.copyfile(candidate/WRAPPER,work/'staged-launcher.exe')
    verify_app(work/'staged-app',app_rows(released));wrapper_after=next(row for row in released['files'] if row['path']==WRAPPER)
    if pin(work/'staged-launcher.exe')!={k:wrapper_after[k] for k in ['bytes','sha256']}:raise ValueError('staged wrapper mismatch')
    child_after=next(row for row in released['files'] if row['path']=='app/织贸助手.exe')
    pg_label_pins={}
    for name in ('pg_ctl','postgres'):
        row=next(row for row in released['files'] if row['path']=='app/resources/tradeloom/postgresql/pgsql/bin/'+name+'.exe')
        pg_label_pins[name]={key:row[key] for key in ['bytes','sha256']}
    build.ensure_product_exe_labels(work,{'wrapper':{k:wrapper_after[k] for k in ['bytes','sha256']},'child':{k:child_after[k] for k in ['bytes','sha256']},**pg_label_pins},work/'product-exe-labels.json',staged=True)
    runtime_log=pin(target/RUNTIME_LOG) if json.loads(config)['schemaVersion']==2 and (target/RUNTIME_LOG).exists() else None
    state={'schemaVersion':1,'target':str(target),'work':str(work),'phase':'prepared','config':build.replay.pin(config),'wrapperBefore':pin(target/WRAPPER),'wrapperAfter':pin(work/'staged-launcher.exe'),'runtimeLogBefore':runtime_log,'dataSelectionPreserved':True,'dataReadCopiedOrMigrated':False,'activationBefore':activation_before,'activationToken':args.activation_token}
    save(work/'state.json',state)
    install_prepared(target,work,state)
    print(json.dumps({'status':'same-path program updated','target':str(target),'work':str(work),'configPreserved':state['config'],'wrapper':state['wrapperAfter'],'phase':state['phase']}))

if __name__=='__main__':main()
