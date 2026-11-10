# O09 native-workflow readiness consumers

This backend slice prevents native workflow actions from running before the owning Host has completed startup recovery. It does not implement Host startup or claim O09 complete.

## Provider contract

The package export `@tradeloom/dsh-business-shell/workflow-native-readiness` exposes:

- `NATIVE_WORKFLOW_READINESS`, the Cordis service key `nativeWorkflowReadiness`;
- `createNativeWorkflowReadiness()`, which owns one Host-lifetime state machine;
- `awaitNativeWorkflowReadiness(ctx, signal)` and `runWhenNativeWorkflowReady(ctx, signal, operation)` for dynamic consumer checks;
- `nativeWorkflowDjangoPort(config, env)` for the existing trusted Django-port parsing contract.

The gate starts `pending`. A Host owner must create and synchronously `ctx.provide(NATIVE_WORKFLOW_READINESS, gate)` before native tools or routes can be used, then start one recovery operation with `gate.startRecovery(recover)`. Recovery fulfillment changes the gate to `ready`; rejection locks it `failed`; Host disposal calls `gate.close()`, which aborts startup and permanently closes that instance. Per-request abort only cancels that caller's wait; it does not cancel shared recovery.

No Host root module is present in this worktree to create the PG run store/journal, call `recoverInterruptedRuns()` once, provide the gate, or dispose it. The corresponding root lifecycle is still in the separate O09 recovery candidate and must be integrated by the Host owner.

## Consumer behavior

`registerWorkflowNativeTools()` wraps each registered native operation with `runWhenNativeWorkflowReady`. The native HTTP handler waits after parsing the request and before resolving the center agent; its actual SDK tool/command call checks the same provider again. This preserves existing task-origin, actor, binding, definition, cancellation, and service checks after the wait.

If the provider is absent, failed, closed, or replaced while waiting, tool calls return the fixed `native_workflow_unavailable` code and HTTP calls return 503 with that code. Request cancellation returns `operation_aborted` and does not call the native service, ToolRuntime, or task authority. Read and prepare actions also wait so their view cannot imply a ready workflow while startup recovery is unresolved.

## Minimal Host composition

```js
import {
  NATIVE_WORKFLOW_READINESS,
  createNativeWorkflowReadiness,
} from '@tradeloom/dsh-business-shell/workflow-native-readiness'
import { createPostgresWorkflowRunStore } from './workflow-postgres.js'
import { createWorkflowRunJournal } from './workflow-run-journal.js'

const readiness = createNativeWorkflowReadiness()
ctx.provide(NATIVE_WORKFLOW_READINESS, readiness)
ctx.effect(() => {
  // Starting recovery is asynchronous; do not block synchronous Host composition.
  // Construction/recovery errors leave the gate failed closed.
  void readiness.startRecovery(async () => {
    const runStore = createPostgresWorkflowRunStore({ /* trusted Host options */ })
    const journal = createWorkflowRunJournal({ store: runStore })
    return journal.recoverInterruptedRuns()
  })
  // Cordis calls this only when the owning Host effect is disposed.
  return () => readiness.close()
})
```

The snippet describes the required Host lifecycle seam; this worktree did not execute that Host composition. The existing journal recovery API remains authoritative and accepts no cancellation signal. Closing the gate prevents admission and prevents a late recovery result from making it ready; it does not claim to cancel a PG operation already in progress. The gate does not change journal semantics, replay requests, or cancel an operation that already passed admission.

## Validation

The normal-package tests verify package self-import, pending-to-ready blocking for both a registered tool and the HTTP UI handler, exact-once release, absent/failed/closed/replaced provider rejection, and request abort. The adjacent UI suite includes existing review and authority regression coverage. See [raw validation](../../recovery-20261029/o09-readiness-consumers-20261031/VALIDATION.md).

These are backend module/handler tests. They do not prove that a production Host provides the gate, that production startup performs recovery, or that Electron/GUI wiring is present. O09 and the original 51/88/N01–N03 scope remain incomplete.
