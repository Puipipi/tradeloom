import hashlib,json,os,pathlib,subprocess,zipfile,sys
stage=pathlib.Path(__file__).parent
archive=stage/'TradeLoom-desktop16-portable-win-x64.zip'
dest=stage/'verification-data/clean extract space 07'
data=stage/'verification-data/clean user data 07'
if dest.exists():raise RuntimeError('Clean destination already exists; preserve previous evidence')
extract_dest=pathlib.Path('\\\\?\\'+str(dest.resolve())) if sys.platform=='win32' else dest
with zipfile.ZipFile(archive) as z:
    if z.testzip() is not None:raise RuntimeError('CRC failure')
    z.extractall(extract_dest)
root=extract_dest/'TradeLoom'
checked=0
for line in (root/'SHA256SUMS.txt').read_text('utf-8').splitlines():
    digest,relative=line.split('  ',1)
    p=root/relative
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    if h.hexdigest()!=digest:raise RuntimeError('Hash mismatch '+relative)
    checked+=1
env=dict(os.environ)
windows=env.get('SystemRoot',r'C:\Windows')
env['PATH']=windows+r'\System32;'+windows
env['NODE_PATH']=r'Z:\not-existing-developer-node-modules'
env['NODE_OPTIONS']='--require=not-existing-developer-hook'
env['DSH_HOME']=r'Z:\not-existing-developer-home'
env['DSH_AGENTS_HOME']=r'Z:\not-existing-developer-agents'
wrapper=stage/'verification-data/clean-preflight.cmd'
wrapper.write_text('@echo off\r\ncall "'+str(dest/'TradeLoom/Start-TradeLoom.cmd')+'" --check --data-root "'+str(data)+'"\r\nexit /b %errorlevel%\r\n',encoding='utf-8')
result=subprocess.run([windows+r'\System32\cmd.exe','/d','/c',str(wrapper)],env=env,cwd=dest,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=60)
(stage/'verification-data/clean-preflight.stdout.txt').write_text(result.stdout,encoding='utf-8')
(stage/'verification-data/clean-preflight.stderr.txt').write_text(result.stderr,encoding='utf-8')
receipt={'archiveCRC':'passed','extractedFilesHashVerified':checked,'cleanPathContainsSpaces':True,'systemOnlyPATH':True,'hostileInheritedNodeVariables':'NODE_OPTIONS/NODE_PATH cleared by cmd launcher','inheritedDshHome':'ignored and replaced by explicit data root','launcherExitCode':result.returncode,'guiStarted':False,'dataRootRelativeToStage':data.relative_to(stage).as_posix(),'electronDataRelativeToDataRoot':'local-app-data/TradeLoom/desktop/user-data'}
(stage/'clean-extract-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print(json.dumps(receipt))
if result.returncode:raise RuntimeError('Clean extracted cmd preflight failed; see local verification stdout/stderr')
