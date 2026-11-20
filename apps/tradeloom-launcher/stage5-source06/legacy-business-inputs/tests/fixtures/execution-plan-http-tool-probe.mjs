import http from 'node:http'
import { pathToFileURL } from 'node:url'

const proof = { center: { ok: false }, delivery: { ok: false }, product: { errorCode: '', requestCount: 0 },
  invalidId: { errorCode: '', requestCount: 0 }, requests: [], requestCount: 0, renderedEnvelope: false }

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`missing_${name.toLowerCase()}`)
  return value
}

function makeRuntime(ToolRuntime) {
  const definitions = new Map()
  const runtime = { ctx: {}, layers: { effect(_ctx, install) {
    return install({ tools: { insert(name, definition) { definitions.set(name, definition); return () => definitions.delete(name) } } })
  } } }
  return {
    definitions,
    register(definition) { return ToolRuntime.prototype.register.call(runtime, definition) },
  }
}

function actor(preset) {
  return { agent: { session: { header: { agentPreset: preset } } }, signal: new AbortController().signal }
}

async function main() {
  const productRoot = required('TRADELOOM_PHASE3_PRODUCT_ROOT')
  const runtimePath = required('TRADELOOM_DSH_TOOLS_LIBRARY')
  const expectedNode = required('TRADELOOM_PHASE3_NODE_EXE')
  const privateHost = required('TRADELOOM_PHASE3_PRIVATE_HOST')
  const privateOrigin = required('TRADELOOM_PHASE3_PRIVATE_ORIGIN')
  const port = Number(required('TRADELOOM_PHASE3_HTTP_PORT'))
  const planId = required('TRADELOOM_PHASE3_PLAN_ID')
  const requirementId = required('TRADELOOM_PHASE3_REQUIREMENT_ID')
  const snapshotId = required('TRADELOOM_PHASE3_SNAPSHOT_ID')
  const description = required('TRADELOOM_PHASE3_DESCRIPTION')
  const evidenceId = required('TRADELOOM_PHASE3_EVIDENCE_ID')
  const sheetIndex = Number(required('TRADELOOM_PHASE3_SHEET_INDEX'))
  const coordinate = required('TRADELOOM_PHASE3_COORDINATE')
  if (process.execPath.toLowerCase() !== expectedNode.toLowerCase() || !Number.isInteger(port) || port < 1 || port > 65535
    || !/^[0-9a-f]{32}$/.test(planId) || !/^[0-9a-f]{32}$/.test(requirementId)
    || !/^[0-9a-f]{32}$/.test(evidenceId) || !/^[0-9a-f]{32}$/.test(snapshotId)
    || privateHost !== '192.168.56.1:3088'
    || privateOrigin !== `http://${privateHost}`) throw new Error('invalid_probe_precondition')

  const businessToolsPath = `${productRoot.replaceAll('\\', '/')}/packages/tradeloom-shell/business-tools.js`
  const [{ registerBusinessTools }, { ToolRuntime }] = await Promise.all([
    import(pathToFileURL(businessToolsPath).href), import(pathToFileURL(runtimePath).href),
  ])
  if (typeof registerBusinessTools !== 'function' || typeof ToolRuntime?.prototype?.register !== 'function') {
    throw new Error('registered_tool_runtime_exports_missing')
  }
  const webServer = {
    protocol: 'http:', host: '192.168.56.1', port: 3088,
    getOrigin: () => privateOrigin,
  }
  const countedRequest = (options, callback) => {
    proof.requests.push({ method: options.method, path: options.path, host: options.headers.host, port: options.port })
    return http.request(options, callback)
  }
  async function register(preset) {
    const runtime = makeRuntime(ToolRuntime)
    const dispose = registerBusinessTools({ webServer, tools: { register: runtime.register } }, { preset },
      { port, timeoutMs: 15000, request: countedRequest })
    const tool = runtime.definitions.get('tradeloom_read_execution_plan')
    if (!tool || tool.parameters?.additionalProperties !== false || tool.parameters?.type !== 'object') {
      dispose?.()
      throw new Error('execution_plan_reader_registration_mismatch')
    }
    return { tool, dispose }
  }
  async function read(preset) {
    const { tool, dispose } = await register(preset)
    try {
      const args = { plan_revision_id: planId }
      const value = await tool.execute(args, actor(preset))
      const rendered = await tool.output.render(args, value)
      const renderedValue = Array.isArray(rendered) && rendered.length === 1 && rendered[0]?.type === 'text'
        ? JSON.parse(rendered[0].text) : null
      const data = value?.ok === true && typeof value.data === 'string' ? JSON.parse(value.data) : null
      const source = data?.requirement?.source_refs?.description?.find(ref => ref.id === evidenceId)
      const valid = !!data && !!source && data.requirement.id === requirementId
        && data.requirement.fields.description === description
        && source.field_key === 'description' && source.snapshot_id === snapshotId
        && source.sheet_index === sheetIndex && source.coordinate === coordinate
        && data.plan?.requirement_revision_id === requirementId
        && data.plan?.materials?.[0]?.proposal?.quantity === '0'
        && data.plan?.operations?.[0]?.proposal?.sequence === 1
        && data.plan?.actual?.status === 'missing' && data.truncated === false
        && renderedValue?.ok === true && renderedValue?.data === value.data
      return { valid, rendered: Array.isArray(rendered) && renderedValue?.ok === true }
    } finally { dispose?.() }
  }

  proof.center.ok = (await read('tradeloom-center')).valid
  proof.delivery.ok = (await read('tradeloom-delivery')).valid
  proof.renderedEnvelope = proof.center.ok && proof.delivery.ok
  proof.requestCount = proof.requests.length

  const productStart = proof.requests.length
  const productRuntime = await register('tradeloom-center')
  try {
    const denied = await productRuntime.tool.execute({ plan_revision_id: planId }, actor('tradeloom-product'))
    proof.product.errorCode = denied?.error_code || ''
    proof.product.requestCount = proof.requests.length - productStart
  } finally { productRuntime.dispose?.() }

  const invalidStart = proof.requests.length
  const centerRuntime = await register('tradeloom-center')
  try {
    const invalid = await centerRuntime.tool.execute({ plan_revision_id: 'not-a-plan' }, actor('tradeloom-center'))
    proof.invalidId.errorCode = invalid?.error_code || ''
    proof.invalidId.requestCount = proof.requests.length - invalidStart
  } finally { centerRuntime.dispose?.() }

  if (!proof.center.ok || !proof.delivery.ok || proof.product.errorCode !== 'role_not_authorized'
    || proof.product.requestCount !== 0 || proof.invalidId.errorCode !== 'invalid_arguments'
    || proof.invalidId.requestCount !== 0 || proof.requestCount !== 2) throw new Error('probe_assertion_failed')
  process.stdout.write(`${JSON.stringify(proof)}\n`)
}

main().catch(error => {
  process.stderr.write(`${error?.stack || error}\n`)
  process.exitCode = 1
})
