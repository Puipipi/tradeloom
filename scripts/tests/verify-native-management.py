"""Real isolated Windows service lifecycle acceptance. Never use an existing DataRoot."""
import argparse, json, os, subprocess, tempfile
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--package',required=True);p.add_argument('--runtime',required=True);p.add_argument('--data-root',required=True);a=p.parse_args()
package=Path(a.package).resolve();root=Path(a.data_root).resolve()
assert os.name=='nt' and not root.exists(), 'Use a fresh isolated Windows DataRoot'
backend=package/'scripts/ServerGuiBackend.ps1'
results=[]
def call(action,payload=None):
    with tempfile.TemporaryFile(mode='w+',encoding='utf-8') as out,tempfile.TemporaryFile(mode='w+',encoding='utf-8') as err:
        args=['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(backend),'-Action',action,'-DataRoot',str(root),'-RuntimeSource',a.runtime,'-Port','28435','-PostgresPort','57435']
        v=subprocess.run(args,input=json.dumps(payload)+'\n' if payload is not None else '',text=True,stdout=out,stderr=err,timeout=150)
        out.seek(0);line=out.readline();err.seek(0)
        assert line, 'Backend returned no JSON: '+err.read()
        data=json.loads(line);return data

def checked(name,condition):
    assert condition,name
    results.append(name);print('PASS: '+name,flush=True)
try:
    checked('missing installation status does not install',call('manage-status')['installed'] is False and not root.exists())
    started=call('manage-start');checked('real fresh install/start healthy',started['ok'] and started['running'] and started['database_running'] and started['healthy'])
    pidfile=root/'django.pid';first=pidfile.read_text().strip()
    denied=call('manage-stop',{'confirmed':False});checked('unconfirmed stop refused without mutation',not denied['ok'] and pidfile.read_text().strip()==first and call('manage-status')['healthy'])
    denied=call('manage-restart',{'confirmed':True,'command':'anything'});checked('extra confirmation fields rejected',not denied['ok'] and pidfile.read_text().strip()==first)
    restart=call('manage-restart',{'confirmed':True});checked('confirmed restart changes owned PID and restores health',restart['ok'] and restart['healthy'] and pidfile.read_text().strip()!=first)
    stopped=call('manage-stop',{'confirmed':True});checked('confirmed stop leaves web and database stopped',stopped['ok'] and not stopped['running'] and not stopped['database_running'])
    status=call('manage-status');checked('live status reports stopped',status['ok'] and not status['running'] and not status['database_running'])
    pidfile.write_text(str(os.getpid()))
    denied=call('manage-stop',{'confirmed':True});checked('foreign saved PID rejected without killing process',not denied['ok'] and pidfile.read_text()==str(os.getpid()))
    pidfile.unlink()
    unsupported=call('manage-start');checked('existing stopped install starts healthy',unsupported['ok'] and unsupported['healthy'])
finally:
    if (root/'server-config.json').exists():
        if (root/'django.pid').exists() and (root/'django.pid').read_text().strip()==str(os.getpid()): (root/'django.pid').unlink()
        stopped=call('manage-stop',{'confirmed':True});checked('QA services stopped',stopped['ok'] and not stopped['running'] and not stopped['database_running'])
print(json.dumps({'passed':results,'physicalDesktopUsed':False,'externalModelUsed':False},ensure_ascii=True))
