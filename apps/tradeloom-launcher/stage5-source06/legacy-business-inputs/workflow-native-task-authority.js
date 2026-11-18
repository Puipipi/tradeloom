import { AsyncLocalStorage } from 'node:async_hooks'
import { createStateStore } from './state.js'
import { createWorkflowNativeUiGate } from './workflow-native-ui-gate.js'
import { createWorkflowNativeCommandAttribution } from './workflow-native-command-attribution.js'

export const name = '@tradeloom/dsh-business-shell/native-task-authority'
export const inject = ['tools', 'agents', 'commands']

// A normal dependency-owned service, independent of Host/Workspace/PG startup.
// Provision of this object never opens a UI pending call or grants a budget.
export function apply(ctx) {
  const gate = createWorkflowNativeUiGate(ctx)
  let store, adapter
  try {
    adapter = createWorkflowNativeCommandAttribution(ctx, {
      uiGate: gate,
      createStateStore: () => store ??= createStateStore(),
    })
  } catch (error) { gate.dispose(); throw error }
  // provide() is registered last: its public disposer invalidates dependents.
  // Then close origins before revoking tasks, so callbacks cannot mint work.
  ctx.effect(() => () => { try { gate.dispose() } finally { adapter.dispose() } }, 'native task authority cleanup')
  const frames = new AsyncLocalStorage()
  const unavailable = () => { throw Object.assign(new Error('native_run_unavailable'), { code: 'native_run_unavailable' }) }
  ctx.provide('nativeTaskAuthority', Object.freeze({ gate, adapter,
    async runCommand(input) {
      const controller = new AbortController()
      const abort = () => controller.abort(input.signal.reason)
      const command = { ...input, abortTask: () => controller.abort() }
      command.taskLease = adapter.prepareTask(command)
      const frame = { controller }
      input.signal.addEventListener('abort', abort, { once: true })
      if (input.signal.aborted) abort()
      try { return await frames.run(frame, () => gate.withPending(command, () => adapter.executeCommand(command))) }
      finally { input.signal.removeEventListener('abort', abort) }
    },
    async bindTask(exec, expectedTask, { requireExisting = false } = {}) {
      const frame = frames.getStore()
      if (!frame || frame.task) unavailable()
      // A persisted run never reconstructs missing authority from its snapshot.
      // Reuse the original state ledger; adapter still verifies its full identity.
      if (requireExisting) {
        const state = await (await (store ??= createStateStore())).read()
        if (!state.budgetScopes?.tasks?.[expectedTask.runId]) unavailable()
      }
      const lease = await adapter.bindTask(exec, expectedTask)
      return frame.task = Object.freeze({ lease, signal: frame.controller.signal })
    },
    executeTask(task, input) { return adapter.executeTask(task.lease, input) },
    releaseTask(task) { return adapter.release(task.lease) },
  }))
}
