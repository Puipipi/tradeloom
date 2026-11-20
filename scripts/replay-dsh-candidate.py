#!/usr/bin/env python3
"""Replay the reviewed versioned SDK, desktop and own-shell recipes into a new directory.

python -B scripts/replay-dsh-candidate.py --source <official-resources/app.asar> \
    --unpacked <official-resources/app.asar.unpacked> --output-root <new-stage>

Produces an ASAR, own business-shell and fresh source provenance, not a complete
installed application. Does not copy an EXE/runtime/profile or start services.
"""
from pathlib import Path
import argparse,copy,hashlib,importlib.util,json,os,shutil,stat,struct,subprocess,sys
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[1]
DEFAULT_VERSION='0.2.2-rc.2'
sha=lambda data:hashlib.sha256(data).hexdigest()
pin=lambda data:{'bytes':len(data),'sha256':sha(data)}

def ordinary(path):
    for item in [path,*path.parents]:
        info=item.lstat()
        if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&0x400:
            raise ValueError(f'reparse input: {item}')

def safe(root,relative):
    parts=relative.replace('\\','/').split('/')
    if not parts or any(part in ('','..','.') or ':' in part for part in parts):raise ValueError(f'invalid relative path: {relative}')
    return root.joinpath(*parts)

def load(path):return json.loads(path.read_text(encoding='utf-8-sig'))
def write_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    with path.open('x',encoding='utf-8',newline='') as stream:json.dump(value,stream,ensure_ascii=False,indent=2);stream.write('\n')

def uses_exact_source(spec, patch_fields):
    mode=spec.get('sourceMode','patch')
    if mode=='exact-source':
        if any(field in spec for field in patch_fields):
            raise ValueError('exact-source recipe cannot also declare patch inputs')
        return True
    if mode!='patch' or any(not spec.get(field) for field in patch_fields):
        raise ValueError('patched recipe requires all patch inputs')
    return False

def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--version',default=DEFAULT_VERSION)
    parser.add_argument('--source',type=Path,required=True)
    parser.add_argument('--unpacked',type=Path,required=True)
    parser.add_argument('--output-root',type=Path,required=True)
    parser.add_argument('--node',default='node')
    parser.add_argument('--derive-pins',action='store_true',help='derive isolated candidate output pins after exact input/patch/integrity checks; never report accepted replay')
    args=parser.parse_args()
    version=args.version
    recipes=load(R/'dsh-base.manifest.json')['base']['upgrade']['recipes']
    if version not in recipes:raise ValueError('unsupported replay version; review the upstream difference first')
    recipe_path=safe(R,recipes[version])
    recipe_root=recipe_path.parent
    source=args.source.resolve();unpacked=args.unpacked.resolve();out=args.output_root.absolute()
    ordinary(source);ordinary(unpacked)
    if unpacked!=Path(str(source)+'.unpacked'):raise ValueError('unpacked must be the matching source.asar.unpacked directory')
    if out.exists():raise ValueError('output already exists; refusing to overwrite')
    ancestor=out.parent
    while not ancestor.exists():ancestor=ancestor.parent
    ordinary(ancestor)
    recipe=load(recipe_path);desktop=load(safe(recipe_root,recipe['desktopRecipe']));business=recipe['businessShell']
    if recipe['version']!=version or desktop['version']!=version:raise ValueError('recipe version mismatch')
    raw=source.read_bytes()
    if pin(raw)!=recipe['officialInput']['appAsar']:raise ValueError('official ASAR preimage drift')
    helperPath=R/'apps/tradeloom-launcher/scripts/write-n01-origin-candidate.py';ordinary(helperPath)
    if sha(helperPath.read_bytes())!='7ef0709fe521e933a53c75ab8c4e8b8bfd4b449b78d789edda1537e7cd8d636b':raise ValueError('ASAR helper drift')
    spec=importlib.util.spec_from_file_location('dsh_replay_asar_helper',helperPath);helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)
    header,offset=helper.parse_asar(raw);oldRows=dict(helper.walk_asar_files(header))
    out.mkdir(parents=True);evidence=out/'evidence';evidence.mkdir()
    consumed={}
    def repo_bytes(relative,target=None):
        path=safe(R,relative);ordinary(path);data=path.read_bytes()
        row={'sourcePath':relative,**pin(data)}
        if target is not None:row['target']=target
        consumed[relative]=row
        return data
    for path in [Path(__file__).resolve(),helperPath,R/'scripts/upgrade-dsh-base.mjs',R/'dsh-base.manifest.json']:
        repo_bytes(path.relative_to(R).as_posix())
    for path in sorted(recipe_root.iterdir()):
        if path.is_file():repo_bytes(path.relative_to(R).as_posix())
    for row in recipe['copies']:repo_bytes(row['source'],row['destination'])
    def run(name,command,cwd=out):
        result=subprocess.run(command,cwd=cwd,capture_output=True)
        (evidence/(name+'.stdout.log')).write_bytes(result.stdout);(evidence/(name+'.stderr.log')).write_bytes(result.stderr)
        write_json(evidence/(name+'.command.json'),{'command':[str(arg) for arg in command],'cwd':str(cwd),'actualExitCode':result.returncode})
        if result.returncode:raise RuntimeError(f'{name} failed; see evidence/{name}.stderr.log')
        return result
    def verify(root,images):
        for relative,expected in images.items():
            if pin(safe(root,relative).read_bytes())!=expected:raise ValueError(f'image drift: {relative}')
    def original(relative):
        entry=oldRows[relative]
        if entry.get('unpacked'):
            path=safe(unpacked,relative);ordinary(path);data=path.read_bytes()
        else:
            start=offset+int(entry['offset']);data=raw[start:start+entry['size']]
        if len(data)!=entry['size']:raise ValueError(f'original size mismatch: {relative}')
        if entry.get('integrity') and sha(data)!=entry['integrity']['hash']:raise ValueError(f'original integrity mismatch: {relative}')
        return data
    sdk=out/'sdk'
    run('sdk-recipe',[args.node,str(R/'scripts/upgrade-dsh-base.mjs'),'--source',str(source),'--version',version,'--stage',str(sdk)])
    verify(sdk,recipe['postimages'])
    desktopRoot=out/'desktop';desktopRoot.mkdir()
    for relative,expected in desktop['preimages'].items():
        data=original(relative)
        if pin(data)!=expected:raise ValueError(f'desktop preimage drift: {relative}')
        path=safe(desktopRoot,relative);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    run('desktop-patch',['git','-c','core.autocrlf=false','-c','core.eol=lf','apply','--whitespace=nowarn',str(safe(recipe_root,desktop['patch']))],desktopRoot)
    verify(desktopRoot,desktop['postimages'])
    for target,row in desktop['sources'].items():
        data=repo_bytes(row['source'],target)
        if pin(data)!=row['preimage']:raise ValueError(f'owned source drift: {row["source"]}')
        if row.get('normalizeLineEndings')=='lf':data=data.replace(b'\r\n',b'\n')
        if row.get('replace'):
            change=row['replace'];before=change['from'].encode();after=change['to'].encode()
            if data.count(before)!=change['count']:raise ValueError(f'owned transform drift: {target}')
            data=data.replace(before,after)
        if pin(data)!=desktop['additions'][target]:raise ValueError(f'owned postimage drift: {target}')
        path=safe(desktopRoot,target);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    # Ordered final own-feature overlay: the official desktop patch runs first,
    # then the declared source map is copied/transformed once. Only now do these
    # own controller/replica files exist. Do not apply this patch in both stages.
    final=desktop.get('finalOverlay')
    desktop_postimages={**desktop['postimages'],**desktop['additions']}
    if final:
        if set(final)!={'patch','preimages','postimages'} or set(final['preimages'])!=set(final['postimages']):raise ValueError('invalid final desktop overlay contract')
        if not set(final['preimages'])<=set(desktop_postimages):raise ValueError('final desktop overlay exceeds declared input map')
        verify(desktopRoot,final['preimages'])
        run('seven-features-desktop-patch',['git','-c','core.autocrlf=false','-c','core.eol=lf','apply','--whitespace=nowarn',str(safe(recipe_root,final['patch']))],desktopRoot)
        verify(desktopRoot,final['postimages'])
        desktop_postimages.update(final['postimages'])
    exact_business=uses_exact_source(business,('patch','packageSource'))
    shell=out/'business-shell';shell.mkdir();packageBytes=repo_bytes(business['sourceRoot']+'/package.json')
    if pin(packageBytes)!=business['sourcePackage']:raise ValueError('formal package preimage drift')
    package=json.loads(packageBytes)
    packaged_files=['package.json',*package['files']]
    if exact_business and (set(packaged_files)!=set(business['preimages']) or business['preimages']!=business['postimages']):
        raise ValueError('exact-source business pins must cover the complete package')
    for relative in packaged_files:
        data=repo_bytes(business['sourceRoot']+'/'+relative,'business-shell/'+relative)
        path=safe(shell,relative);path.parent.mkdir(parents=True,exist_ok=True);path.write_bytes(data)
    verify(shell,business['preimages'])
    if not exact_business:
        run('business-patch',['git','-c','core.autocrlf=false','-c','core.eol=lf','apply','--whitespace=nowarn',str(safe(recipe_root,business['patch']))],shell)
        (shell/'package.json').write_bytes(safe(recipe_root,business['packageSource']).read_bytes())
    business_postimages={relative:pin(safe(shell,relative).read_bytes()) for relative in business['postimages']}
    business_postimages_exact=business_postimages==business['postimages']
    if not args.derive_pins:verify(shell,business['postimages'])
    overrides={relative:safe(sdk,relative).read_bytes() for relative in recipe['postimages']}
    overrides.update({relative:safe(desktopRoot,relative).read_bytes() for relative in desktop_postimages})
    expected={};sidecars={};cursor=0;parts=[];payloads={}
    # Insert every new leaf before walking the final tree. Surgical ASAR updates
    # use this same traversal, so additions retain their directory payload order.
    for relative,data in sorted(overrides.items()):
        if relative not in oldRows:helper.set_asar_file(header,relative,data,0)
    for relative,entry in helper.walk_asar_files(header):
        if relative not in oldRows:
            payloads[relative]=overrides[relative]
            continue
        data=original(relative)
        if entry.get('unpacked'):
            sidecars[relative]=pin(data)
            if relative in overrides:raise ValueError('inline overlay cannot replace an unpacked entry')
            continue
        payloads[relative]=overrides.get(relative,data)
    for relative,data in payloads.items():
        expected[relative]=pin(data);helper.set_asar_file(header,relative,data,cursor);parts.append(data);cursor+=len(data)
    target=out/'app.asar'
    with target.open('xb') as stream:
        stream.write(helper.encode_asar(header,b''))
        for data in parts:stream.write(data)
    parts.clear()
    actual=target.read_bytes();newHeader,newOffset=helper.parse_asar(actual);newRows=dict(helper.walk_asar_files(newHeader))
    if set(newRows)!=set(expected)|set(sidecars):raise ValueError('ASAR entry set mismatch')
    extents=[]
    for relative,entry in newRows.items():
        if entry.get('unpacked'):
            if entry!=oldRows[relative] or pin(original(relative))!=sidecars[relative]:raise ValueError(f'unpacked entry changed: {relative}')
            continue
        start=newOffset+int(entry['offset']);end=start+entry['size'];data=actual[start:end]
        if not newOffset<=start<=end<=len(actual) or pin(data)!=expected[relative]:raise ValueError(f'ASAR payload mismatch: {relative}')
        extents.append((start,end,relative))
        if relative in oldRows:
            prior=oldRows[relative]
            if {k:v for k,v in entry.items() if k not in ['offset','size','integrity']}!={k:v for k,v in prior.items() if k not in ['offset','size','integrity']}:raise ValueError(f'ASAR flags changed: {relative}')
        if entry.get('integrity'):
            integrity=entry['integrity'];block=integrity['blockSize']
            if integrity['algorithm']!='SHA256' or block<=0 or integrity['hash']!=sha(data):raise ValueError('invalid ASAR integrity')
            blocks=[sha(data[i:i+block]) for i in range(0,len(data),block)]
            if not data:
                if integrity['blocks'] not in ([],[sha(b'')]):raise ValueError('invalid empty-file integrity blocks')
            elif blocks!=integrity['blocks']:raise ValueError('invalid ASAR integrity blocks')
    position=newOffset
    for start,end,relative in sorted(extents):
        if start!=position:raise ValueError(f'ASAR overlap/gap: {relative}')
        position=end
    if position!=len(actual):raise ValueError('ASAR trailing payload')
    wanted=recipe['expectedAsar'];asarPin=pin(actual)
    logicalExact=len(newRows)==wanted['logicalEntries'] and len(sidecars)==wanted['unpackedFiles']
    containerExact=asarPin=={key:wanted.get(key) for key in ['bytes','sha256']}
    write_json(evidence/'asar-readback.json',{'actual':asarPin,'expected':wanted,'logicalEntries':len(newRows),'unpackedFiles':len(sidecars),'allExpectedPayloadsExact':True,'allIntegrityBlocksExact':True,'noOverlapOrGap':True,'containerBytesExact':containerExact,'logicalCountsExact':logicalExact})
    if not logicalExact or not containerExact and not args.derive_pins:raise ValueError('fixed ASAR differs from accepted target; do not rewrite expected pins or repack')
    validator_input=business.get('validatorInput')
    if not isinstance(validator_input,dict) or set(validator_input)!={'source','bytes','sha256'}:raise ValueError('explicit business validator source pin required')
    validator=validator_input['source'];validatorBytes=repo_bytes(validator)
    if pin(validatorBytes)!={key:validator_input[key] for key in ['bytes','sha256']}:raise ValueError('declared business validator source drift')
    business_inventory=business['inventory']
    if args.derive_pins:
        records=[]
        for path in sorted(shell.rglob('*')):
            ordinary(path)
            if path.is_file():records.append({'path':path.relative_to(shell).as_posix(),**pin(path.read_bytes())})
        record_path=evidence/'business-derived-records.json';write_json(record_path,records)
        digest_script='import{digestInventory}from '+json.dumps((R/validator).as_uri())+';import{readFile}from"node:fs/promises";console.log(digestInventory(JSON.parse(await readFile(process.argv[1],"utf8"))));'
        digest=run('business-derived-digest',[args.node,'--input-type=module','-e',digest_script,str(record_path)]).stdout.decode().strip()
        if len(digest)!=64 or any(char not in '0123456789abcdef' for char in digest):raise ValueError('invalid original-validator inventory digest')
        business_inventory={'fileCount':len(records),'bytes':sum(row['bytes'] for row in records),'sha256':digest}
    sourceFiles=sorted(consumed.values(),key=lambda row:row['sourcePath']);sourceDigest=sha(json.dumps(sourceFiles,ensure_ascii=False,sort_keys=True,separators=(',',':')).encode())
    head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=R,text=True).strip();dirty=bool(subprocess.check_output(['git','status','--porcelain'],cwd=R,text=True))
    sourceBuild={'ownSourceHead':head,'ownSourceDirty':dirty,'ownSourceFilesSha256':sourceDigest,'appMainSha256':desktop_postimages['lib/main.js']['sha256'],'assemblyKind':'fixed-version source/ASAR replay; not full program installation','vendorVersion':version,'lock':{'upstream':recipe['officialInput'],'patches':{path.name:sha(path.read_bytes()) for path in sorted(recipe_root.iterdir()) if path.is_file()}}}
    metadata={'schemaVersion':1,'artifactScope':'ASAR and own business-shell only; native program payloads not copied or re-certified','sourceBuild':sourceBuild,'resources':{'businessShell':{'version':json.loads((shell/'package.json').read_bytes())['version'],**business_inventory}}}
    write_json(out/'deployment.json',metadata);write_json(out/'source-manifest.json',{'head':head,'dirty':dirty,'sourceFilesSha256':sourceDigest,'sourceFiles':sourceFiles})
    validate=r'''
import assert from 'node:assert/strict';import * as fs from 'node:fs/promises';import path from 'node:path';import {createHash} from 'node:crypto';import vm from 'node:vm';
const [sourcePath,shell,metadataPath]=process.argv.slice(1),source=await fs.readFile(sourcePath,'utf8');
const names=['safeRelative','digestInventory','isInside','assertOrdinaryPath','inventoryOrdinaryFiles','verifyBusinessShell'],NL=String.fromCharCode(10);
const snippets=names.map(name=>{const head=source.indexOf('function '+name+'(');assert.ok(head>=0);const start=source.slice(head-6,head)==='async '?head-6:head;const end=source.indexOf(NL+'}',head);assert.ok(end>head);return source.slice(start,end+2);});
const actual=vm.runInNewContext(snippets.join(NL)+NL+';({verifyBusinessShell,digestInventory})',{path,createHash});
const metadata=JSON.parse(await fs.readFile(metadataPath,'utf8')),verified=await actual.verifyBusinessShell(metadata,shell,fs),records=JSON.parse(JSON.stringify(verified.records));
console.log(JSON.stringify({nativeFs:true,readProjection:false,fileCount:records.length,bytes:records.reduce((n,r)=>n+r.bytes,0),sha256:actual.digestInventory(records),records}));
'''
    result=run('business-nativefs',[args.node,'--input-type=module','-e',validate,str(R/validator),str(shell),str(out/'deployment.json')]);inventory=json.loads(result.stdout)
    if {key:inventory[key] for key in ['fileCount','bytes','sha256']}!=business_inventory:raise ValueError('business inventory differs from exact stage inventory')
    write_json(evidence/'business-nativefs-readback.json',inventory)
    status_version='rc2' if version==DEFAULT_VERSION else version
    status='isolated output pins derived; not accepted replay' if args.derive_pins else f'fixed {status_version} replay exact'
    result={'status':status,'version':version,'asar':asarPin,'logicalEntries':len(newRows),'unpackedFiles':len(sidecars),'businessShell':business_inventory,'sourceFiles':len(sourceFiles),'sourceFilesSha256':sourceDigest,'sourceBuild':sourceBuild,'SDKPreimages':len(recipe['preimages']),'SDKPostimages':len(recipe['postimages']),'desktopPostimages':desktop_postimages,'businessPostimages':business_postimages,'allOutputsMatchAcceptedPayloads':containerExact and business_postimages_exact and business_inventory==business['inventory'],'sourceOnlyReplay':True,'appStarted':False,'fullProgramCopied':False}
    if args.derive_pins:write_json(out/'derived-output-pins.json',{**result,'recipeChanged':False,'acceptedClaim':False,'priorExpectedAsar':wanted,'priorBusinessInventory':business['inventory'],'priorBusinessPostimages':business['postimages']})
    write_json(out/'RESULTS.json',result)
    print(json.dumps({'status':status,'output':str(out),'asar':asarPin,'business':business_inventory,'sourceFiles':len(sourceFiles)}))

if __name__=='__main__':main()
