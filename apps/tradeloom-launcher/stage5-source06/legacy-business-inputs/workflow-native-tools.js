import { ROLE_PRESETS } from './roles.js'
import { join } from 'node:path'
import { resolveOwnedHome, createStateStore } from './state.js'
import { createWorkflowStore } from './workflow-engine.js'
import { createPostgresWorkflowRunStore } from './workflow-postgres.js'
import { createWorkflowNativeService } from './workflow-native-service.js'
import { NATIVE_WORKFLOW_READINESS, runWhenNativeWorkflowReady } from './workflow-native-readiness.js'

export const name = '@tradeloom/dsh-business-shell/workflow-native-tools'
export const inject = ['tools', 'agents', 'workspaceRegistry', 'sessionQuery', 'subagents', 'webServer', 'nativeTaskAuthority', 'nativeWorkflowRuntime']

const WORKFLOW_ID = /^[a-z0-9][a-z0-9_-]{0,47}$/
const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const DEFINITION_REVISION = /^sha256:[a-f0-9]{64}$/
const BINDING_REVISION = /^(?:0|[1-9][0-9]{0,63})$/
const PUBLIC_ERRORS = new Set([
  'unsupported_workflow_graph', 'workflow_not_found', 'workflow_not_confirmed',
  'center_binding_mismatch', 'run_parent_mismatch', 'definition_revision_mismatch',
  'submission_identity_conflict', 'native_bridge_unavailable', 'service_closed',
  'run_not_found', 'NATIVE_PRESET_NOT_ALLOWED',
  'binding_revision_mismatch', 'workflow_not_eligible', 'invalid_expected_revision',
  'unsupported_model_selection', 'upstream_terminal_unverified', 'upstream_output_unavailable', 'native_prompt_too_large',
  'native_run_unavailable', 'native_task_origin_required', 'ui_origin_required', 'resume_blocked', 'resume_plan_conflict', 'resume_revision_conflict', 'operation_conflict', 'operation_aborted',
  'owner_capability_required', 'owner_fenced', 'owner_conflict', 'legacy_unmanaged',
  'owner_namespace_unavailable', 'recovery_unavailable', 'recovery_snapshot_invalid',
  'invalid_recovery_cursor', 'run_create_reconciled',
])
const OUTPUT = {
  schema: {
    type: 'object', additionalProperties: false, required: ['ok', 'data', 'error_code'],
    properties: { ok: { type: 'boolean' }, data: { type: 'string' }, error_code: { type: 'string' } },
  },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
}
const fail = code => ({ ok: false, data: '{}', error_code: code })
const fields = {
  workflowId: { type: 'string', pattern: WORKFLOW_ID.source, maxLength: 48 },
  runId: { type: 'string', pattern: RUN_ID.source, maxLength: 36 },
  activeOnly: { type: 'boolean' },
  expectedDefinitionRevision: { type: 'string', pattern: DEFINITION_REVISION.source, maxLength: 71 },
  expectedBindingRevision: { type: 'string', pattern: BINDING_REVISION.source, maxLength: 64 },
  expectedRunRevision: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
  resumePlanHash: { type: 'string', pattern: DEFINITION_REVISION.source, maxLength: 71 },
  confirm: { type: 'boolean', enum: [true] },
}
const operations = [
  ['submit', ['workflowId', 'expectedDefinitionRevision', 'expectedBindingRevision'], ['workflowId'], 'Submit a saved, human-confirmed agent-only DAG for serial native execution. Predecessors require persisted verified terminal results; unknown pauses dispatch. Non-agent nodes are not supported. Model selection requires the official tool schema to expose provider and model. First use native_prepare and compare revisions, never use them as authorization. Returns a persisted run ID; acceptance is not child completion.'],
  ['get', ['runId'], ['runId'], 'Read one native workflow run owned by the authorized center session.'],
  ['list', ['workflowId', 'activeOnly'], [], 'List native workflow runs owned by the authorized center session.'],
  ['cancel', ['runId'], ['runId'], 'Request cancellation of an owned native workflow run; inspect its persisted status for settlement.'],
  ['prepare', ['workflowId'], ['workflowId'], 'Check the saved workflow eligibility and current trusted center binding without dispatch. Returns the prepared native DTO and revisions; does not approve a workflow or start a child.'],
  ['prepare_resume', ['runId'], ['runId'], 'Read the current persisted manual-resume plan without dispatch. Unknown side effects or an unverified child terminal block resume; plan hashes and revisions are not authorization.'],
  ['resume', ['runId', 'expectedRunRevision', 'expectedDefinitionRevision', 'expectedBindingRevision', 'resumePlanHash', 'confirm'],
    ['runId', 'expectedRunRevision', 'expectedDefinitionRevision', 'expectedBindingRevision', 'resumePlanHash', 'confirm'],
    'Explicitly confirm the prepared resume plan. Persist the operation claim before scheduling new attempts; never rerun done nodes or resend an old request. Reuse the same trusted tool call identity to replay the same operation without dispatch.'],
]

function validArguments(args, allowed, required) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false
  if (Object.keys(args).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(args, key))) return false
  return Object.keys(args).every(key => key === 'workflowId' ? typeof args[key] === 'string' && WORKFLOW_ID.test(args[key])
    : key === 'runId' ? typeof args[key] === 'string' && RUN_ID.test(args[key])
      : key === 'expectedDefinitionRevision' || key === 'resumePlanHash' ? typeof args[key] === 'string' && DEFINITION_REVISION.test(args[key])
        : key === 'expectedBindingRevision' ? typeof args[key] === 'string' && BINDING_REVISION.test(args[key])
          : key === 'expectedRunRevision' ? Number.isSafeInteger(args[key]) && args[key] > 0
            : key === 'confirm' ? args[key] === true
          : typeof args[key] === 'boolean')
}

/** Service methods own all authorization, including reads and cancellation.
 * Never replace the actual ToolRunContext with arguments or a synthetic caller.
 */
export function registerWorkflowNativeTools(ctx, service, config = {}) {
  if (config.preset !== ROLE_PRESETS.center) return () => {}
  if (!ctx?.tools?.register || operations.some(([method]) => typeof service?.[method] !== 'function')) {
    throw new TypeError('Native workflow tools require a ToolRuntime and native service')
  }
  const disposers = []
  const callers = new Set()
  try {
    for (const [method, allowed, required, description] of operations) {
      disposers.push(ctx.tools.register({
        name: `tradeloom_wf_native_${method}`, description,
        parameters: { type: 'object', additionalProperties: false, required, properties: Object.fromEntries(allowed.map(key => [key, fields[key]])) },
        output: OUTPUT,
        async execute(args, exec) {
          if (!validArguments(args, allowed, required)) return fail('invalid_native_workflow_arguments')
          try {
            callers.add(exec.agent)
            return { ok: true, data: JSON.stringify(await runWhenNativeWorkflowReady(ctx, exec.signal, () => {
              ctx.get('nativeWorkflowRuntime').assertService(service)
              return service[method](args, exec)
            })), error_code: '' }
          }
          catch (error) { return fail(PUBLIC_ERRORS.has(error?.code) ? error.code : 'native_workflow_unavailable') }
        },
      }))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }
  let disposed = false
  return async () => {
    if (disposed) return
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
    await Promise.all([...callers].map(agent => service.releaseAgent(agent)))
    callers.clear()
  }
}

function djangoPort(config, env) {
  const value = config.djangoPort ?? env.TRADELOOM_DJANGO_PORT ?? 3090
  if ((typeof value !== 'number' && typeof value !== 'string')
    || (typeof value === 'string' && !/^[1-9][0-9]{0,4}$/.test(value))
    || !Number.isInteger(Number(value)) || Number(value) < 1 || Number(value) > 65535) {
    throw new TypeError('Invalid trusted Django port')
  }
  return Number(value)
}

/** One Host-lifetime recovery/activation owner, shared by scoped preset tools.
 * Lazy start preserves the former first-center composition readiness point; an
 * Agent replacement neither races startup PG nor owns/disposes this service. */
export function createWorkflowNativeHostComposition(ctx, config = {}, dependencies = {}) {
  const env = dependencies.env ?? process.env
  const port = djangoPort(config, env)
  const ownedHome = dependencies.resolveOwnedHome ?? resolveOwnedHome
  const stateFactory = dependencies.createStateStore ?? createStateStore
  const definitionsFactory = dependencies.createWorkflowStore ?? createWorkflowStore
  const runFactory = dependencies.createPostgresWorkflowRunStore ?? createPostgresWorkflowRunStore
  const serviceFactory = dependencies.createWorkflowNativeService ?? createWorkflowNativeService
  let home, state, definitions
  const getHome = () => home ??= Promise.resolve().then(() => ownedHome(env))
  const readState = async () => {
    await getHome()
    state ??= stateFactory({ env })
    return (await state).read()
  }
  const definitionStore = { async get(id) {
    definitions ??= getHome().then(path => definitionsFactory(join(path, 'tradeloom-workflows')))
    return (await definitions).get(id)
  } }
  // Pair only from trusted Host composition, never request headers or tool args.
  // The PG adapter validates exact protocol/host/port/canonical origin.
  const pairedHost = config.pairedHost === undefined
    ? { host: ctx.webServer.host, port: ctx.webServer.port }
    : { ...config.pairedHost }
  let service, detach, disposed = false
  return Object.freeze({
    getService() {
      if (disposed) throw Object.assign(Error('native_workflow_unavailable'), { code: 'native_workflow_unavailable' })
      if (service) return service
      const readiness = ctx.get(NATIVE_WORKFLOW_READINESS)
      if (typeof readiness?.attach !== 'function') throw new Error('native_workflow_unavailable')
      const runStore = runFactory({ webServer: ctx.webServer, port, pairedHost })
      const created = serviceFactory({ ctx, readState, definitionStore, runStore, taskAuthority: ctx.nativeTaskAuthority,
        ...(config.timeoutMs === undefined ? {} : { timeoutMs: config.timeoutMs }) })
      try { detach = readiness.attach(created); service = created; return service }
      catch (error) { created.dispose(); throw error }
    },
    assertService(value) { if (disposed || value !== service) throw Object.assign(Error('native_workflow_unavailable'), { code: 'native_workflow_unavailable' }) },
    get currentService() { return service },
    async dispose() { if (disposed) return; disposed = true; detach?.(); if (service) { await service.dispose(); await service.drain() } },
  })
}

/** Only registration belongs to a preset's fiber. */
export function createWorkflowNativeToolComposition(ctx, config = {}) {
  if (config.preset !== ROLE_PRESETS.center) return () => {}
  const runtime = ctx.get('nativeWorkflowRuntime')
  if (typeof runtime?.getService !== 'function') throw new Error('native_workflow_unavailable')
  return registerWorkflowNativeTools(ctx, runtime.getService(), config)
}

export function apply(ctx, config = {}) {
  if (config.preset !== ROLE_PRESETS.center) return
  return ctx.effect(() => createWorkflowNativeToolComposition(ctx, config), 'tradeloom native workflow tools')
}
