"""Small real filesystem/process fixtures, NOT a real TradeLoom update proof.

The production CLI still requires a full reviewed candidate and baseline.
These tests exercise the exact fixed swap/recovery steps and actual CIM fence.
"""
from pathlib import Path
import copy,importlib.util,json,os,shutil,subprocess,sys,tempfile,unittest
from unittest.mock import patch
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('fixed_apply',R/'scripts/apply-dsh-candidate.py')
apply=importlib.util.module_from_spec(spec);spec.loader.exec_module(apply)

class Interruption(BaseException):pass

class SamePathProgramTests(unittest.TestCase):
    def cli(self,operation,target,work):
        return subprocess.run([sys.executable,'-B',str(R/'scripts/apply-dsh-candidate.py'),operation,'--target',str(target),'--work-root',str(work)],capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)

    def fixture(self,folder,schema=1):
        root=Path(folder);target=root/'program';work=root/'update';target.mkdir();work.mkdir()
        (target/'app').mkdir();(target/'app/payload.bin').write_bytes(b'old app')
        (target/apply.WRAPPER).write_bytes(b'old wrapper')
        data=target/'data-ui-r2' if schema==1 else root/'external-data'
        config=(json.dumps({'schemaVersion':schema,'dataDirectory':'data-ui-r2' if schema==1 else str(data),'hostPort':3088,'djangoPort':3090,'postgresPort':55432},indent=1)+'\n').encode()
        (target/'launcher.json').write_bytes(config)
        data.mkdir();(data/'preserved.txt').write_bytes(b'fixture data: never an update input')
        names=['app/payload.bin',apply.WRAPPER,'launcher.json']
        before={'schemaVersion':1,'files':[{'path':name,**apply.pin(target/name)} for name in names]}
        apply.save(work/'before-entry-manifest.json',before);(work/'before-launcher.json').write_bytes(config)
        (work/'staged-app').mkdir();(work/'staged-app/payload.bin').write_bytes(b'new app')
        (work/'staged-launcher.exe').write_bytes(b'new wrapper')
        released=copy.deepcopy(before)
        for row in released['files']:
            if row['path']=='app/payload.bin':row.update(apply.pin(work/'staged-app/payload.bin'))
            elif row['path']==apply.WRAPPER:row.update(apply.pin(work/'staged-launcher.exe'))
            else:row.update(apply.build.replay.pin(b'candidate config deliberately different'))
        apply.save(work/'candidate-entry-manifest.json',released)
        state={'schemaVersion':1,'target':str(target),'work':str(work),'phase':'prepared','config':apply.build.replay.pin(config),'wrapperBefore':apply.pin(target/apply.WRAPPER),'wrapperAfter':apply.pin(work/'staged-launcher.exe'),'runtimeLogBefore':None}
        apply.save(work/'state.json',state)
        return target,work,state,config

    def assert_restored(self,target,work,config):
        self.assertEqual((target/'app/payload.bin').read_bytes(),b'old app')
        self.assertEqual((target/apply.WRAPPER).read_bytes(),b'old wrapper')
        self.assertEqual((target/'launcher.json').read_bytes(),config)
        data=apply.config_identity(target)[1]
        self.assertEqual((data/'preserved.txt').read_bytes(),b'fixture data: never an update input')
        self.assertEqual(apply.load(work/'state.json')['phase'],'restored')

    def test_real_swap_preserves_config_data_and_records_effective_identity(self):
        with tempfile.TemporaryDirectory(prefix='tradeloom-same-path-') as directory:
            target,work,state,config=self.fixture(directory)
            with patch.object(apply,'stopped',return_value=None):apply.install_prepared(target,work,state)
            self.assertEqual((target/'app/payload.bin').read_bytes(),b'new app');self.assertEqual((target/apply.WRAPPER).read_bytes(),b'new wrapper')
            self.assertEqual((target/'launcher.json').read_bytes(),config)
            effective=apply.load(work/'installed-entry-manifest.json');row=next(row for row in effective['files'] if row['path']=='launcher.json')
            self.assertEqual({k:row[k] for k in ['bytes','sha256']},apply.build.replay.pin(config))
            self.assertEqual(row['origin']['kind'],'preserved-target-launcher-config')
            refused=self.cli('recover',target,work);self.assertNotEqual(refused.returncode,0);self.assertIn(b'no interrupted operation',refused.stderr)
            rolled_back=self.cli('rollback',target,work);self.assertEqual(rolled_back.returncode,0,rolled_back.stdout+rolled_back.stderr)
            self.assert_restored(target,work,config)

    def test_real_failure_rolls_back_and_keeps_original_error(self):
        with tempfile.TemporaryDirectory(prefix='tradeloom-swap-failure-') as directory:
            target,work,state,config=self.fixture(directory);error=OSError('controlled move boundary failure')
            def fail(name):
                if name=='app-installed':raise error
            with patch.object(apply,'stopped',return_value=None),patch.object(apply,'_checkpoint',side_effect=fail):
                with self.assertRaises(OSError) as raised:apply.install_prepared(target,work,state)
            self.assertIs(raised.exception,error);self.assert_restored(target,work,config)

    def test_each_interrupted_real_rename_is_recoverable(self):
        for boundary in ['app-backed-up','app-installed','wrapper-backed-up','wrapper-installed','runtime-log-preserved']:
            with self.subTest(boundary=boundary),tempfile.TemporaryDirectory(prefix='tradeloom-interrupted-') as directory:
                target,work,state,config=self.fixture(directory,schema=2 if boundary=='runtime-log-preserved' else 1)
                if boundary=='runtime-log-preserved':
                    (target/apply.RUNTIME_LOG).write_bytes(b'interrupted runtime history\n');state['runtimeLogBefore']=apply.pin(target/apply.RUNTIME_LOG);apply.save(work/'state.json',state)
                def interrupt(name):
                    if name==boundary:raise Interruption()
                with patch.object(apply,'stopped',return_value=None),patch.object(apply,'_checkpoint',side_effect=interrupt):
                    with self.assertRaises(Interruption):apply.install_prepared(target,work,state)
                recovered=self.cli('recover',target,work);self.assertEqual(recovered.returncode,0,recovered.stdout+recovered.stderr)
                self.assert_restored(target,work,config)
                if boundary=='runtime-log-preserved':self.assertEqual((target/apply.RUNTIME_LOG).read_bytes(),b'interrupted runtime history\n')

    def test_real_payload_validation_rejects_modified_and_unlisted_files(self):
        with tempfile.TemporaryDirectory(prefix='tradeloom-app-files-') as directory:
            target,work,state,config=self.fixture(directory);rows=apply.app_rows(apply.load(work/'before-entry-manifest.json'))
            apply.verify_app(target/'app',rows)
            (target/'app/payload.bin').write_bytes(b'modified')
            with self.assertRaisesRegex(ValueError,'payload/collection'):apply.verify_app(target/'app',rows)
            (target/'app/payload.bin').write_bytes(b'old app');(target/'app/unlisted').write_bytes(b'extra')
            with self.assertRaisesRegex(ValueError,'payload/collection'):apply.verify_app(target/'app',rows)

    def test_reviewed_manifest_hash_is_required_without_reading_data(self):
        with tempfile.TemporaryDirectory(prefix='tradeloom-reviewed-manifest-') as directory:
            target,work,state,config=self.fixture(directory)
            rows=copy.deepcopy(apply.load(work/'before-entry-manifest.json')['files'])
            rows.append({'path':'app/resources/tradeloom/deployment.json','bytes':1,'sha256':'0'*64})
            document=work/'reviewed.json';apply.save(document,{'schemaVersion':1,'files':rows})
            reviewed=apply.pin(document)['sha256'];self.assertEqual(len(apply.manifest(document,reviewed)['files']),4)
            with self.assertRaisesRegex(ValueError,'manifest SHA256 mismatch'):apply.manifest(document,'0'*64)
            raw,data=apply.config_identity(target);self.assertEqual(raw,config);self.assertEqual(data,target/'data-ui-r2')
            self.assertEqual((target/'data-ui-r2/preserved.txt').read_bytes(),b'fixture data: never an update input')

    def test_schema2_old_runtime_log_is_preserved_outside_program_and_restored(self):
        with tempfile.TemporaryDirectory(prefix='tradeloom-runtime-log-') as directory:
            target,work,state,config=self.fixture(directory,schema=2)
            (target/apply.RUNTIME_LOG).write_bytes(b'fixture existing runtime history\n');state['runtimeLogBefore']=apply.pin(target/apply.RUNTIME_LOG)
            with patch.object(apply,'stopped',return_value=None):apply.install_prepared(target,work,state)
            self.assertFalse((target/apply.RUNTIME_LOG).exists());self.assertEqual((work/'before-runtime-launcher.log').read_bytes(),b'fixture existing runtime history\n')
            with patch.object(apply,'stopped',return_value=None):apply._restore(target,work,state)
            self.assertEqual((target/apply.RUNTIME_LOG).read_bytes(),b'fixture existing runtime history\n');self.assert_restored(target,work,config)

    def test_actual_cim_refuses_unusual_named_process_under_target(self):
        self.assertEqual(os.name,'nt','actual Windows CIM owner check required, no skip')
        compiler=Path(os.environ.get('WINDIR','C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        with tempfile.TemporaryDirectory(prefix='tradeloom-owned-process-') as directory:
            target,work,state,config=self.fixture(directory);source=Path(directory)/'Wait.cs'
            source.write_text('using System;class Wait {static void Main(){Console.ReadLine();}}',encoding='utf-8')
            executable=target/'unusual-tool.exe'
            compiled=subprocess.run([str(compiler),'/nologo','/target:exe','/out:'+str(executable),str(source)],capture_output=True)
            self.assertEqual(compiled.returncode,0,compiled.stdout+compiled.stderr)
            # A tiny stdin-waiting console fixture, not a DSH Host/model/GUI.
            child=subprocess.Popen([str(executable)],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                owners=apply.owned_processes([target,work]);self.assertIn(child.pid,[row['ProcessId'] for row in owners])
                with self.assertRaisesRegex(ValueError,'in use'):apply.install_prepared(target,work,state)
                self.assertEqual((target/'app/payload.bin').read_bytes(),b'old app');self.assertEqual((target/'launcher.json').read_bytes(),config)
            finally:
                child.communicate(input=b'\n',timeout=30)
            self.assertEqual(child.returncode,0)
            exact_query=r'''$ErrorActionPreference='Stop';Import-Module (Join-Path $PSHOME 'Modules/CimCmdlets/CimCmdlets.psd1') -ErrorAction Stop;if(Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:FIXTURE_PID)){exit 3}'''
            gone=subprocess.run(['powershell.exe','-NoProfile','-Command',exact_query],env={**os.environ,'FIXTURE_PID':str(child.pid)},capture_output=True,creationflags=subprocess.CREATE_NO_WINDOW)
            self.assertEqual(gone.returncode,0,gone.stderr)

    def test_updater_cli_rejects_target_data_and_dependency_overlap_before_network_or_write(self):
        updater=apply.build.module('updater_path_regression',R/'scripts/update-dsh-candidate.py')
        for case in ['work-target','cache-target-data','output-target','apply-target-data','apply-dependency','apply-output']:
            with self.subTest(case=case),tempfile.TemporaryDirectory(prefix='tradeloom-updater-boundary-') as directory:
                root=Path(directory);target,fixture_work,state,config=self.fixture(directory,schema=2)
                resources=target/'app/resources/tradeloom';resources.mkdir(parents=True)
                (resources/'.tradeloom-bootstrap-owned').write_bytes(b'tradeloom-bootstrap-v1\n')
                (resources/'deployment.json').write_text(json.dumps({'schemaVersion':2,'deploymentMode':'packaged'}),encoding='utf-8')
                baseline={'schemaVersion':1,'files':[{'path':name,**apply.pin(target/name)} for name in ['app/payload.bin','app/resources/tradeloom/.tradeloom-bootstrap-owned','app/resources/tradeloom/deployment.json',apply.WRAPPER,'launcher.json']]}
                document=fixture_work/'target-baseline.json';apply.save(document,baseline)
                old_data=apply.config_identity(target)[1];paths={'work-root':root/'fetch-work','cache-root':root/'official-cache','output-root':root/'new-output','apply-work':root/'apply-work'}
                deps={name:root/'program-inputs'/name for name in ['python-packages','postgresql','plugin-seed']}
                for path in deps.values():path.mkdir(parents=True)
                if case=='work-target':paths['work-root']=target/'new-work'
                elif case=='cache-target-data':paths['cache-root']=old_data/'new-cache'
                elif case=='output-target':paths['output-root']=target/'new-output'
                elif case=='apply-target-data':paths['apply-work']=old_data/'new-apply'
                elif case=='apply-dependency':paths['apply-work']=deps['python-packages']/'new-apply'
                else:paths['apply-work']=paths['output-root']/'new-apply'
                argv=['update-dsh-candidate.py','--apply-to',str(target),'--target-manifest',str(document),'--target-manifest-sha256',apply.pin(document)['sha256'],'--data-root',str(root/'candidate-data')]
                for name,path in {**paths,**deps}.items():argv+=['--'+name,str(path)]
                before=apply.build.inventory(root)
                with patch.object(sys,'argv',argv),patch.object(updater,'open_official',side_effect=AssertionError('network must not be reached')) as network:
                    with self.assertRaisesRegex(ValueError,'write roots overlap|apply work overlaps'):updater.main()
                network.assert_not_called()
                self.assertEqual(apply.build.inventory(root),before)
                for path in paths.values():self.assertFalse(path.exists())

if __name__=='__main__':unittest.main()
