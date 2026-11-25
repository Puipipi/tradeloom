import os,json,re,urllib.request,urllib.error,subprocess,time,pathlib,shutil
import sys,tempfile
prefix=pathlib.Path(sys.argv[1]).resolve();mode=sys.argv[2];kind=sys.argv[3]
evidence=pathlib.Path(sys.argv[4]).resolve();evidence.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(tempfile.mkdtemp(prefix=mode+'-'+kind+'-',dir=evidence))
home=root/'dsh-home';profile=home/'profiles/web';profile.mkdir(parents=True)
for name in ['fixture','observer']:
 text=(pathlib.Path(__file__).parent/('config-path-'+name+'.mjs')).read_text().replace('__PREFIX__',str(prefix))
 (root/(name+'.mjs')).write_text(text)
fixture=root/'fixture.mjs'
if kind=='relative':
 fixture=profile/'插件 with space.mjs';shutil.copyfile(root/'fixture.mjs',fixture);plugin='./插件 with space.mjs'
elif kind=='dotdot':
 fixture=home/'profiles/插件 with space.mjs';shutil.copyfile(root/'fixture.mjs',fixture);plugin='../插件 with space.mjs'
elif kind=='fileurl':plugin=fixture.as_uri()
else:plugin=str(fixture)
rows=[{'insert':[{'id':'wave10-config-fixture','name':plugin,'config':{'secret':'wave10-fixture-secret-not-real'}},{'id':'wave10-config-observer','name':(root/'observer.mjs').as_uri()}]}]
(profile/'cordis.patch.yml').write_text(json.dumps(rows))
extra=[]
if kind in ['home','cli']:
 overlay=[{'id':'wave10-config-fixture','name':fixture.as_uri(),'config':{'ordinary':'locked','live':'live-old','fail':False}}]
 overlaypath=home/'cordis.patch.yml' if kind=='home' else root/'cli.patch.yml'
 overlaypath.write_text(json.dumps(overlay))
 if kind=='cli':extra=['--patch',str(overlaypath)]
port=os.environ.get('CONFIG_PATH_PORT','38962')
logpath=root/'host.raw.log';f=logpath.open('w')
p=subprocess.Popen(['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web',*extra,'--no-open','--port',port],stdout=f,stderr=subprocess.STDOUT,env={**os.environ,'DSH_HOME':str(home),'TZ':'Asia/Shanghai'},cwd=root)
def redact(x):return re.sub(r'token=[A-Za-z0-9_-]+','token=<redacted>',x)
try:
 for _ in range(300):
  txt=logpath.read_text();m=re.search(r'token=([\w-]+)',txt)
  if m:break
  if p.poll() is not None:raise RuntimeError(redact(txt[-3000:]))
  time.sleep(.1)
 else:raise TimeoutError('host did not start')
 op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor())
 op.open('http://127.0.0.1:'+port+'/?token='+m[1],timeout=15).read()
 def request(path,data=None):
  req=urllib.request.Request('http://127.0.0.1:'+port+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
  try:
   r=op.open(req,timeout=20);return r.status,json.load(r)
  except urllib.error.HTTPError as e:return e.code,json.load(e)
 def rpc(method,args):
  status,r=request('/api/'+method,dict(type='client-request',rpcId='config-probe',method=method,payload={'args':args}))
  assert status==200,(status,r)
  return r['result']
 results={}
 status,before=request('/wave10-config-probe');assert status==200,(status,before)
 results['initial']=before
 view=before['liveView'];assert view is not None
 assert view['value']=={'live':'live-old'},view
 assert before['fullValue']['ordinary']==('locked' if kind in ['home','cli'] else 'ordinary-old')
 assert 'secret' not in before['fullValue']
 rejected=rpc('settings/mutate',{'ns':'wave10-config-fixture','ops':[{'op':'set','path':['ordinary'],'value':'forbidden-via-live'}],'expectedRevision':view['revision']})
 assert rejected['ok'] is False,rejected
 results['ordinaryViaSettings']=rejected
 if kind in ['home','cli']:
  patchbefore=(profile/'cordis.patch.yml').read_bytes()
  status,denied=request('/wave10-config-probe',{'changes':{'ordinary':'ordinary-new'}})
  assert status==409 and 'overridden' in denied['error'],(status,denied)
  assert (profile/'cordis.patch.yml').read_bytes()==patchbefore
  assert denied['snapshot']['uid']==before['uid']
  assert denied['snapshot']['fullValue']['ordinary']=='locked'
  print(json.dumps({'result':'PASS','case':kind+' override refused','file_unchanged':True,'instance_unchanged':True}),flush=True)
  raise SystemExit(0)
 updated=rpc('settings/mutate',{'ns':'wave10-config-fixture','ops':[{'op':'set','path':['live'],'value':'live-new'}],'expectedRevision':view['revision']})
 if mode=='original':
  assert updated['ok'] is False and 'overridden' in str(updated),updated
  print(json.dumps({'result':'PASS original reproduction','case':kind,'error':updated}),flush=True)
  raise SystemExit(0)
 assert updated['ok'] is True,updated
 _,afterLive=request('/wave10-config-probe')
 assert len([x for x in afterLive['history'] if x['event']=='mount'])==len([x for x in before['history'] if x['event']=='mount'])
 assert afterLive['fullValue']['live']=='live-new'
 results['afterLive']=afterLive
 status,afterOrdinary=request('/wave10-config-probe',{'changes':{'ordinary':'ordinary-new'}})
 assert status==200,(status,afterOrdinary)
 assert len([x for x in afterOrdinary['history'] if x['event']=='mount'])>len([x for x in afterLive['history'] if x['event']=='mount'])
 assert afterOrdinary['ordinaryPersisted'] is True
 assert afterOrdinary['fullValue']['ordinary']=='ordinary-new'
 results['afterOrdinary']=afterOrdinary
 status,failure=request('/wave10-config-probe',{'changes':{'fail':True}})
 assert status==409,(status,failure)
 assert failure['snapshot']['state']==2,failure
 assert failure['snapshot']['fullValue']['ordinary']=='ordinary-new'
 assert failure['snapshot']['fullValue']['fail'] is False
 assert failure['snapshot']['failPersisted'] is False
 results['activationFailureRollback']=failure
 _,final=request('/wave10-config-probe')
 assert 'wave10-fixture-secret-not-real' not in json.dumps(final)
 results['final']=final
 (root/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'result':'PASS','path_kind':kind,'cases':['settings describe volatile only','ordinary write refused by settings','volatile update no remount','ordinary edit persists and remounts','failed apply rolls file and runtime back','secret excluded from readback'],'profile_entries':len(before['activeConfigEntries']),'initial_uid':before['uid'],'after_live_uid':afterLive['uid'],'after_ordinary_uid':afterOrdinary['uid']},ensure_ascii=False))
finally:
 try:
  if 'results' in locals(): (root/'results.partial.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
 finally:
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  f.close()
  (root/'host.log').write_text(redact(logpath.read_text()))
