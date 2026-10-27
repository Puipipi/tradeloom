from django.test import SimpleTestCase
from workbench.native_artifact_service import inspect_content

class NativeArtifactContentTests(SimpleTestCase):
    def test_safe_types_and_binary(self):
        self.assertEqual(inspect_content(b'hello\n')[0], 'text/plain; charset=utf-8')
        self.assertEqual(inspect_content(b'\x89PNG\r\n\x1a\n')[0], 'application/octet-stream')
        self.assertEqual(inspect_content(b'<svg onload="alert(1)"></svg>')[1], False)


from django.test import TransactionTestCase, RequestFactory, override_settings
from django.core.files.uploadedfile import SimpleUploadedFile
from unittest.mock import patch
import tempfile, json, uuid, hashlib, subprocess
from pathlib import Path
NODE = r"C:/Users/23825/Desktop/ICT/workspace/runtime/tradeloom-harness/releases/0.2.1-rc.3-tradeloom-desktop-23/apps/desktop/.desktop-build/targets/win-x64/runtime/primary-runtime/dependencies/node/bin/node.exe"
NODE_SHA = "ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32"
from workbench.models import CanvasWorkflowRun, NativeArtifactVersion
from workbench.native_artifact_api import register, read

class NativeArtifactPgTests(TransactionTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        settings = override_settings(TRADELOOM_ARTIFACT_ROOT=self.tmp.name, TRADELOOM_ARTIFACT_NODE=NODE, TRADELOOM_ARTIFACT_NODE_SHA256=NODE_SHA); settings.enable(); self.addCleanup(settings.disable)
        env = patch.dict('os.environ', {'TRADELOOM_NATIVE_BRIDGE_KEY':'a'*64}); env.start(); self.addCleanup(env.stop)
        self.factory = RequestFactory(); self.runid = str(uuid.uuid4())
        declaration = {'sourceSessionSeq':4,'fileIndex':0,'presentCallId':'call','sourceTurn':1,'path':'a.txt'}
        start = {'childSessionId':'child','nativeRunId':'native','startInclusive':4}
        evidence = {'schema':'tradeloom.presented-evidence/v1','range':{**start,'endExclusive':5},'declarations':[declaration]}
        node = {'attempt':1,'status':'done','requestId':'req','toolCallId':'tool','childId':'child','nativeRunId':'native','artifactRangeStart':start,'artifactEvidence':evidence,'artifactSource':'deliverables/presented','artifacts':[declaration]}
        self.assertEqual(hashlib.sha256(Path(NODE).read_bytes()).hexdigest(), NODE_SHA)
        shell = Path(__file__).resolve().parents[2] / 'packages' / 'tradeloom-shell'
        script = "import {createConfirmedWorkflowDefinition as c} from './workflow-definition.js'; console.log(JSON.stringify(c({version:1,id:'demo',title:'Workflow',confirmed:true,nodes:[{id:'node',kind:'agent',agent:'product',title:'Task',instruction:'Task'}],edges:[]})))"
        definition = json.loads(subprocess.run([NODE,'--input-type=module','-e',script],cwd=shell,capture_output=True,text=True,timeout=8,check=True).stdout)
        self.snapshot = {'document':definition['document'],'workflowId':'demo','title':'Workflow','status':'done','revision':2,'id':self.runid,'executionMode':'native_dsh','journalSchema':'tradeloom.native-run-journal/v1','parentAgentId':'parent','sessionId':'session','bindingRevision':'1','definitionRevision':definition['definitionRevision'],'nodes':{'node':node}}
        self.snapshot['events'] = [{**{k:node[k] for k in ('requestId','toolCallId','childId','nativeRunId','artifactEvidence','artifactSource','artifacts')}, **{k:self.snapshot[k] for k in ('parentAgentId','sessionId','bindingRevision','definitionRevision')},'source':'subagent/end','type':'node-terminal','status':'done','stopReason':'completed','workflowRunId':self.runid,'nodeId':'node','attempt':1}]
        CanvasWorkflowRun.objects.create(id=self.runid, workflow_id='demo', revision=2,status='done',execution_mode='native_dsh',snapshot=self.snapshot)
        self.data = {'runId':self.runid,'nodeId':'node','attempt':1,'sourceSessionSeq':4,'fileIndex':0,'grant':{'sessionId':'child','runId':self.runid,'nodeId':'node','attempt':1,'sourceSessionSeq':4,'fileIndex':0,'authorized':True,'rootScope':'b'*64}}
    def post(self, content=b'hello', data=None, key='a'*64):
        request = self.factory.post('/private', {'metadata':json.dumps(data or self.data), 'file':SimpleUploadedFile('fixture',content)}, HTTP_X_TRADELOOM_NATIVE_BRIDGE=key)
        return register(request)
    def get(self, run_id, version_id, action='preview', key='a'*64):
        return read(self.factory.get('/private',HTTP_X_TRADELOOM_NATIVE_BRIDGE=key), run_id, version_id, action)
    def test_register_read_replay_and_conflict(self):
        first=self.post(); self.assertEqual(first.status_code,201); payload=json.loads(first.content)
        self.assertEqual(payload['sha256'],hashlib.sha256(b'hello').hexdigest()); self.assertNotIn('previewUrl',payload)
        version=payload['id']; self.assertEqual(self.get(self.runid,version).content,b'hello'); self.assertEqual(self.get(self.runid,version,'download').content,b'hello')
        self.assertEqual(self.get(self.runid,version,key='wrong').status_code,404)
        self.assertEqual(self.get(str(uuid.uuid4()),version).status_code,404)
        self.assertEqual(self.post().status_code,200); self.assertEqual(self.post(b'changed').status_code,409)
        self.assertEqual(NativeArtifactVersion.objects.count(),1)
    def test_invalid_grant_and_old_attempt_do_not_register(self):
        bad={**self.data,'grant':{**self.data['grant'],'authorized':1}}
        self.assertEqual(self.post(data=bad).status_code,400)
        self.snapshot['nodes']['node']['attempt']=2
        CanvasWorkflowRun.objects.filter(pk=self.runid).update(snapshot=self.snapshot)
        self.assertEqual(self.post().status_code,400); self.assertEqual(NativeArtifactVersion.objects.count(),0)
    def test_dangerous_and_tampered_content(self):
        response=self.post(b'<svg onload="alert(1)"></svg>'); version=json.loads(response.content)['id']
        self.assertEqual(self.get(self.runid,version).status_code,415)
        self.assertEqual(self.get(self.runid,version,'download').status_code,200)
        row=NativeArtifactVersion.objects.get(pk=version)
        from workbench.delivery.storage import resolve_artifact_file
        resolve_artifact_file(row.storage_key).write_bytes(b'other')
        self.assertEqual(self.get(self.runid,version,'download').status_code,404)
    def test_png_preview_and_read_failure(self):
        from io import BytesIO
        from PIL import Image
        out=BytesIO(); Image.new('RGB',(1,1),'red').save(out,format='PNG')
        response=self.post(out.getvalue()); version=json.loads(response.content)['id']
        preview=self.get(self.runid,version)
        self.assertEqual(preview.status_code,200); self.assertEqual(preview['Content-Type'],'image/png')
        self.assertEqual(preview.content,out.getvalue())
    def test_storage_failure_and_oversize(self):
        with patch('workbench.delivery.storage.write_native_artifact', side_effect=OSError('private path')):
            response=self.post()
        self.assertEqual(response.status_code,503); self.assertNotIn(b'private path',response.content)
        self.assertEqual(NativeArtifactVersion.objects.count(),0)
        with patch('workbench.native_artifact_api.MAX_NATIVE_ARTIFACT_BYTES', 1):
            self.assertEqual(self.post(b'xx').status_code,413)
    def test_database_failure_cleans_owned_file(self):
        from django.db import IntegrityError
        from pathlib import Path
        with patch('workbench.models.NativeArtifactVersion.objects.create', side_effect=IntegrityError('private detail')):
            response=self.post()
        self.assertEqual(response.status_code,503)
        self.assertEqual(NativeArtifactVersion.objects.count(),0)
        self.assertFalse(any(Path(self.tmp.name).rglob('content')))
    def test_migration_model_fields(self):
        fields={field.name for field in NativeArtifactVersion._meta.fields}
        self.assertTrue({'run','child_session_id','native_run_id','grant_root_scope','source_session_seq','file_index','sha256','storage_key'} <= fields)
    def test_definition_tampering_and_identity_fail_closed(self):
        import copy
        for change in (
            lambda s: s['document'].update(title='tampered'),
            lambda s: s.update(definitionRevision='sha256:'+'0'*64),
            lambda s: s['nodes'].update(other=copy.deepcopy(s['nodes']['node'])),
            lambda s: s['events'][0].update(childId='other'),
        ):
            value=copy.deepcopy(self.snapshot); change(value)
            CanvasWorkflowRun.objects.filter(pk=self.runid).update(snapshot=value)
            self.assertEqual(self.post().status_code,400)
            self.assertEqual(NativeArtifactVersion.objects.count(),0)
    def test_validator_missing_configuration_is_closed(self):
        with override_settings(TRADELOOM_ARTIFACT_NODE='', TRADELOOM_ARTIFACT_NODE_SHA256=''):
            response=self.post()
        self.assertEqual(response.status_code,503)
        self.assertEqual(json.loads(response.content)['code'],'source_validation_unavailable')
        self.assertEqual(NativeArtifactVersion.objects.count(),0)
    def test_private_routes_and_no_key(self):
        request={'metadata':json.dumps(self.data),'file':SimpleUploadedFile('fixture',b'hello')}
        self.assertEqual(self.client.post('/api/native-artifacts',request).status_code,404)
        request={'metadata':json.dumps(self.data),'file':SimpleUploadedFile('fixture',b'hello')}
        response=self.client.post('/api/native-artifacts',request,HTTP_X_TRADELOOM_NATIVE_BRIDGE='a'*64)
        self.assertEqual(response.status_code,201)
        version=json.loads(response.content)['id']; route=f'/api/native-artifacts/{self.runid}/{version}/download'
        self.assertEqual(self.client.get(route).status_code,404)
        self.assertEqual(self.client.get(route,HTTP_X_TRADELOOM_NATIVE_BRIDGE='a'*64).content,b'hello')

    def test_row_snapshot_mismatch_rejected(self):
        CanvasWorkflowRun.objects.filter(pk=self.runid).update(revision=3)
        self.assertEqual(self.post().status_code,400)
        self.assertEqual(NativeArtifactVersion.objects.count(),0)
    def test_collection_get_is_available(self):
        request=self.factory.get('/api/native-artifacts',{'runId':self.runid,'parentAgentId':'parent','parentSessionId':'session'},HTTP_X_TRADELOOM_NATIVE_BRIDGE='a'*64)
        self.assertNotEqual(register(request).status_code,405)
    def list_request(self, run_id=None, parent='parent', session='session', offset=None, key='a'*64):
        query={'runId':run_id or self.runid,'parentAgentId':parent,'parentSessionId':session}
        if offset is not None: query['offset']=str(offset)
        return self.client.get('/api/native-artifacts',query,HTTP_X_TRADELOOM_NATIVE_BRIDGE=key)
    def test_list_empty_auth_and_row_integrity(self):
        response=self.list_request(); self.assertEqual(response.status_code,200)
        self.assertEqual(json.loads(response.content),{'runId':self.runid,'items':[],'nextOffset':None})
        for response in (self.list_request(parent='wrong'),self.list_request(session='wrong'),self.list_request(run_id=str(uuid.uuid4())),self.list_request(key='wrong')):
            self.assertEqual(response.status_code,404); self.assertEqual(json.loads(response.content),{'code':'unavailable'})
        CanvasWorkflowRun.objects.filter(pk=self.runid).update(revision=3)
        self.assertEqual(self.list_request().status_code,404)
    def test_list_paging_and_frozen_source(self):
        from workbench.delivery.storage import write_native_artifact
        self.assertEqual(self.post().status_code,201)
        original=NativeArtifactVersion.objects.get()
        for i in range(1,11):
            item=NativeArtifactVersion.objects.get(pk=original.pk); item.id=uuid.uuid4(); item.file_index=i
            item.storage_key,_=write_native_artifact(b'hello',str(item.id)); item.save(force_insert=True)
        snapshot=self.snapshot; snapshot['nodes']['node']['attempt']=2
        CanvasWorkflowRun.objects.filter(pk=self.runid).update(snapshot=snapshot)
        with patch('workbench.native_artifact_api._verified_content', wraps=__import__('workbench.native_artifact_api',fromlist=['_verified_content'])._verified_content) as check:
            first=json.loads(self.list_request().content); self.assertEqual(check.call_count,10)
        self.assertEqual(len(first['items']),10); self.assertEqual(first['nextOffset'],10)
        second=json.loads(self.list_request(offset=10).content); self.assertEqual(len(second['items']),1); self.assertIsNone(second['nextOffset'])
        self.assertEqual(len({x['id'] for x in first['items']+second['items']}),11)
        self.assertTrue(all(x['source']['sessionId']=='child' and x['attempt']==1 for x in first['items']+second['items']))
    def test_list_invalid_file_and_database_failure(self):
        from workbench.delivery.storage import resolve_artifact_file
        self.assertEqual(self.post(b'<svg></svg>').status_code,201); row=NativeArtifactVersion.objects.get()
        item=json.loads(self.list_request().content)['items'][0]
        self.assertEqual(item['availability'],'ready'); self.assertFalse(item['previewSupported']); self.assertEqual(item['reason'],'preview_unsupported')
        with patch('workbench.native_artifact_api.MAX_NATIVE_ARTIFACT_BYTES', 1):
            self.assertEqual(json.loads(self.list_request().content)['items'][0]['availability'],'unavailable')
        resolve_artifact_file(row.storage_key).write_bytes(b'altered')
        item=json.loads(self.list_request().content)['items'][0]
        self.assertEqual(item['availability'],'unavailable'); self.assertEqual(item['reason'],'file_unavailable'); self.assertNotIn('downloadUrl',item)
        resolve_artifact_file(row.storage_key).unlink()
        self.assertEqual(json.loads(self.list_request().content)['items'][0]['availability'],'unavailable')
        with patch('workbench.native_artifact_api.NativeArtifactVersion.objects.filter',side_effect=__import__('django.db',fromlist=['DatabaseError']).DatabaseError('secret')):
            response=self.list_request()
        self.assertEqual(response.status_code,503); self.assertNotIn(b'items',response.content); self.assertNotIn(b'secret',response.content)
    def test_committed_list_read_in_independent_python(self):
        import os, sys, re
        from django.db import connection
        result=self.post(); version=json.loads(result.content)['id']; digest=json.loads(result.content)['sha256']
        cfg=connection.settings_dict; dbname=cfg['NAME']
        self.assertEqual(cfg['HOST'],'127.0.0.1'); self.assertEqual(str(cfg['PORT']),'55436'); self.assertEqual(cfg['USER'],'artifact_test')
        self.assertRegex(dbname,r'^tradeloom_test_native_artifact_20261027_a\d{2}$')
        env={k:os.environ[k] for k in ('SYSTEMROOT','WINDIR','TEMP','TMP','PGPASSFILE') if k in os.environ}
        env.update({'DJANGO_SETTINGS_MODULE':'config.settings','PYTHONDONTWRITEBYTECODE':'1','TRADELOOM_DB_NAME':dbname,'TRADELOOM_DB_USER':'artifact_test','TRADELOOM_DB_HOST':'127.0.0.1','TRADELOOM_DB_PORT':'55436','TRADELOOM_ARTIFACT_ROOT':self.tmp.name,'TRADELOOM_NATIVE_BRIDGE_KEY':'a'*64})
        script="""import django,sys,json;django.setup();from django.db import connection,transaction;from django.test import RequestFactory;from workbench.native_artifact_api import register
with transaction.atomic():
 with connection.cursor() as c:
  c.execute('SET TRANSACTION READ ONLY');c.execute('SELECT current_database(),current_user,inet_server_port()'); assert c.fetchone()==(sys.argv[1],'artifact_test',55436)
 r=register(RequestFactory().get('/api/native-artifacts',{'runId':sys.argv[2],'parentAgentId':'parent','parentSessionId':'session'},HTTP_X_TRADELOOM_NATIVE_BRIDGE='a'*64))
 assert r.status_code==200; items=json.loads(r.content)['items']; assert len(items)==1 and items[0]['id']==sys.argv[3] and items[0]['sha256']==sys.argv[4] and items[0]['source']['sessionId']=='child'
print('independent-read-ok')"""
        child=subprocess.run([sys.executable,'-X','utf8','-B','-c',script,dbname,self.runid,version,digest],env=env,cwd=Path(__file__).resolve().parents[2],capture_output=True,text=True,timeout=20,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
        self.assertEqual(child.returncode,0,child.stderr); self.assertEqual(child.stdout.strip(),'independent-read-ok')
