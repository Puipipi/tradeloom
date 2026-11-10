import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const acceptance = resolve(root, 'testing/o08_sdk_native_workflow_acceptance.mjs')
const cases = [
  { scenario: 'cancel', timeoutMs: 15_000, expected: { run: 'interrupted', node: 'interrupted', event: 'node-interrupted' } },
  { scenario: 'timeout', timeoutMs: 2_500, expected: { run: 'interrupted', node: 'unknown', event: 'attempt-unknown', error: 'SUBAGENT_TERMINAL_TIMEOUT' } },
  { scenario: 'llm-error', timeoutMs: 15_000, expected: { run: 'failed', node: 'failed', event: 'node-error' } },
]
const results = []

for (const testCase of cases) {
  const env = { ...process.env,
    TRADELOOM_O08_SCENARIO: testCase.scenario,
    TRADELOOM_O08_SERVICE_TIMEOUT_MS: String(testCase.timeoutMs),
  }
  delete env.TRADELOOM_O08_RUNSTORE
  const child = spawnSync(process.execPath, [acceptance], {
    cwd: root, env, encoding: 'utf8', timeout: 19_000, windowsHide: true, maxBuffer: 1024 * 1024,
  })
  assert.ifError(child.error)
  assert.equal(child.signal, null, `${testCase.scenario} acceptance was signalled`)
  assert.equal(child.status, 0, `${testCase.scenario} acceptance failed:\n${child.stderr.slice(-2500)}`)
  const outputLines = child.stdout.trim().split(/\r?\n/)
  const result = JSON.parse(outputLines.at(-1))
  assert.equal(result.ok, true)
  assert.equal(result.phase, 'fault-observed')
  assert.equal(result.scenario, testCase.scenario)
  assert.equal(result.run.status, testCase.expected.run)
  assert.equal(result.run.nodeStatus, testCase.expected.node)
  assert.equal(result.run.outcomeType, testCase.expected.event)
  assert.equal(result.run.attempt, 1)
  assert.equal(result.run.terminalNodeSuccesses, 0)
  assert.equal(result.run.artifacts, 0)
  assert.equal(result.run.parentMatches, true)
  assert.equal(result.sdk.childStarts, 1)
  assert.equal(result.sdk.childEnds, 1)
  assert.equal(result.sdk.activeChildCleared, true)
  if (testCase.expected.error) assert.equal(result.run.persistedTimeoutOutcome, testCase.expected.error)
  if (testCase.scenario === 'cancel' || testCase.scenario === 'timeout') {
    assert.equal(result.sdk.childStopReason, 'aborted')
    assert.equal(result.sdk.signalObserved, true)
  }
  if (testCase.scenario === 'cancel') {
    assert.equal(result.cancellation.abortRequested, true)
    assert.equal(result.cancellation.intentPersisted, true)
    assert.equal(result.cancellation.settled, false)
  }
  if (testCase.scenario === 'llm-error') {
    assert.equal(result.sdk.childStopReason, 'error')
    assert.equal(result.sdk.streamErrorThrown, true)
  }
  results.push({ scenario: testCase.scenario, runStatus: result.run.status,
    nodeStatus: result.run.nodeStatus, outcome: result.run.outcomeType,
    childStopReason: result.sdk.childStopReason, attempt: result.run.attempt })
}

console.log(JSON.stringify({ ok: true, phase: 'all-fault-scenarios-observed', results }))
