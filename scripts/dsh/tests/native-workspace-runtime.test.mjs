import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {patchSetDigest} from '../../../apps/tradeloom-launcher/receipt-writer.mjs'
import {usesInstalledPnpm} from '../build-candidate.mjs'

const repo=fileURLToPath(new URL('../../../',import.meta.url)),workspace=path.dirname(repo)
const batch=path.join(workspace,'workspace/testing/frontend-visual-fixes-20261025/batch66-native-runtime28')
const prior=path.join(workspace,'workspace/testing/frontend-visual-fixes-20261025/batch46-menu-runtime-source/patch-set-27')
const sha=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const lock=JSON.parse(fs.readFileSync(path.join(batch,'patch-set-28/patches.prospective.lock.json'),'utf8'))
const old=JSON.parse(fs.readFileSync(path.join(prior,'patches.prospective.lock.json'),'utf8'))

test('native-workspace patch set retains the exact existing27 inputs and locks only4 additional original source targets',()=>{
 const order=JSON.parse(fs.readFileSync(path.join(batch,'patch-set-28/order.prospective.json'),'utf8'))
 assert.equal(order.count,28);assert.equal(order.order.length,28);assert.equal(new Set(order.order).size,28)
 assert.equal(order.order.at(-1),'native-workspace-surface.patch')
 for(const [name,hash] of Object.entries(old.patches))assert.equal(lock.patches[name],hash)
 for(const [name,hashes] of Object.entries(old.targetFiles))assert.deepEqual(lock.targetFiles[name],hashes)
 assert.equal(Object.keys(lock.targetFiles).length,95)
 assert.equal(sha(path.join(repo,'integrations/dsh/patches/native-workspace-surface.patch')).toUpperCase(),lock.patches['native-workspace-surface.patch'])
 assert.equal(patchSetDigest(lock.patches),'24df3fb1f12e7d4179b9a4e69a928d368da5a28b0ae99137a190b0f886f4c39f')
 assert.equal(usesInstalledPnpm('patch-set-28'),true)
 assert.equal(usesInstalledPnpm('patch-set-27'),true)
})

test('new native source patch has6 exact targets and2 generated owners, not a core renderer override',()=>{
 const patch=fs.readFileSync(path.join(repo,'integrations/dsh/patches/native-workspace-surface.patch'),'utf8')
 const targets=[...patch.matchAll(/^diff --git a\/(\S+) b\/(\S+)$/gm)]
 assert.equal(targets.length,6);assert.equal((patch.match(/^new file mode 100644$/gm)??[]).length,2)
 for(const target of targets)assert.ok(target[2].startsWith('packages/client/ui-sidebar-right/src/'))
 assert.equal(patch.includes('packages/client/ui-renderer/'),false)
 assert.equal(patch.includes('packages/client/ui-slots/'),false)
})

test('prepare rejects an unapproved prospective path before creating the target, using normal PowerShell policy',()=>{
 const runtime=path.join(workspace,'workspace/testing/dsh-slot-patches/temp-runtimes/c66-unapproved-negative')
 assert.equal(fs.existsSync(runtime),false)
 const result=spawnSync('pwsh',['-NoLogo','-NoProfile','-NonInteractive','-File',path.join(repo,'scripts/dsh/prepare-runtime.ps1'),
  '-ReferencePath',path.join(workspace,'workspace/research/references/deepseek-harness-v0.2.1-rc.3-readonly'),'-RuntimePath',runtime,
  '-ProspectiveLockPath',path.join(batch,'not-approved/patches.prospective.lock.json'),'-PatchRootOverride',path.join(repo,'integrations/dsh/patches'),'-PatchOrderPath',path.join(batch,'not-approved/order.prospective.json')],{encoding:'utf8',windowsHide:true})
 assert.equal(result.status,21,result.stdout+result.stderr)
 const record=result.stdout.split(/\r?\n/).map(line=>{try{return JSON.parse(line)}catch{return null}}).find(row=>row?.status)
 assert.equal(record?.status,'prospective_path_rejected');assert.equal(record?.targetCreated,false)
 assert.equal(fs.existsSync(runtime),false)
})
