#!/usr/bin/env python3
"""Actual installed DSH HTTP/bundle authorization. Own loopback Host and synthetic MCP peer."""
import argparse, pathlib, tempfile, json, hashlib, os, shutil, subprocess, time, re
import http.cookiejar, urllib.request, urllib.error, concurrent.futures, signal
p=argparse.ArgumentParser()
for name in ['prefix','bridge','media','image-size','out']:p.add_argument('--'+name,required=True,type=pathlib.Path)
p.add_argument('--port',type=int,default=39307);p.add_argument('--mode',choices=['full','optional-profile'],default='full');a=p.parse_args();here=pathlib.Path(__file__).resolve().parent
prefix=a.prefix.resolve();a.out.mkdir(parents=True,exist_ok=True);run=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=a.out.resolve()));private=run/'private';private.mkdir();evidence=run/'evidence';evidence.mkdir()
home=private/'home';profile=home/'profiles/web';(profile/'node_modules').mkdir(parents=True);workspace=private/'workspace';workspace.mkdir();agents=private/'agents';agents.mkdir()
fixture=private/'fixture';fixture.mkdir();(fixture/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True);shutil.copyfile(here/'plugin-config-r6-fixture.mjs',fixture/'index.mjs')
(fixture/'locale').mkdir();(fixture/'locale/en.json').write_text(json.dumps({'meta':{'title':'Module title must not win'}}));(fixture/'locale/zh.json').write_text(json.dumps({'meta':{'title':'不是本轮列表标题'}}))
(fixture/'package.json').write_text(json.dumps({'name':'wave10-r7-fixture','version':'1.0.0','type':'module','exports':{'.':'./index.mjs','./package.json':'./package.json','./locale/en.json':'./locale/en.json','./locale/zh.json':'./locale/zh.json'}}))
observer=private/'observer';observer.mkdir();(observer/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True);shutil.copyfile(here/'plugin-config-r7-observer.mjs',observer/'index.mjs')
media=private/'dsh-media';shutil.copytree(a.media.resolve(),media,ignore=shutil.ignore_patterns('node_modules','test'));(media/'node_modules').mkdir();(media/'node_modules/@deepseek-ai').symlink_to(prefix/'node_modules/@deepseek-ai',target_is_directory=True);(media/'node_modules/image-size').symlink_to(a.image_size.resolve(),target_is_directory=True)
for name,target in [('wave10-r7-fixture',fixture),('dsh-media',media)]:(profile/'node_modules'/name).symlink_to(target,target_is_directory=True)
(profile/'node_modules/wave10-core-alias').symlink_to(prefix/'node_modules/@deepseek-ai/dsh-sandbox-policy',target_is_directory=True)
mcp=private/'synthetic-mcp.mjs';shutil.copyfile(here/'plugin-config-r7-mcp.mjs',mcp);mcp_record=private/'mcp-processes.jsonl'
raw={'title':'normal','count':1,'explicit':'SYNTHETIC_R6_EXPLICIT','nil':None,'empty':'','bool':False,'zero':0,'equal':'SYNTHETIC_R6_DEFAULT','boundary':'','structEmpty':{},'structArray':[],'structUnknown':{'unused':'public'},'structNonempty':{'token':'SYNTHETIC_R6_EXPLICIT'}}
bundle_dirs={}
def bundle(name,rows,title=None):
 d=private/name;d.mkdir();(d/'node_modules').symlink_to(profile/'node_modules',target_is_directory=True);(d/'index.mjs').write_text('export function apply(){}\n')
 package={'name':name,'version':'1.0.0','type':'module','exports':{'.':'./index.mjs','./package.json':'./package.json','./cordis.patch.yml':'./cordis.patch.yml','./locale/*.json':'./locale/*.json'},'dependencies':{'wave10-r7-fixture':'file:'+str(fixture),'dsh-media':'file:'+str(media)},'dsh':{'bundle':{'patch':'./cordis.patch.yml'}}}
 (d/'package.json').write_text(json.dumps(package));(d/'cordis.patch.yml').write_text(json.dumps([{'insert':rows}]))
 if title:
  (d/'locale').mkdir()
  for lang,value in title.items():(d/'locale'/f'{lang}.json').write_text(json.dumps({'meta':{'title':value}}))
 (profile/'node_modules'/name).symlink_to(d,target_is_directory=True);bundle_dirs[name]=d;return d
main_rows=[{'id':id,'name':'wave10-r7-fixture','config':raw if id=='normal' else {'count':1}}for id in ['normal','home-covered','home-same','cli-covered','flag-only','ambiguous','race']]
main_rows += [{'id':'dsh-media','name':'dsh-media'},{'id':'core-alias','name':'wave10-core-alias','disabled':True}]
bundle('wave10-r7-bundle',main_rows,{'en':'R7 installed bundle','zh':'R7 自装套件'})
bundle('wave10-r7-disabled',[{'id':'disabled-owner','name':'wave10-r7-fixture'}])
bundle('wave10-r7-duplicate',[{'id':'ambiguous','name':'wave10-r7-fixture'}])
bundle('wave10-r7-error',[{'id':'error-entry','name':'wave10-r7-fixture','config':{'count':1}}])
manifest=profile/'package.json';manifest_value={'name':'own-r7-profile','version':'1.0.0','private':True,'dependencies':{**{name:'file:'+str(d)for name,d in bundle_dirs.items()},'wave10-r7-fixture':'file:'+str(fixture),'dsh-media':'file:'+str(media)},'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','@deepseek-ai/dsh-experimental-voice-input-bundle','@deepseek-ai/dsh-experimental-session-search','wave10-r7-bundle','wave10-r7-error']}}}
manifest.write_text(json.dumps(manifest_value))
optional_copy=None
if a.mode=='optional-profile':
 optional_name='@deepseek-ai/dsh-experimental-api-speech-to-text';optional_copy=private/'optional-profile-copy';shutil.copytree(prefix/'node_modules'/optional_name,optional_copy,ignore=shutil.ignore_patterns('node_modules'));(optional_copy/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
 (profile/'node_modules/@deepseek-ai').mkdir();(profile/'node_modules'/optional_name).symlink_to(optional_copy,target_is_directory=True);manifest_value['dependencies'][optional_name]='file:'+str(optional_copy);manifest.write_text(json.dumps(manifest_value))
phone={'id':'dsh-app-phone','name':'@deepseek-ai/dsh-mcp-client','config':{'transport':'stdio','serverName':'wave10_phone','command':shutil.which('node'),'args':[str(mcp)],'cwd':str(workspace),'env':{'R7_MCP_RECORD':str(mcp_record)},'failOnStartupError':True,'reconnect':{'enabled':False}}}
rows=[{'id':x,'disabled':True}for x in ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]+[{'insert':[phone,{'id':'bare-overlay','name':'wave10-r7-fixture','config':{'count':1}},{'id':'disabled-owner','name':'wave10-r7-fixture','config':{'count':1}},{'id':'r7-observer','name':str(observer/'index.mjs')},{'id':'dsh-go-bridge','name':str(a.bridge.resolve()/'lib/index.js')}]}]
patch=profile/'cordis.patch.yml';patch.write_text(json.dumps(rows));home_patch=home/'cordis.patch.yml';home_patch.write_text(json.dumps([{'id':'home-covered','config':{'count':2}},{'id':'home-same','config':{'count':1}},{'id':'flag-only','disabled':False},{'insert':[{'id':'home-insert','name':'wave10-r7-fixture','config':{'count':1}}]}]))
overlay=private/'overlay.yml';overlay.write_text(json.dumps([{'id':'cli-covered','config':{'count':3}},{'id':'speech-to-text-sensevoice','config':{'dataRoot':str(private/'sensevoice'),'modelDirectory':str(private/'offline-models'),'vadModelPath':str(private/'offline-vad.onnx')}},{'insert':[{'id':'cli-insert','name':'wave10-r7-fixture','config':{'count':1}}]}]))
env={k:os.environ[k]for k in ['PATH','LANG','LC_ALL','TMPDIR']if k in os.environ};env.update({'TZ':'Asia/Shanghai','DSH_HOME':str(home),'DSH_AGENTS_HOME':str(agents),'DSH_TELEMETRY_DISABLED':'1','UV_USE_IO_URING':'0','R7_BRIDGE':str(a.bridge.resolve())})
base='http://127.0.0.1:'+str(a.port);route='/dsh-go/v1/plugin-config';audit=[];snapshots=[];cleanup=[];sha=lambda b:hashlib.sha256(b).hexdigest()
def save(name,value):(evidence/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def identity(pid):
 try:
  text=pathlib.Path('/proc/'+str(pid)+'/stat').read_text();v=text[text.rindex(')')+2:].split();return {'pid':pid,'state':v[0],'startTicks':int(v[19])}
 except FileNotFoundError:return None
def snapshot(label):
 value={}
 for file in [manifest,patch,home_patch,overlay,*[d/'cordis.patch.yml'for d in bundle_dirs.values()]]:
  data=file.read_bytes();value[str(file.relative_to(private))]={'bytes':len(data),'sha256':sha(data),'text':data.decode()}
 snapshots.append({'label':label,'files':value});save('snapshots.json',snapshots);return value
def request(op,stage,path,data=None,method=None,headers=None):
 req=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':base,**(headers or {})},method=method)
 started=time.monotonic()
 try:
  with op.open(req,timeout=30)as r:status=r.status;text=r.read().decode();meta=dict(r.headers)
 except urllib.error.HTTPError as r:status=r.code;text=r.read().decode();meta=dict(r.headers)
 body=json.loads(text)if text.startswith('{')else text
 assert not any(x in text for x in ['SYNTHETIC_R6_EXPLICIT','SYNTHETIC_R6_DEFAULT','SYNTHETIC_R6_EXCEPTION','SYNTHETIC_R6_DENIED']),text[:200]
 rec={'stage':stage,'method':method or('GET'if data is None else'POST'),'path':path,'request':data,'status':status,'headers':{k:v for k,v in meta.items()if k.lower()in['content-type','cache-control','x-dsh-go-guard']},'response':body,'elapsedSeconds':time.monotonic()-started};audit.append(rec);save('http-audit.json',audit);return status,body,meta
def get(op,stage,id='normal'):
 status,body,_=request(op,stage,route+'/'+id);assert status==200,(id,status,body);return body
def post(op,stage,id,view,ops):return request(op,stage,route+'/'+id,{'revision':view['revision'],'ops':ops})
def observer_get(op,stage):
 status,proof,_=request(op,stage,'/r7-observer');assert status==200;return proof
def atom(file,data):
 tmp=file.with_name(file.name+'.fixture');tmp.write_bytes(data);os.replace(tmp,file)
def run_host(stage,actions):
 log=private/(stage+'.raw.log');log.touch(mode=0o600);handle=log.open('w');host=None
 try:
  command=['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--patch',str(overlay),'--no-open','--host','127.0.0.1','--port',str(a.port)]
  host=subprocess.Popen(command,cwd=workspace,env=env,stdout=handle,stderr=subprocess.STDOUT);deadline=time.monotonic()+45
  while True:
   if host.poll()is not None:raise RuntimeError('Own Host exited; inspect private log')
   token=re.search(r'token=([\w-]+)',log.read_text())
   if token:break
   if time.monotonic()>deadline:raise TimeoutError('Host startup')
   time.sleep(.05)
  op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));op.open(base+'/?token='+token[1],timeout=15).read()
  proof=observer_get(op,stage);assert proof['actualEditorPrototype']and proof['actualManagerPrototype']and proof['actualBridgeCallback']and proof['asyncChange'],proof
  assert proof['sameManagerOriginal']and proof['sameEditorOriginal'],'Cordis original identity changed'
  for name,info in proof['moduleFiles'].items():assert info['sha256']==sha((prefix/'node_modules'/name/'lib/index.js').read_bytes())
  assert all(value==sha((a.bridge.resolve()/name).read_bytes())for name,value in proof['bridgeFiles'].items())
  save(stage+'-identity.json',{'command':command,'proof':proof,'process':identity(host.pid)});actions(op,stage)
 finally:
  if host and host.poll()is None:
   host.terminate()
   try:host.wait(timeout=10)
   except subprocess.TimeoutExpired:host.kill();host.wait(timeout=5)
  handle.close();cleanup.append({'stage':stage,'pid':host.pid if host else None,'returncode':host.returncode if host else None,'childReaped':host is not None and host.poll()is not None,'procObservation':identity(host.pid)if host else None});save('cleanup.json',cleanup)
def first(op,stage):
 before=snapshot('before-reads');proof=observer_get(op,stage);live={x['localId']:x for x in proof['entries']};bundles={x['name']:x for x in proof['bundles']}
 assert live['dsh-app-phone']['state']==2 and live['bare-overlay']['state']==2 and live['disabled-owner']['state']==2
 assert bundles['wave10-r7-bundle']['enabled']and bundles['wave10-r7-bundle']['installed']and bundles['wave10-r7-bundle']['source']
 status,catalog,_=request(op,stage,route);assert status==200;entries={x['entryId']:x for x in catalog['entries']}
 assert entries['normal']['owner']=='installed'and entries['normal']['bundle']=='wave10-r7-bundle';assert entries['normal']['label']=={'en':'R7 installed bundle','zh':'R7 自装套件'},entries['normal']
 assert entries['normal']['writable']and entries['flag-only']['writable'],entries['normal']
 for id in ['speech-to-text','speech-to-text-sensevoice','api-speech-to-text']:
  assert entries[id]['owner']=='optional'and entries[id]['bundle']=='@deepseek-ai/dsh-experimental-voice-input-bundle'and entries[id]['configurable'],entries[id]
  assert entries[id]['label']==bundles['@deepseek-ai/dsh-experimental-voice-input-bundle']['meta']['title'];get(op,stage,id)
 assert entries['speech-to-text']['writable'];assert not entries['speech-to-text-sensevoice']['writable']and entries['speech-to-text-sensevoice']['reason']=='overridden'
 view=get(op,stage);assert {'.'.join(x['path']):x['configured']for x in view['secrets']}=={'explicit':True,'absent':False,'nil':False,'empty':False,'bool':True,'zero':True,'equal':True,'parent.secret':False,'composite.right':False,'rows.0.secret':False,'boundary':False,'structEmpty':False,'structArray':False,'structUnknown':False,'structNonempty':False}
 media_view=get(op,stage,'dsh-media');assert len(media_view['secrets'])==4 and all(not x['configured']for x in media_view['secrets'])
 assert snapshot('after-reads')==before
 assert entries['ambiguous']['configurable']and entries['ambiguous']['bundle']=='wave10-r7-bundle' # Other declaration is disabled, so cannot own this composition.
 denied=['webserver','connection','credentials','sandbox-policy','fs-sandbox','approval','system-prompt','dsh-app-phone','bare-overlay','home-insert','cli-insert','disabled-owner','core-alias','optional-session-query-sqlite']
 for id in denied:
  assert not entries[id]['configurable']and not entries[id]['writable'],(id,entries[id]);assert request(op,stage,route+'/'+id)[0]==403,id
  paths=['command']if id=='dsh-app-phone'else['count']
  for ops in [[{'op':'set','path':paths,'value':'SYNTHETIC_NOT_EXECUTED'}],[{'op':'unset','path':['args']if id=='dsh-app-phone'else paths}],[{'op':'set','path':paths,'value':'SYNTHETIC_NOT_EXECUTED'},{'op':'unset','path':['args']if id=='dsh-app-phone'else paths}]]:
   assert request(op,stage,route+'/'+id,{'revision':'OLD_R6_REVISION','ops':ops})[0]==403,id
 assert entries['dsh-app-phone']['owner']=='overlay'and entries['dsh-app-phone']['bundle']is None
 assert request(op,stage,route+'/include:normal')[0]==404
 assert snapshot('after-denied-writes')==before
 for id in ['home-covered','home-same','cli-covered','speech-to-text-sensevoice']:
  v=get(op,stage,id);assert not v['writable']and entries[id]['reason']=='overridden'
  assert post(op,stage,id,v,[{'op':'set','path':['language']if id=='speech-to-text-sensevoice'else['count'],'value':'synthetic'}])[0]==409
 # A loaded, still active bundle becomes unreadable: its old instance is denied.
 error_path=bundle_dirs['wave10-r7-error']/'cordis.patch.yml';error_bytes=error_path.read_bytes();get(op,stage,'error-entry')
 try:
  atom(error_path,b'{invalid');bad=observer_get(op,stage);assert next(b for b in bad['bundles']if b['name']=='wave10-r7-error').get('error')
  assert request(op,stage,route+'/error-entry')[0]==403;assert request(op,stage,route+'/error-entry',{'revision':'OLD_R6_REVISION','ops':[{'op':'set','path':['count'],'value':2}]})[0]==403
 finally:atom(error_path,error_bytes)
 # Normal writes still use ConfigEditor, including an official optional live field.
 v=get(op,stage,'speech-to-text');assert post(op,stage,'speech-to-text',v,[{'op':'set','path':['language'],'value':'zh'}])[0]==200
 v=get(op,stage);assert post(op,stage,'normal',v,[{'op':'set','path':['count'],'value':5},{'op':'set','path':['live'],'value':'persisted-live'}])[0]==200
 assert post(op,stage,'normal',v,[{'op':'set','path':['count'],'value':6}])[0]==409
 assert post(op,stage,'dsh-media',get(op,stage,'dsh-media'),[{'op':'set','path':['limits','maxImages'],'value':1}])[0]==200
 # Hold the public HMR gate. The HTTP writer queues only after its outside
 # authorization/snapshot; revoke the recorded installation source on disk.
 v=get(op,stage,'race');before_race=snapshot('before-race');old_manifest=manifest.read_bytes();before_live=next(e for e in observer_get(op,stage)['entries']if e['localId']=='race')
 request(op,stage,'/r7-observer',{'action':'hold'})
 try:
  with concurrent.futures.ThreadPoolExecutor(max_workers=1)as pool:
   pending=pool.submit(post,op,stage,'race',v,[{'op':'set','path':['count'],'value':9}]);deadline=time.monotonic()+10
   while True:
    queued=observer_get(op,stage)
    if queued['queued']:break
    if pending.done()or time.monotonic()>deadline:raise AssertionError('writer did not queue behind real HMR gate')
    time.sleep(.03)
   data=json.loads(old_manifest);del data['dependencies']['wave10-r7-bundle'];atom(manifest,json.dumps(data).encode());revoked=observer_get(op,stage)
   b=next(b for b in revoked['bundles']if b['name']=='wave10-r7-bundle');assert b['enabled']and not b['installed']and 'source'not in b
   request(op,stage,'/r7-observer',{'action':'release'});result=pending.result(timeout=20);assert result[0]==403,result
   after_live=next(e for e in observer_get(op,stage)['entries']if e['localId']=='race');assert before_live['uid']==after_live['uid']and after_live['state']==2
   assert patch.read_text()==before_race['home/profiles/web/cordis.patch.yml']['text']
   save('race-proof.json',{'queued':True,'beforeEntry':before_live,'afterEntry':after_live,'revokedBundle':b,'httpStatus':result[0],'profilePatchUnchanged':True,'scope':'actual HTTP plus public HMR gate; operations observed, never replaced; own manifest source revoked by fixture'})
 finally:
  atom(manifest,old_manifest);request(op,stage,'/r7-observer',{'action':'release'})
 assert get(op,stage,'race')['value']['count']==1
 assert request(op,stage,route,headers={'Origin':'https://evil.invalid'})[0]==403
 anonymous=urllib.request.build_opener(urllib.request.ProxyHandler({}));assert request(anonymous,stage,route)[0]in[401,403]
 for method in ['DELETE','PUT']:assert request(op,stage,route,method=method)[0]==405
 snapshot('after-ordinary-writes');save('qualified-catalog.json',{'entries':catalog['entries'],'authoritativeBundles':proof['bundles']})
def restart(op,stage):
 assert get(op,stage)['value']['count']==5 and get(op,stage)['value']['live']=='persisted-live';assert get(op,stage,'dsh-media')['value']['limits']['maxImages']==1
 assert get(op,stage,'speech-to-text')['value']['language']=='zh';assert not get(op,stage,'speech-to-text-sensevoice')['writable'];assert request(op,stage,route+'/dsh-app-phone')[0]==403
 proof=observer_get(op,stage);assert all(x['preparation']['phase']=='unprepared'for x in proof['speech']['providers']);snapshot('after-restart')
def optional_profile(op,stage):
 proof=observer_get(op,stage);source=proof['optionalSource'];assert source['file']==str(optional_copy/'lib/index.js')and source['actualCallback']and source['actualServicePrototype'],source
 assert source['sha256']==sha((prefix/'node_modules/@deepseek-ai/dsh-experimental-api-speech-to-text/lib/index.js').read_bytes())
 view=get(op,stage,'api-speech-to-text');assert view['owner']=='optional'and view['writable'];assert post(op,stage,'api-speech-to-text',view,[{'op':'set','path':['maxDurationSeconds'],'value':121}])[0]==200
 assert get(op,stage,'api-speech-to-text')['value']['maxDurationSeconds']==121
 for id in ['sandbox-policy','webserver','dsh-app-phone','optional-session-query-sqlite']:assert request(op,stage,route+'/'+id)[0]==403
 status,sync,_=request(op,stage,'/r7-observer',{'action':'sync-edit'});assert status==200 and sync['synchronousCallbackApplied'];assert get(op,stage)['value']['count']==4
 status,disposed,_=request(op,stage,'/r7-observer',{'action':'dispose-during-change'});assert status==200 and disposed['rejected']and disposed['profileUnchanged'],disposed
 save('optional-profile-proof.json',{'resolvedSource':source,'ordinaryEditorSynchronousCallback':sync,'asyncCallbackDisposedOwnEntry':disposed,'scope':'same installed optional module relocated into private profile, no package manager or update download; public bridge GET/POST plus two explicitly separate editor compatibility fixture calls'})
 snapshot('optional-profile-after')
try:
 if a.mode=='full':run_host('r7',first);run_host('r7-restart',restart)
 else:run_host('r7-optional-profile',optional_profile)
 save('RESULT.json',{'status':'PASS_REAL_HOST_R7','dshVersion':json.loads((prefix/'node_modules/@deepseek-ai/dsh/package.json').read_text())['version'],'mode':a.mode,'run':str(run),'httpRequests':len(audit),'ownHostsAllGone':all(x['childReaped']for x in cleanup),'mediaToolsExecuted':False,'packageManagerInvoked':False,'speechPreparationInvoked':False,'source':{'prefix':str(prefix),'bridge':str(a.bridge.resolve()),'media':str(a.media.resolve())},'limits':'Linux loopback Host; synthetic MCP peer only; no App fixture/r13 parity or Android/ABI claim'})
 print(json.dumps({'pass':True,'run':str(run),'requests':len(audit)}),flush=True)
except BaseException as error:save('FAILURE.json',{'type':type(error).__name__,'message':str(error)});raise
finally:
 records=[json.loads(line)for line in mcp_record.read_text().splitlines()]if mcp_record.exists()else[];clean=[]
 for item in records:
  current=identity(item['pid']);matched=current is not None and current['startTicks']==item['startTicks']
  if matched and current['state']!='Z':
   os.kill(item['pid'],signal.SIGTERM);deadline=time.monotonic()+3
   while identity(item['pid'])is not None and time.monotonic()<deadline:time.sleep(.03)
  clean.append({'record':item,'before':current,'after':identity(item['pid']),'signalledOnlyIdentityMatchedOwnPeer':matched and current['state']!='Z'})
 save('mcp-cleanup.json',clean);(a.out/'latest-run.txt').write_text(str(run)+'\n')
