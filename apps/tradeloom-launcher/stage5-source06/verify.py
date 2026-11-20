"""Verify this commit's exact source06 postimages; no application or build is run."""
from pathlib import Path
import argparse,json,hashlib,subprocess
ROOT=Path(__file__).resolve().parents[3];BASE=Path(__file__).parent
m=json.loads((BASE/'SOURCE-MANIFEST.json').read_text(encoding='utf8'));sha=lambda b:hashlib.sha256(b).hexdigest();parser=argparse.ArgumentParser();parser.add_argument('--git-blobs',action='store_true');parser.add_argument('--legacy-replay-inputs',action='store_true',help='strictly test old recipe pins; two inherited mismatches are documented');args=parser.parse_args()
records=[*m['records'],m['deployment'],m['launcher']]
for row in records:
 file=ROOT/row['source'];assert file.resolve().is_relative_to(ROOT);data=file.read_bytes();assert len(data)==row['bytes'] and sha(data)==row['sha256'],row['source']
 if args.git_blobs:
  blob=subprocess.run(['git','show',':'+row['source']],cwd=ROOT,capture_output=True,check=True).stdout;assert blob==data,('Git EOL/blob mismatch',row['source'])
package=json.loads((ROOT/'packages/tradeloom-shell/package.json').read_text(encoding='utf8'))
for name in m['retiredBusiness']:
 assert not (ROOT/'packages/tradeloom-shell'/name).exists();assert name not in package['files'];assert all(name!=v.removeprefix('./') for v in package.get('exports',{}).values())
recipe=json.loads((ROOT/'apps/tradeloom-launcher/dsh-upgrades/0.2.2-rc.2/recipe.json').read_text(encoding='utf8'));legacy=ROOT/recipe['businessShell']['sourceRoot'];assert legacy==ROOT/m['legacyBusinessInputRoot']
for name,pin in {'package.json':recipe['businessShell']['sourcePackage'],**recipe['businessShell']['preimages']}.items():
 data=(legacy/name).read_bytes()
 if args.legacy_replay_inputs:assert len(data)==pin['bytes'] and sha(data)==pin['sha256'],('legacy preimage',name)
 else:
  limits=json.loads((BASE/'LEGACY-INPUT-LIMITS.json').read_text(encoding='utf8'));actual=next(x['source06Actual'] for x in limits['inputs'] if x['path']==name);assert len(data)==actual['bytes'] and sha(data)==actual['sha256'],('source06 legacy source bytes',name)
for name in package['files']:assert (ROOT/'packages/tradeloom-shell'/name).is_file(),name
assert 'client.webai-files' not in (ROOT/'packages/tradeloom-shell/client.source-native.js').read_text(encoding='utf8')
assert 'webai-directory-host' not in (ROOT/'packages/tradeloom-shell/host.js').read_text(encoding='utf8')
assert 'webAiDirectory:' not in (BASE/'asar/lib/preload-app.cjs').read_text(encoding='utf8')
main=(BASE/'asar/lib/main.js').read_text(encoding='utf8')
for marker in ['async openOrFocus(owner, request, expectedWindow)', 'async upload(owner, request)', 'async saveText(owner, request)']:assert marker in main,marker
print(json.dumps({'exactPostimages':len(m['records']),'deploymentAndDerivedLauncher':2,'gitBlobsChecked':args.git_blobs,'retiredNormalModulesAbsent':9,'normalPackageFilesExist':len(package['files']),'source06LegacyInputFiles':6,'legacyRecipePinsAllPassed':False,'legacyStrictRequested':args.legacy_replay_inputs,'buildOrApplicationRun':False}))
