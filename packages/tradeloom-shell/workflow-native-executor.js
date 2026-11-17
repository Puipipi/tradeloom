import { randomUUID } from 'node:crypto'
import { executeNativeTool } from './workflow-native-command-attribution.js'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { ARTIFACT_EVIDENCE_SCHEMA, MAX_DECLARATIONS, validateArtifactEvidence, validateArtifactRangeStart } from './workflow-artifact-source.js'

const TOOL_NAME = 'subagent'
const DESCRIPTION = 'Run workflow task'
const DEFAULT_TIMEOUT_MS = 120_000

function fail(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function extractErrorCategory(error) {
  if (!isRecord(error)) return 'TOOL_ERROR'
  if (typeof error.info?.code === 'string' && error.info.code) return error.info.code
  if (typeof error.code === 'string' && error.code) return error.code
  if (typeof error.name === 'string' && error.name) return error.name
  return 'TOOL_ERROR'
}

function pairKey(id, runId) {
  return JSON.stringify([id, runId])
}

function terminalStatus(stopReason) {
  if (stopReason === 'completed') return 'completed'
  if (stopReason === 'aborted') return 'interrupted'
  return 'failed'
}

/**
 * Create a Host-only executor for the registered official subagent tool.
 * `run(input, exec)` must be invoked by a trusted ToolRuntime handler; its
 * second argument supplies the exact live parent Agent. The binding resolver
 * reads a confirmed persisted run/node and returns its authoritative prompt,
 * revision, attempt and exact session binding. It receives IDs, never an Agent
 * from payload; requestId is only a correlation key, not authorization.
 * Optional `recordChildAck(binding, ack)` is injected by the Host, never JSON
 * input. A journal composition must supply it to persist the matched child
 * before terminal observation; standalone execution may omit persistence.
 */
export function createWorkflowNativeExecutor(ctx, {
  resolveBinding,
  recordChildAck,
  executeTool = input => executeNativeTool(ctx.tools, input),
  createLifecycleScope,
  toolName = TOOL_NAME,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createCallId = randomUUID,
} = {}) {
  if (!ctx?.agents?.get || !ctx?.tools?.execute || typeof ctx.tools.get !== 'function') {
    throw new TypeError('native executor requires Host agents and ToolRuntime services')
  }
  if (typeof resolveBinding !== 'function') throw new TypeError('trusted Host binding resolver is required')
  if (recordChildAck !== undefined && typeof recordChildAck !== 'function') throw new TypeError('recordChildAck must be a Host callback')
  if (typeof executeTool !== 'function') throw new TypeError('executeTool must be a Host callback')
  if (typeof createLifecycleScope !== 'function') throw new TypeError('createLifecycleScope must be a Host callback')
  if (typeof toolName !== 'string' || toolName !== TOOL_NAME) {
    throw new TypeError('only the configured official subagent tool is supported')
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new TypeError('timeoutMs must be positive')
  if (typeof createCallId !== 'function') throw new TypeError('createCallId must be a function')

  // Retain settled entries for this Host lifetime: evicting a completed key
  // would allow a retried workflow attempt to spawn a second native child.
  const attempts = new WeakMap()

  async function run(input, exec) {
    if (!isRecord(input) || typeof input.requestId !== 'string' || !input.requestId
      || typeof input.bindingRevision !== 'string' || !input.bindingRevision
      || typeof input.definitionRevision !== 'string' || !input.definitionRevision
      || typeof input.workflowRunId !== 'string' || !input.workflowRunId
      || typeof input.nodeId !== 'string' || !input.nodeId
      || !Number.isSafeInteger(input.attempt) || input.attempt < 1
      || typeof input.prompt !== 'string' || !input.prompt.trim()
      || Object.hasOwn(input, 'signal')) {
      throw fail('INVALID_NATIVE_REQUEST', 'request, workflow attempt, and prompt are required; signal belongs to ToolRuntime exec')
    }

    const parent = exec?.agent
    if (!parent || typeof parent.id !== 'string' || !parent.id) {
      throw fail('NATIVE_PARENT_UNAVAILABLE', 'trusted ToolRuntime exec.agent is required')
    }
    const callerSignal = exec.signal
    if (!callerSignal || typeof callerSignal.addEventListener !== 'function'
      || typeof callerSignal.removeEventListener !== 'function') {
      throw fail('NATIVE_SIGNAL_UNAVAILABLE', 'trusted ToolRuntime exec.signal is required')
    }
    if (ctx.agents.get(parent.id) !== parent) {
      throw fail('NATIVE_PARENT_UNAVAILABLE', 'exec.agent is not the exact live Host Agent')
    }

    const binding = await resolveBinding({
      workflowRunId: input.workflowRunId,
      nodeId: input.nodeId,
      attempt: input.attempt,
      bindingRevision: input.bindingRevision,
      definitionRevision: input.definitionRevision,
    }, exec)
    if (!isRecord(binding) || binding.authorized !== true
      || typeof binding.requestId !== 'string' || !binding.requestId
      || typeof binding.agentId !== 'string' || !binding.agentId
      || typeof binding.sessionId !== 'string' || !binding.sessionId
      || typeof binding.workflowRunId !== 'string' || !binding.workflowRunId
      || typeof binding.nodeId !== 'string' || !binding.nodeId
      || !Number.isSafeInteger(binding.attempt) || binding.attempt < 1
      || typeof binding.bindingRevision !== 'string' || !binding.bindingRevision
      || typeof binding.definitionRevision !== 'string' || !binding.definitionRevision
      || typeof binding.prompt !== 'string' || !binding.prompt.trim()
      || typeof binding.agentPreset !== 'string' || !binding.agentPreset) {
      throw fail('NATIVE_BINDING_UNAVAILABLE', 'Host must return a confirmed authorized persisted run/node binding')
    }
    if (binding.bindingRevision !== input.bindingRevision) {
      throw fail('NATIVE_BINDING_REVISION_MISMATCH', 'Host role/session binding revision changed')
    }
    if (binding.definitionRevision !== input.definitionRevision) {
      throw fail('NATIVE_DEFINITION_REVISION_MISMATCH', 'persisted workflow definition revision changed')
    }
    if (binding.requestId !== input.requestId
      || binding.workflowRunId !== input.workflowRunId
      || binding.nodeId !== input.nodeId
      || binding.attempt !== input.attempt
      || (binding.instruction ?? binding.prompt) !== input.prompt) {
      throw fail('NATIVE_BINDING_MISMATCH', 'request fields do not match the confirmed Host run/node binding')
    }
    if (binding.agentId !== parent.id) {
      throw fail('NATIVE_BINDING_PARENT_MISMATCH', 'Host binding does not authorize exec.agent')
    }
    if (ctx.agents.get(parent.id) !== parent || parent.session?.id !== binding.sessionId) {
      throw fail('NATIVE_PARENT_UNAVAILABLE', 'bound Agent/session is no longer the exact live Host parent')
    }
    if (callerSignal.aborted) throw fail('ABORTED_BEFORE_NATIVE_TOOL', 'request was cancelled before native tool dispatch')
    if (typeof parent.ctx?.on !== 'function') {
      throw fail('NATIVE_EVENTS_UNAVAILABLE', 'exact parent event scope is unavailable')
    }
    const tool = ctx.tools.get(toolName, parent)
    if (!tool) {
      throw fail('NATIVE_TOOL_UNAVAILABLE', 'official subagent tool is not visible in the bound parent scope')
    }

    const presetSchema = tool.parameters?.properties?.agent_preset
    if (tool.parameters?.type !== 'object' || presetSchema?.type !== 'string'
      || !Array.isArray(presetSchema.enum) || !presetSchema.enum.includes(binding.agentPreset)) {
      throw fail('NATIVE_PRESET_NOT_ALLOWED', 'official subagent tool schema must explicitly allow the persisted role preset')
    }
    if (binding.modelRequest != null && ['provider', 'model'].some(key => {
      const schema = tool.parameters?.properties?.[key]
      const value = binding.modelRequest[key]
      return typeof value !== 'string' || !value.trim() || schema?.type !== 'string'
        || (Array.isArray(schema.enum) && !schema.enum.includes(value))
    })) throw fail('unsupported_model_selection', 'official subagent schema does not allow the saved model pair')

    const key = JSON.stringify([binding.workflowRunId, binding.nodeId, binding.attempt])
    const fingerprint = JSON.stringify([
      binding.requestId,
      binding.bindingRevision,
      binding.definitionRevision,
      binding.prompt,
      binding.agentPreset,
      binding.modelRequest ?? null,
    ])
    let parentAttempts = attempts.get(parent)
    if (!parentAttempts) {
      parentAttempts = new Map()
      attempts.set(parent, parentAttempts)
    }
    const prior = parentAttempts.get(key)
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw fail('IDEMPOTENCY_CONFLICT', 'workflow run/node/attempt was already used with different input')
      }
      return prior.promise
    }

    const promise = executeOnce(input, parent, callerSignal, binding)
    parentAttempts.set(key, { fingerprint, promise })
    return promise
  }

  async function executeOnce(input, parent, callerSignal, binding) {
    if (typeof parent.ctx?.on !== 'function') {
      throw fail('NATIVE_EVENTS_UNAVAILABLE', 'exact parent event scope is unavailable')
    }

    const starts = new Map()
    const ends = new Map()
    const artifactCaptures = new Map()
    const waiters = new Map()
    const controller = new AbortController()
    let toolCallId = null
    let trackedStart
    let interruptSent = false
    let cancelError
    let deadlineExpired = false
    let retainListenersForLateDispatch = false
    let deadlineTimer
    let deadlineAt
    let cleanup = () => {}

    const receipt = fields => ({
      requestId: binding.requestId,
      workflowRunId: binding.workflowRunId,
      nodeId: binding.nodeId,
      attempt: binding.attempt,
      bindingRevision: binding.bindingRevision,
      definitionRevision: binding.definitionRevision,
      parentAgentId: parent.id,
      sessionId: binding.sessionId,
      toolCallId,
      childId: null,
      nativeRunId: null,
      terminalSource: 'unknown',
      artifacts: [],
      artifactSource: 'unknown',
      provider: 'unknown',
      model: 'unknown',
      ...fields,
    })

    const acceptStart = info => {
      if (!info || typeof info.id !== 'string' || typeof info.runId !== 'string' || info.parentSessionId !== binding.sessionId) return
      starts.set(pairKey(info.id, info.runId), info)
      // Public event payload has no range. Capture next-seq synchronously,
      // before this runtime version admits the initial child message.
      const key = pairKey(info.id, info.runId)
      if (artifactCaptures.has(key) || info.local !== true) return
      try {
        const child = ctx.agents.get(info.id)
        const session = child?.session
        if (!session || session.id !== info.id || !Number.isSafeInteger(session.seq) || session.seq < 0 || typeof child.ctx?.on !== 'function') return
        const start = validateArtifactRangeStart({ childSessionId: info.id, nativeRunId: info.runId, startInclusive: session.seq })
        if (start === null) return
        const capture = { session, start, endExclusive: null, declarations: [], failed: false, dispose: null }
        artifactCaptures.set(key, capture)
        capture.dispose = child.ctx.on('session/event', (source, event) => {
          if (source !== session || event?.type !== 'deliverables/presented' || capture.failed || capture.endExclusive !== null) return
          try {
            const data = event.data
            if (!Number.isSafeInteger(event.seq) || event.seq < capture.start.startInclusive
              || !Number.isSafeInteger(data?.turn) || data.turn < 1 || typeof data.callId !== 'string'
              || !Array.isArray(data.files) || data.files.length < 1 || data.files.length > MAX_DECLARATIONS) throw new Error('invalid source')
            const declarations = data.files.map((file, fileIndex) => ({ sourceSessionSeq: event.seq, fileIndex,
              presentCallId: data.callId, sourceTurn: data.turn, path: file?.path,
              ...(file?.description === undefined ? {} : { description: file.description }) }))
            const next = [...capture.declarations, ...declarations]
            if (!validateArtifactEvidence({ schema: ARTIFACT_EVIDENCE_SCHEMA, range: { ...capture.start, endExclusive: event.seq + 1 }, declarations: next }, capture.start)) throw new Error('invalid source')
            capture.declarations = next
          } catch { capture.failed = true; capture.declarations = [] }
        })
        if (typeof capture.dispose !== 'function' && typeof capture.dispose?.dispose !== 'function') capture.failed = true
      } catch {
        const capture = artifactCaptures.get(key)
        if (capture) capture.failed = true
        // Optional artifact capture must never break child execution.
      }
    }
    const acceptEnd = info => {
      if (!info || typeof info.id !== 'string' || typeof info.runId !== 'string' || info.parentSessionId !== binding.sessionId) return
      const key = pairKey(info.id, info.runId)
      if (!starts.has(key) || ends.has(key)) return
      const capture = artifactCaptures.get(key)
      if (capture) {
        try {
          capture.endExclusive = capture.session.seq
          if (!Number.isSafeInteger(capture.endExclusive) || capture.endExclusive < capture.start.startInclusive) capture.failed = true
        } catch { capture.failed = true }
      }
      ends.set(key, info)
      waiters.get(key)?.(info)
    }
    const requestInterrupt = () => {
      if (!trackedStart || interruptSent) return
      if (ends.has(pairKey(trackedStart.id, trackedStart.runId))) return
      interruptSent = true
      if (typeof ctx.subagents?.interrupt !== 'function') {
        cancelError = fail('NATIVE_INTERRUPT_UNAVAILABLE', 'Host subagent interrupt service is unavailable')
        return
      }
      try {
        // This is a request only. Completion is still determined by the paired end event.
        const result = ctx.subagents.interrupt(trackedStart.id, { kind: 'ancestor', agent: parent })
        if (result && typeof result.then === 'function') {
          Promise.resolve(result).catch(error => { cancelError = error })
        }
      } catch (error) {
        cancelError = error
      }
    }
    const onCombinedAbort = () => requestInterrupt()
    const waitForEnd = async (start, timeoutPromise = deadlinePromise) => {
      const key = pairKey(start.id, start.runId)
      const cached = ends.get(key)
      if (cached) return cached
      const terminal = new Promise(resolve => { waiters.set(key, resolve) })
      const result = await Promise.race([terminal, timeoutPromise])
      waiters.delete(key)
      return result?.kind === 'deadline' ? null : result
    }

    // The public lifecycle carrier filters both the service namespace and Agent.
    // Keep the existing Agent scope chain; own only this attempt's observer fiber.
    const lifecycleScope = createLifecycleScope(parent)
    if (scopeOf(lifecycleScope.ctx) !== parent) { await lifecycleScope.dispose(); throw fail('NATIVE_EVENTS_UNAVAILABLE', 'owned observer scope does not match the exact parent') }
    let disposeStart, disposeEnd
    try {
      disposeStart = lifecycleScope.ctx.on('subagent/start', acceptStart)
      disposeEnd = lifecycleScope.ctx.on('subagent/end', acceptEnd)
    } catch (error) {
      try {
        if (typeof disposeStart === 'function') disposeStart()
        else disposeStart?.dispose?.()
      } finally { await lifecycleScope.dispose() }
      throw error
    }
    let startDisposed = false
    let endDisposed = false
    cleanup = async () => {
      if (startDisposed) return
      startDisposed = true
      try {
        controller.signal.removeEventListener('abort', onCombinedAbort)
        callerSignal.removeEventListener('abort', abortFromCaller)
        if (deadlineTimer) clearTimeout(deadlineTimer)
        for (const capture of artifactCaptures.values()) {
          try { if (typeof capture.dispose === 'function') capture.dispose(); else capture.dispose?.dispose?.() } catch { /* Best-effort optional observer cleanup. */ }
        }
        if (typeof disposeStart === 'function') disposeStart()
        else disposeStart?.dispose?.()
        if (!endDisposed) {
          endDisposed = true
          if (typeof disposeEnd === 'function') disposeEnd()
          else disposeEnd?.dispose?.()
        }
      } finally { await lifecycleScope.dispose() }
    }
    const abortFromCaller = () => controller.abort(callerSignal.reason)
    controller.signal.addEventListener('abort', onCombinedAbort, { once: true })
    callerSignal.addEventListener('abort', abortFromCaller, { once: true })

    const deadlinePromise = new Promise(resolve => {
      deadlineAt = Date.now() + timeoutMs
      deadlineTimer = setTimeout(() => {
        deadlineExpired = true
        controller.abort(new Error('native workflow attempt deadline exceeded'))
        resolve({ kind: 'deadline' })
      }, timeoutMs)
    })
    let abortCallerResolve
    const callerAbortPromise = new Promise(resolve => { abortCallerResolve = resolve })
    const observeCallerAbort = () => abortCallerResolve({ kind: 'caller-abort' })
    callerSignal.addEventListener('abort', observeCallerAbort, { once: true })
    if (callerSignal.aborted) {
      abortFromCaller()
      observeCallerAbort()
    }

    const dispatchPromise = (async () => {
      try {
        toolCallId = createCallId()
        const result = await executeTool({
          callId: toolCallId,
          name: toolName,
          arguments: { description: DESCRIPTION, prompt: binding.prompt, agent_preset: binding.agentPreset,
            ...(binding.modelRequest ? { provider: binding.modelRequest.provider, model: binding.modelRequest.model } : {}) },
          agent: parent,
          signal: controller.signal,
        })
        const value = result?.value
        const childId = !result?.isError && isRecord(value) && value.kind === 'activation' && typeof value.name === 'string' && value.name
          && typeof ctx.subagents?.resolveName === 'function'
          ? await ctx.subagents.resolveName(parent, value.name) : null
        return { kind: 'dispatch', result, childId }
      } catch (error) {
        return { kind: 'dispatch-error', error }
      }
    })()

    const candidatesFor = childId => [...starts.values()].filter(start => start.id === childId)
    const ackStart = outcome => {
      const value = outcome?.kind === 'dispatch' ? outcome.result?.value : undefined
      if (!isRecord(value) || value.kind !== 'activation' || typeof value.name !== 'string' || !value.name || typeof outcome.childId !== 'string') return null
      const candidates = candidatesFor(outcome.childId)
      return candidates.length === 1 ? candidates[0] : null
    }
    const disposeAfterLateDispatch = () => {
      void dispatchPromise.then(async outcome => {
        const start = ackStart(outcome)
        if (start) {
          trackedStart = start
          requestInterrupt()
          // Caller completion is already deadline-bounded. Keep this scoped
          // observer briefly to drain a late acknowledgement's teardown.
          let drainTimer
          const drainDeadline = new Promise(resolve => {
            drainTimer = setTimeout(() => resolve({ kind: 'deadline' }), timeoutMs)
          })
          await waitForEnd(start, drainDeadline)
          clearTimeout(drainTimer)
        }
        await cleanup()
      }).catch(async error => {
        cancelError = error
        await cleanup()
      })
    }

    try {
      const outcome = await Promise.race([dispatchPromise, deadlinePromise, callerAbortPromise])
      if (outcome.kind !== 'dispatch' && outcome.kind !== 'dispatch-error') {
        deadlineExpired = outcome.kind === 'deadline'
        retainListenersForLateDispatch = true
        disposeAfterLateDispatch()
        return receipt({
          status: 'unknown',
          cancellationRequested: !deadlineExpired,
          errorCategory: deadlineExpired ? 'NATIVE_EXECUTION_TIMEOUT' : 'NATIVE_EXECUTION_ABORTED_BEFORE_ACK',
        })
      }

      if (Date.now() >= deadlineAt && !deadlineExpired) {
        deadlineExpired = true
        controller.abort(new Error('native workflow attempt deadline exceeded'))
      }
      if (deadlineExpired) {
        retainListenersForLateDispatch = true
        disposeAfterLateDispatch()
        return receipt({
          status: 'unknown',
          cancellationRequested: true,
          errorCategory: 'NATIVE_EXECUTION_TIMEOUT',
        })
      }

      if (outcome.kind === 'dispatch-error') {
        return receipt({
          status: callerSignal.aborted ? 'tool_cancelled' : 'tool_error',
          errorCategory: extractErrorCategory(outcome.error),
          terminalSource: 'tool-runtime',
        })
      }

      const result = outcome.result
      if (!result || result.isError) {
        return receipt({
          status: callerSignal.aborted ? 'tool_cancelled' : 'tool_error',
          errorCategory: result?.isError ? extractErrorCategory(result.error) : 'INVALID_TOOL_RESULT',
          terminalSource: 'tool-runtime',
        })
      }

      const value = result.value
      if (!isRecord(value) || value.kind !== 'activation' || typeof value.name !== 'string' || !value.name || typeof outcome.childId !== 'string') {
        return receipt({
          status: 'tool_error',
          errorCategory: 'INVALID_SUBAGENT_ACK',
          terminalSource: 'tool-runtime',
        })
      }

      const candidates = candidatesFor(outcome.childId)
      if (candidates.length !== 1) {
        return receipt({
          status: 'unknown',
          errorCategory: candidates.length === 0 ? 'SUBAGENT_START_EVENT_MISSING' : 'SUBAGENT_START_EVENT_AMBIGUOUS',
          childId: outcome.childId,
          terminalSource: 'unknown',
        })
      }

      trackedStart = candidates[0]
      if (recordChildAck) {
        const persistence = await Promise.race([
          Promise.resolve().then(() => recordChildAck(binding, {
            toolCallId,
            childId: trackedStart.id,
            nativeRunId: trackedStart.runId,
            ...(artifactCaptures.get(pairKey(trackedStart.id, trackedStart.runId))?.failed === false
              ? { artifactRangeStart: artifactCaptures.get(pairKey(trackedStart.id, trackedStart.runId)).start } : {}),
          })).then(() => ({ kind: 'persisted' }), error => ({ kind: 'persistence-error', error })),
          deadlinePromise,
          callerAbortPromise,
        ])
        if (persistence.kind !== 'persisted') {
          requestInterrupt()
          // Dispatch has already happened. Drain only the owned child's end,
          // bounded by the original attempt deadline; never claim rollback.
          await waitForEnd(trackedStart)
          return receipt({
            status: 'unknown',
            childId: trackedStart.id,
            nativeRunId: trackedStart.runId,
            cancellationRequested: true,
            errorCategory: persistence.kind === 'persistence-error'
              ? extractErrorCategory(persistence.error)
              : persistence.kind === 'deadline' ? 'NATIVE_EXECUTION_TIMEOUT' : 'NATIVE_EXECUTION_ABORTED_BEFORE_ACK_PERSISTENCE',
            errorStage: 'child-ack-persistence',
          })
        }
      }
      if (controller.signal.aborted) requestInterrupt()
      const end = await waitForEnd(trackedStart)
      if (!end || end.id !== trackedStart.id || end.runId !== trackedStart.runId) {
        return receipt({
          status: 'unknown',
          cancellationRequested: callerSignal.aborted || deadlineExpired,
          errorCategory: cancelError ? extractErrorCategory(cancelError) : 'SUBAGENT_TERMINAL_TIMEOUT',
          childId: trackedStart.id,
          nativeRunId: trackedStart.runId,
          provider: trackedStart.provider ?? 'unknown',
        })
      }
      const capture = artifactCaptures.get(pairKey(trackedStart.id, trackedStart.runId))
      const artifactEvidence = capture && !capture.failed ? validateArtifactEvidence({ schema: ARTIFACT_EVIDENCE_SCHEMA,
        range: { ...capture.start, endExclusive: capture.endExclusive }, declarations: capture.declarations }, capture.start) : null
      return receipt({
        status: terminalStatus(end.stopReason),
        stopReason: end.stopReason,
        errorCategory: end.stopReason === 'completed' ? null : end.stopReason,
        childId: trackedStart.id,
        nativeRunId: end.runId,
        terminalSource: 'subagent/end',
        output: end.lastAssistantMessage ?? null,
        provider: end.provider ?? trackedStart.provider ?? 'unknown',
        ...(artifactEvidence === null ? {} : { artifactEvidence }),
      })
    } finally {
      callerSignal.removeEventListener('abort', observeCallerAbort)
      if (!retainListenersForLateDispatch) await cleanup()
    }
  }

  return Object.freeze({ run })
}
