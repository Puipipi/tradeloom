import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const acceptance = resolve(root, 'testing/o08_sdk_native_workflow_acceptance.mjs')
const env = { ...process.env, TRADELOOM_O08_SCENARIO: 'deliverable' }
delete env.TRADELOOM_O08_RUNSTORE
delete env.TRADELOOM_O08_SERVICE_TIMEOUT_MS

const child = spawnSync(process.execPath, [acceptance], {
  cwd: root, env, encoding: 'utf8', timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024,
})
assert.ifError(child.error)
assert.equal(child.signal, null, 'deliverable acceptance was signalled')
assert.equal(child.status, 0, `deliverable acceptance failed:\n${child.stderr.slice(-2500)}`)
const result = JSON.parse(child.stdout.trim().split(/\r?\n/).at(-1))
assert.equal(result.ok, true)
assert.equal(result.phase, 'real-sdk-deliverable-declared')
assert.equal(result.sdk.childStarts, 1)
assert.equal(result.sdk.childEnds, 1)
assert.equal(result.sdk.stopReason, 'completed')
assert.deepEqual(result.sdk.toolCalls.map(({ name, isError }) => ({ name, isError })), [
  { name: 'write', isError: false }, { name: 'present', isError: false },
])
assert.equal(result.sdk.childParentMatches, true)
assert.equal(result.run.status, 'done')
assert.equal(result.run.nodeStatus, 'done')
assert.equal(result.run.artifactState, 'declared')
assert.equal(result.run.attempt, 1)
assert.equal(result.run.fileContentsMatch, true)
assert.equal(result.run.artifactsCount, 1)
assert.equal(result.run.artifactUpload, 'not attempted')
assert.equal(result.run.hashesComputed, false)

console.log(JSON.stringify({
  ok: true,
  phase: 'o08-sdk-deliverable-producer-verified',
  sdk: result.sdk,
  run: result.run,
  boundary: result.boundary,
}))
