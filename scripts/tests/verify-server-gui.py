import argparse
import concurrent.futures
import hashlib
import http.cookiejar
import json
import re
import secrets
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

parser=argparse.ArgumentParser(description="Isolated real PostgreSQL/HTTP server GUI backend verification. Never target an existing installation.")
parser.add_argument("--source-root", type=Path, default=Path(__file__).resolve().parents[2])
parser.add_argument("--qa-root", type=Path, required=True)
parser.add_argument("--runtime-source", type=Path, required=True)
parser.add_argument("--port", type=int, default=27849)
parser.add_argument("--postgres-port", type=int, default=56849)
options=parser.parse_args()
BASE=options.source_root.resolve()
QA=options.qa_root.resolve()
ROOT=QA/"fresh"
if ROOT.exists(): raise SystemExit("Refusing an existing fixture directory; supply a new QA root.")
QA.mkdir(parents=True,exist_ok=True)
PS="C:/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
results=[]
def run(action,payload=None,root=ROOT):
    command=[PS,'-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','RemoteSigned','-File',str(BASE/'scripts/ServerGuiBackend.ps1'),'-Action',action,'-DataRoot',str(root),'-RuntimeSource',str(options.runtime_source),'-Port',str(options.port),'-PostgresPort',str(options.postgres_port)]
    # PG descendants can retain stdout handles; read protocol output from a
    # temporary output sink after the direct PS process exits. No input is saved.
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        subprocess.run(command,input=(json.dumps(payload,ensure_ascii=False)+'\n').encode() if payload else b'',stdout=output,stderr=errors,timeout=600)
        output.seek(0)
        return json.loads(output.read().decode('utf-8-sig'))
def record(name, condition, details=None):
    results.append({'check':name,'passed':bool(condition),'details':details})
    (QA/'verification.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf8')
    print(name+': '+str(bool(condition)),flush=True)
    if not condition: raise RuntimeError(name)

record('Fresh install without interactive administrator',run('start')['ok'])
record('PS5.1 service status and pending administrator',run('status').get('has_admin') is False)
weak=run('create',{'username':'验收管理员','password':'12345678'})
record('Django weak password rejected',not weak['ok'],weak['message'])
password='验证!'+secrets.token_urlsafe(24)
payload={'username':'验收管理员','password':password}
with concurrent.futures.ThreadPoolExecutor(2) as pool:
    attempts=list(pool.map(lambda _:run('create',payload),range(2)))
record('Concurrent first creation exactly once',sum(bool(r['ok']) for r in attempts)==1,[r['message'] for r in attempts])
record('Repeated creation refused',not run('create',payload)['ok'])
jar=http.cookiejar.CookieJar()
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),urllib.request.HTTPCookieProcessor(jar))
url=f'http://127.0.0.1:{options.port}/accounts/login/'
page=opener.open(url).read().decode()
csrf=re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"',page).group(1)
data=urllib.parse.urlencode({'username':payload['username'],'password':password,'csrfmiddlewaretoken':csrf,'next':'/enterprise/console/'}).encode()
response=opener.open(urllib.request.Request(url,data=data,headers={'Referer':url}))
body=response.read().decode()
record('Chinese username and Unicode password HTTP boss login',response.status==200 and '/enterprise/console/' in response.url,{'status':response.status,'url':response.url})
record('Authenticated console contains business management',('控制台' in body or 'console' in body.lower()))
config=(ROOT/'server-config.json').read_bytes()
pid=(ROOT/'django.pid').read_bytes()
app_hash=hashlib.sha256((ROOT/'app/manage.py').read_bytes()).hexdigest()
record('Reuse existing running service',run('start')['has_admin'] is True)
record('Reuse preserves PID configuration and installed app',config==(ROOT/'server-config.json').read_bytes() and pid==(ROOT/'django.pid').read_bytes() and app_hash==hashlib.sha256((ROOT/'app/manage.py').read_bytes()).hexdigest())
partial=QA/'partial';partial.mkdir(exist_ok=True);(partial/'retain.txt').write_text('preserve',encoding='utf8')
r=run('start',root=partial)
record('Unknown nonempty DataRoot preserved',not r['ok'] and (partial/'retain.txt').read_text()=='preserve' and not (partial/'server-config.json').exists(),r['message'])
record('System WScript to WinForms Probe exits zero',subprocess.run(['C:/Windows/System32/cscript.exe','//nologo',str(BASE/'Start-ServerGui.vbs'),'-Probe'],timeout=20).returncode==0)
# Preserve a running service while challenging its read-only ownership guards.
config_path=ROOT/'server-config.json'
pid_path=ROOT/'django.pid'
try:
    tampered=json.loads(config.decode('utf-8-sig'));tampered['app_root']=str(QA/'other-app')
    config_path.write_text(json.dumps(tampered),encoding='utf-8-sig')
    record('Foreign configured app path refused',not run('status')['ok'])
finally:
    config_path.write_bytes(config)
try:
    pid_path.write_text(str(__import__('os').getpid()),encoding='ascii')
    record('Foreign saved server PID refused',not run('start')['ok'])
finally:
    pid_path.write_bytes(pid)
record('Owned service remains healthy after refusals',run('status')['ok'])
print('All integration checks passed; fixture service left running for GUI review. Stop only this QA DataRoot when review ends.',flush=True)
