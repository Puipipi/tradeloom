#!/usr/bin/env python3
"""Actual rc4 Host, synthetic callback/data canaries, own loopback profile only."""
import argparse, hashlib, http.cookiejar, json, os, pathlib, re, shutil
import subprocess, tempfile, time, urllib.error, urllib.request

p=argparse.ArgumentParser()
for key in ['prefix','bridge','out']:p.add_argument('--'+key,type=pathlib.Path,required=True)
p.add_argument('--port',type=int,default=39317)
a=p.parse_args();here=pathlib.Path(__file__).resolve().parent
prefix=a.prefix.resolve();bridge=a.bridge.resolve();a.out.mkdir(parents=True,exist_ok=True)
run=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=a.out.resolve()));private=run/'private';private.mkdir()
evidence=run/'evidence';evidence.mkdir();home=private/'home';profile=home/'profiles/web';(profile/'node_modules').mkdir(parents=True)
agents=private/'agents';agents.mkdir();workspace=private/'workspace';workspace.mkdir()
fixture=private/'fixture';fixture.mkdir();(fixture/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
for name in ['secret-callback-fixture.mjs','secret-callback-cases.mjs']:shutil.copyfile(here/name,fixture/name)
(fixture/'package.json').write_text(json.dumps({'name':'wave10-secret-callback','version':'1.0.0','type':'module','exports':{'.':'./secret-callback-fixture.mjs','./package.json':'./package.json'}}))
(profile/'node_modules/wave10-secret-callback').symlink_to(fixture,target_is_directory=True)
observer=private/'observer';observer.mkdir();(observer/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
shutil.copyfile(here/'secret-callback-observer.mjs',observer/'index.mjs')
generate=['node','--input-type=module','-e',"const m=await import(process.argv[1]); console.log(JSON.stringify({raw:m.raw,hidden:m.cases.flatMap(c=>c.hidden),public:m.cases.flatMap(c=>c.publicMarkers)}))",(fixture/'secret-callback-fixture.mjs').as_uri()]
generated=subprocess.run(generate,capture_output=True,text=True,check=True);inputs=json.loads(generated.stdout)
bundle=private/'bundle';bundle.mkdir();(bundle/'node_modules').symlink_to(profile/'node_modules',target_is_directory=True)
(bundle/'index.mjs').write_text('export function apply(){}\n')
(bundle/'package.json').write_text(json.dumps({'name':'wave10-secret-callback-bundle','version':'1.0.0','type':'module','exports':{'.':'./index.mjs','./package.json':'./package.json','./cordis.patch.yml':'./cordis.patch.yml'},'dependencies':{'wave10-secret-callback':'file:'+str(fixture)},'dsh':{'bundle':{'patch':'./cordis.patch.yml'}}}))
bundle_patch=bundle/'cordis.patch.yml';bundle_patch.write_text(json.dumps([{'insert':[{'id':'callbacks','name':'wave10-secret-callback','config':inputs['raw']}]}]))
(profile/'node_modules/wave10-secret-callback-bundle').symlink_to(bundle,target_is_directory=True)
manifest=profile/'package.json';manifest.write_text(json.dumps({'name':'own-callback-profile','version':'1.0.0','private':True,'dependencies':{'wave10-secret-callback-bundle':'file:'+str(bundle),'wave10-secret-callback':'file:'+str(fixture)},'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app','wave10-secret-callback-bundle']}}}))
patch=profile/'cordis.patch.yml';patch.write_text(json.dumps([{'id':name,'disabled':True}for name in ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]+[{'insert':[{'id':'callback-observer','name':str(observer/'index.mjs')},{'id':'dsh-go-bridge','name':str(bridge/'lib/index.js')}]}]))
env={key:os.environ[key]for key in ['PATH','LANG','LC_ALL','TMPDIR']if key in os.environ}
env.update({'TZ':'Asia/Shanghai','DSH_HOME':str(home),'DSH_AGENTS_HOME':str(agents),'DSH_TELEMETRY_DISABLED':'1','UV_USE_IO_URING':'0','CALLBACK_BRIDGE':str(bridge),'CALLBACK_FIXTURE':str(fixture/'secret-callback-fixture.mjs')})
base='http://127.0.0.1:'+str(a.port);route='/dsh-go/v1/plugin-config';audit=[];snapshots=[]
sha=lambda data:hashlib.sha256(data).hexdigest()
def save(name,value):(evidence/name).write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
def identity(pid):
 try:
  text=pathlib.Path('/proc/'+str(pid)+'/stat').read_text();parts=text[text.rindex(')')+2:].split();return {'pid':pid,'state':parts[0],'startTicks':int(parts[19])}
 except FileNotFoundError:return None
def snapshot(label):
 files={}
 for file in [manifest,patch,bundle_patch]:
  data=file.read_bytes();files[str(file.relative_to(private))]={'bytes':len(data),'sha256':sha(data),'text':data.decode()}
 snapshots.append({'label':label,'files':files});save('snapshots.json',snapshots);return files
def request(op,path,data=None,headers=None):
 req=urllib.request.Request(base+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json','Origin':base,**(headers or {})})
 started=time.monotonic()
 try:
  with op.open(req,timeout=30)as res:status=res.status;text=res.read().decode();meta=dict(res.headers)
 except urllib.error.HTTPError as res:status=res.code;text=res.read().decode();meta=dict(res.headers)
 body=json.loads(text)if text.startswith('{')else text
 audit.append({'method':'GET'if data is None else'POST','path':path,'request':data,'status':status,'response':body,'headers':{k:v for k,v in meta.items()if k.lower()in ['content-type','cache-control','x-dsh-go-guard']},'elapsedSeconds':time.monotonic()-started});save('http-audit.json',audit)
 return status,body
def clean(body):
 serialized=json.dumps(body);found=[marker for marker in inputs['hidden']if marker in serialized]
 assert not found,'sensitive canaries in response: '+','.join(found)
 assert 'SYNTH_CB_R1_POST_REJECTED'not in serialized and 'SYNTH_CB_R1_ERROR_VALIDATION'not in serialized
 for marker in inputs['public']:assert marker in serialized,'ordinary callback unexpectedly removed'
def view(op):
 status,body=request(op,route+'/callbacks');assert status==200;clean(body);return body
def post(op,body,ops):return request(op,route+'/callbacks',{'revision':body['revision'],'ops':ops})

host=None;handle=None
try:
 log=private/'host.raw.log';log.touch(mode=0o600);handle=log.open('w')
 command=['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--no-open','--host','127.0.0.1','--port',str(a.port)]
 host=subprocess.Popen(command,cwd=workspace,env=env,stdout=handle,stderr=subprocess.STDOUT);deadline=time.monotonic()+45
 while True:
  if host.poll()is not None:raise RuntimeError('Own Host exited; inspect private log')
  token=re.search(r'token=([\w-]+)',log.read_text())
  if token:break
  if time.monotonic()>deadline:raise TimeoutError('own Host startup')
  time.sleep(.05)
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
 op.open(base+'/?token='+token[1],timeout=15).read()
 status,proof=request(op,'/callback-observer');assert status==200
 for key in ['actualEditorPrototype','actualManagerPrototype','actualConfigIdentity','actualBridgeCallback','asyncChange']:assert proof[key],key
 assert proof['sourceCanaryOccurrences']>0 and proof['sourceCallbackNodes']>0 and proof['entry']['state']==2
 for name,digest in proof['bridgeFiles'].items():assert digest==sha((bridge/name).read_bytes()),name
 for name,row in proof['moduleFiles'].items():assert row['sha256']==sha(pathlib.Path(row['file']).read_bytes()),name
 save('identity.json',{'command':command,'process':identity(host.pid),'proof':proof,'fixtureGeneratorExit':generated.returncode})
 before=snapshot('before-config-reads')
 status,catalog=request(op,route);assert status==200
 row=next(x for x in catalog['entries']if x['entryId']=='callbacks');assert row['configurable']and row['writable']and row['owner']=='installed'
 first=view(op);assert first['value']['count']==1 and all(not x['writable']for x in first['secrets'])
 assert snapshot('after-config-reads')==before
 anonymous=urllib.request.build_opener(urllib.request.ProxyHandler({}));assert request(anonymous,route+'/callbacks')[0]in[401,403]
 assert request(op,route+'/callbacks',headers={'Origin':'https://evil.invalid'})[0]==403
 status,changed=post(op,first,[{'op':'set','path':['count'],'value':2}]);assert status==200;clean(changed);assert changed['value']['count']==2
 current=view(op);assert current['value']['count']==2;after_write=snapshot('after-ordinary-write')
 for ops in [[{'op':'set','path':['direct'],'value':'SYNTH_CB_R1_POST_REJECTED'}],[{'op':'unset','path':['direct']}],[{'op':'set','path':['count'],'value':9},{'op':'set','path':['ancestor'],'value':{'token':'SYNTH_CB_R1_POST_REJECTED'}}],[{'op':'set','path':['custom_object'],'value':'SYNTH_CB_R1_POST_REJECTED'}]]:
  status,denied=post(op,current,ops);assert status==400
  assert 'SYNTH_CB_R1_'not in json.dumps(denied);assert snapshot('after-denied-'+str(len(audit)))==after_write
 status,failed=post(op,current,[{'op':'set','path':['count'],'value':13}]);assert status==422 and failed['error']['code']=='invalid-config';assert 'SYNTH_CB_R1_'not in json.dumps(failed)
 assert snapshot('after-validation-failure')==after_write
 final=view(op);assert final['value']['count']==2
 status,last=request(op,'/callback-observer');assert status==200 and last['actualConfigIdentity']and last['entry']['state']==2
 assert last['sourceGraphSHA256']==proof['sourceGraphSHA256']and last['sourceCallbackNodes']==proof['sourceCallbackNodes']and last['sourceCanaryOccurrences']==proof['sourceCanaryOccurrences']
 save('original-schema-proof.json',{'before':proof['sourceGraphSHA256'],'after':last['sourceGraphSHA256'],'sourceCallbackNodes':last['sourceCallbackNodes'],'sourceCanaryOccurrences':last['sourceCanaryOccurrences'],'actualConfigIdentity':last['actualConfigIdentity'],'normalCount':last['entry']['count'],'validation422':True,'scope':'original actual Host Schema still has callback source; only outgoing projection omits sensitive callbacks'})
 save('RESULT.json',{'status':'PASS_REAL_RC4_HOST_SECRET_CALLBACK','httpRequests':len(audit),'cookieWarmupsExcluded':1,'mediaToolsExecuted':False,'packageManagerInvoked':False,'externalServicesCalled':False,'source':{'prefix':str(prefix),'bridge':str(bridge)},'run':str(run)})
 print(json.dumps({'status':'PASS','run':str(run),'httpRequests':len(audit)}),flush=True)
except BaseException as error:
 save('FAILURE.json',{'type':type(error).__name__,'message':str(error)});raise
finally:
 if host and host.poll()is None:
  host.terminate()
  try:host.wait(timeout=10)
  except subprocess.TimeoutExpired:host.kill();host.wait(timeout=5)
 if handle:handle.close()
 save('cleanup.json',{'pid':host.pid if host else None,'returncode':host.returncode if host else None,'identity':identity(host.pid)if host else None})
 (a.out/'latest-run.txt').write_text(str(run)+'\n')
