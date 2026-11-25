#!/usr/bin/env python3
"""Manual two-edit migration of exact official rc4 presets; real scoped tool capabilities."""
import argparse, pathlib, tempfile, json, os, subprocess, time, re, shutil
import http.cookiejar, urllib.request
p=argparse.ArgumentParser();p.add_argument('--prefix',required=True,type=pathlib.Path);p.add_argument('--old-prefix',required=True,type=pathlib.Path);p.add_argument('--out',required=True,type=pathlib.Path);p.add_argument('--port',type=int,default=39421);a=p.parse_args()
prefix=a.prefix.resolve();assert json.loads((prefix/'node_modules/@deepseek-ai/dsh/package.json').read_text())['version']=='0.2.2-rc.1';repo=pathlib.Path(__file__).resolve().parents[2];a.out.mkdir(parents=True,exist_ok=True)
root=pathlib.Path(tempfile.mkdtemp(prefix='app-auth-',dir=a.out.resolve()));home=root/'home';home.mkdir();workspace=root/'workspace';workspace.mkdir();fixture=root/'provider';fixture.mkdir();(fixture/'node_modules').symlink_to(prefix/'node_modules',target_is_directory=True)
(fixture/'index.mjs').write_text("""export const name='executor-observer';
export const inject=['agents','tools','webServer','connection'];
export function apply(ctx){ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/executor-proof',handler:async(req,res)=>{
 const rejected=ctx.connection.requestRejection(req);if(rejected!==undefined){res.writeHead(rejected);res.end();return;}
 const id=new URL(req.url,'http://localhost').searchParams.get('id');const agent=ctx.agents.get(id);
 const executor=ctx.tools.selectExecutor(agent);
 const names=['list_agents','subagent','list_subagent_models'];const definitions=Object.fromEntries(names.map(name=>[name,ctx.tools.get(name,agent)]));
 for(const name of names)if(!definitions[name])throw Error('Missing scoped tool '+name);
 const exec={agent,signal:AbortSignal.timeout(10000),callId:'migration-read-only',rootCallId:'migration-read-only'};
 const listed=await definitions.list_agents.execute({},exec);const models=await definitions.list_subagent_models.execute({},exec);
 const proof={agentId:agent.id,executor:executor.constructor.name,visible:names,subagentParameters:Object.keys(definitions.subagent.parameters.properties),listed,models,schemas:executor.describe(Object.values(definitions)).schemas.map(x=>x.name)};
 res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(proof));}}));}
""")
profile=home/'profiles/web';profile.mkdir(parents=True);(profile/'package.json').write_text(json.dumps({'name':'preset-upgrade-fixture','private':True,'dsh':{'profile':{'bundles':['@deepseek-ai/dsh-base','@deepseek-ai/dsh-web-app']}}}))
assert json.loads((a.old_prefix.resolve()/'node_modules/@deepseek-ai/dsh/package.json').read_text())['version']=='0.2.1-rc.4'
legacy=[];migration=[]
for mode in ['standard','ptc']:
 source=a.old_prefix.resolve()/'node_modules/@deepseek-ai/dsh-web-app/presets'/f'{mode}.patch.yml'
 text=source.read_text().replace(f'id: preset-{mode}',f'id: preset-legacy-{mode}',1).replace(f'id: {mode}\n',f'id: legacy-{mode}\n',1)
 # Customize an existing valid field before migration; never replace the whole array.
 original_persona='prefix: You are a coding agent powered by the {{model}} model.'
 assert text.count(original_persona)==1
 text=text.replace(original_persona,'prefix: W17 CUSTOM PERSONA — retain exactly')
 redundant="              - id: tool-subagent-list-agents\n                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'\n"
 old_field='                  modelSelectionSettings: true\n'
 new_fields='                  modelSelection: true\n                  modelDiscovery: true\n'
 assert text.count(redundant)==1 and text.count(old_field)==1
 assert "name: '@deepseek-ai/dsh-tool-subagent-control'"in text
 assert 'modelSelection:'not in text and 'modelDiscovery:'not in text
 before=text;without_redundant=before.replace(redundant,'',1);text=without_redundant.replace(old_field,new_fields,1)
 assert text.replace(new_fields,old_field,1)==without_redundant
 assert 'prefix: W17 CUSTOM PERSONA — retain exactly'in text
 assert ("name: '@deepseek-ai/dsh-agent-tool-presentation'"in text)==(mode=='ptc')
 migration.append({'preset':mode,'removedExactRedundantRow':True,'mappedExactTrue':True,'otherBytesAndOrderPreserved':True,'customPersonaPreserved':True,'oldSelectorPreserved':mode=='ptc'})
 target=root/f'legacy-{mode}.yml';target.write_text(text);legacy += ['--patch',str(target)]
rows=[{'id':x,'disabled':True}for x in ['session-title-llm','llm-pi-ai','llm-deepseek-account','session-telemetry-otel','web-search-deepseek','web-deepseek-api','web-fetch-http','tool-web']]
rows += [{'insert':[{'id':'executor-observer','name':str(fixture/'index.mjs')}]}]
(profile/'cordis.patch.yml').write_text(json.dumps(rows));env={k:os.environ[k]for k in ['PATH','LANG','LC_ALL','TMPDIR']if k in os.environ};env.update(HOME=str(home),DSH_HOME=str(home),DSH_TELEMETRY_DISABLED='1')
log=root/'private-host.log';handle=log.open('w');host=None;audit=[];base=f'http://127.0.0.1:{a.port}'
try:
 host=subprocess.Popen(['node',str(prefix/'node_modules/@deepseek-ai/dsh/lib/bin.js'),'web',*legacy,'--no-open','--host','127.0.0.1','--port',str(a.port)],cwd=workspace,env=env,stdout=handle,stderr=subprocess.STDOUT)
 deadline=time.monotonic()+45
 while True:
  assert host.poll()is None,'Host exited; inspect private log'
  token=re.search(r'token=([\w-]+)',log.read_text())
  if token:break
  assert time.monotonic()<deadline,'Host start timeout';time.sleep(.05)
 op=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()));op.open(base+'/?token='+token[1],timeout=10).read()
 def rpc(method,args={},allow_error=False):
  body={'type':'client-request','rpcId':str(len(audit)),'method':method,'payload':{'args':args}}
  req=urllib.request.Request(base+'/api/'+method,data=json.dumps(body).encode(),headers={'Content-Type':'application/json','Origin':base})
  with op.open(req,timeout=15)as r:out=json.load(r)
  result=out['result'];audit.append({'method':method,'ok':result.get('ok'),'phase':result.get('value',{}).get('phase') if isinstance(result.get('value'),dict)else None,'errorCode':result.get('error',{}).get('code') if isinstance(result.get('error'),dict)else None});assert result.get('ok')or allow_error,(method,result);return result if allow_error else result.get('value')
 proofs=[]
 for preset in ['legacy-standard','legacy-ptc']:
  created=rpc('session/create',{'request':{'agentPreset':preset,'cwd':str(workspace)}})
  with op.open(base+'/executor-proof?id='+created['sessionId'],timeout=15)as response:proof=json.load(response)
  expected='PtcExecutor'if preset.endswith('ptc')else'NativeToolExecutor'
  assert proof['executor']==expected,(preset,proof)
  assert set(['provider','model','reasoning_effort'])<=set(proof['subagentParameters']),proof
  assert proof['listed']==[],proof
  assert isinstance(proof['models'],str)and proof['models'],proof
  assert (proof['schemas']==['run_code'])if preset.endswith('ptc')else set(proof['visible'])<=set(proof['schemas']),proof
  proofs.append({'preset':preset,**proof})
 result={'status':'PASS_MANUAL_MIGRATION_SCOPED','migration':migration,'proofs':proofs,'scope':'exact rc4 standard/PTC two-edit migration; actual session/create, scoped definitions and direct read-only registered-tool calls; no subagent spawn, LLM request, Android, or arbitrary user-config migration'}
 (a.out/'result.json').write_text(json.dumps(result,indent=2));print(json.dumps(result))
finally:
 if host and host.poll()is None:
  host.terminate()
  try:host.wait(timeout=10)
  except subprocess.TimeoutExpired:host.kill();host.wait(timeout=5)
 handle.close();(a.out/'audit.json').write_text(json.dumps(audit,indent=2));(a.out/'latest-run.txt').write_text(str(root))
