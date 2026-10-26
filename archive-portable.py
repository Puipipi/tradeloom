import hashlib,json,pathlib,stat,sys,zipfile
stage=pathlib.Path(__file__).parent
root=stage/'TradeLoom-desktop16-portable-win-x64'
if sys.platform=='win32':root=pathlib.Path('\\\\?\\'+str(root.resolve()))
out=stage/'TradeLoom-desktop16-portable-win-x64.zip'
archive_root='TradeLoom'
def sha(p):
    h=hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()
licenses=[]
for p in root.rglob('*'):
    if p.is_file() and p.name.lower().startswith(('license','licence','copying','notice')):
        licenses.append(p.relative_to(root).as_posix())
(root/'licenses/license-file-index.json').write_text(json.dumps(sorted(licenses),indent=2)+'\n',encoding='utf-8')
files=[]
for p in sorted(root.rglob('*')):
    if p.is_symlink():raise RuntimeError('Refuse symlink '+str(p))
    if p.is_file() and p.relative_to(root).as_posix() not in ('SHA256SUMS.txt','file-manifest.json'):
        files.append({'path':p.relative_to(root).as_posix(),'bytes':p.stat().st_size,'sha256':sha(p)})
identity=json.loads((root/'build-identity.json').read_text('utf-8'))
manifest={'schemaVersion':1,'identity':identity,'manifestSelfExcluded':True,'files':files}
(root/'file-manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
sum_files=files+[{'path':'file-manifest.json','sha256':sha(root/'file-manifest.json')}]
(root/'SHA256SUMS.txt').write_text(''.join(f"{f['sha256']}  {f['path']}\n" for f in sorted(sum_files,key=lambda x:x['path'])),encoding='utf-8')
if out.exists():raise RuntimeError('Archive exists; preserve it and choose a new output name')
print(json.dumps({'stage':'hash-manifest-complete','files':len(files),'payloadBytes':sum(f['bytes'] for f in files)}),flush=True)
with zipfile.ZipFile(out,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=5,allowZip64=True) as z:
    for p in sorted(root.rglob('*')):
        if p.is_file():z.write(p,archive_root+'/'+p.relative_to(root).as_posix())
with zipfile.ZipFile(out) as z:
    bad=z.testzip()
    if bad:raise RuntimeError('ZIP CRC failure '+bad)
    count=len(z.infolist())
receipt={'artifact':out.name,'archiveRoot':archive_root,'bytes':out.stat().st_size,'sha256':sha(out),'zipEntries':count,'zipCRC':'passed','gitHubSingleAssetUnder2GiB':out.stat().st_size<2*1024**3,'payloadManifestFiles':len(files),'maxPayloadRelativePathLength':max(len(f['path']) for f in files),'licenseFilesIndexed':len(licenses),'guiVerification':'not-repeated-after-final-bootstrap-corrections; actual headless Host route proof is separate'}
(stage/'archive-receipt.json').write_text(json.dumps(receipt,indent=2)+'\n',encoding='utf-8')
print(json.dumps(receipt),flush=True)
