#!/usr/bin/env python3
"""Actual appAuth dynamic RPC on real DSH; local synthetic OAuth flow only."""
import argparse, pathlib, tempfile, json, os, subprocess, time, re, shutil
import http.cookiejar, urllib.request
p=argparse.ArgumentParser();p.add_argument('--prefix',required=True,type=pathlib.Path);p.add_argument('--out',required=True,type=pathlib.Path);p.add_argument('--port',type=int,default=39421);a=p.parse_args()
prefix=a.prefix.resolve();assert json.loads((prefix/'node_modules/@deepseek-ai/dsh/package.json').read_text())['version']=='0.2.2-rc.1';repo=pathlib.Path(__file__).resolve().parents[2];a.out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(tempfile.mkdtemp(prefix='app-auth-',dir=a.out.resolve()));home=root/'home';home.mkdir();workspace=root/'workspace';workspace.mkdir();fixture=root/'provider';fixture.mkdir();(fixture/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
(fixture/'index.mjs').write_text('''import z from '@deepseek-ai/schemastery';
export const name='synthetic-auth-provider';
export const inject=['authorization'];
export const Config=z.object({providers:z.dict(z.object({displayName:z.string(),apiKeyEnv:z.string()})).default({})});
export function apply(ctx){for(const provider of ['openai-codex','anthropic'])ctx.authorization.registerFlow({key:'llm-pi-ai/'+provider,label:'Local synthetic flow',methods:[{id:'oauth',label:'Local'}],async run(session){
 session.notify({message:'Local fixture only'});
 const answer=await session.prompt({message:'Enter synthetic approval',placeholder:'approve',signal:session.signal});
 session.signal.throwIfAborted();if(answer!=='approve')throw Error('authorization failed');
 await session.commit({kind:'grant',payload:{type:'oauth',access:'SYNTHETIC_ACCESS',refresh:'SYNTHETIC_REFRESH',expires:4102444800000}});
}});}
''')
profile=home/'profiles/web';profile.mkdir(parents=True);(profile/'package.json').write_text(json.dumps({'name':'local-auth-test','private':True,'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
rows=[{'id':x,'disabled':True}for x in ['session-title-llm','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]
# Real authorization service in a separate public Cordis scope; built-in OAuth flows are never called.
rows += [{'insert':[{'id':'synthetic-auth-scope','name':'cordis:group','group':True,'isolate':{'authorization':True},'config':[{'id':'local-authorization','name':'@deepseek-ai/dsh-authorization'},{'id':'local-provider','name':str(fixture/'index.mjs')},{'id':'dsh-app-auth','name':str(repo/'app/assets/engine/auth/index.mjs')}]}]}]
(profile/'cordis.patch.yml').write_text(json.dumps(rows));env={k:os.environ[k]for k in ['PATH','LANG','LC_ALL','TMPDIR']if k in os.environ};env.update(HOME=str(home),DSH_HOME=str(home),DSH_TELEMETRY_DISABLED='1')
log=root/'private-host.log';handle=log.open('w');host=None;audit=[];base=f'http://127.0.0.1:{a.port}'
try:
 host=subprocess.Popen(['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web','--no-open','--host','127.0.0.1','--port',str(a.port)],cwd=workspace,env=env,stdout=handle,stderr=subprocess.STDOUT)
 deadline=time.monotonic()+45
 while True:
  assert host.poll()is None,'Host exited; inspect private log'
  token=re.search(r'token=([\w-]+)',log.read_text())
  if token:break
  assert time.monotonic()<deadline,'Host start timeout';time.sleep(.05)
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));op.open(base+'/?token='+token[1],timeout=10).read()
 def rpc(method,args={}):
  body={'type':'client-request','rpcId':str(len(audit)),'method':method,'payload':{'args':args}}
  req=urllib.request.Request(base+'/api/'+method,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':base})
  with op.open(req,timeout=15)as r:out=json.load(r)
  result=out['result'];audit.append({'method':method,'ok':result.get('ok'),'phase':result.get('value',{}).get('phase') if isinstance(result.get('value'),dict)else None,'errorCode':result.get('error',{}).get('code') if isinstance(result.get('error'),dict)else None});assert result.get('ok'),(method,result);return result.get('value')
 def settled(id,phases):
  for _ in range(100):
   v=rpc('appAuth/poll',{'attemptId':id})
   if v['phase']in phases:return v
   time.sleep(.03)
  raise AssertionError({'phase':v.get('phase'),'message':'Expected local synthetic prompt'})
 assert all(not x['signedIn']for x in rpc('appAuth/list')['providers'])
 for provider in ['openai-codex','anthropic']:
  id=rpc('appAuth/begin',{'provider':provider})['attemptId'];assert settled(id,['prompt','failed'])['phase']=='prompt'
  rpc('appAuth/cancel',{'attemptId':id});assert settled(id,['cancelled','failed'])['phase']=='cancelled'
  assert not next(x for x in rpc('appAuth/list')['providers']if x['id']==provider)['signedIn']
  id=rpc('appAuth/begin',{'provider':provider})['attemptId'];assert settled(id,['prompt','failed'])['phase']=='prompt'
  rpc('appAuth/answer',{'attemptId':id,'value':'approve'});assert settled(id,['done','failed'])['phase']=='done'
  assert next(x for x in rpc('appAuth/list')['providers']if x['id']==provider)['signedIn']
  settings=rpc('settings/describe');section=next(x for x in settings['namespaces']if x['ns']=='llm-pi-ai');assert section['value']['providers'][provider]['displayName']
  rpc('appAuth/signOut',{'provider':provider});assert not next(x for x in rpc('appAuth/list')['providers']if x['id']==provider)['signedIn']
  section=next(x for x in rpc('settings/describe')['namespaces']if x['ns']=='llm-pi-ai');assert provider not in section['value'].get('providers',{})
 result={'status':'PASS','dshVersion':json.loads((prefix/'node_modules/@deepseek-ai/dsh/package.json').read_text())['version'],'methods':sorted({x['method']for x in audit if x['method'].startswith('appAuth/')}),'requests':len(audit),'scope':'actual Host/RPC/AppAuth/authorization/credentials/settings; synthetic provider, no external OAuth, no Android'}
 (a.out/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if host and host.poll()is None:
  host.terminate()
  try:host.wait(timeout=10)
  except subprocess.TimeoutExpired:host.kill();host.wait(timeout=5)
 handle.close();(a.out/'audit.json').write_text(json.dumps(audit,indent=2));(a.out/'latest-run.txt').write_text(str(root))
