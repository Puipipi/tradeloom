#!/usr/bin/env python3
"""Fetch the official nightly input and assemble a supported isolated candidate.

Never runs the installer/application, switches an installation or migrates data.
Only reviewed versions are supported; a new nightly stops before asset download.
"""
from pathlib import Path,PureWindowsPath
import argparse,base64,datetime,hashlib,importlib.util,json,os,subprocess,sys,urllib.request
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('complete_candidate',R/'scripts/build-dsh-candidate.py')
build=importlib.util.module_from_spec(spec);spec.loader.exec_module(build)
FEED_URL='https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs):raise ValueError('official URL redirected; review channel/asset identity')

def open_official(url):
    # urllib's ordinary HTTPS trust/proxy handling is retained; no TLS bypass.
    return urllib.request.build_opener(NoRedirect).open(url,timeout=40)

def parse_feed(raw):
    """Read the observed electron-updater YAML shape, not arbitrary YAML code."""
    if len(raw)>65536:raise ValueError('official feed exceeds supported metadata size')
    lines=raw.decode('utf-8-sig').replace('\r\n','\n').splitlines();result={'files':[]};i=0;current=None
    def scalar(value,index,indent):
        if value=='>-':
            if index>=len(lines) or not lines[index].startswith(' '*indent) or lines[index].startswith(' '*(indent+1)):raise ValueError('unsupported folded feed scalar')
            value=lines[index][indent:];index+=1
        if value.startswith('"'):value=json.loads(value)
        elif value.startswith("'"):
            if not value.endswith("'"):raise ValueError('invalid feed string')
            value=value[1:-1].replace("''", "'")
        elif not value or value[0] in '!&*[{#' or '\t' in value:raise ValueError('unsupported feed scalar')
        if not isinstance(value,str):raise ValueError('feed scalar must be text')
        return value,index
    while i<len(lines):
        line=lines[i];i+=1
        if not line.strip():continue
        if '\t' in line:raise ValueError('unsupported feed indentation')
        indent=len(line)-len(line.lstrip(' '));text=line[indent:]
        if indent==0:
            target=result
            if text=='files:':
                if current is not None or result['files']:raise ValueError('duplicate files declaration')
                current={};continue
            if ':' not in text:raise ValueError('unsupported feed record')
            key,value=text.split(':',1);continuation=2
            if key not in ['version','path','sha512','releaseDate','stagingPercentage']:raise ValueError('unknown official feed field')
        elif indent==2 and text.startswith('- '):
            target={};result['files'].append(target);current=target
            if ':' not in text[2:]:raise ValueError('unsupported feed file')
            key,value=text[2:].split(':',1);continuation=6
        elif indent==4 and current is not None:
            target=current
            if ':' not in text:raise ValueError('unsupported feed file field')
            key,value=text.split(':',1);continuation=6
        else:raise ValueError('unsupported feed layout')
        if target is not result and key not in ['url','size','sha512']:raise ValueError('unknown feed asset field')
        if key in target:raise ValueError('duplicate feed field')
        target[key],i=scalar(value.strip(),i,continuation)
    if len(result['files'])!=1 or set(result['files'][0])!={'url','size','sha512'}:raise ValueError('expected one Windows x64 feed asset')
    asset=result['files'][0]
    if result.get('path')!=asset['url'] or result.get('sha512')!=asset['sha512']:raise ValueError('feed top-level and files identity differ')
    if not asset['size'].isdigit() or int(asset['size'])<1:raise ValueError('invalid feed asset length')
    asset['size']=int(asset['size'])
    if len(base64.b64decode(asset['sha512'],validate=True))!=64:raise ValueError('invalid feed SHA512')
    version=result.get('version','')
    if not version or len(version)>128 or any(c in version for c in '/\\:'):raise ValueError('invalid feed version')
    return result

def resolve_release(feed):
    version=feed['version'];registry=build.replay.load(R/'dsh-base.manifest.json')['base']['upgrade']['recipes']
    if version not in registry:raise ValueError('unsupported official version '+version+'; review upstream SDK/desktop/own-overlay differences before downloading assets')
    recipe_path=build.replay.safe(R,registry[version]);recipe=build.replay.load(recipe_path)
    if not recipe.get('programRecipe'):raise ValueError('official version has no reviewed complete-program recipe: '+version)
    policy_path=build.replay.safe(recipe_path.parent,recipe['programRecipe']);program=build.replay.load(policy_path)
    acquisition=program['acquisition'];asset=feed['files'][0];frozen=program['upstream']['installer']
    if recipe['version']!=version or program['version']!=version or acquisition['feedURL']!=FEED_URL:raise ValueError('reviewed recipe version/channel mismatch')
    if (asset['url'],asset['size'],asset['sha512'])!=(frozen['url'],frozen['bytes'],frozen['sha512']):raise ValueError('official metadata differs from reviewed recipe; stop for asset/recipe review')
    return recipe_path,policy_path,program

def parse_listing(raw):
    # The old private parser did not normalize binary CRLF and saw one record.
    text=raw.decode('utf-8-sig').replace('\r\n','\n');lines=text.splitlines()
    try:start=lines.index('----------')+1
    except ValueError:raise ValueError('7z full listing boundary missing')
    rows=[];row={}
    for line in lines[start:]+['']:
        if not line:
            if row:
                if 'Path' not in row:raise ValueError('7z record has no path')
                rows.append(row);row={}
            continue
        if ' = ' not in line:raise ValueError('unsupported 7z listing record')
        key,value=line.split(' = ',1)
        if key in row:raise ValueError('duplicate 7z field')
        row[key]=value
    if not rows:raise ValueError('7z has no archive entries')
    return rows

def validate_listing(rows):
    seen=set();files={}
    reserved={'CON','PRN','AUX','NUL',*[str(prefix)+str(n) for prefix in ['COM','LPT'] for n in range(1,10)]}
    for row in rows:
        raw=row['Path'];parts=raw.replace('\\','/').split('/');path=PureWindowsPath(raw)
        if not raw or path.is_absolute() or path.drive or any(c in raw for c in ':\0\r\n') or any(p in ('','.','..') or p.endswith((' ','.')) or p.split('.')[0].upper() in reserved for p in parts):raise ValueError('unsafe archive path')
        if any(row.get(k) for k in ['Symbolic Link','Hard Link','Reparse Point']) or 'L' in row.get('Attributes','').split('_')[0] or row.get('Encrypted')=='+':raise ValueError('archive link/encrypted entry is unsupported')
        normalized='/'.join(parts);key=normalized.casefold()
        if key in seen:raise ValueError('archive duplicate/case-colliding path')
        seen.add(key)
        if row.get('Folder')!='+' and not row.get('Attributes','').startswith('D'):
            size=row.get('Size','')
            files[normalized]=int(size) if size.isdigit() else None
    return files

def verify_installer(path,expected):
    build.replay.ordinary(path);total=0;digest=hashlib.sha512()
    with path.open('rb') as stream:
        while block:=stream.read(1024*1024):total+=len(block);digest.update(block)
    actual=base64.b64encode(digest.digest()).decode('ascii')
    if total!=expected['bytes'] or actual!=expected['sha512']:raise ValueError('cached/downloaded installer size or SHA512 mismatch; preserved without replacement')
    return {'bytes':total,'sha512':actual,**build.file_pin(path)}

AUTHENTICODE_COMMAND = r"""
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1')
$signature = Get-AuthenticodeSignature -LiteralPath $env:TRADELOOM_INSTALLER_VERIFY_PATH
[pscustomobject]@{
    status = $signature.Status.ToString()
    subject = $signature.SignerCertificate.Subject
    issuer = $signature.SignerCertificate.Issuer
    thumbprint = $signature.SignerCertificate.Thumbprint
} | ConvertTo-Json -Compress
"""

def inspect_installer_signature(path, run):
    command = ['powershell.exe','-NoProfile','-NonInteractive','-Command',AUTHENTICODE_COMMAND]
    env = {**os.environ, 'TRADELOOM_INSTALLER_VERIFY_PATH':str(path.absolute())}
    return json.loads(run('installer-signature',command,env=env).decode('utf-8-sig'))

def require_installer_publisher(signature, expected):
    if not isinstance(expected,str) or not expected:
        raise ValueError('reviewed publisher subject missing')
    if not isinstance(signature,dict) or signature.get('status')!='Valid' or signature.get('subject')!=expected:
        raise ValueError('official Authenticode/publisher verification failed')
    return {**signature,'publisherExact':True}

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    for name in ['cache-root','work-root','output-root','python-packages','postgresql','plugin-seed']:parser.add_argument('--'+name,type=Path,required=True)
    parser.add_argument('--data-root',required=True);parser.add_argument('--node',default='node')
    parser.add_argument('--extractor',type=Path,default=Path('C:/Program Files/7-Zip/7z.exe'))
    parser.add_argument('--compiler',type=Path,default=Path(os.environ.get('WINDIR','C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe')
    parser.add_argument('--apply-to',type=Path);parser.add_argument('--target-manifest',type=Path)
    parser.add_argument('--target-manifest-sha256');parser.add_argument('--apply-work',type=Path)
    parser.add_argument('--resource-editor',type=Path,help='exact pinned electron/rcedit executable; no global install')
    args=parser.parse_args()
    if os.name!='nt':raise ValueError('supported acquisition/signature contract requires Windows x64')
    apply_values=[args.apply_to,args.target_manifest,args.target_manifest_sha256,args.apply_work]
    if any(v is not None for v in apply_values) and not all(v is not None for v in apply_values):raise ValueError('same-path apply requires explicit target, reviewed baseline manifest/SHA and new apply work directory')
    apply_source_before=None
    if args.apply_to:
        apply_path=R/'scripts/apply-dsh-candidate.py';apply_source_before=build.file_pin(apply_path)
        applier=build.module('same_path_preflight',apply_path)
        if build.file_pin(apply_path)!=apply_source_before:raise ValueError('apply source changed during preflight')
        target=Path(os.path.abspath(args.apply_to));apply_work=Path(os.path.abspath(args.apply_work))
        if apply_work.exists() or target.anchor.casefold()!=apply_work.anchor.casefold() or build.overlaps(target,apply_work):raise ValueError('apply work must be new, separate and on target volume')
        applier.manifest(args.target_manifest,args.target_manifest_sha256)
        _target_config,target_data=applier.recognized(target);applier.stopped(target,apply_work)
    work=Path(os.path.abspath(args.work_root));cache=Path(os.path.abspath(args.cache_root));out=Path(os.path.abspath(args.output_root));data=build.local_data_path(args.data_root)
    if work.exists() or out.exists():raise ValueError('work/output root must be new; no overwrite or resume')
    roots=[R,cache,out,data,args.python_packages.absolute(),args.postgresql.absolute(),args.plugin_seed.absolute()]
    if args.apply_to:
        if any(build.overlaps(write_root,protected) for write_root in [work,cache,out,apply_work] for protected in [target,target_data]):raise ValueError('acquisition/apply write roots overlap target or preserved target data')
        if any(build.overlaps(apply_work,source) for source in [R,work,cache,out,data,args.python_packages.absolute(),args.postgresql.absolute(),args.plugin_seed.absolute()]):raise ValueError('apply work overlaps source/dependency/generation roots')
    if any(build.overlaps(work,p) for p in roots) or any(build.overlaps(cache,p) for p in roots if p!=cache):raise ValueError('acquisition work/cache roots must be separate from source, program, data and dependency inputs')
    for root in [work,cache,out]:
        parent=root
        while not parent.exists():parent=parent.parent
        build.replay.ordinary(parent)
    work.mkdir(parents=True)
    def write(name,value):build.replay.write_json(work/name,value)
    def run(label,command,*,env=None):
        result=subprocess.run([str(p) for p in command],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW,env=env)
        (work/(label+'.stdout.log')).write_bytes(result.stdout);(work/(label+'.stderr.log')).write_bytes(result.stderr)
        write(label+'.command.json',{'command':[str(p) for p in command],'actualExitCode':result.returncode})
        if result.returncode:raise RuntimeError(label+' failed; original outputs retained; inspect apply state/rollback if applicable; installer/application not launched')
        return result.stdout
    with open_official(FEED_URL) as response:
        if response.status!=200 or response.url!=FEED_URL:raise ValueError('unexpected official metadata response')
        raw=response.read(65537)
    (work/'nightly.yml').write_bytes(raw);feed=parse_feed(raw)
    write('feed.json',{'url':FEED_URL,'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'bytes':len(raw),'sha256':build.sha(raw),'metadata':feed})
    recipe_path,policy_path,program=resolve_release(feed);policy=program['acquisition'];installer_spec=program['upstream']['installer']
    if policy['entry']!=Path(__file__).resolve().relative_to(R).as_posix():raise ValueError('reviewed acquisition entry mismatch')
    build.validate_windows_branding(program['windowsBranding'],args.resource_editor)
    source_paths=[Path(__file__).resolve(),R/policy['applyScript'],policy_path]
    source_pins={p.relative_to(R).as_posix():build.file_pin(p) for p in source_paths}
    if apply_source_before is not None and source_pins[policy['applyScript']]!=apply_source_before:raise ValueError('apply source changed after early ownership check')
    if not cache.exists():cache.mkdir(parents=True)
    installer=cache/installer_spec['url'].rsplit('/',1)[1];reused_installer=installer.exists()
    if not reused_installer:
        partial=Path(str(installer)+'.part')
        if partial.exists():raise ValueError('partial download already exists; preserved, no automatic retry/overwrite')
        with open_official(installer_spec['url']) as response,partial.open('xb') as target:
            if response.status!=200 or response.url!=installer_spec['url']:raise ValueError('unexpected official asset response')
            length=response.headers.get('Content-Length')
            if length is not None and int(length)!=installer_spec['bytes']:raise ValueError('official Content-Length differs from recipe')
            total=0
            while block:=response.read(1024*1024):
                total+=len(block)
                if total>installer_spec['bytes']:raise ValueError('official download exceeds reviewed length')
                target.write(block)
        verify_installer(partial,installer_spec);partial.rename(installer)
    identity=verify_installer(installer,installer_spec)
    signature=require_installer_publisher(inspect_installer_signature(installer,run),policy['publisherSubject'])
    vendor=cache/'extracted';reused_vendor=vendor.exists()
    if not reused_vendor:
        build.replay.ordinary(args.extractor)
        if build.file_pin(args.extractor)!=policy['extractor']:raise ValueError('reviewed existing extractor bytes/SHA mismatch; no install/fallback')
        outer=parse_listing(run('installer-list',[args.extractor,'l','-slt','-sccUTF-8',installer]));validate_listing(outer)
        selected=[row for row in outer if row['Path']==policy['payload']['path']]
        if len(outer)!=policy['outerEntries'] or len(selected)!=1 or selected[0].get('Size')!=str(policy['payload']['bytes']):raise ValueError('official outer payload/listing identity drift')
        container=cache/'container';container.mkdir();run('payload-extract',[args.extractor,'x',installer,'-o'+str(container),policy['payload']['path'],'-y','-sccUTF-8'])
        payload=container.joinpath(*PureWindowsPath(policy['payload']['path']).parts);build.replay.ordinary(payload)
        if payload.stat().st_size!=policy['payload']['bytes']:raise ValueError('extracted inner archive size mismatch')
        inner=parse_listing(run('payload-list',[args.extractor,'l','-slt','-sccUTF-8',payload]));expected=validate_listing(inner)
        if len(inner)!=policy['innerEntries'] or len(expected)!=program['vendor']['fileCount'] or any(size is None for size in expected.values()):raise ValueError('incomplete/unsupported official program listing')
        write('archive-boundaries.json',{'outerEntries':len(outer),'innerEntries':len(inner),'expectedFiles':len(expected),'allPathsLinksCheckedBeforeExtraction':True})
        temporary=cache/'extracted.partial';temporary.mkdir();run('program-extract',[args.extractor,'x',payload,'-o'+str(temporary),'-y','-sccUTF-8'])
        rows=build.inventory(temporary)
        if {row['path']:row['bytes'] for row in rows}!=expected:raise ValueError('extraction files/sizes differ from full listing')
        if build.codepoint_tree(rows)!={k:program['vendor'][k] for k in ['fileCount','bytes','sha256']}:raise ValueError('extracted official complete tree digest mismatch')
        temporary.rename(vendor)
    tree=build.codepoint_tree(build.inventory(vendor))
    if tree!={k:program['vendor'][k] for k in ['fileCount','bytes','sha256']}:raise ValueError('cached official complete tree drift; preserved, no replacement')
    write('acquisition.json',{'version':feed['version'],'feedSha256':build.sha(raw),'installer':identity,'signature':signature,'vendor':tree,'reusedInstaller':reused_installer,'reusedExtractedTree':reused_vendor,'installerExecuted':False})
    command=[sys.executable,'-B',R/'scripts/build-dsh-candidate.py','--version',feed['version'],'--vendor-root',vendor,'--python-packages',args.python_packages,'--postgresql',args.postgresql,'--plugin-seed',args.plugin_seed,'--data-root',args.data_root,'--output-root',out,'--node',args.node,'--compiler',args.compiler,'--resource-editor',args.resource_editor]
    run('complete-build',command)
    built=build.replay.load(out/'build-receipt.json');manifest=build.replay.load(out/'source-manifest.json');captured={row['sourcePath']:row for row in manifest['sourceFiles']}
    for name,pin in source_pins.items():
        if build.file_pin(R/name)!=pin or {k:captured[name][k] for k in ['bytes','sha256']}!=pin:raise ValueError('acquisition source changed or absent from complete source snapshot')
    applied=None
    if args.apply_to:
        command=[sys.executable,'-B',R/policy['applyScript'],'apply','--candidate-root',out/'program','--candidate-manifest',out/'program-entry-manifest.json','--candidate-manifest-sha256',build.file_pin(out/'program-entry-manifest.json')['sha256'],'--target',args.apply_to,'--target-manifest',args.target_manifest,'--target-manifest-sha256',args.target_manifest_sha256,'--work-root',args.apply_work,'--node',args.node]
        run('same-path-apply',command)
        applied={'target':str(args.apply_to),'installedManifest':build.file_pin(args.apply_work/'installed-entry-manifest.json'),'state':build.file_pin(args.apply_work/'state.json')}
    write('update-receipt.json',{'status':'official metadata/input verified and supported complete candidate generated; application not launched','version':feed['version'],'entrySources':source_pins,'sourceFilesSha256':built['sourceFilesSha256'],'programZip':built['programZip'],'sourceZip':built['sourceZip'],'buildReceipt':build.file_pin(out/'build-receipt.json'),'cacheReuse':{'installer':reused_installer,'extractedTree':reused_vendor},'samePathApply':applied,'formalSwitchExecuted':False,'dataReadCreatedOrMigrated':False})
    print(json.dumps({'status':'isolated official-input update complete','version':feed['version'],'receipt':str(work/'update-receipt.json'),'programRoot':built['programRoot']}))

if __name__=='__main__':main()
