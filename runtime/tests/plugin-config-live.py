import os,json,re,urllib.request,urllib.error,subprocess,time,pathlib,shutil,sys
import tempfile,concurrent.futures
here=pathlib.Path(__file__).resolve().parent
prefix=pathlib.Path(sys.argv[1]).resolve()
evidence=pathlib.Path(sys.argv[2]).resolve();evidence.mkdir(parents=True,exist_ok=True)
mode=sys.argv[3] if len(sys.argv)>3 else 'normal'
root=pathlib.Path(tempfile.mkdtemp(prefix=mode+'-',dir=evidence))
port=os.environ.get('PLUGIN_CONFIG_PORT','38984')
home=root/'dsh-home';(home/'profiles/web').mkdir(parents=True)
for name in ['fixture','observer']:
 (root/(name+'.mjs')).write_text((here/('plugin-config-'+name+'.mjs')).read_text().replace('__PREFIX__',str(prefix)))
(root/'no-schema.mjs').write_text('export function apply(){}\n')
package=root/'fixture-package';package.mkdir()
shutil.copyfile(root/'fixture.mjs',package/'fixture.mjs');shutil.copyfile(root/'no-schema.mjs',package/'no-schema.mjs')
(package/'package.json').write_text(json.dumps({'name':'wave10-config-fixture-package','version':'1.0.0','type':'module','exports':{'.':'./fixture.mjs','./no-schema':'./no-schema.mjs'}}))
profile=home/'profiles/web';(profile/'node_modules').mkdir();(profile/'node_modules/wave10-config-fixture-package').symlink_to(package,target_is_directory=True)
(profile/'package.json').write_text(json.dumps({'name':'own-config-regression-profile','version':'1.0.0','private':True,'dependencies':{'wave10-config-fixture-package':'file:'+str(package)},'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
rows=[{'id':x,'disabled':True} for x in ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]+[{'insert':[
 {'id':'wave10-config-fixture','name':'wave10-config-fixture-package','config':{'secret':'SYNTHETIC_CONFIG_SECRET'}},
 {'id':'second-instance','name':'wave10-config-fixture-package'},
 {'id':'no-schema','name':'wave10-config-fixture-package/no-schema'},
 {'id':'inactive','name':'wave10-config-fixture-package','disabled':True},
 {'id':'wave10-config-observer','name':str(root/'observer.mjs')},
 {'id':'dsh-go-bridge','name':str(here.parent/'bridge/dsh-go-bridge/lib/index.js')},
 {'id':'route-probe','name':str(here/'route-probe/index.js')},
]}]
(home/'profiles/web/cordis.patch.yml').write_text(json.dumps(rows))
overlay=root/'overlay.yml';overlay.write_text('- id: wave10-config-fixture\n  config:\n    ordinary: overlay\n')
if mode=='home':shutil.copyfile(overlay,home/'cordis.patch.yml')
logpath=root/'host.raw.log'
f=logpath.open('w')
hostenv={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','TMPDIR'] if k in os.environ}
hostenv.update({'DSH_HOME':str(home),'DSH_TELEMETRY_DISABLED':'1','TZ':'Asia/Shanghai'})
p=subprocess.Popen(['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web']+(['--patch',str(overlay)] if mode=='cli' else [])+['--no-open','--host','127.0.0.1','--port',port],stdout=f,stderr=subprocess.STDOUT,env=hostenv,cwd=root)
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
 def request(path,data=None,headers=None):
  req=urllib.request.Request('http://127.0.0.1:'+port+''+path,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json',**(headers or {})})
  try:
   r=op.open(req,timeout=20);return r.status,json.load(r)
  except urllib.error.HTTPError as e:
   text=e.read().decode();return e.code,(json.loads(text) if text.startswith('{') else text)
 def rpc(method,args):
  status,r=request('/api/'+method,dict(type='client-request',rpcId='config-probe',method=method,payload={'args':args}))
  assert status==200,(status,r)
  return r['result']
 results={}
 base='/dsh-go/v1/plugin-config'
 status,listing=request(base);assert status==200,(status,listing)
 rows={x['entryId']:x for x in listing['entries']}
 assert rows['wave10-config-fixture']['configurable']
 assert rows['second-instance']['configurable']
 assert rows['no-schema']['reason']=='no-schema'
 assert rows['inactive']['state']=='inactive'
 results['list']=listing
 def get():
  status,body=request(base+'/wave10-config-fixture');assert status==200,(status,body);return body
 def post(view,ops):return request(base+'/wave10-config-fixture',{'revision':view['revision'],'ops':ops})
 if mode in ('home','cli'):
  before=get();old=(home/'profiles/web/cordis.patch.yml').read_bytes()
  status,denied=post(before,[{'op':'set','path':['ordinary'],'value':'write-denied'}]);assert status==409 and denied['error']['code']=='overridden',(status,denied)
  assert (home/'profiles/web/cordis.patch.yml').read_bytes()==old
  print(json.dumps({'result':'PASS','mode':mode,'case':'override refuses and file unchanged'}));sys.exit(0)
 guards=[]
 for path in [base,base+'/wave10-config-fixture']:
  for method in ['GET','POST']:
   for headers in [{},{'Cookie':'conn=invalid'}]:
    req=urllib.request.Request('http://127.0.0.1:'+port+''+path,data=b'{}' if method=='POST' else None,headers={'Content-Type':'application/json',**headers},method=method)
    try:urllib.request.urlopen(req);raise AssertionError('anonymous admitted')
    except urllib.error.HTTPError as e:assert e.code in (401,403);guards.append({'method':method,'status':e.code})
   for headers in [{'Origin':'https://evil.invalid'},{'Sec-Fetch-Site':'cross-site'},{'Host':'evil.invalid'}]:
    status,_=request(path,data={} if method=='POST' else None,headers=headers);assert status==403,(headers,status);guards.append({'method':method,'status':status})
 results['guards']=guards
 with (root/'route-guard.log').open('w') as gate:
  subprocess.run(['node',str(here/'route-guard.mjs'),'http://127.0.0.1:'+port+'',m[1],'--guard','patched'],env={**os.environ,'TZ':'Asia/Shanghai'},stdout=gate,stderr=subprocess.STDOUT,check=True)
 before=get();assert before['value']['ordinary']=='ordinary-old';assert before['value']['count']==7
 assert 'SYNTHETIC_' not in json.dumps(before)
 assert before['schema']['refs']
 results['initial']=before
 with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
  futures=[pool.submit(post,before,[{'op':'set','path':['count'],'value':n}]) for n in [8,9]]
  simultaneous=[f.result() for f in futures]
 assert sorted(status for status,_ in simultaneous)==[200,409],[(status,body.get('error',{}).get('code')) for status,body in simultaneous]
 results['simultaneousPostStatuses']=[status for status,_ in simultaneous]
 before=get()
 status,defaultArray=post(before,[{'op':'unset','path':['items','0']}]);assert status==200 and defaultArray['value']['items']==['second'],(status,defaultArray)
 before=get()
 status,mixed=post(before,[{'op':'set','path':['ordinary'],'value':'ordinary-new'},{'op':'set','path':['live'],'value':'live-new'}]);assert status==200,(status,mixed)
 assert mixed['value']['ordinary']=='ordinary-new' and mixed['value']['live']=='live-new'
 results['mixed']=mixed
 status,stale=post(before,[{'op':'set','path':['count'],'value':9}]);assert status==409 and stale['error']['code']=='conflict',(status,stale)
 results['stale']=stale
 for ops in [[{'op':'set','path':['secret'],'value':'SYNTHETIC_DENIED'}],[{'op':'set','path':['nested'],'value':{'visible':'x'}}],[{'op':'set','path':['ordinary'],'value':{'__jsExpr':'1'}}],[{'op':'set','path':['constructor'],'value':{}}],[{'op':'set','path':[],'value':{}}]]:
  status,denied=post(get(),ops);assert status==400,(status,denied)
 status,invalid=post(get(),[{'op':'set','path':['count'],'value':'invalid-number'}]);assert status==422,(status,invalid)
 status,changed=post(get(),[{'op':'set','path':['count'],'value':8}]);assert status==200,(status,changed)
 status,unset=post(changed,[{'op':'unset','path':['count']}]);assert status==200 and unset['value']['count']==7,(status,unset)
 results['unset']=unset
 status,array=post(get(),[{'op':'set','path':['items'],'value':['a','b','c']},{'op':'unset','path':['items','1']}]);assert status==200 and array['value']['items']==['a','c'],(status,array)
 results['array']=array
 status,failed=post(get(),[{'op':'set','path':['fail'],'value':True}]);assert status==409 and failed['error']['code']=='apply-failed',(status,failed)
 after=get();assert after['value']['fail'] is False and after['value']['ordinary']=='ordinary-new'
 results['applyFailure']=failed
 beforeRestart=get();_,obsBefore=request('/wave10-config-probe')
 status,_=request('/wave10-config-probe',{'action':'restart'});assert status==200
 _,obsAfter=request('/wave10-config-probe');assert obsBefore['uid']==obsAfter['uid']
 assert len(obsAfter['history'])>len(obsBefore['history'])
 status,restarted=post(beforeRestart,[{'op':'set','path':['count'],'value':12}]);assert status==409 and restarted['error']['code']=='conflict',(status,restarted)
 results['sameUidRestart']=restarted
 externalBefore=get()
 with (home/'profiles/web/cordis.patch.yml').open('a') as f:f.write('\n- id: wave10-config-fixture\n  config:\n    ordinary: external-change\n')
 status,external=post(externalBefore,[{'op':'set','path':['count'],'value':13}]);assert status==409 and external['error']['code']=='conflict',(status,external)
 results['externalChange']=external
 status,_=request('/wave10-config-probe',{'action':'failRecovery'});assert status==200
 status,recovery=post(get(),[{'op':'set','path':['fail'],'value':True}]);assert status==500 and recovery['error']['code']=='recovery-failed',(status,recovery)
 results['recoveryFailure']=recovery
 results['final']=after
 (root/'results.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
 print(json.dumps({'result':'PASS','extraCases':['20 GET/POST real route guard refusals','simultaneous POST one winner','same UID restart conflict','external disk change conflict','recovery failure 500'],'cases':['list and two instances','schema graph and secret redaction','mixed persist','stale revision','secret-parent-expression-prototype-root denial','invalid config','unset default','array remove','apply rollback']}))

finally:
 try:
  if 'results' in locals(): (root/'results.partial.json').write_text(json.dumps(results,ensure_ascii=False,indent=2)+'\n')
 finally:
  p.terminate()
  try:p.wait(timeout=10)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  f.close()
  (root/'host.log').write_text(redact(logpath.read_text()))
