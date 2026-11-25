"""Real Host regression: an inherited live package run blocks service mutations.

Only self-created Node package-manager fixtures and local bundles are executed.
No registry, real pnpm, account, or third-party lifecycle script is used.
Linux subreaper support is required to reap the exact orphan created by this test.
"""
import argparse,concurrent.futures,ctypes,hashlib,json,os,pathlib,shutil,signal,subprocess,tempfile,threading,time,urllib.request,urllib.error,uuid
parser=argparse.ArgumentParser();parser.add_argument('--prefix',type=pathlib.Path,required=True);parser.add_argument('--out',type=pathlib.Path,required=True);parser.add_argument('--port',type=int,default=39201);parser.add_argument('--cases',nargs='+',choices=['failure','hold'],default=['failure','hold']);parser.add_argument('--expected-manager-sha256',default='7a2c0b3e117e23744fa30adb744137308e2212a50d631feeab19ee9de6ed94b5');args=parser.parse_args()
here=pathlib.Path(__file__).resolve().parent;prefix=args.prefix.resolve();out=args.out.resolve();out.mkdir(parents=True,exist_ok=True)
assert hashlib.sha256((prefix/'node_modules/@deepseek-ai/dsh-plugin-manager/lib/index.js').read_bytes()).hexdigest()==args.expected_manager_sha256,'unexpected service module bytes'
root=pathlib.Path(tempfile.mkdtemp(prefix='run-',dir=out));evidence=root/'evidence';evidence.mkdir()
assert ctypes.CDLL(None,use_errno=True).prctl(36,1,0,0,0)==0,'Linux subreaper setup failed'
sha=lambda value:hashlib.sha256(value).hexdigest()
write_lock=threading.Lock()
def write(path,data):
 with write_lock:
  temp=path.with_name(path.name+'.tmp');temp.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');temp.replace(path)
def wait_for(predicate,label,timeout=25):
 deadline=time.monotonic()+timeout
 while time.monotonic()<deadline:
  result=predicate()
  if result:return result
  time.sleep(.02)
 raise TimeoutError(label)
def identity(pid):
 try:
  text=pathlib.Path('/proc/'+str(pid)+'/stat').read_text();fields=text[text.rindex(')')+2:].split()
  return {'pid':pid,'state':fields[0],'ppid':int(fields[1]),'pgrp':int(fields[2]),'startTicks':int(fields[19])}
 except FileNotFoundError:return None
def same_process(before):
 after=identity(before['pid']);return after if after and after['startTicks']==before['startTicks'] else None
files=['package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml','compatibility.json','package.json.lock','.plugin-manager/run.json']
def snapshot(profile):
 result={}
 for name in files:
  file=profile/name
  if not file.exists():result[name]={'exists':False};continue
  data=file.read_bytes();result[name]={'exists':True,'bytes':len(data),'sha256':sha(data),'text':data.decode()}
 return result
def file_equals(a,b,name):return a[name]==b[name]
def read_json_if(path):
 if not path.exists():return None
 try:return json.loads(path.read_text())
 except json.JSONDecodeError:return None
def main_case(mode):
 case=root/mode;private=case/'private';private.mkdir(parents=True);control=private/'control';control.mkdir();home=private/'home';profile=home/'profiles/web';profile.mkdir(parents=True);workspace=private/'workspace';workspace.mkdir()
 dest=evidence/mode;dest.mkdir();write(dest/'orchestrator.json',identity(os.getpid()))
 (case/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True);shutil.copyfile(here/'observer.mjs',case/'observer.mjs')
 bundles={}
 for key in ['a','b']:
  package=private/('bundle-'+key);package.mkdir();name='wave10-crash-probe-'+key
  write(package/'package.json',{'name':name,'version':'1.0.0','private':True,'dsh':{'bundle':{'patch':'cordis.patch.yml'}}});(package/'cordis.patch.yml').write_text('[]\n');bundles[key]=package
 patches=[{'id':id,'disabled':True} for id in ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]
 patches.extend([{'id':'plugin-manager','config':{'idleTimeoutMs':60000,'inspectTimeoutMs':20000,'lockWaitMs':20000,'registry':'https://registry.fixture.invalid/','fallbackRegistries':[]}},{'insert':[{'id':'install-crash-observer','name':str(case/'observer.mjs')}]}])
 write(profile/'cordis.patch.yml',patches);(profile/'pnpm-lock.yaml').write_text("lockfileVersion: '9.0'\n# synthetic baseline\n")
 hosts=[];handles=[];audit=[];steps=[];base='http://127.0.0.1:'+str(args.port)
 env={k:os.environ[k] for k in ['PATH','LANG','LC_ALL','TMPDIR'] if k in os.environ}
 env.update({'TZ':'Asia/Shanghai','DSH_TELEMETRY_DISABLED':'1','DSH_HOME':str(home),'FIXTURE_DSH_PREFIX':str(prefix),'FIXTURE_HOST_PORT':str(args.port),'FIXTURE_PM_SCRIPT':str(here/'package-manager.mjs'),'FIXTURE_CONTROL_ROOT':str(control),'FIXTURE_MODE':mode,'FIXTURE_EXPECTED_MANAGER_SHA256':args.expected_manager_sha256})
 def start(generation):
  logpath=private/(generation+'.raw.log');logpath.touch(mode=0o600);handle=logpath.open('w');handles.append(handle)
  process=subprocess.Popen(['node',str(here/'launcher.mjs')],cwd=workspace,env={**env,'FIXTURE_GENERATION':generation},stdout=handle,stderr=subprocess.STDOUT);hosts.append(process)
  write(dest/'hosts.json',[{'pid':p.pid,'identity':identity(p.pid)} for p in hosts])
  def token():
   import re
   match=re.search(r'token=([\w-]+)',logpath.read_text())
   if match:return match[1]
   assert process.poll() is None,'Host exited; inspect private log'
  value=wait_for(token,'Host ready',35);opener=urllib.request.build_opener(urllib.request.HTTPCookieProcessor());opener.open(base+'/?token='+value,timeout=15).read()
  proof=wait_for(lambda:read_json_if(control/('loaded-module-'+generation+'.json')),'loaded real service module')
  assert proof['matchesExpectedHash'] and proof['runtimeInstanceOfImportedClass'] and proof['changeHasEarlyGuard'],proof
  return process,opener
 def rpc(opener,method,arguments):
  payload={'type':'client-request','rpcId':'wire-'+str(uuid.uuid4()),'method':method,'payload':{'args':arguments}}
  request=urllib.request.Request(base+'/api/'+method,data=json.dumps(payload).encode(),headers={'Content-Type':'application/json','Origin':base})
  try:
   response=opener.open(request,timeout=30);status=response.status;body=json.load(response)
  except Exception as error:
   audit.append({'method':method,'request':arguments,'transportError':type(error).__name__});write(dest/'http-audit.json',audit);return {'transportError':type(error).__name__}
  audit.append({'method':method,'request':arguments,'status':status,'response':body})
  write(dest/'http-audit.json',audit)
  assert status==200 and body['type']=='server-response',body
  assert body['result']['ok'],body
  return body['result']['value']
 def install(opener,key,request_id):return rpc(opener,'pluginManager/installBundle',{'spec':str(bundles[key]),'options':{'requestId':request_id,'enabled':True}})
 def snap(label):
  state=snapshot(profile);steps.append({'label':label,'profile':state});write(dest/'steps.json',steps);return state
 def stop_host(process):
  if process.poll() is None:
   state=identity(process.pid)
   if state and state['state'] in ['T','t']:os.kill(process.pid,signal.SIGCONT)
   process.terminate()
   try:process.wait(timeout=10)
   except subprocess.TimeoutExpired:process.kill();process.wait(timeout=5)
 def reap_known(pid):
  try:
   got,status=os.waitpid(pid,os.WNOHANG)
   return got==pid
  except ChildProcessError:return identity(pid) is None
 pool=concurrent.futures.ThreadPoolExecutor(max_workers=2)
 try:
  original,opener=start('original');baseline=snap('before-install');request_id='crash-'+mode+'-'+str(uuid.uuid4())
  if mode=='failure':
   result=install(opener,'a',request_id);after=snap('normal-failure-return')
   assert result['application']=='failed' and result['packageResult']['exitCode']==17,result
   assert file_equals(baseline,after,'package.json') and file_equals(baseline,after,'pnpm-lock.yaml')
   assert not after['package.json.lock']['exists'] and not after['.plugin-manager/run.json']['exists']
   return {'mode':mode,'result':result,'manifestAndLockRestored':True,'residualDownloadedPackageExists':(profile/'node_modules/wave10-crash-probe-a').is_symlink()}
  pending=pool.submit(install,opener,'a',request_id)
  if mode=='hold':
   ready=wait_for(lambda:read_json_if(control/'old-pm-ready.json'),'old PM ready');old=identity(ready['pid']);assert old and old['ppid']==original.pid
   marker=wait_for(lambda:read_json_if(profile/'.plugin-manager/run.json'),'run marker');assert marker['pid']==old['pid']
   assert int((profile/'package.json.lock').read_text())==original.pid
   before_kill=snap('old-pm-phase1-before-host-kill')
   original.kill();original.wait(timeout=10);assert original.returncode==-signal.SIGKILL
   old_after_kill=same_process(old);assert old_after_kill and old_after_kill['state']!='Z','old PM did not survive Host SIGKILL'
   write(dest/'host-kill.json',{'hostPid':original.pid,'hostReturnCode':original.returncode,'oldPmBefore':old,'oldPmAfter':old_after_kill})
   interrupted=pending.result(timeout=5);assert 'transportError' in interrupted,interrupted
   successor,new_opener=start('successor');old_request=rpc(new_opener,'pluginManager/waitForInstall',{'requestId':request_id});assert old_request is None
   before_successor=snap('successor-before-new-install')
   successor_pending=pool.submit(install,new_opener,'b','successor-'+str(uuid.uuid4()))
   def owns_profile_lock():
    try:return (profile/'package.json.lock').read_text().strip()==str(successor.pid)
    except FileNotFoundError:return False
   wait_for(owns_profile_lock,'successor acquired actual profile lock')
   (control/'write-phase2').touch();phase2_ack=wait_for(lambda:read_json_if(control/'old-pm-phase2-ack.json'),'old PM phase2 complete');assert phase2_ack['pid']==old['pid']
   phase2=snap('old-pm-phase2-after-successor-lock')
   assert not file_equals(before_successor,phase2,'package.json') and not file_equals(before_successor,phase2,'pnpm-lock.yaml')
   rejected=successor_pending.result(timeout=20)
   after_reject=snap('successor-rejected-old-pm-still-alive');old_after_reject=same_process(old)
   assert old_after_reject and old_after_reject['state']!='Z'
   write(dest/'rejected-process-observation.json',{'oldPm':old_after_reject,'result':rejected})
   assert rejected['application']=='failed',rejected
   assert rejected['error']['code']=='operation-error' and 'started by an earlier package operation' in rejected['error']['diagnostic'],rejected
   assert 'packageResult' not in rejected,'refusal must happen before running the installation callback'
   commands=[json.loads(line) for line in (control/'commands.jsonl').read_text().splitlines()]
   assert not [row for row in commands if row['generation']=='successor'],'early refusal must happen before config-get as well as add'
   preserved={name:file_equals(phase2,after_reject,name) for name in ['package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml','compatibility.json']}
   assert all(preserved.values()),'new service operation overwrote the live old package run'
   assert read_json_if(profile/'.plugin-manager/run.json')==marker
   before_enable=snap('before-enable-with-old-pm-alive')
   blocked_enable=rpc(new_opener,'pluginManager/setBundleEnabled',{'name':'wave10-crash-probe-a','enabled':True})
   after_enable=snap('enable-refused-with-old-pm-alive')
   assert blocked_enable['application']=='failed' and blocked_enable['error']['code']=='operation-error',blocked_enable
   assert blocked_enable['changed'] is False and 'started by an earlier package operation' in blocked_enable['error']['diagnostic']
   assert all(file_equals(before_enable,after_enable,name) for name in ['package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml','compatibility.json'])
   old_after_enable=same_process(old);assert old_after_enable and old_after_enable['state']!='Z'
   cancel_request_id='cancel-during-guard-'+str(uuid.uuid4())
   cancelling_install=pool.submit(install,new_opener,'b',cancel_request_id)
   wait_for(owns_profile_lock,'cancellable install acquired actual profile lock')
   cancel_result=rpc(new_opener,'pluginManager/cancelInstall',{'requestId':cancel_request_id})
   cancelled_install_result=cancelling_install.result(timeout=20)
   after_cancel=snap('cancel-during-early-guard-return')
   old_after_cancel=same_process(old)
   write(dest/'cancel-results.json',{'cancelResult':cancel_result,'installResult':cancelled_install_result,'oldPmAfterCancel':old_after_cancel})
   assert cancel_result['status']=='cancelled',cancel_result
   assert cancelled_install_result['application']=='cancelled',cancelled_install_result
   assert old_after_cancel and old_after_cancel['state']!='Z','cancelling new request must not stop old PM'
   assert all(file_equals(after_enable,after_cancel,name) for name in ['package.json','pnpm-lock.yaml','cordis.patch.yml','pnpm-workspace.yaml','compatibility.json'])
   assert read_json_if(profile/'.plugin-manager/run.json')==marker
   assert not [json.loads(line) for line in (control/'commands.jsonl').read_text().splitlines() if json.loads(line)['generation']=='successor']
   (control/'release-old-pm').touch();wait_for(lambda:reap_known(old['pid']),'reap owned old PM');assert identity(old['pid']) is None
   enabled=rpc(new_opener,'pluginManager/setBundleEnabled',{'name':'wave10-crash-probe-a','enabled':True})
   after_enabled=snap('same-enable-after-old-pm-exit')
   assert enabled['application']=='applied' and enabled['changed'] is True,enabled
   assert not after_enabled['.plugin-manager/run.json']['exists']
   retry=install(new_opener,'b','retry-'+str(uuid.uuid4()));after_retry=snap('after-old-pm-exit-and-retry')
   commands=[json.loads(line) for line in (control/'commands.jsonl').read_text().splitlines()]
   assert sum(row['generation']=='successor' and row['args'][0]=='add' for row in commands)==1
   assert not after_retry['.plugin-manager/run.json']['exists'] and not after_retry['package.json.lock']['exists']
   assert retry['application']=='failed' and retry['packageResult']['exitCode']==17
   assert file_equals(after_enabled,after_retry,'package.json') and file_equals(after_enabled,after_retry,'pnpm-lock.yaml')
   return {'mode':mode,'hostKillExit':original.returncode,'oldPmBeforeKill':old,'oldPmAfterKill':old_after_kill,'oldPmAfterRejectedOperation':old_after_reject,'oldPmAfterBlockedEnable':old_after_enable,'oldPmAfterCancel':old_after_cancel,'record':marker,'waitForOldRequestAfterRestart':old_request,'newInstallResult':rejected,'newPmCommandsWhileOldAlive':0,'phase2Preserved':preserved,'blockedEnable':blocked_enable,'cancelResult':cancel_result,'cancelledInstallResult':cancelled_install_result,'sameEnableAfterOldExit':enabled,'oldPmReaped':True,'retryAfterOldExit':retry,'interruptedHTTP':interrupted}
 finally:
  for name in ['write-phase2','release-query','release-old-pm']:(control/name).touch()
  for process in reversed(hosts):stop_host(process)
  if (control/'commands.jsonl').exists():
   for row in [json.loads(line) for line in (control/'commands.jsonl').read_text().splitlines()]:
    if row['ppid'] not in [p.pid for p in hosts]:continue
    deadline=time.monotonic()+5
    while (current:=same_process(row)) is not None:
     if current['state']=='Z':reap_known(row['pid'])
     elif time.monotonic()>=deadline:
      # Only this fixture's PID with its original /proc start identity.
      os.kill(row['pid'],signal.SIGKILL)
     if time.monotonic()>=deadline+5:raise RuntimeError('owned PM did not exit during cleanup')
     time.sleep(.02)
  pool.shutdown(wait=True)
  for handle in handles:handle.close()
  write(dest/'steps.json',steps);write(dest/'http-audit.json',audit)
  for file in control.iterdir():
   if file.is_file() and file.stat().st_size:shutil.copyfile(file,dest/file.name)
  write(dest/'final-profile.json',snapshot(profile))
  rows=[json.loads(line) for line in (control/'commands.jsonl').read_text().splitlines()] if (control/'commands.jsonl').exists() else []
  write(dest/'cleanup.json',{'hosts':[{'pid':p.pid,'returnCode':p.returncode,'currentIdentity':identity(p.pid)} for p in hosts],'fixtures':[{'pid':r['pid'],'startTicks':r['startTicks'],'sameProcessAfterCleanup':same_process(r)} for r in rows]})
results=[]
try:
 for mode in args.cases:
  result=main_case(mode);results.append(result);print(json.dumps({'case':mode,'completed':True}),flush=True)
  write(evidence/'COMPLETED.json',results)
 write(evidence/'SUMMARY.json',{'status':'PASS_SCOPED_LOCAL_HOST','results':results,'expectedServiceModuleSha256':args.expected_manager_sha256,'subreaper':'orchestrator-only Linux PR_SET_CHILD_SUBREAPER; only known self-created PM PIDs reaped','productScope':'service change early active-run guard; original late checks retained','registryNetwork':'package manager is fixed local Node fixture; no real pnpm or registry invocation'})
 print(json.dumps({'status':'OBSERVED_LOCAL_HOST','run':str(root),'cases':len(results)}))
except BaseException as error:
 write(evidence/'FAILURE.json',{'type':type(error).__name__,'message':str(error),'completedResults':results});print(json.dumps({'status':'FAILED','run':str(root),'error':str(error)}));raise
finally:(out/'latest-run.txt').write_text(str(root)+'\n')
