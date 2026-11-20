"""Focused acquisition contracts; no application, installer or service is run.

Set DSH_OFFICIAL_CACHE to the existing reviewed input cache. The actual
signature and 7z listing tests are required, not silently skipped or stubbed.
"""
from pathlib import Path
import base64,copy,hashlib,importlib.util,json,os,subprocess,sys,tempfile,unittest
sys.dont_write_bytecode=True
R=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('official_update',R/'scripts/update-dsh-candidate.py')
update=importlib.util.module_from_spec(spec);spec.loader.exec_module(update)
K=R/'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2'
policy_path=K/'program-recipe.json';program=update.build.replay.load(policy_path)
installer=program['upstream']['installer']
FEED=('version: 0.2.2-rc.2\nfiles:\n  - url: >-\n      '+installer['url']+'\n    size: '+str(installer['bytes'])+'\n    sha512: >-\n      '+installer['sha512']+'\npath: >-\n  '+installer['url']+'\nsha512: >-\n  '+installer['sha512']+"\nstagingPercentage: 15\nreleaseDate: '2026-11-11T10:26:31.270Z'\n").encode()

def actual_official_input():
    cache=Path(os.environ['DSH_OFFICIAL_CACHE'])
    version=os.environ.get('DSH_OFFICIAL_TEST_VERSION','0.2.2-rc.2')
    recipe=R/'apps/tradeloom-launcher/dsh-upgrades'/version/'program-recipe.json'
    actual=update.build.replay.load(recipe)
    if actual['version']!=version:raise ValueError('test input version drift')
    return cache,actual,actual['upstream']['installer']

class OfficialAcquisitionContracts(unittest.TestCase):
    def test_actual_feed_shape_and_strict_reviewed_release_selection(self):
        feed=update.parse_feed(FEED.replace(b'\n',b'\r\n'))
        recipe,policy,value=update.resolve_release(feed)
        self.assertEqual(policy,policy_path);self.assertEqual(recipe,K/'recipe.json');self.assertEqual(value['version'],'0.2.2-rc.2')
        unknown=copy.deepcopy(feed);unknown['version']='999.0.0-unreviewed'
        with self.assertRaisesRegex(ValueError,'unsupported official version'):update.resolve_release(unknown)
        for key,value in [('size',installer['bytes']+1),('sha512',base64.b64encode(b'x'*64).decode()),('url','https://example.invalid/not-official.exe')]:
            drift=copy.deepcopy(feed);drift['files'][0][key]=value
            with self.subTest(key=key),self.assertRaisesRegex(ValueError,'differs from reviewed recipe'):update.resolve_release(drift)

    def test_ambiguous_or_unsupported_feed_is_rejected(self):
        for raw in [FEED+b'version: other\n',FEED+b'unknownField: value\n',FEED.replace(b'  - url:',b'    - url:'),FEED.replace(b'files:',b'files: &anchor'),b'x'*65537]:
            with self.subTest(raw=raw[:30]),self.assertRaises(ValueError):update.parse_feed(raw)
        wrong=FEED.replace(b'path: >-\n  https:',b'path: >-\n  http:')
        with self.assertRaisesRegex(ValueError,'identity differ'):update.parse_feed(wrong)

    def test_complete_crlf_listing_and_path_link_boundaries(self):
        raw=b'7-Zip metadata\r\n----------\r\nPath = resources\r\nSize = 0\r\nAttributes = D\r\n\r\nPath = resources\\a.js\r\nSize = 2\r\nAttributes = A\r\n\r\nPath = b.js\r\nSize = 3\r\nAttributes = A\r\n'
        rows=update.parse_listing(raw);self.assertEqual(len(rows),3)
        self.assertEqual(update.validate_listing(rows),{'resources/a.js':2,'b.js':3})
        for path in ['../outside','C:\\outside','\\\\host\\share','a/../b','a/./b','a:b','NUL.txt','trailing.','trailing ']:
            with self.subTest(path=path),self.assertRaises(ValueError):update.validate_listing([{'Path':path,'Size':'1','Attributes':'A'}])
        for field,value in [('Symbolic Link','x'),('Hard Link','x'),('Reparse Point','x'),('Attributes','AL'),('Encrypted','+')]:
            row={'Path':'a','Size':'1','Attributes':'A',field:value}
            with self.subTest(field=field),self.assertRaises(ValueError):update.validate_listing([row])
        with self.assertRaisesRegex(ValueError,'case-colliding'):update.validate_listing([{'Path':'A','Size':'0'},{'Path':'a','Size':'0'}])
        with self.assertRaisesRegex(ValueError,'boundary missing'):update.parse_listing(b'Path = a\nSize = 1\n')

    def test_real_file_digest_failure_preserves_input(self):
        with tempfile.TemporaryDirectory(prefix='tradeloom-download-contract-') as directory:
            path=Path(directory)/'fixture.exe';data=b'harmless digest fixture';path.write_bytes(data)
            expected={'bytes':len(data),'sha512':base64.b64encode(hashlib.sha512(data).digest()).decode()}
            self.assertEqual(update.verify_installer(path,expected)['sha256'],hashlib.sha256(data).hexdigest())
            bad={**expected,'bytes':len(data)+1}
            with self.assertRaisesRegex(ValueError,'SHA512 mismatch'):update.verify_installer(path,bad)
            self.assertEqual(path.read_bytes(),data)

    def test_actual_windows_signature_and_publisher_contract(self):
        self.assertEqual(os.name,'nt')
        cache,program,installer=actual_official_input()
        source=cache/installer['url'].rsplit('/',1)[1]
        self.assertEqual(update.verify_installer(source,installer)['bytes'],installer['bytes'])
        def run(label,command,*,env):
            result=subprocess.run(command,env=env,capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            return result.stdout
        identity=update.inspect_installer_signature(source,run)
        subject=program['acquisition']['publisherSubject']
        self.assertTrue(update.require_installer_publisher(identity,subject)['publisherExact'])
        with self.assertRaisesRegex(ValueError,'Authenticode/publisher'):
            update.require_installer_publisher(identity,'Unreviewed Publisher')
        with tempfile.TemporaryDirectory(prefix='tradeloom-publisher-contract-') as directory:
            unsigned=Path(directory)/'unsigned [literal].exe'
            unsigned.write_bytes(b'unsigned synthetic file')
            rejected=update.inspect_installer_signature(unsigned,run)
            self.assertNotEqual(rejected['status'],'Valid')
            with self.assertRaisesRegex(ValueError,'Authenticode/publisher'):
                update.require_installer_publisher(rejected,subject)
        with self.assertRaises(json.JSONDecodeError):
            update.inspect_installer_signature(source,lambda *a,**kw:b'not json')

    def test_actual_reviewed_7z_full_listing_before_extraction(self):
        cache,program,installer=actual_official_input()
        tool=Path(os.environ.get('DSH_SEVENZIP','C:/Program Files/7-Zip/7z.exe'))
        self.assertEqual(update.build.file_pin(tool),program['acquisition']['extractor'])
        source=cache/installer['url'].rsplit('/',1)[1]
        payload=cache/'container'/Path(*update.PureWindowsPath(program['acquisition']['payload']['path']).parts)
        for path,count in [(source,program['acquisition']['outerEntries']),(payload,program['acquisition']['innerEntries'])]:
            result=subprocess.run([str(tool),'l','-slt','-sccUTF-8',str(path)],capture_output=True)
            self.assertEqual(result.returncode,0,result.stderr)
            rows=update.parse_listing(result.stdout);self.assertEqual(len(rows),count)
            files=update.validate_listing(rows)
            if path==payload:
                self.assertEqual(len(files),program['vendor']['fileCount']);self.assertEqual(sum(files.values()),program['vendor']['bytes'])
        # This proves real complete listing/validation, not a cold extraction or
        # a full build. The real single-command integration is recorded separately.

if __name__=='__main__':unittest.main()
