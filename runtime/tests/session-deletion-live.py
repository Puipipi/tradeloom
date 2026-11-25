import argparse, pathlib, tempfile, subprocess, os, time, re, urllib.request, urllib.error, json, socket
ap=argparse.ArgumentParser();ap.add_argument("--prefix",type=pathlib.Path,required=True);ap.add_argument("--output",type=pathlib.Path,required=True);a=ap.parse_args()
a.repo=pathlib.Path(__file__).resolve().parents[2];a.prefix=a.prefix.resolve();a.output=a.output.resolve();a.output.mkdir(parents=True,exist_ok=True)
with tempfile.TemporaryDirectory(prefix="delete-live-") as tmp:
 home=pathlib.Path(tmp);diag=a.repo/"runtime/tests/fixtures/session-deletion-observer.mjs"
 patch=home/"bridge.yml";patch.write_text("- insert:\n    - id: dsh-go-bridge\n      name: "+str(a.repo/"runtime/bridge/dsh-go-bridge/lib/index.js")+"\n    - id: diagnostic\n      name: "+str(diag)+"\n")
 sock=socket.socket();sock.bind(("127.0.0.1",0));port=sock.getsockname()[1];sock.close()
 log=a.output/"host.log"
 with log.open("w") as f:
  p=subprocess.Popen(["node",str(a.prefix/"node_modules/@deepseek-ai/dsh/lib/bin.js"),"web","--patch",str(patch),"--host","127.0.0.1","--no-open","--port",str(port)],stdout=f,stderr=subprocess.STDOUT,env={**os.environ,"HOME":tmp,"DSH_HOME":str(home/"dsh"),"TZ":"Asia/Shanghai"})
  try:
   for _ in range(300):
    m=re.search(r"token=([\w-]+)",log.read_text())
    if m:break
    if p.poll() is not None:raise RuntimeError(log.read_text())
    time.sleep(.1)
   else:raise TimeoutError("boot")
   op=urllib.request.build_opener(urllib.request.HTTPCookieProcessor());op.open(f"http://127.0.0.1:{port}/?token="+m[1])
   results=[]
   def request(path,data=None):
    req=urllib.request.Request(f"http://127.0.0.1:{port}"+path,data=None if data is None else json.dumps(data).encode(),headers={"Content-Type":"application/json"})
    try:
     with op.open(req,timeout=15) as r:status,body=r.status,json.load(r)
    except urllib.error.HTTPError as e:status,body=e.code,json.load(e)
    result={"path":path,"status":status,"body":body};results.append(result);print(json.dumps(result),flush=True);return status,body
   def rpc(method,args):return request("/api/"+method,{"type":"client-request","rpcId":"delete-test","method":method,"payload":{"args":args}})
   def create(id):
    status,body=rpc("session/create",{"request":{"sessionId":id,"cwd":tmp}})
    assert status==200 and body["result"]["ok"] is True
   def observe(action,id,extra=""):return request("/local-deletion-test/"+action+"?id="+id+extra)
   def delete(id):return request("/dsh-go/v1/sessions/delete",{"sessionId":id})
   assert request("/dsh-go/v1/sessions/deletion")== (200,{"supported":True,"version":1})
   create("fresh")
   fresh=delete("fresh")
   state=observe("snapshot","fresh")[1]
   assert fresh== (200,{"deleted":True,"sessionId":"fresh"})
   assert state["attempt"]["before"]["materialized"] is False
   assert state["attempt"]["capturedWriter"]["materialized"] is True
   assert state["current"]["deleted"] and not state["current"]["writer"]
   assert delete("fresh")[0]==200  # committed tombstone retry is idempotent
   create("durable")
   assert observe("flush","durable")[0]==200
   assert observe("snapshot","durable")[1]["current"]["materialized"] is True
   assert delete("durable")[0]==200
   import concurrent.futures
   with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
    for id,fail in [("gate",False),("failure",True)]:
     create(id);observe("arm",id,"&fail=1" if fail else "")
     future=pool.submit(delete,id)
     for _ in range(200):
      if observe("entered",id)[1]["entered"]:break
      time.sleep(.01)
     else:raise TimeoutError("dispose gate")
     assert observe("snapshot",id)[1]["current"]["pending"] is True
     for action in ["open","clone-create"]:
      status,body=observe(action,id)
      assert status==500 and body["name"]=="SessionPersistenceNotFoundError",body
     status,body=rpc("session/prompt",{"request":{"requestId":"blocked-"+id,"sessionId":id,"mode":"queue","content":[{"type":"text","text":"must not reach a model"}]}})
     assert status==200 and body["result"]["ok"] is False,body
     assert "SessionPersistenceNotFoundError" in body["result"]["error"]["details"]["reason"],body
     assert observe("flush",id)[0]==200  # already-owned drain remains legitimate under the fence
     observe("release",id)
     assert future.result()[0]==(500 if fail else 200)
     state=observe("snapshot",id)[1]["current"]
     assert state["pending"] is False
     if fail:
      assert state["deleted"] is False and state["writer"] is True
      assert delete(id)[0]==200
   print("PASS: real Host fresh, durable, tombstone retry, concurrent open/create/prompt refusal, disposal failure and retry",flush=True)
  finally:
   p.terminate()
   try:p.wait(timeout=10)
   except subprocess.TimeoutExpired:p.kill();p.wait()
