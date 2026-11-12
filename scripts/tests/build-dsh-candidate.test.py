"""Focused offline builder contracts; never calls launcher Main or any service.

Run on Windows: python -B scripts/tests/build-dsh-candidate.test.py
The full official-input assembly is a separate, explicit integration command.
"""
from pathlib import Path
import copy,hashlib,importlib.util,json,os,subprocess,sys,tempfile,unittest
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('complete_builder',R/'scripts/build-dsh-candidate.py')
builder=importlib.util.module_from_spec(spec);spec.loader.exec_module(builder)
K=R/'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2'
recipe=builder.replay.load(K/'recipe.json');program=builder.replay.load(K/'program-recipe.json')

class CompleteCandidateContracts(unittest.TestCase):
    def test_explicit_local_data_selection(self):
        for value in ['', 'data-ui-r2','../data','C:data',r'\\server\share',r'\\?\C:\data',r'\\.\C:\data']:
            with self.subTest(value=value),self.assertRaises(ValueError):builder.local_data_path(value)
        self.assertTrue(str(builder.local_data_path('D:/isolated-contract-data')).lower().endswith('isolated-contract-data'))

    def test_actual_manifest_validator_accepts_only_three_validator_identity_keys(self):
        # Controlled metadata tests the actual exported validator, not native-fs
        # verification of an assembled tree. The builder does both after assembly.
        empty=hashlib.sha256(b'').hexdigest()
        resources={**program['programResources'],'business':{'root':'resources/tradeloom/backend','fileCount':4,'bytes':4,'sha256':empty,'files':[{'path':name,'bytes':1,'sha256':empty} for name in ['manage.py','requirements-workbench.txt','config/settings.py','workbench/__init__.py']]},'businessShell':{'root':'resources/tradeloom/business-shell','version':'contract','fileCount':68,'bytes':1,'sha256':empty}}
        metadata=builder.deployment_metadata(program,recipe,builder.replay.load(K/'desktop-recipe.json'),resources,'contract-head',True,empty,{'contract.patch':empty})
        self.assertEqual(set(metadata['sourceBuild']['lock']['nativeArtifactValidator']),{'receiptSha256','nodeRelativePath','nodeSha256'})
        script="import {validateInstalledManifest} from "+json.dumps((R/'apps/tradeloom-launcher/installed-bootstrap.mjs').as_uri())+";let s='';for await(const c of process.stdin)s+=c;validateInstalledManifest(JSON.parse(s));console.log('actual manifest accepted');"
        def validate(value):return subprocess.run(['node','--input-type=module','-e',script],input=json.dumps(value),text=True,encoding='utf-8',capture_output=True)
        valid=validate(metadata);self.assertEqual(valid.returncode,0,valid.stderr)
        wrong=copy.deepcopy(metadata);wrong['sourceBuild']['lock']['nativeArtifactValidator']['scope']='not permitted in installed lock'
        rejected=validate(wrong);self.assertNotEqual(rejected.returncode,0);self.assertIn('runtime Node validator',rejected.stderr)

    def test_declared_backend_dependencies_and_fixed_input_contract(self):
        sources=program['backendSources'];self.assertEqual(sources,sorted(set(sources)))
        for name in program['backendAdditionalSourceConsumers']:self.assertIn(name,sources)
        self.assertIn('../packages/tradeloom-shell/workflow-schema.js',(R/'workbench/workflow_definition_validator.mjs').read_text(encoding='utf-8'))
        self.assertIn('../packages/tradeloom-shell/workflow-definition.js',(R/'workbench/workflow_definition_validator.mjs').read_text(encoding='utf-8'))
        for name in program['backendExcludedUnprovenLegacySamples']:self.assertNotIn(name,sources)
        self.assertEqual(recipe['officialInput']['version'],program['version'])
        self.assertEqual(program['vendor']['fileCount'],7892)
        self.assertEqual(program['output']['programOnlyTopLevel'],['app','launcher.json','启动工作台.exe'])
        source=(R/'scripts/build-dsh-candidate.py').read_text(encoding='utf-8')
        self.assertNotIn('sol-handoff',source);self.assertNotIn('registerHooks',source)

    def test_actual_launcher_readconfig_schema1_and_schema2_without_launching(self):
        self.assertEqual(os.name,'nt','the actual .NET launcher contract requires Windows')
        compiler=Path(os.environ.get('WINDIR','C:/Windows'))/'Microsoft.NET/Framework64/v4.0.30319/csc.exe'
        self.assertTrue(compiler.is_file(),'existing .NET compiler required; no download/fallback')
        harness=r'''
using System;using System.IO;using System.Reflection;
internal static class LauncherContract {
  public static int Main(string[] args) {
    try {
      var result=typeof(Program).GetMethod("ReadConfig",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{args[0]});
      if(args.Length==2 && args[1]=="log") {
        string program=Path.GetDirectoryName(args[0]);
        string data=Path.GetFullPath(Path.Combine(program,(string)result.GetType().GetField("DataDirectory").GetValue(result)));
        int schema=(int)result.GetType().GetField("SchemaVersion").GetValue(result);
        string directory=(string)typeof(Program).GetMethod("LauncherLogDirectory",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{program,data,schema});
        typeof(Program).GetMethod("WriteLauncherEvent",BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,new object[]{directory,"contract-log",123,null});
        Console.WriteLine(directory);return 0;
      }
      Console.WriteLine(result.GetType().GetField("DataDirectory").GetValue(result));return 0;
    } catch(TargetInvocationException error) {
      var code=error.InnerException.GetType().GetProperty("Code");
      if(code==null || (string)code.GetValue(error.InnerException,null)!="CONFIG_INVALID")throw;
      Console.WriteLine("CONFIG_INVALID");return 2;
    }
  }
}
'''
        with tempfile.TemporaryDirectory(prefix='tradeloom-launcher-contract-') as folder:
            root=Path(folder)/'program';root.mkdir();before=(R/program['launcher']['source']).read_bytes()
            (root/'Program.cs').write_bytes(before);(root/'Contract.cs').write_text(harness,encoding='utf-8')
            def compile(name):
                target=root/name
                result=subprocess.run([str(compiler),'/nologo','/target:exe','/main:LauncherContract','/utf8output','/codepage:65001','/reference:System.Web.Extensions.dll','/reference:System.Windows.Forms.dll','/out:'+str(target),str(root/'Program.cs'),str(root/'Contract.cs')],capture_output=True)
                self.assertEqual(result.returncode,0,result.stdout+result.stderr);return target
            original=compile('before.exe')
            applied=subprocess.run(['git','-c','core.autocrlf=false','apply','--whitespace=nowarn',str(K/program['launcher']['patch'])],cwd=root,capture_output=True)
            self.assertEqual(applied.returncode,0,applied.stderr)
            self.assertEqual(builder.file_pin(root/'Program.cs'),program['launcher']['postimage'])
            candidate=compile('candidate.exe');external=root.parent/(root.name+'-data-not-created')
            self.assertFalse(external.exists())
            def check(executable,version,data,expected,**changes):
                config={'schemaVersion':version,'dataDirectory':data,'hostPort':3088,'djangoPort':3090,'postgresPort':55432};config.update(changes)
                path=root/'launcher.json';path.write_text(json.dumps(config),encoding='utf-8')
                result=subprocess.run([str(executable),str(path)],capture_output=True,text=True)
                self.assertEqual(result.returncode,expected,(config,result.stdout,result.stderr))
                if expected:self.assertEqual(result.stdout.strip(),'CONFIG_INVALID')
            for executable in [original,candidate]:
                check(executable,1,'data-ui-r2',0);check(executable,1,'another-profile',2);check(executable,1,'data-ui-r2',2,hostPort=3089)
            check(original,2,str(external),2);check(candidate,2,str(external),0)
            for data in ['', 'data-ui-r2','C:relative',r'\\host\share',r'\\?\C:\data',r'\\.\C:\data',str(root),str(root/'data'),str(root.parent)]:check(candidate,2,data,2)
            check(candidate,2,str(external),2,djangoPort=3091)
            self.assertFalse(external.exists(),'ReadConfig must not create, inspect or migrate the data target')
            config=root/'launcher.json'
            config.write_text(json.dumps({'schemaVersion':2,'dataDirectory':str(external),'hostPort':3088,'djangoPort':3090,'postgresPort':55432}),encoding='utf-8')
            logged=subprocess.run([str(candidate),str(config),'log'],capture_output=True,text=True)
            self.assertEqual(logged.returncode,0,logged.stderr)
            self.assertEqual(Path(logged.stdout.strip()),external/'logs')
            self.assertFalse(external.exists(),'logger must not pre-create an unowned data root')
            self.assertFalse((root/'启动工作台.log').exists(),'schema2 must not fall back to program-root log')
            (external/'logs').mkdir(parents=True)
            logged=subprocess.run([str(candidate),str(config),'log'],capture_output=True,text=True)
            self.assertEqual(logged.returncode,0,logged.stderr);self.assertIn('event=contract-log',(external/'logs/启动工作台.log').read_text(encoding='utf-8'))
            config.write_text(json.dumps({'schemaVersion':1,'dataDirectory':'data-ui-r2','hostPort':3088,'djangoPort':3090,'postgresPort':55432}),encoding='utf-8')
            logged=subprocess.run([str(candidate),str(config),'log'],capture_output=True,text=True)
            self.assertEqual(logged.returncode,0,logged.stderr);self.assertEqual(Path(logged.stdout.strip()),root)
            self.assertIn('event=contract-log',(root/'启动工作台.log').read_text(encoding='utf-8'))
            reversed_patch=subprocess.run(['git','-c','core.autocrlf=false','apply','--reverse',str(K/program['launcher']['patch'])],cwd=root,capture_output=True)
            self.assertEqual(reversed_patch.returncode,0,reversed_patch.stderr);self.assertEqual((root/'Program.cs').read_bytes(),before)

if __name__=='__main__':unittest.main()
