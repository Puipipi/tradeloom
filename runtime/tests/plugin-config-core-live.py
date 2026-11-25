#!/usr/bin/env python3
"""R4 read-only baseline and R5 formal HTTP boundary, isolated real rc4 Hosts."""
import argparse,pathlib,tempfile,json,hashlib,os,shutil,subprocess,time,re,http.cookiejar,urllib.request,urllib.error
p=argparse.ArgumentParser()
for name in ['prefix','old-bridge','bridge','media','image-size','out']:p.add_argument('--'+name,required=True,type=pathlib.Path)
p.add_argument('--port',type=int,default=39303);a=p.parse_args()
here=pathlib.Path(__file__).resolve().parent;prefix=a.prefix.resolve();a.out.mkdir(parents=True,exist_ok=True);run=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=a.out.resolve()));private=run/'private';private.mkdir();evidence=run/'evidence';evidence.mkdir()
home=private/'home';profile=home/'profiles/web';(profile/'node_modules').mkdir(parents=True);workspace=private/'workspace';workspace.mkdir();agents=private/'agents';agents.mkdir()
observer=private/'observer';observer.mkdir();shutil.copyfile(here/'plugin-config-core-observer.mjs',observer/'observer.mjs');(observer/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
media=private/'dsh-media';shutil.copytree(a.media.resolve(),media,ignore=shutil.ignore_patterns('node_modules','test'));(media/'node_modules').mkdir();(media/'node_modules/@deepseek-ai').symlink_to(prefix/'node_modules/@deepseek-ai',target_is_directory=True);(media/'node_modules/image-size').symlink_to(a.image_size.resolve(),target_is_directory=True)
third=private/'third-party';third.mkdir();(third/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
(third/'package.json').write_text(json.dumps({'name':'wave10-core-boundary-plugin','version':'1.0.0','type':'module','main':'index.mjs','exports':{'.':'./index.mjs','./package.json':'./package.json'},'dsh':{'bundle':{'patch':'cordis.patch.yml'}}}))
(third/'index.mjs').write_text("import Schema from '@deepseek-ai/schemastery';\nexport const name='wave10-core-boundary-plugin';\nexport const Config=Schema.object({title:Schema.string().default('own local fixture'),count:Schema.number().default(1),secret:Schema.string().role('secret')});\nexport function apply(){}\n")
(third/'cordis.patch.yml').write_text(json.dumps([{'insert':[{'id':'own-config-plugin','name':'wave10-core-boundary-plugin','config':{'secret':'SYNTHETIC_ONLY_SECRET'}}]}]))
wrapper=private/'media-wrapper';wrapper.mkdir();(wrapper/'package.json').write_text(json.dumps({'name':'wave10-core-media-wrapper','version':'1.0.0','private':True,'dependencies':{'dsh-media':'0.1.0-m0.2'},'dsh':{'bundle':{'patch':'cordis.patch.yml'}}}));(wrapper/'cordis.patch.yml').write_text(json.dumps([{'insert':[{'id':'dsh-media','name':'dsh-media'}]}]))
for name,target in [('wave10-core-boundary-plugin',third),('wave10-core-media-wrapper',wrapper),('dsh-media',media)]:
 (profile/'node_modules'/name).symlink_to(target,target_is_directory=True)
(profile/'package.json').write_text(json.dumps({'name':'own-r5-core-profile','version':'1.0.0','private':True,'dependencies':{'wave10-core-boundary-plugin':'1.0.0','wave10-core-media-wrapper':'1.0.0'},'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','wave10-core-boundary-plugin','wave10-core-media-wrapper','@deepseek-ai/dsh-experimental-session-search']}}}))
active=private/'active-bridge';active.symlink_to(a.old_bridge.resolve(),target_is_directory=True)
patches=[{'id':x,'disabled':True} for x in ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]
patches += [{'insert':[{'id':'dsh-go-bridge','name':str(active/'lib/index.js')},{'id':'r5-core-observer','name':str(observer/'observer.mjs')}]}]
(profile/'cordis.patch.yml').write_text(json.dumps(patches))
env={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','TMPDIR'] if k in os.environ};env.update({'TZ':'Asia/Shanghai','DSH_HOME':str(home),'DSH_AGENTS_HOME':str(agents),'DSH_TELEMETRY_DISABLED':'1','UV_USE_IO_URING':'0','CORE_FIXTURE_BRIDGE':str(active)})
base='http://127.0.0.1:'+str(a.port);route='/dsh-go/v1/plugin-config';audit=[];snapshots=[];cleanup=[];core=['webserver','connection','credentials','sandbox-policy','fs-sandbox','approval','system-prompt'];old={}
sha=lambda data:hashlib.sha256(data).hexdigest()
def identity(pid):
 try:
  text=pathlib.Path('/proc/'+str(pid)+'/stat').read_text();s=text[text.rindex(')')+2:].split();return {'pid':pid,'state':s[0],'startTicks':int(s[19])}
 except FileNotFoundError:return None
def save(name,value):(evidence/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def snapshot(label):
 value={}
 for name in ['package.json','cordis.patch.yml','pnpm-lock.yaml','package.json.lock','.plugin-manager/run.json']:
  f=profile/name;data=f.read_bytes() if f.exists() else None;value[name]={'exists':data is not None,'bytes':len(data) if data is not None else None,'sha256':sha(data) if data is not None else None,'text':data.decode() if data is not None else None}
 snapshots.append({'label':label,'files':value});save('snapshots.json',snapshots);return value
def request(op,stage,path,data=None,headers=None,method=None):
 req=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':base,**(headers or {})},method=method)
 try:
  with op.open(req,timeout=30) as response:status=response.status;text=response.read().decode()
 except urllib.error.HTTPError as error:status=error.code;text=error.read().decode()
 body=json.loads(text) if text.startswith('{') else text
 assert 'SYNTHETIC_ONLY_SECRET' not in text
 audit.append({'stage':stage,'method':method or ('GET' if data is None else 'POST'),'path':path,'status':status,'request':data,'response':body});save('http-audit.json',audit);return status,body
def run_host(stage,actions):
 log=private/(stage+'.raw.log');log.touch(mode=0o600);handle=log.open('w');host=None
 try:
  host=subprocess.Popen(['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--no-open','--host','127.0.0.1','--port',str(a.port)],cwd=workspace,env={**env,'CORE_FIXTURE_STAGE':stage},stdout=handle,stderr=subprocess.STDOUT)
  deadline=time.monotonic()+40
  while True:
   assert host.poll() is None,'Own Host exited; inspect private log';token=re.search(r'token=([\w-]+)',log.read_text())
   if token:break
   if time.monotonic()>deadline:raise TimeoutError('startup')
   time.sleep(.05)
  op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));op.open(base+'/?token='+token[1],timeout=10).read()
  status,proof=request(op,stage,'/r5-core-observer');assert status==200;save(stage+'-loaded-source.json',proof)
  expected=a.old_bridge.resolve() if stage=='r4' else a.bridge.resolve()
  assert all(sha((expected/name).read_bytes())==value for name,value in proof['bridgeFiles'].items())
  actions(op,stage,proof)
 finally:
  if host and host.poll() is None:
   host.terminate()
   try:host.wait(timeout=10)
   except subprocess.TimeoutExpired:host.kill();host.wait(timeout=5)
  handle.close();cleanup.append({'stage':stage,'pid':host.pid if host else None,'returncode':host.returncode if host else None,'identity':identity(host.pid) if host else None});save('cleanup.json',cleanup)
def before(op,stage,proof):
 status,catalog=request(op,stage,route);assert status==200
 for id in core:
  status,value=request(op,stage,route+'/'+id);old[id]={'status':status,'value':value}
 assert all(x in {e['id'] for e in proof['entries']} for x in core)
 save('baseline.json',{'catalogEntries':len(catalog['entries']),'configurable':sum(bool(x['configurable']) for x in catalog['entries']),'coreStatus':{k:v['status'] for k,v in old.items()},'readOnly':True})
def after(op,stage,proof):
 baseline=snapshot('before-r5-denials');status,catalog=request(op,stage,route);assert status==200;ids={x['entryId'] for x in catalog['entries']}
 assert not (set(core)|{'optional-session-query-sqlite','optional-tool-session-query','dsh-go-bridge','r5-core-observer'})&ids,ids
 assert {'own-config-plugin','dsh-media'}<=ids,ids
 assert all(x['kind']=='plugin' and x['owner'] and x['source']=='external-package' for x in catalog['entries'])
 for id in core+['optional-session-query-sqlite','optional-tool-session-query','r5-core-observer']:
  assert request(op,stage,route+'/'+id)[0]==403,id
  oldview=old.get(id,{}).get('value',{});revision=oldview.get('revision','OLD_R4_REVISION') if isinstance(oldview,dict) else 'OLD_R4_REVISION'
  public=oldview.get('value',{}) if isinstance(oldview,dict) else {};path=[next(iter(public),'synthetic')];value=public.get(path[0],'synthetic')
  setop={'op':'set','path':path,'value':value};unset={'op':'unset','path':path}
  for ops in [[setop],[unset],[setop,unset]]:assert request(op,stage,route+'/'+id,{'revision':revision,'ops':ops})[0]==403,id
 assert snapshot('after-r5-denials')==baseline
 status,own=request(op,stage,route+'/own-config-plugin');assert status==200 and own['owner']=='wave10-core-boundary-plugin'
 status,changed=request(op,stage,route+'/own-config-plugin',{'revision':own['revision'],'ops':[{'op':'set','path':['title'],'value':'saved externally owned plugin'},{'op':'set','path':['count'],'value':2}]});assert status==200 and changed['value']['count']==2
 assert request(op,stage,route+'/own-config-plugin',{'revision':own['revision'],'ops':[{'op':'set','path':['count'],'value':3}]})[0]==409
 assert request(op,stage,route+'/own-config-plugin',{'revision':changed['revision'],'ops':[{'op':'set','path':['secret'],'value':'SYNTHETIC_DENIED'}]})[0]==400
 status,media=request(op,stage,route+'/dsh-media');assert status==200 and media['owner']=='dsh-media' and 'dsh-go/media/catalog' in json.dumps(media['schema'])
 status,media2=request(op,stage,route+'/dsh-media',{'revision':media['revision'],'ops':[{'op':'set','path':['limits','maxImages'],'value':1}]});assert status==200 and media2['value']['limits']['maxImages']==1
 assert request(op,stage,route+'/dsh-media',{'revision':media2['revision'],'ops':[{'op':'set','path':['credentials','slot1','apiKey'],'value':'SYNTHETIC_DENIED'}]})[0]==400
 assert request(op,stage,route,headers={'Origin':'https://evil.invalid'})[0]==403
 anonymous=urllib.request.build_opener(urllib.request.ProxyHandler({}));assert request(anonymous,stage,route)[0] in [401,403]
 snapshot('after-allowed-plugin-writes')
def restart(op,stage,proof):
 status,own=request(op,stage,route+'/own-config-plugin');assert status==200 and own['value']['count']==2 and own['value']['title']=='saved externally owned plugin'
 status,media=request(op,stage,route+'/dsh-media');assert status==200 and media['value']['limits']['maxImages']==1
 assert request(op,stage,route+'/sandbox-policy')[0]==403
 snapshot('after-r5-restart')
try:
 run_host('r4',before);active.unlink();active.symlink_to(a.bridge.resolve(),target_is_directory=True);run_host('r5',after);run_host('r5-restart',restart)
 save('RESULT.json',{'status':'PASS_REAL_HOST_CORE_BOUNDARY','run':str(run),'httpRequests':len(audit),'coreIds':core,'oldR4ReadStatus':{k:v['status'] for k,v in old.items()},'source':{'prefix':str(prefix),'oldBridge':str(a.old_bridge.resolve()),'bridge':str(a.bridge.resolve()),'media':str(a.media.resolve())},'mediaToolsExecuted':False,'packageManagerInvoked':False,'ownHostsAllGone':all(x['identity'] is None for x in cleanup)})
 print(json.dumps({'pass':True,'run':str(run),'requests':len(audit)}),flush=True)
except BaseException as error:save('FAILURE.json',{'type':type(error).__name__,'message':str(error)});raise
finally:(a.out/'latest-run.txt').write_text(str(run)+'\n')
